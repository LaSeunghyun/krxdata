/**
 * backtest-shareholder-return.mjs — 주주환원형 공시(자사주취득·현금배당·자사주소각·기업가치제고) 드리프트 전략
 *   포지션사이징+실비용 백테스트 (2026-07-24, PEAD 스크리닝 후속).
 *   수주계약(알파 노이즈 확인됨)·무상증자(초소표본 n=10) 제외.
 *
 * ⚠ 정직한 한계: 공시 데이터가 3개월(고유일자 41개)뿐 — combo-v2급 MC강건성 검증 불가능한 수준.
 *   방향성 참고용. slots/stop/hold 소규모 스윕은 하되, 콤보처럼 몇년치 몬테카를로는 못 함.
 *
 * 실행: node backtest-shareholder-return.mjs [--slots 8] [--stop 10] [--hold 20]
 */
import 'dotenv/config';
import readline from 'readline';
import { createReadStream } from 'fs';
import { classifyDisclosure } from './ai-events.mjs';
import { calcRoundTripPnl, calcBuyCashImpact, calcSellCashImpact, DEFAULT_FEE_BPS, getSellTaxBps } from './execution-model.mjs';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const SLOTS = argOf('--slots', 8);
const STOP_PCT = argOf('--stop', 10);
const HOLD_DAYS = argOf('--hold', 20);
const CAPITAL = 10_000_000;
const FEE_BPS = DEFAULT_FEE_BPS, TAX_BPS = getSellTaxBps('KOSPI');
const TARGET_TYPES = new Set(['자사주취득', '현금배당', '자사주소각', '기업가치제고']);
const MIN_TURNOVER = 3e9, MIN_PRICE = 2000;

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  return r.json();
};

console.log('일봉 캐시 로드 중...');
const priceMap = new Map();
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: createReadStream('./candles-daily.jsonl') });
  rl.on('line', (line) => { if (!line.trim()) return; const o = JSON.parse(line); priceMap.set(o.code, { d: o.d, o: o.o, h: o.h, l: o.l, c: o.c }); });
  rl.on('close', resolve);
});
console.log(`${priceMap.size}종목 로드 완료`);

const liq = await dbQuery(`SELECT stock_code, avg_turnover_20d FROM stock_analysis WHERE current_price>=${MIN_PRICE} AND avg_turnover_20d>=${MIN_TURNOVER}`);
const liquidSet = new Set(liq.map(r => r.stock_code));
console.log(`유동성 필터 통과 ${liquidSet.size}종목`);

const disc = await dbQuery(`SELECT stock_code, rcept_dt, report_nm FROM stock_disclosures ORDER BY rcept_dt, stock_code`);

// 이벤트 추출: 종목별 최근 이벤트만(같은 종목 며칠 내 중복공시는 첫 신호만 사용, 재진입 방지는 시뮬레이션 단계에서 처리)
const events = [];
for (const row of disc) {
  const c = classifyDisclosure(row.report_nm);
  if (!c.catalytic || c.polarity !== 'positive' || !TARGET_TYPES.has(c.type)) continue;
  if (!liquidSet.has(row.stock_code)) continue;
  const p = priceMap.get(row.stock_code);
  if (!p) continue;
  const eventDate = row.rcept_dt.replace(/-/g, '');
  let lo = 0, hi = p.d.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (p.d[mid] > eventDate) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  const i0 = ans;
  if (i0 < 0) continue;
  events.push({ code: row.stock_code, type: c.type, entryIdx: i0, entryDate: p.d[i0] });
}
console.log(`후보 이벤트 ${events.length}건 (유동성+유형 필터 후)`);

// 종목별로 entryDate 기준 dedupe(같은 종목 30일 내 중복 이벤트는 첫 신호만)
events.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
const lastEntryByCode = new Map();
const dedup = [];
for (const e of events) {
  const last = lastEntryByCode.get(e.code);
  if (last && e.entryIdx - last < 30) continue;
  dedup.push(e);
  lastEntryByCode.set(e.code, e.entryIdx);
}
console.log(`중복제거 후 ${dedup.length}건`);

// 날짜순 이벤트 큐 → slots 기반 포지션 시뮬레이션(균등분산, equity 재투자)
const byDate = new Map();
for (const e of dedup) { if (!byDate.has(e.entryDate)) byDate.set(e.entryDate, []); byDate.get(e.entryDate).push(e); }
// 거래일 타임라인은 대표종목(삼성전자) 캘린더 기준, 첫 이벤트~마지막 이벤트+보유기간 버퍼로 한정
// (버그수정: 이전엔 dedup 종목들의 전체 히스토리(2021~) 유니온을 써서 CAGR 연환산 분모가 4.8년으로 뻥튀기됐었음)
const masterCal = priceMap.get('005930').d;
const firstEventDate = dedup.reduce((m, e) => e.entryDate < m ? e.entryDate : m, dedup[0].entryDate);
const lastEventDate = dedup.reduce((m, e) => e.entryDate > m ? e.entryDate : m, dedup[0].entryDate);
const startIdx = masterCal.indexOf(firstEventDate);
let endIdx = masterCal.indexOf(lastEventDate) + HOLD_DAYS + 5;
endIdx = Math.min(endIdx, masterCal.length - 1);
const allDates = masterCal.slice(startIdx, endIdx + 1);

let cash = CAPITAL;
const positions = []; // { code, entry, qty, entryIdx }
const trades = [];
const equityCurve = [];
let peakEquity = CAPITAL, maxDD = 0;

for (const date of allDates) {
  // ① 청산 체크 (보유중 각 포지션)
  for (let pi = positions.length - 1; pi >= 0; pi--) {
    const pos = positions[pi];
    const p = priceMap.get(pos.code);
    const idx = p.d.indexOf(date);
    if (idx < 0 || idx <= pos.entryIdx) continue;
    const heldDays = idx - pos.entryIdx;
    const px = p.c[idx], lo = p.l[idx];
    const stopPx = pos.entry * (1 - STOP_PCT / 100);
    let exitPx = null, reason = null;
    if (lo <= stopPx) { exitPx = stopPx; reason = 'stop'; }
    else if (heldDays >= HOLD_DAYS) { exitPx = px; reason = 'timeout'; }
    if (exitPx != null) {
      const pnl = calcRoundTripPnl({ entry: pos.entry, exit: exitPx, qty: pos.qty, feeBps: FEE_BPS, taxBps: TAX_BPS });
      cash += calcSellCashImpact({ fill: exitPx, qty: pos.qty, feeBps: FEE_BPS, taxBps: TAX_BPS });
      trades.push({ code: pos.code, entry: pos.entry, exit: exitPx, reason, heldDays, retPct: (pnl / (pos.entry * pos.qty)) * 100 });
      positions.splice(pi, 1);
    }
  }
  // ② 신규 진입 (이 날짜에 이벤트 있고 슬롯 여유 있으면)
  const todays = byDate.get(date) || [];
  for (const e of todays) {
    if (positions.length >= SLOTS) break;
    if (positions.some(p => p.code === e.code)) continue;
    const p = priceMap.get(e.code);
    const idx = p.d.indexOf(date);
    if (idx !== e.entryIdx) continue; // 안전장치
    const entryPx = p.o[idx];
    if (!entryPx || entryPx <= 0) continue;
    const equity = cash + positions.reduce((s, pp) => { const pd = priceMap.get(pp.code); const ci = pd.d.indexOf(date); return s + (ci >= 0 ? pp.qty * pd.c[ci] : pp.qty * pp.entry); }, 0);
    const budget = Math.min(cash, equity / SLOTS);
    const qty = Math.floor(budget / entryPx);
    if (qty < 1) continue;
    const cost = calcBuyCashImpact({ fill: entryPx, qty, feeBps: FEE_BPS });
    if (cost > cash) continue;
    cash -= cost;
    positions.push({ code: e.code, entry: entryPx, qty, entryIdx: idx });
  }
  // ③ 자산곡선 기록
  const posVal = positions.reduce((s, pp) => { const pd = priceMap.get(pp.code); const ci = pd.d.indexOf(date); return s + (ci >= 0 ? pp.qty * pd.c[ci] : pp.qty * pp.entry); }, 0);
  const eq = cash + posVal;
  peakEquity = Math.max(peakEquity, eq);
  maxDD = Math.max(maxDD, (peakEquity - eq) / peakEquity * 100);
  equityCurve.push({ date, eq });
}

const finalEq = equityCurve[equityCurve.length - 1]?.eq ?? CAPITAL;
const years = (new Date(allDates[allDates.length-1].replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')) - new Date(allDates[0].replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3'))) / (365*86400000);
const cagr = years > 0 ? (Math.pow(finalEq / CAPITAL, 1/years) - 1) * 100 : null;

console.log(`\n=== 주주환원 드리프트 백테스트 (slots=${SLOTS}, stop=-${STOP_PCT}%, hold=${HOLD_DAYS}일) ===`);
console.log(`기간: ${allDates[0]} ~ ${allDates[allDates.length-1]} (${years.toFixed(2)}년)`);
console.log(`체결 ${trades.length}건 | 최종자본 ${finalEq.toLocaleString()}원 | CAGR ${cagr?.toFixed(1)}% | MDD ${maxDD.toFixed(1)}%`);
if (trades.length) {
  const wins = trades.filter(t => t.retPct > 0);
  console.log(`승률 ${(wins.length/trades.length*100).toFixed(1)}% | 청산: stop ${trades.filter(t=>t.reason==='stop').length} / timeout ${trades.filter(t=>t.reason==='timeout').length}`);
  console.log(`평균수익 ${(trades.reduce((s,t)=>s+t.retPct,0)/trades.length).toFixed(2)}%/거래`);
}
console.log(`\n⚠ 3개월치 데이터(고유일자~41개) — MC강건성 검증 불가, 방향성 참고용`);
