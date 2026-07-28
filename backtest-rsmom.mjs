/**
 * backtest-rsmom.mjs — 상대강도(RS) 랭킹 모멘텀 독립 백테스터 (2026-07-25).
 *   목적: "rsi2(역추세)도 hi120(즉시돌파)도 틀렸다면?" 전제의 제3 방향 검증.
 *   기존 swing-mom(ret60 top10·스톱-25%·21일보유)은 froth-chasing으로 CAGR -50% 참패 → 개념 재구현.
 *
 * 설계(의도적으로 combo-v2와 다르게):
 *   - 랭킹: 12-1 모멘텀(lookback 기간 수익률에서 최근 skip일 제외) — 단기 반전 회피, 학계 표준
 *   - riskadj: 모멘텀/변동성(일간 수익률 표준편차)으로 위험조정 랭킹 옵션
 *   - 보유: 상위 top개, rebal일마다 리밸런싱(돌파 타이밍에 의존 안 함)
 *   - 게이트: 개별 종목이 자기 MA(matrend일) 위일 때만 보유(추세 이탈 시 현금)
 *   - 청산: 리밸런싱 탈락 / MA 이탈 / 트레일(옵션). 극단 스톱(-25%) 안 씀
 *   - 비용/체결: 메인 엔진과 동일(수수료 1.5bp×2 + 매도세 20bp + 1틱 슬리피지, 종가 체결)
 *   - PIT: day t 판정은 t까지의 봉만 사용
 *
 * 실행: node backtest-rsmom.mjs [--top 5] [--rebal 20] [--lookback 120] [--skip 20]
 *                              [--riskadj] [--matrend 60] [--trail 0] [--uni 420]
 *                              [--subsample 0.8 --seed N]
 */
import { createReadStream } from 'fs';
import readline from 'readline';
import { calcBuyCashImpact, calcSellCashImpact, DEFAULT_FEE_BPS, getSellTaxBps } from './execution-model.mjs';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TOP = Number(argOf('--top', 5));
const REBAL = Number(argOf('--rebal', 20));
const LOOKBACK = Number(argOf('--lookback', 120));
const SKIP = Number(argOf('--skip', 20));
const RISKADJ = argv.includes('--riskadj');
const MATREND = Number(argOf('--matrend', 60));
const TRAIL = Number(argOf('--trail', 0));
const UNI = Number(argOf('--uni', 420));
const SUBSAMPLE = Number(argOf('--subsample', 1));
const SEED = Number(argOf('--seed', 0));
const FROM = argOf('--from', '20230102'), TO = argOf('--to', '20260611');
const CAPITAL = Number(argOf('--capital', 10_000_000));
const MIN_PRICE = 2000, MIN_TURNOVER = 3e9;
const FEE = DEFAULT_FEE_BPS, TAX = getSellTaxBps('KOSPI');

const tickSize = (p) => p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
const tickUp = (p) => Math.round(p / tickSize(p)) * tickSize(p) + tickSize(p);
const tickDn = (p) => Math.round(p / tickSize(p)) * tickSize(p) - tickSize(p);

// 결정론적 PRNG(시드) — 메인 엔진 MC와 동일한 취지(유니버스 무작위 표본)
let _s = SEED || 1;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };

const P = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('./candles-daily.jsonl') });
  rl.on('line', (l) => { if (!l.trim()) return; const o = JSON.parse(l); P.set(o.code, o); });
  rl.on('close', res);
});

// MC 서브샘플: 종목 일부 제외
let codes = [...P.keys()];
if (SUBSAMPLE < 1) {
  const keep = codes.filter(() => rnd() < SUBSAMPLE);
  const dropped = codes.length - keep.length;
  codes = keep;
  console.log(`[MC] seed=${SEED} subsample=${SUBSAMPLE} — ${dropped}종목 제외`);
}
const pool = new Map(codes.map(c => [c, P.get(c)]));

// 거래일 캘린더(삼성전자 기준)
const cal = P.get('005930').d.filter(d => d >= FROM && d <= TO);
const idxOf = (o, day) => o.d.indexOf(day);
const lastIdxBefore = (o, day) => { let lo = 0, hi = o.d.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (o.d[m] <= day) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };

/** day 시점 랭킹(PIT): 유동성 필터 → 12-1 모멘텀(옵션 위험조정) 내림차순 */
function rank(day) {
  const rows = [];
  for (const [code, o] of pool) {
    const i = lastIdxBefore(o, day);
    if (i < LOOKBACK + 5) continue;
    if (o.c[i] < MIN_PRICE) continue;
    let to = 0; for (let j = i - 19; j <= i; j++) to += o.c[j] * o.v[j];
    to /= 20;
    if (to < MIN_TURNOVER) continue;
    const past = o.c[i - LOOKBACK], recent = o.c[i - SKIP];
    if (!past || !recent) continue;
    let score = (recent / past - 1) * 100;   // 12-1: 최근 SKIP일 제외 구간 수익률
    if (RISKADJ) {
      let s = 0, n = 0;
      for (let j = i - 59; j <= i; j++) { if (j < 1) continue; const r = o.c[j] / o.c[j - 1] - 1; s += r * r; n++; }
      const vol = n ? Math.sqrt(s / n) * 100 : 0;
      score = vol > 0 ? score / vol : 0;
    }
    rows.push({ code, score, to });
  }
  rows.sort((a, b) => b.to - a.to);
  const univ = rows.slice(0, UNI);            // 유동성 상위 UNI개로 유니버스 한정
  univ.sort((a, b) => b.score - a.score);
  return univ;
}

/** 종목이 자기 MA 위인가(추세 유지) */
function aboveMA(o, i, n) {
  if (!n) return true;
  if (i < n) return false;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += o.c[j];
  return o.c[i] > s / n;
}

let cash = CAPITAL;
const pos = new Map(); // code -> {qty, entry, hi}
const trades = [];
const eqCurve = [];
let peak = CAPITAL, mdd = 0;

const equity = (day) => {
  let v = cash;
  for (const [code, p] of pos) { const o = pool.get(code); const i = lastIdxBefore(o, day); v += p.qty * (i >= 0 ? o.c[i] : p.entry); }
  return v;
};
const sell = (day, code, px, reason) => {
  const p = pos.get(code); if (!p) return;
  const fill = tickDn(px);
  cash += calcSellCashImpact({ fill, qty: p.qty, feeBps: FEE, taxBps: TAX });
  trades.push({ code, entry: p.entry, exit: fill, reason, retPct: (fill / p.entry - 1) * 100 });
  pos.delete(code);
};

for (let di = 0; di < cal.length; di++) {
  const day = cal[di];

  // ① 보유 관리 — MA 이탈 / 트레일
  for (const [code, p] of [...pos]) {
    const o = pool.get(code); const i = idxOf(o, day);
    if (i < 0) continue;
    p.hi = Math.max(p.hi, o.c[i]);
    if (TRAIL > 0 && o.c[i] <= p.hi * (1 - TRAIL / 100)) { sell(day, code, o.c[i], 'trail'); continue; }
    if (MATREND > 0 && !aboveMA(o, i, MATREND)) { sell(day, code, o.c[i], 'ma_break'); continue; }
  }

  // ② 리밸런싱(REBAL일마다)
  if (di % REBAL === 0) {
    const r = rank(day);
    const top = r.slice(0, TOP).map(x => x.code);
    const keep = new Set(r.slice(0, TOP * 2).map(x => x.code)); // 상위 2배수까진 유지(회전율 억제)
    for (const [code] of [...pos]) {
      if (keep.has(code)) continue;
      const o = pool.get(code); const i = idxOf(o, day);
      if (i >= 0) sell(day, code, o.c[i], 'rebalance');
    }
    for (const code of top) {
      if (pos.has(code) || pos.size >= TOP) continue;
      const o = pool.get(code); const i = idxOf(o, day);
      if (i < 0) continue;
      if (!aboveMA(o, i, MATREND)) continue;           // 추세 게이트
      const budget = Math.min(cash, Math.floor(equity(day) / TOP));
      const fill = tickUp(o.c[i]);
      const qty = Math.floor(budget / (fill * (1 + FEE / 10_000)));
      if (qty < 1) continue;
      const cost = calcBuyCashImpact({ fill, qty, feeBps: FEE });
      if (cost > cash) continue;
      cash -= cost;
      pos.set(code, { qty, entry: fill, hi: fill });
    }
  }

  const eq = equity(day);
  peak = Math.max(peak, eq);
  mdd = Math.max(mdd, (peak - eq) / peak * 100);
  eqCurve.push(eq);
}

const finalEq = eqCurve[eqCurve.length - 1];
const years = cal.length / 246;
const cagr = (Math.pow(finalEq / CAPITAL, 1 / years) - 1) * 100;
const wins = trades.filter(t => t.retPct > 0);
const gp = wins.reduce((s, t) => s + t.retPct, 0), gl = Math.abs(trades.filter(t => t.retPct <= 0).reduce((s, t) => s + t.retPct, 0));

console.log(`rsmom  top${TOP} rebal${REBAL} lb${LOOKBACK} skip${SKIP}${RISKADJ ? ' riskadj' : ''} ma${MATREND} trail${TRAIL} uni${UNI}`);
console.log(`  체결 ${trades.length} | 승률 ${(wins.length / (trades.length || 1) * 100).toFixed(0)}% | PF ${gl > 0 ? (gp / gl).toFixed(2) : '-'} | CAGR ${cagr.toFixed(1)}% | MDD ${mdd.toFixed(1)}% | 최종 ${Math.round(finalEq).toLocaleString()}원`);
console.log(`  청산: ${['rebalance','ma_break','trail'].map(r => `${r} ${trades.filter(t=>t.reason===r).length}`).join(' / ')}`);
