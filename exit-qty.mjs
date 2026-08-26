/**
 * exit-qty.mjs — 예약청산 매도수량 산정.
 *
 * 배경(2026-08-26): 예약청산이 브로커 보유수량을 실시간으로 읽어(`qty = Number(it.quantity)`)
 *   예약 생성 후 사용자가 산 물량까지 팔았다. 08:00 에 326주 예약 중 147주가 체결됐고,
 *   사용자가 08:02~08:06 에 143주를 재매수했는데 08:06 집행이 **322주 전량**을 던졌다.
 *   예약은 만들어진 시점의 수량에 묶여야 한다.
 */

/**
 * @returns {{sellQty:number, base:number, release:boolean}}
 *   base    = 이번 집행의 상한(= min(브로커 보유, 예약 잔량)). 부분익절 판정도 이 값 기준이다.
 *   release = 팔 수 있는 예약분이 없다 → 호출부가 예약 자체를 해제해야 한다.
 */
export function plannedSellQty({ brokerQty, exitQty, frac }) {
  const bk = Number(brokerQty);
  const cap = Number.isFinite(Number(exitQty)) ? Number(exitQty) : bk;
  const base = Math.min(Number.isFinite(bk) ? bk : 0, Number.isFinite(cap) ? cap : 0);
  // ★ base<=0 분기가 없으면 아래 Math.max(1, ...) 가 **1주를 판다.** 예약이 소진됐는데
  //   사용자가 새로 사서 보유가 다시 0보다 커진 경우가 정확히 그렇다(사고의 축소판).
  if (!(base > 0)) return { sellQty: 0, base: 0, release: true };
  const f = Number(frac ?? 1);
  const sellQty = f >= 1 ? base : Math.max(1, Math.floor(base * f));
  return { sellQty, base, release: false };
}
