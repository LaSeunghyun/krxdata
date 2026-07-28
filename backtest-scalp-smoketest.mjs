/**
 * backtest-scalp-smoketest.mjs — m4markets 스캘핑 가이드(VWAP+EMA9/21 크로스, R:R 1.5~2, 5~10분 보유) 소규모 스모크테스트.
 *   2026-07-24: 토스 1분봉이 실측 ~8거래일까지만 제공돼 진짜 백테스트는 불가 — 방향성만 확인하는 용도.
 *   호가창(Level2) 조건은 데이터 없어 제외(VWAP+EMA만으로 진입).
 */
import { readFileSync } from 'fs';
import { calcRoundTripPnl, DEFAULT_FEE_BPS, getSellTaxBps } from './execution-model.mjs';

const FEE_BPS = DEFAULT_FEE_BPS, TAX_BPS = getSellTaxBps('KOSPI');
const STOP_PCT = 0.4;      // 진입가 대비 손절 -0.4% (스캘핑 타이트 스탑 가정)
const RR = 1.75;           // 기사 권장 1:1.5~1:2 중간값 → 목표 +0.7%
const TARGET_PCT = STOP_PCT * RR;
const MAX_HOLD_MIN = 10;   // 기사 권장 보유시간 상한

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function dayKey(ts) { return ts.slice(0, 10); }

function simulateStock(name, bars) {
  const cd = [...bars].reverse(); // 최신순 → 시간순
  const close = cd.map(b => b.close), vol = cd.map(b => b.volume);
  const ema9 = ema(close, 9), ema21 = ema(close, 21);

  // 일별 VWAP(누적 price*vol/vol, 거래일 바뀌면 리셋)
  const vwap = new Array(cd.length).fill(null);
  let cumPV = 0, cumV = 0, curDay = null;
  for (let i = 0; i < cd.length; i++) {
    const dk = dayKey(cd[i].timestamp);
    if (dk !== curDay) { curDay = dk; cumPV = 0; cumV = 0; }
    const typical = (cd[i].high + cd[i].low + cd[i].close) / 3;
    cumPV += typical * vol[i]; cumV += vol[i];
    vwap[i] = cumV > 0 ? cumPV / cumV : close[i];
  }

  const trades = [];
  let i = 21; // EMA21 워밍업 이후부터
  while (i < cd.length - 1) {
    const crossUp = ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i];
    const aboveVwap = close[i] > vwap[i];
    if (crossUp && aboveVwap && dayKey(cd[i].timestamp) === dayKey(cd[i + 1].timestamp)) {
      const entry = cd[i + 1].open; // 신호 확정 다음봉 시가 진입(lookahead 방지)
      const stopPx = entry * (1 - STOP_PCT / 100);
      const tgtPx = entry * (1 + TARGET_PCT / 100);
      let exitPx = null, reason = null, holdMin = 0;
      for (let j = i + 1; j < cd.length && j <= i + 1 + MAX_HOLD_MIN; j++) {
        if (dayKey(cd[j].timestamp) !== dayKey(cd[i + 1].timestamp)) { exitPx = cd[j - 1].close; reason = 'day_end'; holdMin = j - 1 - i; break; }
        if (cd[j].low <= stopPx) { exitPx = stopPx; reason = 'stop'; holdMin = j - i; break; }
        if (cd[j].high >= tgtPx) { exitPx = tgtPx; reason = 'target'; holdMin = j - i; break; }
        if (j === i + 1 + MAX_HOLD_MIN) { exitPx = cd[j].close; reason = 'timeout'; holdMin = j - i; }
      }
      if (exitPx != null) {
        const pnl = calcRoundTripPnl({ entry, exit: exitPx, qty: 1, feeBps: FEE_BPS, taxBps: TAX_BPS });
        const retPct = (pnl / entry) * 100;
        trades.push({ name, entryTs: cd[i + 1].timestamp, entry, exitPx, reason, holdMin, retPct });
        i = i + 1 + holdMin; // 청산 시점 이후로 재개(중복 진입 방지)
        continue;
      }
    }
    i++;
  }
  return trades;
}

const data = JSON.parse(readFileSync('./candles-1m-smoketest.json', 'utf8'));
let all = [];
for (const { name, bars } of data) all = all.concat(simulateStock(name, bars));

console.log(`=== 스캘핑 스모크테스트 (VWAP+EMA9/21 크로스, 손절-${STOP_PCT}%/목표+${TARGET_PCT.toFixed(2)}%, 최대${MAX_HOLD_MIN}분) ===`);
console.log(`데이터: 토스 1분봉 실측 가용범위(~8거래일) 중 ${data.length}종목, 스모크테스트 — 표본 극소, 방향성 참고용\n`);

if (!all.length) {
  console.log('진입 신호 0건 (크로스+VWAP 조건을 만족한 시그널이 이 표본기간엔 없었음)');
} else {
  const wins = all.filter(t => t.retPct > 0);
  const winRate = wins.length / all.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.retPct, 0) / wins.length : 0;
  const losses = all.filter(t => t.retPct <= 0);
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.retPct, 0) / losses.length : 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  const pf = losses.length ? Math.abs(wins.reduce((s, t) => s + t.retPct, 0) / losses.reduce((s, t) => s + t.retPct, 0)) : Infinity;

  console.log(`체결 ${all.length}건 | 승률 ${(winRate * 100).toFixed(1)}% | PF ${pf.toFixed(2)} | 평균수익 +${avgWin.toFixed(2)}% | 평균손실 ${avgLoss.toFixed(2)}% | 기댓값/거래 ${expectancy.toFixed(3)}%`);
  console.log(`청산사유: target ${all.filter(t=>t.reason==='target').length} / stop ${all.filter(t=>t.reason==='stop').length} / timeout ${all.filter(t=>t.reason==='timeout').length} / day_end ${all.filter(t=>t.reason==='day_end').length}`);
  console.log('\n종목별:');
  for (const nm of [...new Set(all.map(t => t.name))]) {
    const ts = all.filter(t => t.name === nm);
    const w = ts.filter(t => t.retPct > 0).length;
    console.log(`  ${nm}: ${ts.length}건, 승률 ${(w / ts.length * 100).toFixed(0)}%, 합계 ${ts.reduce((s,t)=>s+t.retPct,0).toFixed(2)}%`);
  }
}
