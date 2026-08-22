#!/usr/bin/env node
/**
 * diag-live-fill-f.mjs — **라이브 봇의 실제 체결 기록으로 f_entry 를 지금 계산** (2026-08-04)
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────────
 * 횡단면 잔차 스캘핑의 마지막 관문은 체결 품질이다: `f = (체결가 − 진입봉 시가) / (진입봉 고저폭)`.
 * **f ≥ 0.18 이면 EV 가 0 이하**로 떨어진다(backtest-xs-scalp `--advfill` 실측: f=0 +0.384 / f=0.5 −0.668).
 * 내일 소액 실주문으로 재려 했으나 — `stock-live` 가 이미 **실체결가(px)와 지정가(limitPx)를
 * 몇 주째 저널에 남기고 있다.** 같은 계좌·같은 크로싱 지정가 방식이므로 **오늘 바로 1차 추정**이 가능하다.
 *
 * ⚠️ 한계(결론에 반드시 병기): 이 체결들은 **rsi2/hi120 스윙 진입**이지 −5% 횡단면 급락 직후가 아니다.
 *   급락 순간은 스프레드·변동성이 더 크므로 이 값은 **낙관적 하한**으로 읽어야 한다.
 *   그래도 "이 계좌·이 주문방식의 기본 체결 품질"을 알려주고, 여기서 이미 0.18 을 넘으면 **그 자체로 기각**이다.
 *
 * 실행(VM 에서만 — 토스 API IP 화이트리스트): node diag-live-fill-f.mjs
 */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getCandles1m } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const THRESHOLD = 0.18;
const j = JSON.parse(readFileSync(join(__dirname, 'stock-live-journal.json'), 'utf8'));
const buys = (j.trades || []).filter(t => t.side === 'BUY' && t.px > 0 && t.limitPx > 0);
console.log(`=== 라이브 실체결 f_entry 측정 ===`);
console.log(`저널 BUY ${buys.length}건 (fillSrc=actual ${buys.filter(b => b.fillSrc === 'actual').length}건)\n`);

const rows = [];
for (const b of buys) {
  // 체결 시각(KST 문자열) → epoch. 저널 ts 는 "YYYY-MM-DD HH:MM:SS" KST.
  const fillMs = Date.parse(b.ts.replace(' ', 'T') + '+09:00');
  if (!Number.isFinite(fillMs)) { console.log(`  ts 파싱 실패: ${b.ts}`); continue; }
  const daysBack = Math.ceil((Date.now() - fillMs) / 86_400_000) + 1;
  const need = Math.min(20_000, Math.max(1500, daysBack * 800));   // 하루 ~720분(NXT 포함) + 여유
  let cd;
  try { cd = await getCandles1m(b.code, need); }
  catch (e) { console.log(`  캔들 조회 실패 ${b.code}: ${String(e.message).slice(0, 90)}`); continue; }
  /**
   * ★ 봉 매칭 — 저널 ts 를 그대로 쓰면 안 된다. `recordTrade` 는 `settleOrder` 폴링(최대 24초) **이후**에
   *   호출되므로 ts 가 실제 체결보다 최대 ~30초 늦다. 그 봉을 쓰면 체결가가 봉 범위 밖으로 나온다
   *   (1차 실행에서 봉내위치 1.33·−0.52 가 나와 발각 — 구조적으로 불가능한 값이라 매칭 오류의 증거).
   *   → ts 기준 **직전 3분 구간에서 체결가를 [저,고] 안에 포함하는 봉**을 찾는다. 여러 개면 가장 늦은 것.
   *   포함하는 봉이 없으면 **계산하지 않고 버린다**(추정으로 메우면 그게 결론을 만든다).
   */
  const win = cd.filter(x => { const t = Date.parse(x.timestamp); return t <= fillMs + 60_000 && t >= fillMs - 180_000; })
    .sort((a, b2) => Date.parse(b2.timestamp) - Date.parse(a.timestamp));
  const bar = win.find(x => b.px >= Number(x.low) - 1e-9 && b.px <= Number(x.high) + 1e-9);
  if (!bar) {
    console.log(`  ⊘ ${b.name}(${b.code}) ${b.ts} — 체결가 ${b.px.toLocaleString()} 를 포함하는 분봉 없음(후보 ${win.length}봉) → 제외`);
    continue;
  }
  const o = Number(bar.open), h = Number(bar.high), l = Number(bar.low);
  const rng = h - l;
  const f = rng > 0 ? (b.px - o) / rng : null;
  const slipVsLimit = (b.px / b.limitPx - 1) * 100;      // 지정가 대비 얼마나 유리하게 체결됐나(음수=유리)
  const posInRange = rng > 0 ? (b.px - l) / rng : null;  // 봉 내 위치(0=저가, 1=고가)
  rows.push({ ...b, o, h, l, rng, f, slipVsLimit, posInRange });
}

if (!rows.length) { console.log('\n계산 가능한 건 0 — 캔들 조회 범위 밖일 가능성.'); process.exit(1); }

console.log(`${'일시'.padEnd(20)}${'종목'.padEnd(16)}${'체결가'.padStart(11)}${'봉시가'.padStart(11)}${'고저폭%'.padStart(9)}${'f'.padStart(8)}${'봉내위치'.padStart(9)}${'지정가대비%'.padStart(12)}`);
for (const r of rows) {
  console.log(`${r.ts.padEnd(20)}${(r.name ?? '').slice(0, 14).padEnd(16)}${r.px.toLocaleString().padStart(11)}${r.o.toLocaleString().padStart(11)}` +
    `${((r.rng / r.o * 100).toFixed(3)).padStart(9)}${(r.f != null ? r.f.toFixed(3) : '-').padStart(8)}` +
    `${(r.posInRange != null ? r.posInRange.toFixed(2) : '-').padStart(9)}${r.slipVsLimit.toFixed(3).padStart(12)}`);
}

const fs_ = rows.map(r => r.f).filter(v => v != null).sort((a, b) => a - b);
const med = fs_[Math.floor(fs_.length / 2)];
const mean = fs_.reduce((a, b) => a + b, 0) / fs_.length;
const over = fs_.filter(v => v >= THRESHOLD).length;
console.log(`\n── f_entry 분포 (n=${fs_.length}) ──`);
console.log(`  중위 ${med.toFixed(3)} · 평균 ${mean.toFixed(3)} · 최소 ${fs_[0].toFixed(3)} · 최대 ${fs_[fs_.length - 1].toFixed(3)}`);
console.log(`  임계 ${THRESHOLD} 초과 ${over}/${fs_.length}건 (${(over / fs_.length * 100).toFixed(0)}%)`);
console.log(`\n  판정: 중위 f ${med.toFixed(3)} ${med < THRESHOLD ? '< 0.18 → **백테 전제 성립**(이 표본 기준)' : '≥ 0.18 → **기각 방향**'}`);
console.log(`\n※ 한계: 이 체결은 rsi2/hi120 스윙 진입이다. −5% 횡단면 급락 직후는 스프레드·변동성이 더 크므로`);
console.log(`  실제 전략의 f 는 이보다 **나쁠 가능성이 높다**. 이 값은 낙관적 하한으로 읽을 것.`);
console.log(`  최종 판정은 measure-slippage.mjs 의 동일 조건 실측(내일~)으로 한다.`);
