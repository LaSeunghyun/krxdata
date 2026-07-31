/**
 * research-value-cash.mjs — 밸류·현금흐름 팩터 통합 검정 (2026-07-31)
 *
 * ═══ 두 가설을 같은 프레임에서 검정한다 ═══
 * ① ROE-PBR 회귀 잔차 (증권가 밸류에이션 표준):
 *    PBR 을 ROE 에 회귀해 회귀선 아래면 저평가. 제시 예 PBR=0.0696×ROE+0.2953.
 *    → 계수를 고정하지 않고 **매일 횡단면 재적합**한다(지수용 계수를 종목에 갖다 붙이면 안 된다).
 * ② "현금은 거짓말하지 않는다" (자료 2):
 *    회계이익은 현금유출입과 무관하게 손익계산서에 기재된다. 투자는 실제 현금을 본다.
 *    → **현금흐름 기반 지표가 이익 기반 지표보다 예측력이 높은가**를 직접 비교한다.
 *
 * ═══ 오늘 확립한 검정 규율을 전부 적용 ═══
 * · 포트폴리오 없음 — 매일 횡단면 순위 → Spearman IC + 십분위 스프레드
 * · **귀무 대조군** 2개(결정적 노이즈) → |IC|·t·스프레드 바닥 실측
 * · **직교화(방안 C)** — 이미 유의한 것으로 측정된 통제변수에 회귀하고 **나머지만** 검정한다.
 *   통제: ret20 · distMA60 · atrPct · pos120 (research-ic.mjs 에서 t -5.9 / -6.5 / -23.2 / 유의)
 *   이게 핵심이다: 잔차가 그 선형결합에 불과하면 **새 정보가 0**이다.
 * · **왜곡종목 배제(방안 E)** — stock_analysis.bonus_flag 종목 제외(무상증자로 과거 BPS 왜곡).
 * · 시점 정합 — 각 연간보고서는 `rcept_dt` 이후에만 사용(룩어헤드 차단).
 *
 * ═══ PBR·시총을 가격에서 만드는 이유 ═══
 * stock_financials.pbr / market_cap 은 **행 기록 시점** 값이라 과거 행이 어긋난다
 * (SK하이닉스 2024: pbr 11.48 vs market_cap/total_equity 18.735).
 * 그래서 발행주식수(=stock_analysis.market_cap_tril×1e12/current_price)로 BPS 를 만들고
 * PBR_t = 종가_t / BPS, 시총_t = 종가_t × 주식수 로 매일 재계산한다.
 *
 * ═══ 남는 한계 (해소 못 함) ═══
 * · ROE·현금흐름이 **연 1회**다(2023·2024·2025 3시점). 원 자료의 12MF(선행 추정)와 다른 지표다.
 *   분기 TTM 은 DB 에 재료가 없다(분기 행에 net_income·total_equity 전부 0건, revenue 만 있음).
 *   → OpenDART 직접 수집이 필요하고 그건 별도 프로젝트다(방안 B).
 * · 발행주식수가 현재 스냅샷 → bonus_flag 로 일부만 배제. 무상증자 외 분할·감자는 남는다.
 * · 생존편향: 풀이 현재 상장분.
 *
 * 실행: node --max-old-space-size=6144 research-value-cash.mjs
 */
import 'dotenv/config';
import { createReadStream } from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const CANDLES = String(argOf('--candles', 'candles-daily-toss-clean.jsonl'));
const MIN_TOV = Number(argOf('--minturnover', 3e9));
const HORIZONS = [5, 20, 60];
const MIN_STOCKS = 60;
const KEEP_BONUS = argv.includes('--keepbonus');   // 기본은 무상증자 종목 배제

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── 1) 정적 메타: 주식수 + 무상증자 플래그 ───────────────────────────────────
const shares = new Map(), bonus = new Set();
for (const r of await dbQuery(`SELECT stock_code, market_cap_tril, current_price, bonus_flag FROM stock_analysis WHERE current_price > 0 AND market_cap_tril > 0`)) {
  const s = (Number(r.market_cap_tril) * 1e12) / Number(r.current_price);
  if (Number.isFinite(s) && s > 0) shares.set(r.stock_code, s);
  if (r.bonus_flag) bonus.add(r.stock_code);
}

// ── 2) 연간 재무 패널 (시점 정합) ─────────────────────────────────────────────
const fin = await dbQuery(`
  SELECT stock_code, analysis_year, roe, net_income, op_income, cf_ops, capex, total_asset, total_equity, rcept_dt
  FROM stock_financials
  WHERE quarter IS NULL AND rcept_dt IS NOT NULL
    AND roe IS NOT NULL AND net_income IS NOT NULL AND cf_ops IS NOT NULL AND total_equity > 0 AND total_asset > 0
  ORDER BY stock_code, rcept_dt`);
const panel = new Map();
for (const r of fin) {
  const sh = shares.get(r.stock_code); if (!sh) continue;
  if (!KEEP_BONUS && bonus.has(r.stock_code)) continue;
  const bps = Number(r.total_equity) / sh;
  if (!(bps > 0)) continue;
  const rec = {
    from: String(r.rcept_dt).replace(/-/g, '').slice(0, 8),
    roe: Number(r.roe), bps, sh,
    ni: Number(r.net_income), oi: Number(r.op_income ?? 0),
    cfo: Number(r.cf_ops), capex: Number(r.capex ?? 0), ta: Number(r.total_asset),
  };
  if (!panel.has(r.stock_code)) panel.set(r.stock_code, []);
  panel.get(r.stock_code).push(rec);
}
for (const a of panel.values()) a.sort((x, y) => x.from.localeCompare(y.from));
console.log(`재무 ${fin.length}행 · 주식수 ${shares.size}종목 · 무상증자 플래그 ${bonus.size}종목${KEEP_BONUS ? '(유지)' : '(배제)'} → 패널 ${panel.size}종목`);

const finAt = (code, day) => { const a = panel.get(code); if (!a) return null; let r = null; for (const x of a) { if (x.from <= day) r = x; else break; } return r; };

// ── 3) 일봉 ──────────────────────────────────────────────────────────────────
const C = [];
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream(CANDLES), crlfDelay: Infinity });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200 && panel.has(j.code)) C.push(j); } catch {} });
  rl.on('close', res);
});
const idxOf = new Map(C.map(j => [j.code, new Map(j.d.map((d, i) => [String(d), i]))]));
const allDays = [...new Set(C.flatMap(j => j.d.map(String)))].sort();
console.log(`일봉 ${C.length}종목 (패널 교집합) · ${CANDLES}`);

// ── 4) 통계 도구 ─────────────────────────────────────────────────────────────
const h32 = (a, b) => { let x = (a * 374761393 + b * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177 | 0; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const seedOf = (c) => { let h = 0; for (const ch of String(c)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; };
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const tval = (x) => { if (x.length < 3) return 0; const m = mean(x); const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(x.length)) : 0; };
/**
 * ★ 2026-07-31 추가: 자기상관 보정.
 *
 * 왜 필요한가 — 순진한 t 는 일별 IC 가 독립이라고 가정한다. 그런데 이 연구는 두 겹으로 종속이다:
 *   ① 전방수익이 h일 겹친다(20일 지평이면 연속 19일이 같은 미래를 공유)
 *   ② **재무 특징이 연 1회 갱신**이라 같은 횡단면이 약 170일씩 반복된다
 * 그래서 `roe 60일 t 13.6` 같은 값은 실효 표본이 3(보고서 시점)에 가까운데 510으로 계산된 것이다.
 * 보정 없이 읽으면 오늘 하루 종일 잡아온 "노이즈 바닥" 규율을 이 층에서 스스로 깨는 셈이다.
 *
 * 두 가지를 나란히 낸다:
 *   · Newey-West: 겹침(①)을 lag L=h 까지의 자기공분산으로 보정. Bartlett 커널.
 *   · 비중복(non-overlapping): h일 간격으로 골라 겹침을 **구조적으로 제거**. 표본이 1/h 로 줄지만 독립에 가깝다.
 * ②(연 1회 갱신)는 어느 쪽으로도 완전히 해소되지 않는다 → 연도부호 일관성(N=3)을 최종 근거로 병기한다.
 */
const tvalNW = (x, L) => {
  const n = x.length; if (n < 10) return 0;
  const m = mean(x);
  const g = (l) => { let s = 0; for (let i = l; i < n; i++) s += (x[i] - m) * (x[i - l] - m); return s / n; };
  let v = g(0);
  const LL = Math.min(L, n - 2);
  for (let l = 1; l <= LL; l++) v += 2 * (1 - l / (LL + 1)) * g(l);
  return v > 0 ? m / Math.sqrt(v / n) : 0;
};
const tvalNonOverlap = (x, stride) => { const sub = []; for (let i = 0; i < x.length; i += Math.max(1, stride)) sub.push(x[i]); return { t: tval(sub), n: sub.length }; };
const spearman = (xs, ys) => {
  const n = xs.length; if (n < 20) return null;
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Float64Array(n); o.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys);
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; } mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
};
const decile = (xs, ys) => {
  const o = xs.map((v, i) => [v, ys[i]]).sort((a, b) => a[0] - b[0]);
  const k = Math.max(1, Math.floor(o.length / 10));
  return ((o.slice(-k).reduce((s, p) => s + p[1], 0) / k) - (o.slice(0, k).reduce((s, p) => s + p[1], 0) / k)) * 100;
};
/** 다변량 OLS 잔차: y 를 X(절편 포함)에 회귀하고 잔차 반환. 가우스 소거. */
function olsResid(y, X) {
  const n = y.length, p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p + 1));
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][a] * X[i][b]; A[a][b] = s; }
    let s = 0; for (let i = 0; i < n; i++) s += X[i][a] * y[i]; A[a][p] = s;
  }
  for (let c = 0; c < p; c++) {
    let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-10) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k]; }
  }
  const beta = Array.from({ length: p }, (_, i) => A[i][p] / A[i][i]);
  return y.map((v, i) => v - X[i].reduce((s, x, k) => s + x * beta[k], 0));
}
const atrPct = (j, i) => { let t = 0; for (let k = i - 13; k <= i; k++) t += Math.max(j.h[k] - j.l[k], Math.abs(j.h[k] - j.c[k - 1]), Math.abs(j.l[k] - j.c[k - 1])); return (t / 14) / j.c[i]; };
const pos120 = (j, i) => { let hi = -Infinity, lo = Infinity; for (let k = i - 119; k <= i; k++) { if (j.h[k] > hi) hi = j.h[k]; if (j.l[k] < lo) lo = j.l[k]; } return hi > lo ? (j.c[i] - lo) / (hi - lo) : 0.5; };
const distMA60 = (j, i) => { let s = 0; for (let k = i - 59; k <= i; k++) s += j.c[k]; return j.c[i] / (s / 60) - 1; };

// ── 5) 검정 대상 특징 ────────────────────────────────────────────────────────
//   [밸류·이익] pbr · roe · residPBR · ey(이익수익률) · oy(영업이익수익률)
//   [현금]      cfy(영업현금흐름수익률) · fcfy(FCF수익률) · cfconv(현금전환율) · accrual(발생액)
//   [귀무]      NULL_a · NULL_b
const FEATS = ['pbr', 'roe', 'residPBR', 'ey', 'oy', 'cfy', 'fcfy', 'cfconv', 'accrual', 'NULL_a', 'NULL_b'];
const CTRL = ['ret20', 'distMA60', 'atrPct', 'pos120'];
const acc = {};
for (const f of FEATS) acc[f] = { raw: HORIZONS.map(() => ({ ics: [], sps: [], byYear: new Map() })), orth: HORIZONS.map(() => ({ ics: [], sps: [], byYear: new Map() })) };

let nDay = 0;
for (const day of allDays) {
  if (day < '20230601') continue;
  const rows = [];
  for (const j of C) {
    const i = idxOf.get(j.code).get(day);
    if (i == null || i < 130) continue;
    if (i + Math.max(...HORIZONS) >= j.d.length) continue;
    const f = finAt(j.code, day); if (!f) continue;
    let to = 0; for (let k = i - 19; k <= i; k++) to += j.c[k] * (j.v?.[k] ?? 0);
    if (to / 20 < MIN_TOV) continue;
    const mc = j.c[i] * f.sh;
    const pbr = j.c[i] / f.bps;
    if (!(pbr > 0) || pbr > 50 || !(mc > 0)) continue;
    rows.push({
      code: j.code, i, j,
      pbr, roe: f.roe,
      ey: f.ni / mc, oy: f.oi / mc,
      cfy: f.cfo / mc, fcfy: (f.cfo - f.capex) / mc,
      cfconv: Math.abs(f.ni) > 1 ? Math.max(-5, Math.min(5, f.cfo / f.ni)) : 0,
      accrual: (f.ni - f.cfo) / f.ta,
      ret20: j.c[i] / j.c[i - 20] - 1, distMA60: distMA60(j, i), atrPct: atrPct(j, i), pos120: pos120(j, i),
    });
  }
  if (rows.length < MIN_STOCKS) continue;
  nDay++;
  // residPBR: 횡단면 단순회귀 pbr ~ roe
  const n = rows.length;
  const mx = mean(rows.map(r => r.roe)), my = mean(rows.map(r => r.pbr));
  let sxy = 0, sxx = 0; for (const r of rows) { sxy += (r.roe - mx) * (r.pbr - my); sxx += (r.roe - mx) ** 2; }
  const a1 = sxx > 0 ? sxy / sxx : 0, b1 = my - a1 * mx;
  for (const r of rows) r.residPBR = r.pbr - (a1 * r.roe + b1);
  for (const r of rows) { r.NULL_a = h32(seedOf(r.code), nDay); r.NULL_b = h32(seedOf(r.code) ^ 0x5bf03635, nDay * 7 + 1); }

  const X = rows.map(r => [1, r.ret20, r.distMA60, r.atrPct, r.pos120]);
  const y = day.slice(0, 4);
  HORIZONS.forEach((h, hi) => {
    const fw = rows.map(r => r.j.c[r.i + h] / r.j.c[r.i] - 1);
    for (const f of FEATS) {
      const xs = rows.map(r => r[f]);
      for (const [mode, vec] of [['raw', xs], ['orth', olsResid(xs, X)]]) {
        if (!vec) continue;
        const ic = spearman(vec, fw); if (ic == null) continue;
        const A = acc[f][mode][hi];
        A.ics.push(ic); A.sps.push(decile(vec, fw));
        if (!A.byYear.has(y)) A.byYear.set(y, []);
        A.byYear.get(y).push(ic);
      }
    }
  });
}

// ── 6) 출력 ──────────────────────────────────────────────────────────────────
console.log(`\n사용 거래일 ${nDay}일 · 지평 ${HORIZONS.join('/')}일 · 유동성 ${(MIN_TOV / 1e8).toFixed(0)}억 · 통제 ${CTRL.join('·')}\n`);
const flat = [];
for (const mode of ['raw', 'orth']) {
  console.log(`=== ${mode === 'raw' ? '원본 IC' : '직교화 후 IC (통제변수 제거)'} ===`);
  console.log('특징        지평   일수    IC평균   순진t   NW-t  비중복t/n  십분위스프레드  연도부호');
  console.log('─'.repeat(96));
  for (const f of FEATS) {
    HORIZONS.forEach((h, hi) => {
      const A = acc[f][mode][hi]; if (A.ics.length < 50) return;
      const ic = mean(A.ics), t = tval(A.ics), sp = mean(A.sps);
      const yrs = [...A.byYear.entries()].sort().map(([, v]) => (mean(v) >= 0 ? '+' : '−'));
      const cons = yrs.length > 1 && yrs.every(s => s === yrs[0]);
      const tNW = tvalNW(A.ics, h);
      const no = tvalNonOverlap(A.ics, h);
      flat.push({ f, h, mode, ic, t, tNW, tNO: no.t, nNO: no.n, sp, cons });
      console.log(`${f.padEnd(11)} ${String(h).padStart(3)}일 ${String(A.ics.length).padStart(5)}  ${ic.toFixed(4).padStart(8)} ${t.toFixed(1).padStart(7)} ${tNW.toFixed(1).padStart(7)} ${(no.t.toFixed(1) + '/' + no.n).padStart(9)}  ${(sp.toFixed(3) + '%').padStart(9)}   ${yrs.join('')}${cons ? ' ✓' : ''}`);
    });
  }
  console.log('');
}

for (const mode of ['raw', 'orth']) {
  const nl = flat.filter(r => r.mode === mode && r.f.startsWith('NULL_'));
  const re = flat.filter(r => r.mode === mode && !r.f.startsWith('NULL_'));
  if (!nl.length) continue;
  const mxa = (k) => Math.max(...nl.map(r => Math.abs(r[k])));
  const icF = mxa('ic'), tF = mxa('t'), spF = mxa('sp');
  const tFnw = Math.max(...nl.map(r => Math.abs(r.tNW))), tFno = Math.max(...nl.map(r => Math.abs(r.tNO)));
  const pass = re.filter(r => Math.abs(r.ic) > icF && Math.abs(r.tNW) > tFnw && Math.abs(r.tNO) > tFno && Math.abs(r.sp) > spF);
  console.log(`  (귀무 NW-t 바닥 ${tFnw.toFixed(2)} · 비중복t 바닥 ${tFno.toFixed(2)} — 판정은 **NW·비중복 둘 다** 초과 요구)`);
  console.log(`=== 귀무 바닥 [${mode}] |IC| ${icF.toFixed(4)} · |t| ${tF.toFixed(2)} · |스프레드| ${spF.toFixed(3)}% ===`);
  console.log(`세 지표 모두 초과: ${pass.length}/${re.length}건`);
  for (const r of pass.sort((x, y) => Math.abs(y.t) - Math.abs(x.t)))
    console.log(`  ${r.f.padEnd(10)} ${String(r.h).padStart(2)}일  IC ${r.ic.toFixed(4)}  순진t ${r.t.toFixed(1)} → NW ${r.tNW.toFixed(1)} · 비중복 ${r.tNO.toFixed(1)}(n=${r.nNO})  스프레드 ${r.sp.toFixed(3)}%  ${r.cons ? '연도일관' : '연도불일치'}`);
  if (!pass.length) console.log('  없음');
  console.log('');
}

console.log('=== 현금 vs 이익 직접 비교 (자료 2 가설) ===');
for (const mode of ['raw', 'orth']) {
  HORIZONS.forEach((h, hi) => {
    const g = (f) => { const A = acc[f][mode][hi]; return A.ics.length >= 50 ? { ic: mean(A.ics), t: tval(A.ics) } : null; };
    const e = g('ey'), c = g('cfy'), fc = g('fcfy');
    if (!e || !c) return;
    console.log(`  [${mode}] ${String(h).padStart(2)}일  이익수익률 t ${e.t.toFixed(1)} · 영업현금 t ${c.t.toFixed(1)} · FCF t ${fc ? fc.t.toFixed(1) : '-'}  → ${Math.abs(c.t) > Math.abs(e.t) ? '현금 우세' : '이익 우세'}`);
  });
}
console.log(`\n※ IC는 비용 전이다. 왕복 0.33%p + 스프레드를 넘어야 실현 가능하다.`);
console.log(`※ ROE·현금흐름이 연 1회(2023·2024·2025) → 특징 변동의 상당분이 가격에서 온다. 직교화 IC가 그 보정판이다.`);
console.log(`※ 원 자료는 12MF(선행 추정)를 쓴다. 여기 ROE 는 과거 실적이므로 같은 지표가 아니다.`);
