/**
 * research-roe-pbr.mjs — ROE-PBR 회귀 잔차의 예측력 검정 (2026-07-31)
 *
 * ═══ 검정 대상 ═══
 * 증권가 밸류에이션 표준 도구: PBR 을 ROE 에 회귀하고 회귀선 아래(잔차 음수)면 저평가로 본다.
 *   제시된 지수 예: PBR = 0.0696 × ROE + 0.2953 → ROE 25.5% 면 적정 PBR 2.07x,
 *   실제 1.30x 이므로 -37% 저평가.
 * 질문: **잔차가 미래 수익을 예측하나.** 예측하지 못하면 어떤 매매규칙으로도 만들 수 없다.
 *
 * ═══ 설계 (2026-07-31 오늘 확립한 원칙 적용) ═══
 * ① 계수를 고정하지 않는다. 0.0696·0.2953 은 **지수 시계열**에 적합된 값이다. 개별 종목에 쓰려면
 *    매 시점 **횡단면으로 다시 적합**해야 한다. 안 그러면 지수용 계수를 종목에 갖다 붙이는 것이 된다.
 * ② 포트폴리오 없음. 매일 횡단면 순위 → 십분위 스프레드 + Spearman IC (research-ic.mjs 와 같은 층).
 * ③ **귀무 대조군 동반.** 순수 노이즈 특징을 같은 파이프라인에 통과시켜 |IC|·t·스프레드 바닥을 실측한다.
 *    (research-ic.mjs 실측 바닥: |IC| 0.0022 · |t| 1.42 · 스프레드 0.220%)
 * ④ **변동성 통제.** 같은 연구에서 저변동성이 압도적 1위였다(atrPct 20일 t -23.2).
 *    저PBR 은 통상 고변동성이라 잔차가 변동성의 역방향 대리변수일 수 있다 → 변동성 분위 내 잔차도 본다.
 *
 * ═══ PBR 산출 (DB pbr 을 쓰지 않는 이유) ═══
 * stock_financials.pbr 은 **행 기록 시점**의 값이다. 최신 연도만 market_cap/total_equity 와 일치하고
 * 과거 연도는 어긋난다(SK하이닉스 2024: pbr 11.48 vs mc/eq 18.735) — market_cap 이 현재 스냅샷이라서다.
 * 그래서 가격에서 직접 만든다:
 *   BPS = total_equity / 발행주식수,  발행주식수 = stock_analysis.market_cap_tril×1e12 / current_price
 *   PBR_t = 종가_t / BPS
 * 시점 정합: 각 연간보고서는 **rcept_dt 이후**에만 사용한다(룩어헤드 차단).
 *
 * ═══ 한계 (정직히) ═══
 * · ROE 가 **과거 실적**이다. 원 자료는 12MF(12개월 선행, 애널리스트 추정)를 쓴다 — 같은 지표가 아니다.
 * · ROE·total_equity 가 연 1회 갱신 → 특징 변동의 대부분이 **가격**에서 온다.
 *   즉 잔차는 사실상 "느린 밸류 + 최근 가격" 혼합이다. 순수 밸류 신호로 해석하면 안 된다.
 * · 발행주식수가 현재 스냅샷 → 분할·증자 종목의 과거 BPS 가 왜곡된다.
 * · 생존편향: 풀이 현재 상장분.
 *
 * 실행: node --max-old-space-size=6144 research-roe-pbr.mjs
 */
import 'dotenv/config';
import { createReadStream } from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const CANDLES = String(argOf('--candles', 'candles-daily-toss-clean.jsonl'));
const MIN_TOV = Number(argOf('--minturnover', 3e9));
const HORIZONS = [5, 10, 20, 60];
const MIN_STOCKS = 60;

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── 1) 재무: 연간보고서(quarter IS NULL)만, ROE·total_equity·rcept_dt 필수 ──────
const fin = await dbQuery(`
  SELECT stock_code, analysis_year, roe, total_equity, rcept_dt
  FROM stock_financials
  WHERE quarter IS NULL AND roe IS NOT NULL AND total_equity > 0 AND rcept_dt IS NOT NULL
  ORDER BY stock_code, rcept_dt`);
const shares = new Map();
for (const r of await dbQuery(`SELECT stock_code, market_cap_tril, current_price FROM stock_analysis WHERE current_price > 0 AND market_cap_tril > 0`)) {
  const s = (Number(r.market_cap_tril) * 1e12) / Number(r.current_price);
  if (Number.isFinite(s) && s > 0) shares.set(r.stock_code, s);
}
// code → [{from(rcept_dt), roe, bps}] 시간순
const panel = new Map();
for (const r of fin) {
  const sh = shares.get(r.stock_code);
  if (!sh) continue;
  const bps = Number(r.total_equity) / sh;
  if (!(bps > 0)) continue;
  const from = String(r.rcept_dt).replace(/-/g, '').slice(0, 8);
  (panel.get(r.stock_code) ?? panel.set(r.stock_code, []).get(r.stock_code)).push({ from, roe: Number(r.roe), bps });
}
for (const a of panel.values()) a.sort((x, y) => x.from.localeCompare(y.from));
console.log(`재무 ${fin.length}행 · 발행주식수 ${shares.size}종목 · 패널 구성 ${panel.size}종목`);

/** day 시점에 유효한(공시된) 가장 최신 연간보고서 */
const finAt = (code, day) => {
  const a = panel.get(code); if (!a) return null;
  let r = null;
  for (const x of a) { if (x.from <= day) r = x; else break; }
  return r;
};

// ── 2) 일봉 ──────────────────────────────────────────────────────────────────
const C = [];
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream(CANDLES), crlfDelay: Infinity });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200 && panel.has(j.code)) C.push(j); } catch {} });
  rl.on('close', res);
});
console.log(`일봉 ${C.length}종목 (재무 패널과 교집합) · 데이터 ${CANDLES}`);

// ── 3) 결정적 노이즈 (귀무 대조군) ───────────────────────────────────────────
const h32 = (a, b) => { let x = (a * 374761393 + b * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177 | 0; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const seedOf = (code) => { let h = 0; for (const ch of String(code)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };

// ── 4) 일별 횡단면: 회귀 적합 → 잔차 → 전방수익 수집 ─────────────────────────
const atrPct = (j, i) => { let t = 0; for (let k = i - 13; k <= i; k++) t += Math.max(j.h[k] - j.l[k], Math.abs(j.h[k] - j.c[k - 1]), Math.abs(j.l[k] - j.c[k - 1])); return (t / 14) / j.c[i]; };
const idxOf = new Map(C.map(j => [j.code, new Map(j.d.map((d, i) => [String(d), i]))]));
const allDays = [...new Set(C.flatMap(j => j.d.map(String)))].sort();

const FEATS = ['resid', 'pbr', 'roe', 'NULL_a', 'NULL_b'];
const acc = {};   // feat → horizon → { ics:[], sps:[], byYear:Map }
for (const f of FEATS) acc[f] = HORIZONS.map(() => ({ ics: [], sps: [], byYear: new Map() }));
// 변동성 통제용: 저변동성 절반 / 고변동성 절반 안에서의 resid IC
const accVol = { lo: HORIZONS.map(() => ({ ics: [] })), hi: HORIZONS.map(() => ({ ics: [] })) };

const spearman = (xs, ys) => {
  const n = xs.length; if (n < 20) return null;
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Float64Array(n); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys);
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; } mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
};
const decileSpread = (xs, ys) => {
  const o = xs.map((v, i) => [v, ys[i]]).sort((a, b) => a[0] - b[0]);
  const k = Math.max(1, Math.floor(o.length / 10));
  const lo = o.slice(0, k).reduce((s, p) => s + p[1], 0) / k;
  const hi = o.slice(-k).reduce((s, p) => s + p[1], 0) / k;
  return (hi - lo) * 100;   // % 단위 (상위십분위 − 하위십분위)
};

let nDayUsed = 0;
for (const day of allDays) {
  if (day < '20230601') continue;                       // 첫 rcept_dt(20230526) 이후
  const rows = [];
  for (const j of C) {
    const i = idxOf.get(j.code).get(day);
    if (i == null || i < 60) continue;
    if (i + Math.max(...HORIZONS) >= j.d.length) continue;
    const f = finAt(j.code, day); if (!f) continue;
    let to = 0; for (let k = i - 19; k <= i; k++) to += j.c[k] * (j.v?.[k] ?? 0);
    if (to / 20 < MIN_TOV) continue;
    const pbr = j.c[i] / f.bps;
    if (!(pbr > 0) || pbr > 50) continue;                // 이상치 컷
    rows.push({ code: j.code, pbr, roe: f.roe, atr: atrPct(j, i), i, j });
  }
  if (rows.length < MIN_STOCKS) continue;
  nDayUsed++;
  // 횡단면 OLS: pbr = a*roe + b
  const n = rows.length;
  let sx = 0, sy = 0; for (const r of rows) { sx += r.roe; sy += r.pbr; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0; for (const r of rows) { sxy += (r.roe - mx) * (r.pbr - my); sxx += (r.roe - mx) ** 2; }
  const a = sxx > 0 ? sxy / sxx : 0, b = my - a * mx;
  for (const r of rows) r.resid = r.pbr - (a * r.roe + b);

  const y = day.slice(0, 4);
  const volSorted = [...rows].sort((p, q) => p.atr - q.atr);
  const half = Math.floor(volSorted.length / 2);
  const loSet = new Set(volSorted.slice(0, half).map(r => r.code));

  HORIZONS.forEach((h, hi) => {
    const fw = rows.map(r => r.j.c[r.i + h] / r.j.c[r.i] - 1);
    for (const f of FEATS) {
      const xs = rows.map((r, k) => f === 'NULL_a' ? h32(seedOf(r.code), nDayUsed)
        : f === 'NULL_b' ? h32(seedOf(r.code) ^ 0x5bf03635, nDayUsed * 7 + 1)
        : r[f]);
      const ic = spearman(xs, fw); if (ic == null) continue;
      const A = acc[f][hi];
      A.ics.push(ic); A.sps.push(decileSpread(xs, fw));
      (A.byYear.get(y) ?? A.byYear.set(y, []).get(y)).push(ic);
    }
    // 변동성 통제
    for (const [tag, pick] of [['lo', true], ['hi', false]]) {
      const sub = rows.filter(r => loSet.has(r.code) === pick);
      if (sub.length < 30) continue;
      const ic = spearman(sub.map(r => r.resid), sub.map(r => r.j.c[r.i + h] / r.j.c[r.i] - 1));
      if (ic != null) accVol[tag][hi].ics.push(ic);
    }
  });
}

// ── 5) 집계 ──────────────────────────────────────────────────────────────────
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const tval = (x) => { const m = mean(x); const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(x.length)) : 0; };

console.log(`\n사용 거래일 ${nDayUsed}일 · 지평 ${HORIZONS.join('/')}일 · 유동성 하한 ${(MIN_TOV / 1e8).toFixed(0)}억\n`);
console.log('특징      지평   일수    IC평균     t값     십분위스프레드   연도별 IC 부호');
console.log('─'.repeat(84));
const flat = [];
for (const f of FEATS) {
  HORIZONS.forEach((h, hi) => {
    const A = acc[f][hi]; if (A.ics.length < 50) return;
    const ic = mean(A.ics), t = tval(A.ics), sp = mean(A.sps);
    const yrs = [...A.byYear.entries()].sort().map(([, v]) => (mean(v) >= 0 ? '+' : '−'));
    const consistent = yrs.length > 1 && yrs.every(s => s === yrs[0]);
    flat.push({ f, h, ic, t, sp, consistent, n: A.ics.length });
    console.log(`${f.padEnd(9)} ${String(h).padStart(3)}일 ${String(A.ics.length).padStart(5)}  ${ic.toFixed(4).padStart(8)} ${t.toFixed(1).padStart(7)}   ${(sp.toFixed(3) + '%').padStart(10)}    ${yrs.join('')} ${consistent ? '✓일관' : ''}`);
  });
}

const nulls = flat.filter(r => r.f.startsWith('NULL_'));
const reals = flat.filter(r => !r.f.startsWith('NULL_'));
if (nulls.length) {
  const mxa = (k) => Math.max(...nulls.map(r => Math.abs(r[k])));
  const icF = mxa('ic'), tF = mxa('t'), spF = mxa('sp');
  console.log(`\n=== 귀무 바닥 (NULL ${nulls.length}건) ===`);
  console.log(`|IC| ${icF.toFixed(4)} · |t| ${tF.toFixed(2)} · |스프레드| ${spF.toFixed(3)}%`);
  const pass = reals.filter(r => Math.abs(r.ic) > icF && Math.abs(r.t) > tF && Math.abs(r.sp) > spF);
  console.log(`\n세 지표 모두 바닥 초과: ${pass.length}/${reals.length}건`);
  for (const r of pass.sort((x, y) => Math.abs(y.t) - Math.abs(x.t))) {
    console.log(`  ${r.f.padEnd(8)} ${String(r.h).padStart(2)}일  IC ${r.ic.toFixed(4)}  t ${r.t.toFixed(1)}  스프레드 ${r.sp.toFixed(3)}%  ${r.consistent ? '연도일관' : '연도불일치'}`);
  }
  if (!pass.length) console.log('  없음 — 노이즈를 넘는 예측력이 검출되지 않았다.');
}

console.log(`\n=== 변동성 통제: 잔차 IC (저변동성 절반 vs 고변동성 절반) ===`);
HORIZONS.forEach((h, hi) => {
  const L = accVol.lo[hi].ics, H = accVol.hi[hi].ics;
  if (L.length < 50 || H.length < 50) return;
  console.log(`  ${String(h).padStart(2)}일  저변동성군 IC ${mean(L).toFixed(4)} (t ${tval(L).toFixed(1)})  ·  고변동성군 IC ${mean(H).toFixed(4)} (t ${tval(H).toFixed(1)})`);
});
console.log(`※ 두 군에서 부호·크기가 유지되면 잔차가 변동성의 대리변수가 아니다. 한쪽만 유의하면 교란이다.`);
console.log(`※ ROE 는 과거 실적이다 — 원 자료의 12MF(선행 추정)와 다른 지표다.`);
console.log(`※ ROE·BPS 가 연 1회 갱신이라 특징 변동의 대부분은 가격에서 온다. 순수 밸류 신호가 아니다.`);
