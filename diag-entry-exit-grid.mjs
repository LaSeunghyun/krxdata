/**
 * diag-entry-exit-grid.mjs — 진입시각 × 청산시각 × 보유일 격자 (2026-07-29 사용자 요청)
 *   "전체 종목 대상으로 언제 들어가서 언제 나올 때 가장 좋은 수익을 내는지"
 *
 * ★ 격자는 위양성 공장이다. 10진입 × 5일 × 6청산 = 300칸이면 15칸이 우연히 유의하게 나온다.
 *   그래서 절차를 코드에 박는다:
 *     1) 신호를 **날짜로 IS/OOS 분할**
 *     2) IS에서만 격자를 계산해 상위 칸을 고른다
 *     3) 그 칸들만 OOS에서 확인한다
 *     4) IS 상위가 OOS 상위가 아니면 → 격자 전체가 노이즈로 판정
 *   오늘 마지막 실패(목표거리 2% 필터)가 이 절차를 안 밟아 순환논증이 됐다.
 *
 * 표본 한계(정직히):
 *  - 분봉이 있는 **234종목**만이다. "전체 2,605종목"은 분봉이 없어 시각 분석이 불가능하다.
 *  - 생존편향: 현재 상장 종목만 → 절대 수치는 낙관.
 *  - 독립 표본은 종목수가 아니라 **신호일 수**다.
 *  - 진입/청산 모두 그 분의 종가에 체결된다고 본다(호가창 없음). 비용 0.33%p 왕복 차감.
 *
 * 실행: node diag-entry-exit-grid.mjs [--split 20260531] [--top 12]
 */
import { createReadStream, readdirSync, readFileSync } from 'fs';
import readline from 'readline';
import { join } from 'path';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DIR = 'data-1m';
const SPLIT = String(argOf('--split', '20260531'));
const TOP = Number(argOf('--top', 12));
const TIN = [900, 930, 1000, 1030, 1100, 1130, 1300, 1330, 1400, 1500];
const TOUT = [900, 1000, 1100, 1300, 1400, 1520];
const KDAYS = [0, 1, 2, 3, 4];
const RSI_MAX = 10, VOL_MIN = 1.25, COST = 0.33;

const KST = (s) => new Date(s * 1000 + 9 * 3_600_000);
const dayOf = (s) => KST(s).toISOString().slice(0, 10).replace(/-/g, '');
const hmOf = (s) => { const d = KST(s); return d.getUTCHours() * 100 + d.getUTCMinutes(); };

const NEED = new Set(readdirSync(DIR).filter(f => f.endsWith('.jsonl')).map(f => f.replace('.jsonl', '')));
NEED.add('005930');
const HIST = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => {
    const m = l.slice(0, 40).match(/"code"\s*:\s*"(\d{6})"/);
    if (!m || !NEED.has(m[1])) return;
    try { const j = JSON.parse(l); if (j.c?.length >= 200) HIST.set(j.code, j); } catch {}
  });
  rl.on('close', res);
});
const mkt = HIST.get('005930');
const mIdx = new Map(mkt.d.map((d, i) => [d, i]));

const rsi2At = (c, i) => { let u = 0, d = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) u += ch; else d -= ch; } return u + d === 0 ? 50 : u / (u + d) * 100; };
function regimeAt(mi) {
  if (mi < 60) return null;
  let a = 0, b = 0;
  for (let k = mi - 19; k <= mi; k++) a += mkt.c[k];
  for (let k = mi - 59; k <= mi; k++) b += mkt.c[k];
  a /= 20; b /= 60;
  const r5 = (mkt.c[mi] / mkt.c[mi - 5] - 1) * 100;
  if (mkt.c[mi] > a && a > b) return 'UP';
  if (mkt.c[mi] < a && r5 < -3) return 'DOWN';
  return 'NEUTRAL';
}

// 격자: seg('IS'|'OS') → key(tin_k_tout) → {n, sum, win}
const G = { IS: new Map(), OS: new Map() };
const add = (seg, key, r) => { let g = G[seg].get(key); if (!g) G[seg].set(key, g = { n: 0, sum: 0, win: 0 }); g.n++; g.sum += r; if (r > 0) g.win++; };
let nSigIS = 0, nSigOS = 0, nSkip = 0;
const daysIS = new Set(), daysOS = new Set();

for (const f of readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
  const code = f.replace('.jsonl', '');
  const j = HIST.get(code);
  if (!j) continue;
  let o;
  try { o = JSON.parse(readFileSync(join(DIR, f), 'utf8').split('\n')[0]); } catch { continue; }
  if (!o.t?.length) continue;

  const dmap = new Map();
  for (let i = 0; i < o.t.length; i++) {
    const d = dayOf(o.t[i]);
    let a = dmap.get(d);
    if (!a) dmap.set(d, a = []);
    a.push({ hm: hmOf(o.t[i]), c: o.c[i] });
  }
  const days = [...dmap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bars]) => ({ day, bars }));
  const dayIdx = new Map(days.map((d, i) => [d.day, i]));
  const jIdx = new Map(j.d.map((d, i) => [d, i]));
  // 수정주가 불일치 제외 (234개 중 6개 — 2026-07-29 확인된 함정)
  { let n = 0, mm = 0; for (const dd of days) { const k = jIdx.get(dd.day); if (k == null) continue; const r = dd.bars.at(-1).c / j.c[k]; n++; if (r < 0.95 || r > 1.05) mm++; } if (n < 10 || mm / n > 0.05) { nSkip++; continue; } }

  const priceAt = (di, hm) => { const b = days[di]?.bars.find(x => x.hm >= hm); return b ? b.c : null; };

  for (let i = 200; i < j.c.length - 1; i++) {
    if (rsi2At(j.c, i) >= RSI_MAX) continue;
    let v20 = 0; for (let k = i - 19; k <= i; k++) v20 += j.v[k];
    if (!(v20 > 0) || j.v[i] / (v20 / 20) < VOL_MIN) continue;
    const mi = mIdx.get(j.d[i]);
    const rg = mi == null ? null : regimeAt(mi);
    if (rg == null || rg === 'NEUTRAL') continue;
    const eDay = j.d[i + 1];
    const si = dayIdx.get(eDay);
    if (si == null) continue;
    const seg = eDay < SPLIT ? 'IS' : 'OS';
    if (seg === 'IS') { nSigIS++; daysIS.add(eDay); } else { nSigOS++; daysOS.add(eDay); }

    for (const tin of TIN) {
      const pin = priceAt(si, tin);
      if (!(pin > 0)) continue;
      for (const k of KDAYS) {
        const di = si + k;
        if (di >= days.length) break;
        for (const tout of TOUT) {
          if (k === 0 && tout <= tin) continue;          // 같은 날은 진입 이후만
          const pout = priceAt(di, tout);
          if (!(pout > 0)) continue;
          add(seg, `${tin}_${k}_${tout}`, (pout / pin - 1) * 100 - COST);
        }
      }
    }
  }
}

const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
console.log(`제외 ${nSkip}종목(수정주가 불일치) · IS 신호 ${nSigIS.toLocaleString()}건(${daysIS.size}일) · OOS 신호 ${nSigOS.toLocaleString()}건(${daysOS.size}일)`);
console.log(`분할 ${SPLIT} · 격자 ${G.IS.size}칸 · 비용 ${COST}%p\n`);

const MINN = 30;
const rows = [...G.IS.entries()].filter(([, g]) => g.n >= MINN)
  .map(([k, g]) => ({ k, isAvg: g.sum / g.n, isN: g.n, isWin: g.win / g.n * 100 }))
  .sort((a, b) => b.isAvg - a.isAvg);
for (const r of rows) { const o = G.OS.get(r.k); r.osAvg = o && o.n >= MINN ? o.sum / o.n : null; r.osN = o?.n ?? 0; }

const label = (k) => { const [tin, d, tout] = k.split('_'); return `진입 ${tin} → ${d}일차 ${tout} 청산`; };
console.log(`=== IS 상위 ${TOP}칸 (표본 ${MINN}+ 만) ===`);
console.log('순위  조합                          IS평균    IS승률  IS표본 │ OOS평균   OOS표본');
rows.slice(0, TOP).forEach((r, i) => console.log(
  `${String(i + 1).padStart(3)}   ${label(r.k).padEnd(28)} ${f2(r.isAvg).padStart(7)}%  ${r.isWin.toFixed(1).padStart(5)}%  ${String(r.isN).padStart(5)} │ ${(r.osAvg == null ? '   n부족' : f2(r.osAvg).padStart(7) + '%')}  ${String(r.osN).padStart(6)}`));

console.log(`\n=== IS 하위 ${TOP}칸 (대조군) ===`);
console.log('순위  조합                          IS평균    IS승률  IS표본 │ OOS평균   OOS표본');
rows.slice(-TOP).forEach((r, i) => console.log(
  `${String(rows.length - TOP + i + 1).padStart(3)}   ${label(r.k).padEnd(28)} ${f2(r.isAvg).padStart(7)}%  ${r.isWin.toFixed(1).padStart(5)}%  ${String(r.isN).padStart(5)} │ ${(r.osAvg == null ? '   n부족' : f2(r.osAvg).padStart(7) + '%')}  ${String(r.osN).padStart(6)}`));

// ── 판정: IS 상위가 OOS에서도 상위인가 (순위 상관) ──
const paired = rows.filter(r => r.osAvg != null);
if (paired.length >= 10) {
  const byOs = [...paired].sort((a, b) => b.osAvg - a.osAvg);
  const osRank = new Map(byOs.map((r, i) => [r.k, i]));
  const n = paired.length;
  let d2 = 0;
  paired.forEach((r, isRank) => { const d = isRank - osRank.get(r.k); d2 += d * d; });
  const rho = 1 - (6 * d2) / (n * (n * n - 1));
  const topK = Math.max(5, Math.floor(n * 0.2));
  const isTop = new Set(paired.slice(0, topK).map(r => r.k));
  const osTop = new Set(byOs.slice(0, topK).map(r => r.k));
  const overlap = [...isTop].filter(k => osTop.has(k)).length;
  console.log(`\n=== 판정 ===`);
  console.log(`대조 가능 칸 ${n}개 · 순위상관(Spearman) ${rho.toFixed(3)}`);
  console.log(`IS 상위 ${topK}칸 중 OOS 상위 ${topK}칸에도 든 것: ${overlap}개 (무작위 기대 ${(topK * topK / n).toFixed(1)}개)`);
  console.log(`IS 상위 ${topK}칸의 OOS 평균: ${f2(paired.slice(0, topK).reduce((s, r) => s + r.osAvg, 0) / topK)}%`);
  console.log(`IS 하위 ${topK}칸의 OOS 평균: ${f2(paired.slice(-topK).reduce((s, r) => s + r.osAvg, 0) / topK)}%`);
  console.log(`전체 칸의 OOS 평균:        ${f2(paired.reduce((s, r) => s + r.osAvg, 0) / n)}%`);
  console.log(`\n※ 순위상관이 0 근처면 IS 순위가 OOS를 예측하지 못한다 = 격자 전체가 노이즈.`);
  console.log(`※ IS상위의 OOS평균이 IS하위의 OOS평균보다 유의하게 높아야 "시각에 엣지가 있다"고 말할 수 있다.`);
}
