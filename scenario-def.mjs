/**
 * scenario-def.mjs — 시장 상황 시나리오 20개 정의 (2026-07-29)
 *
 * ★ 설계 원칙 (오늘의 실패에서 도출)
 * ① **관측 가능·PIT만.** 그날까지의 데이터로만 분류한다. 사후 라벨링 금지.
 * ② **결과를 보기 전에 정의를 고정한다.** 어느 파라미터가 이기는지 보고 경계를 조정하면
 *    그게 오늘 목표거리 가설을 죽인 순환논증이다.
 * ③ **성능이 아니라 상태로 분류한다.** 워크포워드에서 "과거 성능 기반 적응 선택"은 4승5패로
 *    실패했다(레짐은 성능으로 예측 안 됨). 상태 분류는 다른 접근이다.
 *
 * 축 2개 · 5×4 = 20 시나리오
 *   추세  T1~T5 : 시장 프록시(005930) 20일 수익률 구간
 *   변동성 V1~V4 : 시장 20일 실현변동성의 **1년 롤링 분위** (절대값이 아니라 상대 위치 —
 *                  국면마다 변동성 수준이 달라 절대 임계는 한쪽 구간에만 몰린다)
 *
 * ※ 프록시 한계: 005930 단일 종목이다. 오늘 breadth·HMA 대안을 10시드 MC로 검증했고
 *   전부 프록시보다 나빴다(breadth MA20 1.24 · MA200 -0.02 · HMA 0.62 vs 프록시 1.56).
 *   그래서 프록시를 쓴다 — 최선이라고 실측된 것이다.
 */

export const TREND_BINS = [
  { key: 'T1', name: '급락', lo: -Infinity, hi: -10 },
  { key: 'T2', name: '하락', lo: -10, hi: -3 },
  { key: 'T3', name: '횡보', lo: -3, hi: 3 },
  { key: 'T4', name: '상승', lo: 3, hi: 10 },
  { key: 'T5', name: '급등', lo: 10, hi: Infinity },
];
export const VOL_BINS = [
  { key: 'V1', name: '변동성 매우낮음', lo: 0, hi: 0.25 },
  { key: 'V2', name: '변동성 낮음', lo: 0.25, hi: 0.50 },
  { key: 'V3', name: '변동성 높음', lo: 0.50, hi: 0.75 },
  { key: 'V4', name: '변동성 매우높음', lo: 0.75, hi: 1.01 },
];

/**
 * 시장 상태 분류. mkt = {c:[], d:[]} (오래된순), i = 오늘 인덱스.
 * 반환 { trend, vol, key } 또는 null(데이터 부족).
 * 변동성 분위는 **직전 252일 내 자기 순위**로 계산한다 → 절대 수준 변화에 둔감.
 */
export function classify(mkt, i) {
  if (i < 252 + 21) return null;
  const ret20 = (mkt.c[i] / mkt.c[i - 20] - 1) * 100;
  // 20일 실현변동성 (일간수익률 표준편차)
  const rv = (k) => {
    let m = 0; for (let j = k - 19; j <= k; j++) m += mkt.c[j] / mkt.c[j - 1] - 1;
    m /= 20;
    let s = 0; for (let j = k - 19; j <= k; j++) { const r = mkt.c[j] / mkt.c[j - 1] - 1; s += (r - m) ** 2; }
    return Math.sqrt(s / 20);
  };
  const today = rv(i);
  let below = 0, n = 0;
  for (let k = i - 251; k <= i; k++) { const v = rv(k); if (Number.isFinite(v)) { n++; if (v < today) below++; } }
  if (!n) return null;
  const pct = below / n;
  const t = TREND_BINS.find(b => ret20 >= b.lo && ret20 < b.hi);
  const v = VOL_BINS.find(b => pct >= b.lo && pct < b.hi);
  if (!t || !v) return null;
  return { trend: t.key, vol: v.key, key: `${t.key}${v.key}`, ret20, volPct: pct };
}

export const ALL_KEYS = TREND_BINS.flatMap(t => VOL_BINS.map(v => `${t.key}${v.key}`));
export const LABEL = Object.fromEntries(TREND_BINS.flatMap(t => VOL_BINS.map(v => [`${t.key}${v.key}`, `${t.name}·${v.name}`])));
