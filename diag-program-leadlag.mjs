/**
 * diag-program-leadlag.mjs — "프로그램매매가 매도세로 바뀌면 주가가 떨어지나" 실측
 *
 * ═══ 질문의 함정 ═══
 * 동시(contemporaneous) 상관은 거의 **항등식**이다. 프로그램 매도 주문 자체가 시장가 매도이고
 * 그게 호가를 밀어내린다 → "프로그램이 팔면 떨어진다"는 같은 사건을 두 번 세는 것에 가깝다.
 * 그걸로는 아무것도 예측할 수 없다.
 *
 * 매매에 쓸 수 있는 건 **선행(lead-lag)** 뿐이다: t 구간의 프로그램 순매수가 t+1 구간의 수익률을
 * 예측하는가. 그래서 둘을 따로 재고 나란히 놓는다.
 *
 * ═══ 측정 ═══
 * 입력 = collect-flow-intraday.mjs 의 flow-YYYYMMDD.jsonl (pg = 당일 누적 프로그램 순매수, px = 가격)
 *   Δpg_t = pg_t − pg_{t-1}   (그 구간의 프로그램 순매수 유량)
 *   ret_t = px_t / px_{t-1} − 1
 *   동시   : corr(Δpg_t, ret_t)        ← 항등식에 가깝다. 해석 주의
 *   선행   : corr(Δpg_t, ret_{t+1})    ← 이게 유일하게 의미 있는 값
 *   조건부 : Δpg_t < 0 일 때 ret_{t+1} 평균 vs Δpg_t > 0 일 때 평균  ← 질문에 직접 답하는 형태
 *
 * Δpg 는 종목별 스케일이 달라 **당일 거래량으로 정규화**한다(종목 간 합산 가능하게).
 * 폴 간격이 비정상(수집 중단 등)인 구간은 버린다 — 간격이 다르면 유량 비교가 깨진다.
 *
 * ═══ 한계 (해석 전에 읽을 것) ═══
 *  · 표본 1일·소수 종목·단일 레짐(DOWN). 이건 **탐색**이고 검증이 아니다.
 *  · 분 단위 수익률은 자기상관이 강해 단순 상관의 유의성이 과대평가된다(NW 보정 없음).
 *  · 전략 반영은 MC 백테를 거쳐야 한다. 이 프로젝트 룰 개선 전적은 20축 35변종 0승 전패다.
 *
 * 실행: node diag-program-leadlag.mjs [YYYYMMDD]
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY = process.argv[2] ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
const F = join(__dirname, 'flow-intraday', `flow-${DAY}.jsonl`);
if (!existsSync(F)) { console.error(`수집 파일 없음: ${F}`); process.exit(1); }

const rows = readFileSync(F, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const secOf = (at) => { const t = at.slice(11); return +t.slice(0, 2) * 3600 + +t.slice(3, 5) * 60 + +t.slice(6, 8); };

const corr = (xs, ys) => {
  const n = xs.length;
  if (n < 8) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
};
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const codes = [...new Set(rows.map(r => r.code))];
// 정상 폴 간격 = 중위값. 그 2배를 넘는 구간은 수집 중단 등으로 유량 비교가 깨지므로 버린다.
const allGaps = [];
for (const code of codes) {
  const rs = rows.filter(r => r.code === code).sort((a, b) => a.at.localeCompare(b.at));
  for (let i = 1; i < rs.length; i++) allGaps.push(secOf(rs[i].at) - secOf(rs[i - 1].at));
}
allGaps.sort((a, b) => a - b);
const medGap = allGaps[allGaps.length >> 1] ?? 60;
const MAX_GAP = medGap * 2;

console.log(`=== ${DAY} 프로그램매매 → 주가 선행성 실측 ===`);
console.log(`정상 폴 간격 중위 ${medGap}초 · ${MAX_GAP}초 초과 구간 제외\n`);

const allNow = { x: [], y: [] }, allNext = { x: [], y: [] };
const condDown = [], condUp = [];

console.log('종목      구간수  동시corr  선행corr  │ Δpg<0 다음수익  Δpg>0 다음수익  차이');
console.log('─'.repeat(88));
for (const code of codes) {
  const rs = rows.filter(r => r.code === code && r.pg != null && r.px > 0).sort((a, b) => a.at.localeCompare(b.at));
  const seg = [];
  for (let i = 1; i < rs.length; i++) {
    const gap = secOf(rs[i].at) - secOf(rs[i - 1].at);
    if (gap <= 0 || gap > MAX_GAP) continue;
    const vol = rs[i].vol || 1;
    seg.push({
      dpg: (rs[i].pg - rs[i - 1].pg) / vol * 100,        // 거래량 대비 %
      ret: (rs[i].px / rs[i - 1].px - 1) * 100,
    });
  }
  if (seg.length < 10) { console.log(`${code}  구간 ${seg.length} — 표본 부족`); continue; }
  const nowX = seg.map(s => s.dpg), nowY = seg.map(s => s.ret);
  const nextX = seg.slice(0, -1).map(s => s.dpg), nextY = seg.slice(1).map(s => s.ret);
  allNow.x.push(...nowX); allNow.y.push(...nowY);
  allNext.x.push(...nextX); allNext.y.push(...nextY);
  const d = [], u = [];
  for (let i = 0; i < seg.length - 1; i++) (seg[i].dpg < 0 ? d : u).push(seg[i + 1].ret);
  condDown.push(...d); condUp.push(...u);
  const p = (v) => v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8);
  const c = (v) => v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(2)).padStart(8);
  console.log(`${code}  ${String(seg.length).padStart(5)}  ${c(corr(nowX, nowY))}  ${c(corr(nextX, nextY))}  │ ${p(avg(d))}%(n=${String(d.length).padStart(3)}) ${p(avg(u))}%(n=${String(u.length).padStart(3)}) ${p(avg(d) != null && avg(u) != null ? avg(d) - avg(u) : null)}`);
}

console.log('\n=== 전체 합산 ===');
const cNow = corr(allNow.x, allNow.y), cNext = corr(allNext.x, allNext.y);
console.log(`  동시 corr(Δpg_t, ret_t)     = ${cNow == null ? '-' : cNow.toFixed(3)}  (n=${allNow.x.length})  ← 항등식에 가깝다`);
console.log(`  선행 corr(Δpg_t, ret_{t+1}) = ${cNext == null ? '-' : cNext.toFixed(3)}  (n=${allNext.x.length})  ← 예측력은 이것뿐`);
const aD = avg(condDown), aU = avg(condUp);
console.log(`\n  프로그램 순매도 구간(Δpg<0) 다음 구간 평균수익 ${aD == null ? '-' : (aD >= 0 ? '+' : '') + aD.toFixed(4) + '%'} (n=${condDown.length})`);
console.log(`  프로그램 순매수 구간(Δpg>0) 다음 구간 평균수익 ${aU == null ? '-' : (aU >= 0 ? '+' : '') + aU.toFixed(4) + '%'} (n=${condUp.length})`);
if (aD != null && aU != null) {
  const diff = aD - aU;
  console.log(`  차이 ${(diff >= 0 ? '+' : '') + diff.toFixed(4)}%p`);
  console.log(`\n=== 판정 ===`);
  if (Math.abs(cNext ?? 0) < 0.05) {
    console.log(`  선행 상관 |${(cNext ?? 0).toFixed(3)}| < 0.05 → **예측력 없음.** 프로그램이 매도로 바뀐 것을 보고`);
    console.log(`  다음 구간 하락을 기대할 근거가 이 표본에는 없다. 동시 상관이 크다면 그건`);
    console.log(`  "팔았으니 떨어졌다"를 같은 사건으로 두 번 센 것이다.`);
  } else {
    console.log(`  선행 상관 ${cNext.toFixed(3)} — 0 이 아니다. 다만 분 단위 수익률은 자기상관이 강해`);
    console.log(`  단순 상관은 유의성을 과대평가한다. NW 보정·직교화·다일 표본 없이는 채택 불가.`);
  }
}
console.log(`\n※ 표본 ${DAY} 하루 · ${codes.length}종목 · 레짐 DOWN. 탐색이며 검증이 아니다.`);
