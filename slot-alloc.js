// slot-alloc.js — 순수 함수. 라이브 슬롯 배분/후보 선정. 부작용 없음(테스트 가능).

/**
 * momUniverse 우선순위 순 hi120 시그널 배열에서 badCodes 제외, 상위 maxN개 반환.
 * @param {Array} rankedSignals - [{code,name,close,atrMult,breakoutPct}] (이미 hi120 통과, 우선순위 순)
 * @param {Set|Array} badCodes - 악재 공시 제외 종목
 * @param {number} maxN - 후보 리스트 최대 길이
 */
export function pickBuyCandidates(rankedSignals, badCodes, maxN) {
  const bad = badCodes instanceof Set ? badCodes : new Set(badCodes ?? []);
  const out = [];
  for (const s of rankedSignals ?? []) {
    if (bad.has(s.code)) continue;
    out.push(s);
    if (out.length >= maxN) break;
  }
  return out;
}
