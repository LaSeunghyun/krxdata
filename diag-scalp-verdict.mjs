#!/usr/bin/env node
/**
 * diag-scalp-verdict.mjs — 국내주식 인트라데이 스캘핑 최종 판정 산수 (2026-08-04)
 *
 * 입력은 두 실측치뿐이다. 둘 다 이 저장소에서 잰 값이고 여기서 재계산하지 않는다:
 *   · 최선 총엣지 = +0.1662%p  (diag-scalp-edge.mjs · vwap2.0c · 380분 · n=21,377 · 281종목)
 *   · 비용 구성   = 수수료 0.015%×2 + 거래세 0.15% + 틱 0.12%/편도 (diag-scalp-friction.mjs)
 *
 * 목적: "비용을 어디까지 낮추면 성립하는가"를 구성요소별로 분해해, 남은 경로가 있는지 없는지를 못박는다.
 * 엣지는 손익비 선택과 무관한 **상한**이다(배리어를 어떻게 잡든 평균은 드리프트가 정한다).
 */
const EDGE = 0.1662;        // %p — 측정된 최선. 이 값을 못 넘으면 어떤 TP/SL 도 순기대값 음수.
const FEE1 = 0.015;         // 편도 수수료 %
const TAX = 0.15;           // 매도 거래세 % (개별주식)
const TICK1 = 0.12;         // 편도 틱 슬리피지 % (유니버스 중위)
const TICK1_LOW = 0.06;     // 저틱 종목만 선별 시 편도 %

const rows = [
  ['현행 (시장가 왕복)',              FEE1 * 2 + TAX + TICK1 * 2,        '기준선'],
  ['지정가 진입 (1틱 절약)',          FEE1 * 2 + TAX + TICK1,            '체결 역선택 위험 별도'],
  ['저틱 종목만 (--tickmax)',         FEE1 * 2 + TAX + TICK1_LOW * 2,    '유니버스 축소'],
  ['저틱 + 지정가',                   FEE1 * 2 + TAX + TICK1_LOW,        '둘 다 적용'],
  ['수수료 0 이벤트 + 저틱 + 지정가', TAX + TICK1_LOW,                   '수수료 무료 계좌'],
  ['거래세 면제(ETF) + 현행 틱',      FEE1 * 2 + TICK1 * 2,              'ETF 는 증권거래세 없음'],
  ['거래세 면제(ETF) + 저틱',         FEE1 * 2 + TICK1_LOW * 2,          'ETF 호가단위 5원'],
  ['거래세 면제 + 저틱 + 지정가',     FEE1 * 2 + TICK1_LOW,              '최선 가정'],
];

console.log('=== 국내주식 인트라데이 스캘핑 — 비용 시나리오별 판정 ===');
console.log(`측정된 최선 총엣지 = +${EDGE}%p (vwap2.0c · 380분 보유 · n=21,377)`);
console.log('※ 엣지는 손익비 무관 상한이다. TP/SL 은 분산 배분만 바꾸고 평균은 못 바꾼다.\n');
console.log(`${'시나리오'.padEnd(30)}${'왕복비용'.padStart(10)}${'순EV'.padStart(10)}${'판정'.padStart(8)}  비고`);
let anyPass = false;
for (const [name, cost, note] of rows) {
  const ev = EDGE - cost;
  if (ev > 0) anyPass = true;
  console.log(`${name.padEnd(30)}${(cost.toFixed(3) + '%').padStart(10)}${((ev >= 0 ? '+' : '') + ev.toFixed(3) + '%').padStart(10)}${(ev > 0 ? '성립' : '음수').padStart(8)}  ${note}`);
}

console.log(`\n── 결론 ──`);
console.log(`  개별주식에서는 **어떤 비용 절감 조합으로도 음수**다. 거래세 0.15% 가 단독으로 엣지의 90% 를 먹는다.`);
console.log(`  ${anyPass ? '유일하게 양수가 되는 줄은 전부 **거래세 면제(ETF)** 전제다.' : '전 시나리오 음수.'}`);
console.log(`\n  필요 조건 역산:`);
console.log(`   · 현행 비용(0.420%)에서 성립하려면 엣지가 **${(0.420 / EDGE).toFixed(1)}배** 커져야 한다 (측정 8개 신호계열 중 없음)`);
console.log(`   · 현행 엣지로 성립하려면 왕복비용이 **${EDGE.toFixed(3)}% 미만**이어야 한다`);
console.log(`     → 개별주식 이론 하한 = 수수료0 + 거래세 ${TAX}% + 틱 0 = ${TAX}% (체결 완벽 가정) → 여유 ${(EDGE - TAX).toFixed(3)}%p`);
console.log(`     즉 **슬리피지 0·수수료 0 이라는 불가능한 가정에서만** 겨우 양수다.`);
console.log(`\n  남은 경로 1개(미측정): **ETF·레버리지 ETF** — 증권거래세 면제 + 호가단위 5원.`);
console.log(`   단 지수 ETF 는 변동성이 개별주보다 낮아 VWAP 이격 신호 자체가 덜 발생하고 진폭도 작을 수 있다.`);
console.log(`   → 같은 측정을 ETF 분봉으로 다시 해야 판정 가능. **현재 candles-1m.jsonl 에 ETF 0종목**(데이터 조달 필요).`);
