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

/**
 * 후보 리스트를 슬롯 예산(floor(equity/slots)) 단위로 배분. 총 보유 slots개 상한.
 * 각 종목 살 수 있는 만큼(슬롯예산×atrMult & cashAvailable 클램프). 못 사면 다음 후보.
 * backtest closePhase 신규진입(슬롯별 floor(equity/slots), atrMult 곱)과 동일 원리.
 * @returns {Array<{code,name,qty,price}>}
 */
export function allocateSlots(candidates, heldSlots, slots, equity, cashAvailable) {
  const slotBudget = Math.floor(equity / slots);
  const out = [];
  let cash = cashAvailable;
  let held = heldSlots;
  for (const c of candidates ?? []) {
    if (held >= slots) break;
    const budget = Math.min(slotBudget * (c.atrMult ?? 1), cash);
    const qty = Math.floor(budget / (c.price * 1.01));
    if (qty < 1) continue;
    out.push({ code: c.code, name: c.name, qty, price: c.price });
    cash -= qty * c.price * 1.01;
    held++;
  }
  return out;
}
