/**
 * market-day.mjs — 오늘(KST)이 한국 증시 거래일인지 판정하는 공용 헬퍼.
 *
 * 배경(2026-08-16): 주말·공휴일에도 텔레그램 발송이 계속돼 사용자가 "장이 없는 날은 보내지 마라"
 * 요청. 원인은 두 갈래였다 —
 *   ① forecast-run 의 캘린더 파서가 배열을 기대하는데 Toss `getKrMarketCalendar()` 는
 *      `{today, previousBusinessDay, nextBusinessDay}` **객체**를 반환 → 휴장 체크가 사상 0회 발화.
 *   ② push-candidates·validate-hypotheses·measure-slippage 는 휴장 체크 자체가 없었다.
 *
 * 판정 규칙:
 *   - 주말(KST 토·일)은 API 없이 확정 휴장. Toss 캘린더가 죽어도 주말 오발송은 없다.
 *   - 평일은 Toss 캘린더 `today.integrated`(휴장이면 null)로 공휴일 판정.
 *   - 캘린더 실패 시 평일은 **fail-open(거래일 취급)** — 거래일 알림 유실이 휴일 소음보다 나쁘다.
 *     (.no-buy 스위치의 fail-open 과 같은 원칙)
 *
 * Toss 호출 비용: GET 1회. forecast-run 이 이미 매 실행 같은 엔드포인트를 쓰고 있어(하루 7회,
 * 장중 포함) 토큰 경합 리스크는 실증적으로 무시 수준. 그래도 호출측에서 장중 대량 사용은 피할 것.
 */
import { isTossConfigured, getKrMarketCalendar } from './toss-api.js';

const kstNow = () => new Date(Date.now() + 9 * 3600e3);
export const kstDateKey = () => kstNow().toISOString().slice(0, 10).replace(/-/g, '');
export const isWeekendKST = () => [0, 6].includes(kstNow().getUTCDay());

/** 캘린더 엔트리가 거래일인가 — forecast-run.isTrading 과 동일 판정식 */
export const calEntryTrading = (d) => !!(d && (d.integrated || d.regularMarket));

/**
 * 오늘이 거래일이면 true. 옵션으로 미리 받아둔 캘린더를 재사용할 수 있다.
 * @param {object} [preloadedCal] getKrMarketCalendar() 결과 재사용용 (선택)
 */
export async function isTradingDayKST(preloadedCal) {
  const weekend = isWeekendKST();
  let cal = preloadedCal ?? null;
  if (!cal && isTossConfigured()) {
    try { cal = await getKrMarketCalendar(); } catch { cal = null; }
  }
  const today = cal?.today && String(cal.today.date).replace(/-/g, '') === kstDateKey() ? cal.today : null;
  if (today) return calEntryTrading(today);
  return !weekend; // 캘린더 불능: 주말=휴장 확정, 평일=fail-open
}
