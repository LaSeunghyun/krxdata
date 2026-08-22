/**
 * screen-halfyear.mjs — 반기보고서 기준 저평가 스크리닝
 *
 * 반기 행(report_code=11012)의 매출·영업이익 YoY로 실적 모멘텀을 최신화하고,
 * 연간 행(11011)의 자본·순이익 + 현재 시총으로 밸류를 재계산한다.
 *
 * ⚠️⚠️ 매매 신호로 쓰지 말 것 — 순위의 예측력이 없다는 근거가 2개 있다 (2026-08-14 확인).
 *
 * ① 이벤트 실측: 2026-08-13 반기 제출 + 유동성 통과 71종목의 익일(8/14) 수익률
 *    - 평균 +0.26% / 중앙값 -0.86% / 상승 30 : 하락 41
 *    - 영업이익 증가율 상위 1/3 +0.33%  vs  하위 1/3 +1.57%  ← 방향이 반대
 *    - 상관계수(영업이익YoY ↔ 익일수익률) 0.041 ≈ 0
 * ② config.js FACTOR_WEIGHTS (1년치 PIT IC 측정, look-ahead 제거 후):
 *    value 0 (노이즈 컷) · earningsMomentum -0.03 (60일 IC>0 비율 0%)
 *    → 이 스크린의 두 축(밸류 50 : 실적 50)이 정확히 그 둘이다.
 *
 * 해석: 반기 실적은 새 정보가 아니다. 증권사 추정치·업황 데이터로 이미 가격에 반영돼 있고,
 *      공시는 확인 절차일 뿐이다(제주반도체 매출 4.7배 발표 → 익일 +1.5%).
 *
 * ③ PIT 백테스트 재검증 (backtest-pit.mjs --weights, 400일·33회 리밸런스, 2026-08-14):
 *    조합                          60일 IC   60일 net분위스프레드
 *    baseline(config)              -0.001    +2.2%
 *    A 스크린(value.5+earn.5)      +0.039    -0.3%   ← 거래비용도 못 넘음
 *    B 스크린+priceMomentum        +0.039    +2.8%
 *    C priceMomentum 단독          +0.004    +4.2%   ← 스크린 축을 섞으면 오히려 하락
 *    D value 단독                  +0.067    +1.1%
 *    → 스크린 축을 넣으면 매매수익이 나빠진다. IC가 양수여도 분위 스프레드는 음수(A).
 *
 * ④ 국면 분해(--subperiods)로 본 두 축의 실체:
 *    value 60일 IC 0.067 → 2026Q2 제외 시 0.008.  그 한 분기 IC가 0.202로 전부였다(=아티팩트).
 *    earningsMomentum 전체 -0.041, 어느 분기를 빼도 -0.025~-0.047로 부호가 안 흔들린다(=견고하게 해로움).
 *
 * 결론: 기각. 한 축은 한 분기짜리 아티팩트, 다른 축은 일관되게 마이너스다.
 * 용도: 개별 종목 조사의 출발점(싸고 실적 좋은 회사 목록)으로만 쓴다. 매수 순위·자동매매 편입 금지.
 *
 * 실행: node screen-halfyear.mjs [--year 2026] [--min-turnover 3000000000]
 */
import { dbQuery } from "./dart-financials-backfill.js";
import { MIN_AVG_TURNOVER } from "./config.js";

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const YEAR = Number(getArg("--year", 2026));
const PREV = YEAR - 1;
const MIN_TURN = Number(getArg("--min-turnover", MIN_AVG_TURNOVER));

const rows = await dbQuery(`
  SELECT a.stock_code, a.corp_name, a.mrkt_ctg, a.sector,
         a.current_price, a.market_cap_tril, a.avg_turnover_20d,
         a.high_52w, a.low_52w, a.total_score,
         h.revenue      AS h_rev,   h.op_income     AS h_op,
         h.revenue_yoy  AS h_rev_yoy, h.op_income_yoy AS h_op_yoy, h.rcept_dt,
         y.total_equity, y.net_income, y.revenue AS y_rev, y.op_income AS y_op,
         y.debt_ratio, y.roe, y.op_margin, y.cf_ops
  FROM stock_analysis a
  JOIN stock_financials h
    ON h.stock_code = a.stock_code AND h.analysis_year = ${YEAR} AND h.report_code = '11012'
  LEFT JOIN stock_financials y
    ON y.stock_code = a.stock_code AND y.analysis_year = ${PREV} AND y.report_code = '11011'
  WHERE a.current_price > 1000
    AND (a.avg_turnover_20d IS NULL OR a.avg_turnover_20d >= ${MIN_TURN})
`);

console.log(`반기 데이터 보유 + 유동성 통과: ${rows.length}종목`);

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const enriched = rows.map(r => {
  const cap = num(r.market_cap_tril) != null ? num(r.market_cap_tril) * 1e12 : null;
  const eq = num(r.total_equity), ni = num(r.net_income);
  const pbr = cap && eq && eq > 0 ? cap / eq : null;
  const per = cap && ni && ni > 0 ? cap / ni : null;
  const hOp = num(r.h_op), hRev = num(r.h_rev);
  const opYoY = num(r.h_op_yoy), revYoY = num(r.h_rev_yoy);
  const cf = num(r.cf_ops);
  const hi = num(r.high_52w), px = num(r.current_price);
  return {
    ...r, cap, pbr, per, hOp, hRev, opYoY, revYoY, cf,
    opMarginH: hOp != null && hRev ? (hOp / hRev) * 100 : null,
    drawdown: hi && px ? ((px - hi) / hi) * 100 : null,
  };
});

// ── 하드 게이트 ──
// factors.quarterlyYoY는 "전년 적자 → 당기 흑자"를 999로 클리핑한다.
// 실제 증가율이 아니므로 연속형 지표와 섞으면 순위가 오염된다 → 플래그로 분리.
const TURNAROUND = 999;
// 금융·보험은 '매출액' 개념이 달라(영업수익) 매출YoY·영업이익률이 비교 불가.
const EXCLUDED_SECTORS = new Set(["금융·보험"]);

const gated = enriched.filter(r =>
  r.pbr != null && r.pbr > 0 &&
  r.hOp != null && r.hOp > 0 &&              // 반기 영업흑자
  r.hRev != null && r.hRev > 0 &&            // 매출 인식 정상 (계정 매핑 실패 배제)
  r.opYoY != null && r.opYoY > 0 &&          // 반기 영업이익 개선
  !EXCLUDED_SECTORS.has(r.sector) &&
  !(r.cf != null && r.cf < 0 && r.pbr < 0.5) // 밸류트랩 배제(저PBR+음수 영업현금흐름)
).map(r => ({ ...r, turnaround: r.opYoY === TURNAROUND }));

const nTurn = gated.filter(r => r.turnaround).length;
console.log(`하드 게이트 통과: ${gated.length}종목 (그중 흑자전환 ${nTurn}종목)`);

// ── 백분위 스코어 (낮을수록 좋은 지표는 반전) ──
const pctRank = (arr, key, asc) => {
  const vals = arr.map(r => r[key]).filter(v => v != null).sort((a, b) => a - b);
  return v => {
    if (v == null || !vals.length) return null;
    let lo = 0, hi = vals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < v) lo = m + 1; else hi = m; }
    const p = lo / vals.length;
    return asc ? 1 - p : p;   // asc=true → 값이 작을수록 高점
  };
};
const rPbr = pctRank(gated, "pbr", true);
const rPer = pctRank(gated, "per", true);
// 999(흑자전환)를 제외한 실제 증가율만으로 백분위를 만든다.
// 섞으면 흑자전환 종목이 전부 동점 최상위가 되어 tie-break이 무의미해진다.
const contYoY = gated.filter(r => !r.turnaround);
const rOpYoY = pctRank(contYoY, "opYoY", false);
const rRevYoY = pctRank(gated, "revYoY", false);
const rMargin = pctRank(gated, "opMarginH", false);
// 흑자전환에 부여할 고정 백분위 — 상위권이되 최상위는 아님(적자 탈출 ≠ 고성장)
const TURNAROUND_PCT = 0.80;

const scored = gated.map(r => {
  const parts = {
    pbr: rPbr(r.pbr), per: rPer(r.per),
    opYoY: r.turnaround ? TURNAROUND_PCT : rOpYoY(r.opYoY),
    revYoY: rRevYoY(r.revYoY), margin: rMargin(r.opMarginH),
  };
  // 밸류 50 : 실적 50
  const value = ((parts.pbr ?? 0.5) * 0.6 + (parts.per ?? 0.5) * 0.4) * 50;
  const perf = ((parts.opYoY ?? 0.5) * 0.5 + (parts.revYoY ?? 0.5) * 0.3 + (parts.margin ?? 0.5) * 0.2) * 50;
  return { ...r, parts, valueScore: value, perfScore: perf, screenScore: value + perf };
}).sort((a, b) => b.screenScore - a.screenScore);

const fmtEok = v => v == null ? "-" : (v / 1e8).toFixed(0);
const f1 = v => v == null ? "-" : v.toFixed(1);

console.log(`\n=== 반기 기준 저평가 상위 25 ===`);
console.log("순위 종목(코드) 시장 | 현재가 | PBR | PER | 반기매출YoY | 반기OP_YoY | 반기OPM | 52주고점대비 | 점수");
scored.slice(0, 25).forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(2)} ${r.corp_name}(${r.stock_code}) ${r.mrkt_ctg} | ` +
    `${Number(r.current_price).toLocaleString()} | ${f1(r.pbr)} | ${f1(r.per)} | ` +
    `${f1(r.revYoY)}% | ${f1(r.opYoY)}% | ${f1(r.opMarginH)}% | ${f1(r.drawdown)}% | ${r.screenScore.toFixed(1)}`
  );
});

console.log(`\n=== 반기 영업이익 실제 증가율 상위 20 (흑자전환 제외) ===`);
contYoY.slice().sort((a, b) => (b.opYoY ?? 0) - (a.opYoY ?? 0)).slice(0, 20).forEach((r, i) => {
  console.log(`${String(i + 1).padStart(2)} ${r.corp_name}(${r.stock_code}) ${r.sector ?? "-"} | ` +
    `반기매출 ${fmtEok(r.hRev)}억 OP ${fmtEok(r.hOp)}억 | 매출YoY ${f1(r.revYoY)}% OP_YoY ${f1(r.opYoY)}% | PBR ${f1(r.pbr)}`);
});

console.log(`\n=== 흑자전환 종목 (전년 반기 적자 → 당기 흑자) ===`);
gated.filter(r => r.turnaround).sort((a, b) => (b.hOp ?? 0) - (a.hOp ?? 0)).slice(0, 15).forEach((r, i) => {
  console.log(`${String(i + 1).padStart(2)} ${r.corp_name}(${r.stock_code}) ${r.sector ?? "-"} | ` +
    `반기매출 ${fmtEok(r.hRev)}억 OP ${fmtEok(r.hOp)}억 | 매출YoY ${f1(r.revYoY)}% | PBR ${f1(r.pbr)}`);
});

const out = scored.map(r => ({
  stock_code: r.stock_code, corp_name: r.corp_name, mrkt_ctg: r.mrkt_ctg, sector: r.sector,
  current_price: r.current_price, pbr: r.pbr, per: r.per,
  turnaround: r.turnaround,
  h_rev_eok: r.hRev != null ? +(r.hRev / 1e8).toFixed(0) : null,
  h_op_eok: r.hOp != null ? +(r.hOp / 1e8).toFixed(0) : null,
  rev_yoy: r.revYoY, op_yoy: r.opYoY, op_margin_h: r.opMarginH,
  drawdown_52w: r.drawdown, screen_score: +r.screenScore.toFixed(1),
}));
const fs = await import("node:fs");
fs.writeFileSync("screen-halfyear.json", JSON.stringify(out, null, 1));
console.log(`\n전체 ${out.length}종목 → screen-halfyear.json 저장`);
