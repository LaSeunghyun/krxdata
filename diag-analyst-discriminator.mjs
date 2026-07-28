/**
 * diag-analyst-discriminator.mjs — 애널리스트가 combo-v2 승/패 판별자인가 (2026-07-25).
 *   질문: 같은 신호(hi120 돌파·rsi2 과매도) 안에서, 진입 시점 애널리스트 상태로 이길 거래와 질 거래를 미리 구분할 수 있나?
 *   ★ look-ahead 차단: 각 거래의 진입일(day) **이전** 리포트만 사용한다.
 *   입력: cv2-dump.json(거래) + analyst-hist.json(의견 이력)
 */
import { readFileSync } from 'fs';

const T = JSON.parse(readFileSync('./cv2-dump.json', 'utf8')).books['combo-v2'].trades;
const H = JSON.parse(readFileSync('./analyst-hist.json', 'utf8'));

const rank = (s) => {
  const t = String(s ?? '').toLowerCase().replace(/\s/g, '');
  if (!t || t.includes('notrated') || t === 'n/r') return null;
  if (/매도|sell|underperform|underweight|reduce/.test(t)) return 1;
  if (/중립|hold|neutral|marketperform|equalweight/.test(t)) return 2;
  if (/매수|buy|outperform|overweight|strongbuy|적극/.test(t)) return 3;
  return null;
};
const ymd = (d) => String(d).replace(/-/g, '');

/** 진입일 이전 리포트만으로 상태 계산 */
function stateAt(code, day, windowDays = 90) {
  const rows = H[code] ?? [];
  const d = ymd(day);
  const dt = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00Z`);
  const cut = new Date(dt.getTime() - windowDays * 86400000);
  const cutS = cut.toISOString().slice(0, 10).replace(/-/g, '');
  const win = rows.filter(r => r.date < d && r.date >= cutS && rank(r.opinion) != null);
  if (!win.length) return { covered: false, n: 0 };
  const targets = win.map(r => r.targetPrice).filter(v => v > 0).sort((a, b) => a - b);
  const consensus = targets.length ? targets[Math.floor(targets.length / 2)] : null;
  let up = 0, dn = 0;
  for (const r of win) { const c = rank(r.opinion), p = rank(r.prevOpinion); if (c != null && p != null) { if (c > p) up++; else if (c < p) dn++; } }
  // 목표가 방향: 윈도 전반부 대비 후반부 중앙값 변화
  const sorted = [...win].sort((a, b) => a.date.localeCompare(b.date));
  const half = Math.floor(sorted.length / 2);
  const med = (arr) => { const v = arr.map(r => r.targetPrice).filter(x => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const early = med(sorted.slice(0, half || 1)), late = med(sorted.slice(half));
  const tgtDir = (early && late) ? (late / early - 1) * 100 : null;
  return { covered: true, n: win.length, firms: new Set(win.map(r => r.firm)).size, consensus, upgrades: up, downgrades: dn, tgtDir, latest: sorted[sorted.length - 1].date };
}

const fmt = (n) => (n / 1e4).toFixed(0) + '만';
const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
const stat = (g) => g.length ? `n=${String(g.length).padStart(4)} 순 ${fmt(sum(g)).padStart(8)} 거래당 ${fmt(sum(g) / g.length).padStart(7)} 승률 ${(g.filter(t => t.pnl > 0).length / g.length * 100).toFixed(0).padStart(3)}%` : 'n=0';

const enriched = T.map(t => ({ ...t, a: stateAt(t.code, t.day) }));

console.log(`총 ${T.length}거래 | 애널리스트 이력 보유 종목 ${Object.values(H).filter(v => v.length).length}/${Object.keys(H).length}`);
console.log(`진입시점 커버리지 있는 거래: ${enriched.filter(t => t.a.covered).length} / 없는 거래: ${enriched.filter(t => !t.a.covered).length}\n`);

const show = (label, groups) => {
  console.log(`=== ${label} ===`);
  for (const [k, g] of groups) console.log(`  ${k.padEnd(26)} ${stat(g)}`);
  console.log();
};

for (const sub of ['hi120', 'rsi2']) {
  const S = enriched.filter(t => t.ctx?.sub === sub);
  show(`${sub} — 커버리지 유무`, [
    ['커버 있음', S.filter(t => t.a.covered)],
    ['커버 없음', S.filter(t => !t.a.covered)],
  ]);
  const cov = S.filter(t => t.a.covered);
  show(`${sub} — 상하향 조정(진입 전 90일)`, [
    ['상향 있음(up>0)', cov.filter(t => t.a.upgrades > 0)],
    ['하향 있음(dn>0)', cov.filter(t => t.a.downgrades > 0)],
    ['변화 없음', cov.filter(t => t.a.upgrades === 0 && t.a.downgrades === 0)],
  ]);
  show(`${sub} — 목표가 방향(윈도 전→후 중앙값)`, [
    ['목표가 상승(+2%↑)', cov.filter(t => t.a.tgtDir != null && t.a.tgtDir > 2)],
    ['목표가 보합', cov.filter(t => t.a.tgtDir != null && Math.abs(t.a.tgtDir) <= 2)],
    ['목표가 하락(-2%↓)', cov.filter(t => t.a.tgtDir != null && t.a.tgtDir < -2)],
  ]);
  show(`${sub} — 컨센서스 상승여력(진입가 대비)`, [
    ['여력 0~20%', cov.filter(t => t.a.consensus && (t.a.consensus / t.entry - 1) * 100 <= 20)],
    ['여력 20~50%', cov.filter(t => t.a.consensus && (t.a.consensus / t.entry - 1) * 100 > 20 && (t.a.consensus / t.entry - 1) * 100 <= 50)],
    ['여력 50%+', cov.filter(t => t.a.consensus && (t.a.consensus / t.entry - 1) * 100 > 50)],
    ['진입가>컨센서스(초과)', cov.filter(t => t.a.consensus && t.entry > t.a.consensus)],
  ]);
  show(`${sub} — 커버 증권사 수`, [
    ['1~2개사', cov.filter(t => t.a.firms <= 2)],
    ['3~5개사', cov.filter(t => t.a.firms >= 3 && t.a.firms <= 5)],
    ['6개사+', cov.filter(t => t.a.firms >= 6)],
  ]);
}
