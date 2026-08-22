#!/usr/bin/env node
/**
 * diag-forecast-inputs.mjs — 섹터 방향예측 **입력 후보 IC 측정** (2026-08-05)
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────────
 * 반사실 검정에서 엔진 상수(shrink·cap·부호) 18조합 전부 IS·OOS 동시개선 실패였다.
 * 즉 **변환이 아니라 입력이 문제**다. 현행 입력은 `m20`(최근 20구간 평균) 하나뿐이고,
 * 원장 14거래일 기준으로 방향정보가 사실상 없었다.
 *
 * 그래서 "무엇을 넣어야 하나"를 먼저 잰다. 원장(14일)이 아니라 **가격 4.8년**으로 재야
 * 결론이 선다. 수급·공시는 이력이 짧아(40거래일·3.5개월) 보조 측정으로만 둔다.
 *
 * ── 방법 ──────────────────────────────────────────────────────────────────────
 *   섹터 일간 수익률 = 그 섹터 종목들의 **동일가중** 평균(시총가중은 과거 시총이 없어 생존편향이 더 커진다)
 *   예측자는 전부 **T 시점까지만** 사용. 타깃 = T+1 섹터 수익률.
 *   지표 = spearman IC(섹터-일 pooled) + 부호일치율. IS/OOS 시간분할.
 *
 * ── 사전선언 ──────────────────────────────────────────────────────────────────
 *   · |IC| > 0.03 이면 약한 정보, > 0.05 유의미 (이 저장소 PIT 백테와 같은 기준)
 *   · **IS·OOS 부호가 같아야** 후보. 뒤집히면 기각(반사실 검정에서 m20 이 정확히 그랬다)
 *   · 다중비교 주의 — 예측자 N개를 재면 그중 하나는 우연히 좋다. 부호 일관성을 1차 필터로 쓴다.
 *
 * 실행: node diag-forecast-inputs.mjs
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySectorOverride } from './strategy-contract.mjs';
import { spearmanIC } from './backtest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const FILE = join(__dirname, 'candles-daily-toss-clean.jsonl');
const ARGV = process.argv.slice(2);
const argOf = (f, d) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const BEGIN = argOf('--begin', '20220101');
const MIN_STOCKS = 5;

async function dbQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`db ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const secRows = await dbQuery(`SELECT stock_code, sector FROM stock_analysis WHERE sector IS NOT NULL`);
const SECTOR = applySectorOverride(Object.fromEntries(secRows.map(r => [r.stock_code, r.sector])));

// ── 종목 일간 수익률 적재 → 섹터 동일가중 시계열 ──────────────
const bySecDate = new Map();   // sector → Map(date → {sum, n})
const allDates = new Set();
{
  const rl = createInterface({ input: createReadStream(FILE) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const sec = SECTOR[j.code];
    if (!sec) continue;
    const { d, c } = j;
    if (!c || c.length < 100) continue;
    if (!bySecDate.has(sec)) bySecDate.set(sec, new Map());
    const m = bySecDate.get(sec);
    for (let i = 1; i < c.length; i++) {
      const date = String(d[i]);
      if (date < BEGIN) continue;
      if (!(c[i - 1] > 0) || !(c[i] > 0)) continue;
      const ret = (c[i] / c[i - 1] - 1) * 100;
      if (Math.abs(ret) > 40) continue;                 // 데이터 이상치·권리락 방어
      const o = m.get(date) ?? { sum: 0, n: 0 };
      o.sum += ret; o.n++; m.set(date, o);
      allDates.add(date);
    }
  }
}
const dates = [...allDates].sort();
// 섹터별 시계열(날짜 정렬, 최소 종목수 충족일만)
const series = new Map();
for (const [sec, m] of bySecDate) {
  const arr = dates.map(dt => { const o = m.get(dt); return o && o.n >= MIN_STOCKS ? o.sum / o.n : null; });
  if (arr.filter(v => v != null).length >= 300) series.set(sec, arr);
}
console.log(`=== 섹터 방향예측 입력 IC 측정 ===`);
console.log(`섹터 ${series.size}개 · 거래일 ${dates.length}일 (${dates[0]}~${dates[dates.length - 1]})\n`);

// 시장요인(전 섹터 평균) — 잔차 계산용
const mkt = dates.map((_, i) => {
  const vs = [...series.values()].map(a => a[i]).filter(v => v != null);
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
});

// ── 예측자 ────────────────────────────────────────────────────
/** 전부 T 시점까지만 사용. arr[i] 는 i일 수익률이므로 i 까지의 값만 본다. */
const PRED = {
  'm20 (현행)':      (a, i) => mean(a, i - 19, i),
  'm5':              (a, i) => mean(a, i - 4, i),
  'm1 (전일)':       (a, i) => a[i],
  'm60':             (a, i) => mean(a, i - 59, i),
  'dd20 (20일누적)': (a, i) => sum(a, i - 19, i),
  'rsi2류(2일합)':   (a, i) => sum(a, i - 1, i),
  'sigma20':         (a, i) => sd(a, i - 19, i),
  '잔차m20 (시장차감)': (a, i, mk) => { const s = mean(a, i - 19, i), m = mean(mk, i - 19, i); return s != null && m != null ? s - m : null; },
  '잔차m5':          (a, i, mk) => { const s = mean(a, i - 4, i), m = mean(mk, i - 4, i); return s != null && m != null ? s - m : null; },
  '시장m1':          (a, i, mk) => mk[i],
};
function slice(a, s, e) { const out = []; for (let k = Math.max(0, s); k <= e; k++) if (a[k] != null) out.push(a[k]); return out; }
function mean(a, s, e) { const v = slice(a, s, e); return v.length >= Math.max(2, Math.floor((e - s + 1) * 0.6)) ? v.reduce((x, y) => x + y, 0) / v.length : null; }
function sum(a, s, e) { const v = slice(a, s, e); return v.length ? v.reduce((x, y) => x + y, 0) : null; }
function sd(a, s, e) { const v = slice(a, s, e); if (v.length < 5) return null; const m = v.reduce((x, y) => x + y, 0) / v.length; return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length); }

// ── pooled 표본 구성 ──────────────────────────────────────────
const half = Math.floor(dates.length / 2);
const rowsIS = {}, rowsOOS = {};
for (const k of Object.keys(PRED)) { rowsIS[k] = []; rowsOOS[k] = []; }
for (const [, a] of series) {
  for (let i = 60; i < dates.length - 1; i++) {
    const tgt = a[i + 1];
    if (tgt == null) continue;
    for (const [k, fn] of Object.entries(PRED)) {
      let v; try { v = fn(a, i, mkt); } catch { v = null; }
      if (v == null || !Number.isFinite(v)) continue;
      (i < half ? rowsIS : rowsOOS)[k].push([v, tgt]);
    }
  }
}

const signRate = (pairs) => pairs.filter(([x, y]) => Math.sign(x) === Math.sign(y)).length / pairs.length * 100;
console.log(`${'예측자'.padEnd(20)}${'n(IS)'.padStart(9)}${'IS IC'.padStart(9)}${'IS부호'.padStart(8)}${'OOS IC'.padStart(9)}${'OOS부호'.padStart(9)}${'판정'.padStart(12)}`);
const out = [];
for (const k of Object.keys(PRED)) {
  const a = rowsIS[k], b = rowsOOS[k];
  if (a.length < 500 || b.length < 500) continue;
  const ia = spearmanIC(a), ib = spearmanIC(b);
  const consistent = Math.sign(ia) === Math.sign(ib) && Math.abs(ia) > 0.01 && Math.abs(ib) > 0.01;
  const strong = consistent && Math.min(Math.abs(ia), Math.abs(ib)) >= 0.03;
  out.push({ k, ia, ib, consistent, strong });
  console.log(`${k.padEnd(20)}${String(a.length).padStart(9)}${ia.toFixed(4).padStart(9)}${(signRate(a).toFixed(1) + '%').padStart(8)}` +
    `${ib.toFixed(4).padStart(9)}${(signRate(b).toFixed(1) + '%').padStart(9)}` +
    `${(strong ? '★강함' : consistent ? '부호일관' : '기각').padStart(12)}`);
}
console.log(`\n── 사전선언 판정 ──`);
const strong = out.filter(x => x.strong), cons = out.filter(x => x.consistent && !x.strong);
if (strong.length) for (const x of strong) console.log(`  ★ ${x.k} — IS ${x.ia.toFixed(4)} / OOS ${x.ib.toFixed(4)} (|IC| ≥ 0.03 · 부호일관)`);
else console.log(`  |IC| ≥ 0.03 이면서 부호 일관인 예측자 **0건**`);
if (cons.length) console.log(`  · 부호만 일관(약함): ${cons.map(x => `${x.k} ${x.ia.toFixed(3)}/${x.ib.toFixed(3)}`).join(' · ')}`);
console.log(`\n※ 섹터-일 pooled IC. 다중비교라 하나쯤은 우연히 좋다 — **부호 일관성**을 1차 필터로 썼다.`);
console.log(`※ 동일가중 섹터지수(과거 시총 없음). 생존편향 있음 — 예측자 간 **상대비교**가 목적.`);
