/**
 * diag-flow-discriminator.mjs — 수급(기관·외국인)이 combo-v2 승/패 판별자인가 (2026-07-25).
 *   질문: 같은 신호(hi120 돌파·rsi2 과매도) 안에서, 진입 직전 수급으로 이길/질 거래를 미리 구분할 수 있나?
 *   ★ look-ahead 차단: 진입일(day) **이전** 거래일 수급만 사용.
 *   ★ 미수집=미커버 오분류 방지: krx-flows.json에 없는 종목의 거래는 분석에서 제외(카운트만 보고).
 *   입력: cv2-dump.json(거래) + krx-flows.json(pykrx 백필)
 */
import { readFileSync } from 'fs';

const T = JSON.parse(readFileSync('./cv2-dump.json', 'utf8')).books['combo-v2'].trades;
const F = JSON.parse(readFileSync('./krx-flows.json', 'utf8'));
const ymd = (d) => String(d).replace(/-/g, '');

/** 진입일 이전 N거래일 수급 합 (억원). null = 데이터 부족 */
function flowBefore(code, day, n) {
  const rec = F[code];
  if (!rec) return null;
  const d = ymd(day);
  const dates = Object.keys(rec).filter(k => k < d).sort().slice(-n);
  if (dates.length < n) return null;
  let org = 0, frg = 0;
  for (const k of dates) { org += rec[k][0]; frg += rec[k][1]; }
  return { org: org / 1e8, frg: frg / 1e8, both: (org + frg) / 1e8 };
}

const fmt = (n) => (n / 1e4).toFixed(0) + '만';
const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
const stat = (g) => g.length ? `n=${String(g.length).padStart(4)} 순 ${fmt(sum(g)).padStart(8)} 거래당 ${fmt(sum(g) / g.length).padStart(7)} 승률 ${(g.filter(t => t.pnl > 0).length / g.length * 100).toFixed(0).padStart(3)}%` : 'n=0';

const haveData = new Set(Object.keys(F).filter(c => Object.keys(F[c]).length > 0));
const usable = T.filter(t => haveData.has(t.code));
console.log(`전체 ${T.length}거래 | 수급 데이터 보유종목 ${haveData.size}/${Object.keys(F).length} | 분석대상 거래 ${usable.length} (미수집 종목 거래 ${T.length - usable.length}건 제외)\n`);

const E = usable.map(t => ({ ...t, f5: flowBefore(t.code, t.day, 5), f20: flowBefore(t.code, t.day, 20) })).filter(t => t.f5 && t.f20);
console.log(`수급 계산 가능 거래: ${E.length}\n`);

const show = (label, groups) => {
  console.log(`=== ${label} ===`);
  for (const [k, g] of groups) console.log(`  ${k.padEnd(30)} ${stat(g)}`);
  console.log();
};

for (const sub of ['hi120', 'rsi2']) {
  const S = E.filter(t => t.ctx?.sub === sub);
  if (!S.length) continue;
  console.log(`########## ${sub} (n=${S.length}) ##########\n`);
  show(`${sub} — 외국인 5일 순매수 방향`, [
    ['외국인 순매수(+)', S.filter(t => t.f5.frg > 0)],
    ['외국인 순매도(-)', S.filter(t => t.f5.frg <= 0)],
  ]);
  show(`${sub} — 기관 5일 순매수 방향`, [
    ['기관 순매수(+)', S.filter(t => t.f5.org > 0)],
    ['기관 순매도(-)', S.filter(t => t.f5.org <= 0)],
  ]);
  show(`${sub} — 기관+외국인 5일 합산`, [
    ['둘다 순매수', S.filter(t => t.f5.org > 0 && t.f5.frg > 0)],
    ['하나만 순매수', S.filter(t => (t.f5.org > 0) !== (t.f5.frg > 0))],
    ['둘다 순매도', S.filter(t => t.f5.org <= 0 && t.f5.frg <= 0)],
  ]);
  show(`${sub} — 20일 누적 기관+외국인(억)`, [
    ['-100억 이하(강한 이탈)', S.filter(t => t.f20.both <= -100)],
    ['-100~0억', S.filter(t => t.f20.both > -100 && t.f20.both <= 0)],
    ['0~100억', S.filter(t => t.f20.both > 0 && t.f20.both <= 100)],
    ['100억+ (강한 유입)', S.filter(t => t.f20.both > 100)],
  ]);
  show(`${sub} — 5일 외국인 규모(억)`, [
    ['-50억 이하', S.filter(t => t.f5.frg <= -50)],
    ['-50~0억', S.filter(t => t.f5.frg > -50 && t.f5.frg <= 0)],
    ['0~50억', S.filter(t => t.f5.frg > 0 && t.f5.frg <= 50)],
    ['50억+', S.filter(t => t.f5.frg > 50)],
  ]);
}
