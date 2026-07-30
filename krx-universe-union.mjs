/**
 * krx-universe-union.mjs — KRX 재검증에 필요한 종목 집합을 정확히 산출 (2026-07-30)
 *
 * 2,605종목 전부 수집하면 ~113분이다. 백테가 실제로 만지는 종목만 뽑으면 그 일부다.
 * backtest-swing.mjs 의 유니버스 로직을 그대로 재현해 **주간 top-N의 합집합**을 구한다:
 *   · rsi2  : largeCaps = stock_analysis 현재시총 상위 RSI_UNI(30) — 정적 리스트
 *   · hi120 : mcapUniverse(day, LIVE_UNI=420) = sharesEst(정적 주식수) × 당일종가 상위 420,
 *             단 20일 평균거래대금 >= MIN_TURNOVER 통과분. 주간 캐시(weekKey).
 *
 * 출력: krx-universe-union.json  { rsi2:[...], hi120:[...], union:[...] }
 *
 * ※ 이 유니버스 자체에 lookahead 결함이 있다(정적 주식수·현재시총 기준 — backtest-swing.mjs:445~448
 *   에 이미 기록됨). 여기서 고치지 않는다. KRX 재검증의 목적은 **종가 소스만 바꿔 같은 조건으로 비교**하는
 *   것이므로, 유니버스 정의를 동시에 바꾸면 원인이 섞여 비교가 불가능해진다.
 */
import 'dotenv/config';
import { createReadStream, writeFileSync } from 'fs';
import readline from 'readline';

const MIN_PRICE = 1_000;
const MIN_TURNOVER = 3_000_000_000;   // 일평균 거래대금 30억 (strategy-contract 하드필터와 동일)
const LIVE_UNI = 420;
const RSI_UNI = 30;
const FROM = '20230102';

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── 1) 정적 메타 ─────────────────────────────────────────────────────────────
const allRows = await dbQuery(`SELECT stock_code, current_price, market_cap_tril, avg_turnover_20d FROM stock_analysis WHERE current_price > 0`);
const sharesEst = new Map();
for (const r of allRows) {
  const sh = (Number(r.market_cap_tril) * 1e12) / Number(r.current_price);
  if (Number.isFinite(sh) && sh > 0) sharesEst.set(r.stock_code, sh);
}
const rsi2Set = new Set();
for (const minPx of [1_000, 2_000]) {
  for (const r of await dbQuery(
    `SELECT stock_code FROM stock_analysis WHERE current_price >= ${minPx} AND avg_turnover_20d >= ${MIN_TURNOVER} ORDER BY market_cap_tril DESC LIMIT ${RSI_UNI}`
  )) rsi2Set.add(r.stock_code);
}
const rsi2Uni = [...rsi2Set];
console.log(`stock_analysis ${allRows.length}행 · sharesEst ${sharesEst.size}종목 · rsi2 유니버스 ${rsi2Uni.length}종목`);

// ── 2) Toss 일봉 로드 (유니버스 판정에만 사용 — 종가 소스 교체와 무관) ─────────
const candles = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => {
    try {
      const j = JSON.parse(l);
      if (!j?.code || !Array.isArray(j.d)) return;
      if (!sharesEst.has(j.code)) return;                 // 시총 산출 불가 종목은 mcapUniverse가 스킵
      candles.set(j.code, j);
    } catch {}
  });
  rl.on('close', res);
});
console.log(`일봉 로드 ${candles.size}종목 (sharesEst 보유분만)`);

// ── 3) 주간 top-420 합집합 ────────────────────────────────────────────────────
const lastIndexBefore = (cd, day) => { let lo = 0, hi = cd.d.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (String(cd.d[m]) <= day) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
const weekKey = (day) => { const d = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };

// 전체 거래일 = 어느 종목이든 등장하는 날짜의 합집합
const allDays = [...new Set([...candles.values()].flatMap(j => j.d.map(String)))].filter(d => d >= FROM).sort();
console.log(`거래일 ${allDays.length}일 · ${allDays[0]} ~ ${allDays.at(-1)}`);

// MIN_PRICE는 backtest-swing.mjs가 2000, strategy-contract 계열이 1000을 쓴다. 컷이 달라지면
// top-420 편입 종목도 달라지므로(싼 종목을 빼면 다른 종목이 들어온다) **두 설정의 합집합**을 취한다.
// 과수집은 무해하고 누락은 치명적이다.
const hi120Uni = new Set();
let weeks = 0;
for (const minPx of [1_000, 2_000]) {
  const seenWeek = new Set();
  for (const day of allDays) {
    const wk = weekKey(day);
    if (seenWeek.has(wk)) continue;                        // mcapUniverse는 주간 캐시 = 주당 1회만 산출
    seenWeek.add(wk);
    if (minPx === 1_000) weeks++;
    const scored = [];
    for (const [code, cd] of candles) {
      const i = lastIndexBefore(cd, day);
      if (i < 20 || cd.c[i] < minPx) continue;
      let turnover = 0;
      for (let j = i - 19; j <= i; j++) turnover += cd.c[j] * cd.v[j];
      if (turnover / 20 < MIN_TURNOVER) continue;
      scored.push({ code, mcap: sharesEst.get(code) * cd.c[i] });
    }
    scored.sort((a, b) => b.mcap - a.mcap);
    for (const s of scored.slice(0, LIVE_UNI)) hi120Uni.add(s.code);
  }
}

const union = [...new Set([...rsi2Uni, ...hi120Uni])].sort();
console.log(`\n주 ${weeks}개 산출 · hi120 합집합 ${hi120Uni.size}종목 · rsi2 ${rsi2Uni.length}종목`);
console.log(`**최종 합집합 ${union.length}종목** (전체 ${candles.size} 중 ${(union.length / candles.size * 100).toFixed(1)}%)`);
console.log(`예상 수집시간: ${union.length}종목 × 2.6초 = 약 ${Math.round(union.length * 2.6 / 60)}분 (직렬), 병렬3이면 약 ${Math.round(union.length * 2.6 / 60 / 3)}분`);

writeFileSync('krx-universe-union.json', JSON.stringify({
  builtAt: allDays.at(-1), from: FROM, liveUni: LIVE_UNI, rsiUni: RSI_UNI,
  minPrice: MIN_PRICE, minTurnover: MIN_TURNOVER,
  rsi2: rsi2Uni, hi120: [...hi120Uni].sort(), union,
}, null, 1));
console.log(`→ krx-universe-union.json 기록`);
