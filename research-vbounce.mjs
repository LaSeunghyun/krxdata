/**
 * research-vbounce.mjs — "노타형" 바닥반등 종목 스캔 + 공통점 분석 (2026-07-27, 사용자 요청)
 *
 * 노타(486990) 실측 템플릿: 120일고가 49,000 → 저점 15,130(07-21, -69%) → 3일 뒤 21,750 = **+43.8%**
 *   거래량비 0.48x(바닥) → 4.55x(반등 3일차), RSI2 0.0 → 100, MA20 아래에서 시작해 07-24에 돌파.
 * 조건(오늘 기준):
 *   ① 20일 최저가가 **최근 N거래일 이내**(방금 바닥을 쳤다)  ② 그 저점 대비 반등률 ≥ G%
 *   ③ 120일 고가 대비 ≤ H% (큰 하락 후)                      ④ 오늘 거래량 ≥ 20일 평균 × V
 * 일봉은 로컬 캐시(전일까지) + **오늘 봉은 KIS**(장마감 후 확정). 수급은 stock_investor_flows(전일까지 확정분).
 * 실행: node research-vbounce.mjs [--lowdays 5] [--gain 15] [--hiprox 80] [--vol 1.5]
 */
import 'dotenv/config';
import { loadDaily } from './scan-1m-core.mjs';
import { getDailyPrices } from './kis-api.js';
import { createReadStream } from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const LOWDAYS = Number(argOf('--lowdays', 5));
const GAIN = Number(argOf('--gain', 15));
const HIPROX = Number(argOf('--hiprox', 80)) / 100;
const VOL = Number(argOf('--vol', 1.5));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 150)}`);
  return r.json();
};

const NAME = new Map();
for (const r of await dbQuery('SELECT stock_code, corp_name FROM stocks')) NAME.set(r.stock_code, String(r.corp_name ?? '').replace(/&amp;/g, '&'));
const nm = (c) => `${NAME.get(c) ?? '?'}(${c})`;

// 전체 일봉 로드(유동성 필터 전) — 반등 계산에 원시 시계열이 필요
const HIST = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 130) HIST.set(j.code, j); } catch {} });
  rl.on('close', res);
});
const { daily, freshDate } = await loadDaily();   // 유동성 통과 목록 (20일 거래대금 30억+)
console.log(`유동성 통과 ${daily.size}종목 · 캐시 기준일 ${freshDate} · 오늘 봉은 KIS 조회`);

const hits = [];
let done = 0, fail = 0;
for (const code of daily.keys()) {
  const j = HIST.get(code);
  if (!j) { fail++; continue; }
  let today = null;
  try {
    const bars = await getDailyPrices(code);
    today = bars[0];                                  // 최신순 → [0] = 오늘(장마감 후 확정)
    await sleep(150);
  } catch { fail++; continue; }
  if (!today || today.date <= freshDate) { fail++; continue; }   // 오늘 봉 없으면 제외

  const n = j.c.length;
  // 최근 20일 저가 시계열(오늘 포함)
  const lows = [...j.l.slice(n - 19), Number(today.low)];
  const dates = [...j.d.slice(n - 19), today.date];
  const lo = Math.min(...lows);
  const loI = lows.indexOf(lo);
  const daysSinceLow = lows.length - 1 - loI;          // 0=오늘이 저점
  const px = Number(today.close);
  const bounce = (px / lo - 1) * 100;
  let hi120 = 0; for (let i = Math.max(0, n - 119); i < n; i++) hi120 = Math.max(hi120, j.h[i]);
  hi120 = Math.max(hi120, Number(today.high));
  let av = 0; for (let i = n - 20; i < n; i++) av += j.v[i]; av /= 20;
  const volRatio = av > 0 ? Number(today.volume) / av : 0;
  let ma20 = 0; for (let i = n - 19; i < n; i++) ma20 += j.c[i]; ma20 = (ma20 + px) / 20;
  const dayRet = (px / j.c[n - 1] - 1) * 100;

  if (daysSinceLow <= LOWDAYS && daysSinceLow >= 1 && bounce >= GAIN && px / hi120 <= HIPROX && volRatio >= VOL) {
    hits.push({ code, px, lo, loDate: dates[loI], daysSinceLow, bounce, hiProx: px / hi120, volRatio, ma20, aboveMa20: px > ma20, dayRet, turnover: daily.get(code).turnover });
  }
  if (++done % 100 === 0) console.log(`  ${done}/${daily.size} (실패 ${fail}, 적합 ${hits.length})`);
}
console.log(`조회 완료 ${done}종목 / 실패 ${fail} → 조건 충족 ${hits.length}종목\n`);

hits.sort((a, b) => b.bounce - a.bounce);
console.log(`=== 노타형 바닥반등: 저점이 ${LOWDAYS}일 내 · 반등 ≥${GAIN}% · 120일고가 대비 ≤${(HIPROX * 100).toFixed(0)}% · 거래량 ≥${VOL}x ===`);
console.log('종목                        현재가     저점(날짜)        반등    경과  120고가비  거래량   당일비   MA20');
for (const h of hits) {
  console.log(`${nm(h.code).padEnd(24)} ${h.px.toLocaleString().padStart(9)}  ${h.lo.toLocaleString().padStart(8)}(${h.loDate.slice(4)})  ${('+' + h.bounce.toFixed(1) + '%').padStart(7)}  ${h.daysSinceLow}일  ${(h.hiProx * 100).toFixed(1).padStart(6)}%  ${h.volRatio.toFixed(2).padStart(5)}x  ${((h.dayRet >= 0 ? '+' : '') + h.dayRet.toFixed(1) + '%').padStart(6)}  ${h.aboveMa20 ? '위' : '아래'}`);
}
if (!hits.length) { console.log('  (해당 없음)'); process.exit(0); }

// ── 공통점 분석 ──────────────────────────────────────────────────────────────
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('\n=== 공통점 ===');
console.log(`반등률      평균 +${avg(hits.map(h => h.bounce)).toFixed(1)}%  중위 +${med(hits.map(h => h.bounce)).toFixed(1)}%`);
console.log(`120고가비   평균 ${(avg(hits.map(h => h.hiProx)) * 100).toFixed(1)}%  → 고점 대비 평균 ${(100 - avg(hits.map(h => h.hiProx)) * 100).toFixed(1)}% 하락 상태`);
console.log(`거래량비    평균 ${avg(hits.map(h => h.volRatio)).toFixed(2)}x  중위 ${med(hits.map(h => h.volRatio)).toFixed(2)}x`);
console.log(`저점 경과   평균 ${avg(hits.map(h => h.daysSinceLow)).toFixed(1)}일  | MA20 위 ${hits.filter(h => h.aboveMa20).length}/${hits.length}종목`);
console.log(`거래대금    중위 ${Math.round(med(hits.map(h => h.turnover)) / 1e8).toLocaleString()}억`);
const loDates = {};
for (const h of hits) loDates[h.loDate] = (loDates[h.loDate] ?? 0) + 1;
console.log(`저점 날짜 분포: ${Object.entries(loDates).sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => `${d.slice(4)} ${c}종목`).join(' · ')}`);

// 수급 (전일까지 확정분, 최근 5일 기관+외국인 누적)
try {
  const codes = hits.map(h => `'${h.code}'`).join(',');
  const fl = await dbQuery(`SELECT stock_code, SUM(net) total FROM (
      SELECT stock_code, (COALESCE(orgn_amt_mil,0)+COALESCE(frgn_amt_mil,0)) net,
             ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) rn
      FROM stock_investor_flows WHERE stock_code IN (${codes})) t
    WHERE rn <= 5 GROUP BY stock_code`);
  const m = new Map(fl.map(r => [r.stock_code, Number(r.total) / 100]));
  const vals = hits.map(h => m.get(h.code)).filter(v => v != null);
  console.log(`\n수급(기관+외국인 5일 누적, 확정분 ${vals.length}/${hits.length}종목): 순매수 ${vals.filter(v => v > 0).length}종목 · 순매도 ${vals.filter(v => v <= 0).length}종목 · 중위 ${med(vals).toFixed(0)}억`);
  for (const h of hits) { const v = m.get(h.code); if (v != null) console.log(`   ${nm(h.code).padEnd(24)} ${v >= 0 ? '+' : ''}${v.toFixed(0)}억`); }
} catch (e) { console.log(`\n수급 조회 실패: ${String(e.message).slice(0, 60)}`); }
