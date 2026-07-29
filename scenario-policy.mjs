/**
 * scenario-policy.mjs — 시장 시나리오 조건부 파라미터 정책 (2026-07-29)
 *
 * scenario-def.mjs의 classify()(추세 T1~T5 × 변동성 분위 V1~V4, 프록시 005930)로
 * 오늘 시장을 분류하고, **검증을 통과한 시나리오에만** 차별 파라미터를 반환한다.
 * 나머지 17개 시나리오는 전부 현행 라이브 기본값 폴백 — 이 모듈이 건드리지 않는다.
 *
 * ── 검증 통과 근거 (2026-07-29, scen-matrix.mjs·scen-interaction.mjs) ─────────────
 * 사전 등록 게이트: ①이웃값 봉우리/고원 ②10시드 MC(subsample 0.8)에서 IS·OOS 각 ≥8/10 시드
 * 시나리오내 델타 양수 ③상호작용(시나리오내-시나리오외) 분리로 전역 주효과 배제.
 *
 * T3V1 (횡보·변동성 매우낮음, 91일/868일) → trailPct 6→10
 *   MC 40/40 전항목 양수 (IS내 10/10·IS상호 10/10·OOS내 10/10·OOS상호 10/10)
 *   IS +1.05pp/OOS +2.04pp (포지션 평균수익률, n=52/25) · 이웃 trail12도 시드 레벨 9/10·10/10(고원 확정)
 *   해석: 저변동 횡보장은 되돌림이 얕고 느려 좁은 트레일(6%)이 러너를 조기 강판시킨다.
 *   ⚠ T3V1은 2023(IS)·2025(OOS) 두 에피소드 군집에만 존재(2024·2026 = 0일) — 독립 표본 2개로 읽을 것.
 *   ⚠ 실유니버스 OOS 단일경로에서 MDD 29.4→41.6% 악화 관측(횡보→급락 전환 시 넓은 트레일이 낙폭 확대).
 *     시드 레벨 중앙값은 +1.15pp라 게이트 통과지만, 전환 리스크는 구조적으로 실재한다.
 *
 * T2V4 (하락·변동성 매우높음, 81일/868일) → rsiVolMin 0→1.25  ★경계선 통과 — 섀도우 권장
 *   MC IS내 9/10 · OOS내 8/10 (기준 턱걸이) · IS +0.86pp/OOS +1.17pp (n=30/28)
 *   이웃 사다리 비단조(1.0에서 기준 이하로 함몰 후 1.25·1.5 고원) — 정합성 약함.
 *   표본의 78%(46/59)가 2024년에 집중 — 연도별 방향은 4/4 일치하나 2024 외 n≤7.
 *   해석: 급락장 과매도 진입에 투매 거래량 확인(당일≥20일평균×1.25)을 요구해 낙하나이프 배제.
 *
 * 제품 레벨 (전체 기간 10시드 MC, 최종자본): T3V1만 적용 8/10 개선(MDD 중앙값 +1.15pp) ·
 *   두 개 모두 적용 8/10 개선(MDD 중앙값 ±0.0pp) · 둘다>T3V1만 7/10.
 *   구간 단일경로: IS Calmar 1.16→1.49 · OOS 0.95→1.50 (두 개 적용 기준).
 *
 * 기각된 것: trail10@T3V4(MC OOS 3/10)·trail10@T2V4(MC OOS 1/10)·atrmax5@T4V3(이웃 스파이크)
 *   — 전체 유니버스 단일경로에선 그럴듯했으나 시드 레벨에서 붕괴. 자세한 판정은 보고서 참조.
 *
 * ── 의미론 (백테스트와 동일해야 함 — backtest-swing.mjs --scenpolicy 배선과 1:1) ──
 * · rsiVolMin: **진입일** 필터. 그날 시나리오가 T2V4면 rsi2 후보에 거래량비 ≥1.25 요구.
 * · trailPct: **진입일 시나리오로 포지션에 고정**(진입 후 시나리오가 바뀌어도 유지).
 *   부분익절 레벨도 함께 스케일: tp1 = trailPct×1, tp2 = trailPct×2 (T3V1이면 +10%/+20%).
 *   검증 런(trail 스윕)이 이 의미론으로 측정됐으므로 라이브도 동일해야 한다.
 *
 * ── 라이브(stock-live.mjs) 배선 방법 — 문서화만, 코드 수정은 배포 결정 후 ──
 * 1) 진입 필터: stock-live.mjs:112 `rsiVolMin: RSI_ENTRY_FILTER.volMin`
 *    → `rsiVolMin: policyFor(mkt, i).params.rsiVolMin` (mkt = 005930 일봉, i = 오늘 인덱스).
 * 2) 트레일·익절: stock-live.mjs:30 `TRAIL_PCT = 6` 상수와 strategy-contract.mjs PARTIAL_TP
 *    (tp1Pct 6/tp2Pct 12)를 **진입 시점에 포지션 메타로 저장**하도록 변경:
 *    진입 시 { trailPct, tp1Pct, tp2Pct } = policyFor(...).params 를 저널/DB에 기록하고,
 *    청산 검사(stock-live.mjs:375·627·630-631)와 부분익절 검사에서 포지션 저장값을 사용.
 *    저장값 없는 기존 포지션은 현행 상수로 폴백.
 * 3) 분류 데이터: classify()는 273영업일(252+21) 이력이 필요. 005930 일봉 300개 이상 확보 후 호출,
 *    부족하면 null → DEFAULTS 폴백(안전).
 *
 * ── 한계 (배포 판단 시 반드시 읽을 것) ──
 * · 시나리오 20개 중 IS/OOS 양쪽 20일 이상은 6개뿐 — 나머지 14개는 표본 외 검증 원리적 불가(미검증).
 * · 다중비교: 13구성×6시나리오=78비교에서 IS·OOS 방향 동시일치 28건(우연 기대 ~19.5) 중 2건 채택.
 *   MC 게이트는 종목 구성 요행을 거르지만 **선택 편향 자체를 소거하지 못한다**(시드가 기간을 공유).
 * · 생존편향: 유니버스가 현재 상장분 — 절대 수치 전부 낙관.
 * · 진짜 검증은 배포 후 미래 데이터뿐. T2V4는 특히 섀도우(로그만) 운용을 권장.
 *
 * CLI: node scenario-policy.mjs            → 오늘(캐시 마지막 날) 분류·파라미터 출력
 *      node scenario-policy.mjs 20260601   → 지정일 기준
 */
import { classify } from './scenario-def.mjs';

/** 현행 라이브 기본값 (strategy-contract.mjs 2026-07-24 uni420 재조정과 동일) */
export const DEFAULTS = Object.freeze({ trailPct: 6, tp1Pct: 6, tp2Pct: 12, rsiVolMin: 0 });

/** 검증 통과 시나리오만 등재. 여기 없는 키는 전부 DEFAULTS. */
export const SCENARIO_OVERRIDES = Object.freeze({
  T3V1: { trailPct: 10 },     // MC 40/40 통과
  T2V4: { rsiVolMin: 1.25 },  // MC 9/10·8/10 경계선 통과 — 섀도우 권장
});

/**
 * 오늘 시장 분류 → 파라미터 셋.
 * @param mkt {c:[],d:[]} 005930 일봉(오래된순), @param i 오늘 인덱스
 * @returns { scenario, overridden, params: { trailPct, tp1Pct, tp2Pct, rsiVolMin } }
 */
export function policyFor(mkt, i) {
  const s = classify(mkt, i);
  const ov = s ? SCENARIO_OVERRIDES[s.key] : null;
  const trailPct = ov?.trailPct ?? DEFAULTS.trailPct;
  return {
    scenario: s?.key ?? null,
    overridden: !!ov,
    params: {
      trailPct,
      tp1Pct: trailPct * 1,   // 검증 런과 동일: 부분익절 레벨은 trailPct에 비례
      tp2Pct: trailPct * 2,
      rsiVolMin: ov?.rsiVolMin ?? DEFAULTS.rsiVolMin,
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────
const { pathToFileURL } = await import('url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createReadStream } = await import('fs');
  const { createInterface } = await import('readline');
  const asOf = process.argv[2] ?? null;
  const rl = createInterface({ input: createReadStream(new URL('./candles-daily.jsonl', import.meta.url)), crlfDelay: Infinity });
  let mkt = null;
  for await (const line of rl) {
    if (!line.includes('"005930"')) continue;
    try { const rec = JSON.parse(line); if (rec.code === '005930') { mkt = rec; break; } } catch {}
  }
  if (!mkt) { console.error('005930 일봉을 candles-daily.jsonl에서 찾지 못함'); process.exit(1); }
  let i = mkt.d.length - 1;
  if (asOf) { i = mkt.d.findLastIndex(d => d <= asOf); if (i < 0) { console.error(`${asOf} 이전 데이터 없음`); process.exit(1); } }
  const p = policyFor(mkt, i);
  const s = classify(mkt, i);
  console.log(`기준일 ${mkt.d[i]} | 시나리오 ${p.scenario ?? '분류불가(이력부족)'}${s ? ` (20일수익률 ${s.ret20.toFixed(1)}% · 변동성분위 ${(s.volPct * 100).toFixed(0)}%)` : ''}`);
  console.log(`오버라이드 ${p.overridden ? '적용' : '없음(기본값)'} | trail ${p.params.trailPct}% · tp1 +${p.params.tp1Pct}% · tp2 +${p.params.tp2Pct}% · rsiVolMin ${p.params.rsiVolMin}`);
}
