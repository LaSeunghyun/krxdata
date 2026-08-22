#!/usr/bin/env node
/**
 * diag-alpha-beta.mjs — combo-v2 일별 수익률의 알파/베타 분해 (2026-08-08, 연구용·읽기전용)
 *
 * 왜: 원장 어디에도 알파/베타 분해가 없다. 모든 판정이 "자기 기준선 대비 Δ"였다.
 *   α가 0이면 combo-v2 는 알파가 없고 시장베타 × 레짐타이밍이며 연구 방향이 통째로 바뀐다.
 *
 * 입력: backtest-swing.mjs --dump 산출물(books.<strat>.daily = [{day, equity}])
 *   ⚠️ --dump 는 시뮬레이션에 영향이 없다(마지막에 파일만 쓴다). 항등 확인은 호출측에서 할 것.
 *
 * 시장 프록시 2종:
 *   ① 등가중 합성지수 — candles-daily-toss-clean.jsonl 전 종목 일수익률 평균. 거래 불가(참조용)
 *   ② KODEX 200(069500) 실제 일봉 — 거래 가능. ⚠️ ETF 는 KRX 정규장만, 종목 일봉은 KRX+NXT 통합
 *      = 세션 정의가 다르다. 이 불일치는 보정하지 않는다(보정하면 추정으로 메우는 셈).
 *
 * §1-C 규율: 순진한 t 는 자기상관으로 부풀려진다 → Newey-West(Bartlett) 표준오차를 병기한다.
 * §1-B 규율: 전기간 단일 측정 금지 → 전기간/IS/OOS 3구간을 각각 낸다.
 *
 * 실행: node diag-alpha-beta.mjs [--dump eq-base-rsivol0.json] [--strat combo-v2]
 */
import { readFileSync, existsSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DUMP = argOf('--dump', 'eq-base-rsivol0.json');
const STRAT = argOf('--strat', 'combo-v2');
const CANDLES = argOf('--candles', 'candles-daily-toss-clean.jsonl');
const IS_END = argOf('--isend', '20241231');
const OOS_BEG = argOf('--oosbeg', '20250102');
const TD = 246;                       // 연 거래일 (연율화)

// ── 1. 전략 일별 수익률 ─────────────────────────────────────
const dump = JSON.parse(readFileSync(join(__dirname, DUMP), 'utf8'));
const daily = dump.books[STRAT].daily;
if (!daily?.length) { console.error(`${DUMP} 에 books.${STRAT}.daily 가 없다`); process.exit(1); }
const sDays = daily.map(x => x.day);
const sEq = daily.map(x => x.equity);

// ── 2. 시장 프록시 ①: 등가중 합성지수 + 레짐 프록시 005930 ──
const px = new Map();                 // code -> Map(date -> close)
{
  const rl = createInterface({ input: createReadStream(join(__dirname, CANDLES)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    const m = new Map();
    for (let i = 0; i < o.d.length; i++) if (o.c[i] > 0) m.set(o.d[i], o.c[i]);
    px.set(o.code, m);
  }
}
const ewRet = new Map();              // date -> 등가중 일수익률
{
  const allDays = [...new Set([...px.values()].flatMap(m => [...m.keys()]))].sort();
  for (let i = 1; i < allDays.length; i++) {
    const d0 = allDays[i - 1], d1 = allDays[i];
    let sum = 0, n = 0;
    for (const m of px.values()) {
      const a = m.get(d0), b = m.get(d1);
      if (!a || !b) continue;
      const r = b / a - 1;
      if (r > -0.35 && r < 0.35) { sum += r; n++; }   // 액면분할·데이터오류 방어
    }
    if (n >= 200) ewRet.set(d1, sum / n);
  }
}

// ── 3. 시장 프록시 ②: KODEX 200 실제 일봉 (newest-first → reverse) ──
function loadEtf(code) {
  const f = join(__dirname, `etf-daily-${code}.json`);
  if (!existsSync(f)) return null;
  const bars = JSON.parse(readFileSync(f, 'utf8')).slice().reverse();   // ★ toss 는 newest-first
  const m = new Map();
  for (const b of bars) m.set(String(b.timestamp).slice(0, 10).replace(/-/g, ''), b.close);
  const days = [...m.keys()].sort();
  const ret = new Map();
  for (let i = 1; i < days.length; i++) ret.set(days[i], m.get(days[i]) / m.get(days[i - 1]) - 1);
  return ret;
}

// ── 4. 레짐 (backtest-swing proxyRegime 과 동일 판정식: 005930 SMA20/60 + ret5) ──
const regimeOf = (() => {
  const m = px.get('005930');
  const days = [...m.keys()].sort();
  const c = days.map(d => m.get(d));
  const idx = new Map(days.map((d, i) => [d, i]));
  return (day) => {
    let i = idx.get(day);
    if (i == null) { for (let j = days.length - 1; j >= 0; j--) if (days[j] <= day) { i = j; break; } }
    if (i == null || i < 60) return 'NEUTRAL';
    let maF = 0, maS = 0;
    for (let j = i - 19; j <= i; j++) maF += c[j];
    for (let j = i - 59; j <= i; j++) maS += c[j];
    maF /= 20; maS /= 60;
    const ret5 = (c[i] / c[i - 5] - 1) * 100;
    if (c[i] > maF && maF > maS) return 'UP';
    if (c[i] < maF && ret5 < -3) return 'DOWN';
    return 'NEUTRAL';
  };
})();

// ── 5. 회귀 + Newey-West ───────────────────────────────────
function ols(y, x) {
  const n = y.length;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const beta = sxy / sxx, alpha = my - beta * mx;
  const e = y.map((v, i) => v - alpha - beta * x[i]);
  const sse = e.reduce((a, b) => a + b * b, 0);
  const sst = y.reduce((a, b) => a + (b - my) ** 2, 0);
  return { n, alpha, beta, e, r2: 1 - sse / sst, sxx, mx, sse };
}
/** Newey-West(Bartlett, lag L) 표준오차. L=0 이면 순진한 OLS SE. */
function nwSE(fit, x, L) {
  const { n, e, mx, sxx } = fit;
  const z = x.map(v => v - mx);          // 기울기용 중심화 회귀자
  const zi = z.map((v, i) => v * e[i]);
  let S = zi.reduce((a, b) => a + b * b, 0);
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1);           // Bartlett 커널
    let s = 0;
    for (let i = l; i < n; i++) s += zi[i] * zi[i - l];
    S += 2 * w * s;
  }
  const seBeta = Math.sqrt(S) / sxx;
  // 절편: 회귀자 = 1
  let Sa = e.reduce((a, b) => a + b * b, 0);
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1);
    let s = 0;
    for (let i = l; i < n; i++) s += e[i] * e[i - l];
    Sa += 2 * w * s;
  }
  const seAlpha = Math.sqrt(Sa) / n;
  return { seAlpha, seBeta };
}
const mdd = (rets) => {                  // 수익률열 → 복리 MDD(%)
  let eq = 1, pk = 1, worst = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); worst = Math.max(worst, (pk - eq) / pk); }
  return worst * 100;
};
const stdev = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const cagr = (rets) => (rets.reduce((a, r) => a * (1 + r), 1) ** (TD / rets.length) - 1) * 100;

// ── 6. 정렬된 표본 만들기 ───────────────────────────────────
function sample(mktRet, filter) {
  const y = [], x = [], ds = [];
  for (let i = 1; i < sDays.length; i++) {
    const d = sDays[i];
    const m = mktRet.get(d);
    if (m == null) continue;                       // 시장 관측 없는 날은 버린다(추정으로 메우지 않는다)
    if (filter && !filter(d)) continue;
    y.push(sEq[i] / sEq[i - 1] - 1); x.push(m); ds.push(d);
  }
  return { y, x, ds };
}

function report(label, mktRet, filter, L) {
  const { y, x, ds } = sample(mktRet, filter);
  if (y.length < 30) { console.log(`${label.padEnd(26)} 표본부족 n=${y.length}`); return null; }
  const f = ols(y, x);
  const se = nwSE(f, x, L);
  const se0 = nwSE(f, x, 0);
  const aAnn = f.alpha * TD * 100;
  const tA = f.alpha / se.seAlpha, tA0 = f.alpha / se0.seAlpha;
  const tB = f.beta / se.seBeta;
  const resid = f.e.map(v => v + f.alpha);         // 헤지 포트폴리오 수익 = α + ε
  console.log(
    `${label.padEnd(26)} n=${String(f.n).padStart(4)} β=${f.beta.toFixed(3)} (t_NW ${tB.toFixed(1)}) ` +
    `α=${aAnn.toFixed(1)}%/yr t_NW=${tA.toFixed(2)} [순진 t=${tA0.toFixed(2)}, 배율 ${(tA0 / tA).toFixed(2)}×] ` +
    `R²=${(f.r2 * 100).toFixed(1)}% 잔차연변동성=${(stdev(f.e) * Math.sqrt(TD) * 100).toFixed(1)}% 잔차MDD=${mdd(resid).toFixed(1)}%`
  );
  return { ...f, aAnn, tA, tB, resid, ds, y, x };
}

// ── 7. 출력 ────────────────────────────────────────────────
const L = Number(argOf('--nwlag', '6'));   // floor(4*(T/100)^(2/9)) ≈ 6 @ T=868
console.log(`=== combo-v2 알파/베타 분해 === dump=${DUMP} · ${sDays[0]}~${sDays[sDays.length - 1]} · n일=${sDays.length}`);
console.log(`Newey-West Bartlett lag L=${L} · 연율화 ${TD}거래일 · IS≤${IS_END} / OOS≥${OOS_BEG}\n`);

const etf = loadEtf('069500');
const PROXIES = [['등가중 합성지수', ewRet]];
if (etf) PROXIES.push(['KODEX200(069500) 실측', etf]);

const results = {};
for (const [pname, mret] of PROXIES) {
  console.log(`\n──── 시장 프록시: ${pname} ────`);
  results[pname] = {};
  results[pname].all = report('전기간', mret, null, L);
  results[pname].is = report(`IS (~${IS_END})`, mret, d => d <= IS_END, L);
  results[pname].oos = report(`OOS (${OOS_BEG}~)`, mret, d => d >= OOS_BEG, L);
  console.log('  · 레짐별 (전기간)');
  for (const rg of ['UP', 'NEUTRAL', 'DOWN']) report(`    ${rg}`, mret, d => regimeOf(d) === rg, L);
}

// ── 7-B. 실제 투자비중(노출) 재구성 ─────────────────────────
// ⚠️ 부분익절 때문에 한 포지션이 2~3개 거래레코드로 쪼개진다(각 레코드가 자기 qty 슬라이스를 갖는다).
//    레코드 단위로 합산해야 노출이 맞고, "동시보유 종목수"는 code 로 중복제거해야 한다.
const expo = new Map();               // date -> 진입원가 기준 투자비중
{
  const dIdx = new Map(sDays.map((d, i) => [d, i]));
  const notional = new Array(sDays.length).fill(0);
  for (const t of dump.books[STRAT].trades) {
    const a = dIdx.get(t.eday), b = dIdx.get(String(t.day).replace(/-/g, ''));
    if (a == null || b == null) continue;
    for (let i = a; i < b; i++) notional[i] += t.entry * t.qty;
  }
  for (let i = 0; i < sDays.length; i++) expo.set(sDays[i], sEq[i] > 0 ? notional[i] / sEq[i] : 0);
}
{
  const v = sDays.map(d => expo.get(d));
  const cash = v.filter(x => x < 0.02).length;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sorted = [...v].sort((a, b) => a - b);
  console.log(`\n\n=== 실제 노출 === 평균 투자비중 ${(mean * 100).toFixed(1)}% · 중위 ${(sorted[sorted.length >> 1] * 100).toFixed(1)}% · 전액현금일 ${cash}/${v.length} (${(cash / v.length * 100).toFixed(1)}%)`);
  console.log('  → 포트폴리오 β 가 낮은 것은 종목이 저베타여서가 아니라 현금 때문일 수 있다. 조건부 β = β / 평균노출 로 대조한다.');
}

// ── 8. 헤지 시뮬레이션: 사전선언 게이트 판정 ────────────────
console.log('\n\n=== 헤지 포트폴리오 판정 (사전선언 게이트) ===');
console.log('게이트: 잔차 MDD ≤ 11.7%(인버스 ETF · carry 3.9%p/yr) / ≤ 14.9%(미니선물 · carry 0.3%p/yr)');
console.log('기준선: CAGR 32.8% · MDD 29.3% · Calmar 1.12\n');
for (const [pname, mret] of PROXIES) {
  const all = results[pname].all; if (!all) continue;
  // (a) 전기간 β 사용 = in-sample 헤지(낙관적 상한)
  // (b) IS 에서 추정한 β 를 OOS 에 적용 = 실행 가능한 형태
  const bIS = results[pname].is?.beta;
  for (const [tag, beta, rows] of [
    ['전기간 β(IS 낙관)', all.beta, all],
    ...(bIS != null && results[pname].oos ? [[`OOS(IS추정 β=${bIS.toFixed(3)})`, bIS, results[pname].oos]] : []),
  ]) {
    for (const [inst, carry] of [['인버스ETF', 0.039], ['미니선물', 0.003]]) {
      const h = rows.y.map((v, i) => v - beta * rows.x[i] - carry / TD);
      const c = cagr(h), m = mdd(h), gate = inst === '인버스ETF' ? 11.7 : 14.9;
      console.log(`${pname} · ${tag.padEnd(24)} ${inst.padEnd(8)} CAGR ${c.toFixed(1).padStart(6)}%  MDD ${m.toFixed(1).padStart(5)}%  Calmar ${(c / m).toFixed(2).padStart(5)}  게이트(${gate}%) ${m <= gate ? '통과' : '미달'}`);
    }
  }
}

// ── 9. 동적 헤지: 그날의 실제 투자비중만큼만 헤지한다 ────────
// 정적 헤지는 전액현금일(23%)에도 숏을 들고 있어 시장이 오르면 그대로 잃는다.
// 조건부 β(= 보유 중일 때의 β) × 그날 노출 = 실행 가능한 헤지비율.
console.log('\n=== 동적 헤지 (헤지비율 = 그날 투자비중 × 조건부 β) ===');
for (const [pname, mret] of PROXIES) {
  const all = results[pname].all; if (!all) continue;
  const meanExp = sDays.reduce((a, d) => a + expo.get(d), 0) / sDays.length;
  const bCond = all.beta / meanExp;
  for (const [tag, filt] of [['전기간', null], [`IS(~${IS_END})`, d => d <= IS_END], [`OOS(${OOS_BEG}~)`, d => d >= OOS_BEG]]) {
    const { y, x, ds } = sample(mret, filt);
    for (const [inst, carry] of [['인버스ETF', 0.039], ['미니선물', 0.003]]) {
      const h = y.map((v, i) => {
        const w = expo.get(ds[i]) ?? 0;
        return v - w * bCond * x[i] - (w * carry) / TD;
      });
      const c = cagr(h), m = mdd(h);
      console.log(`${pname} · ${tag.padEnd(18)} ${inst.padEnd(8)} 조건부β=${bCond.toFixed(3)}  CAGR ${c.toFixed(1).padStart(6)}%  MDD ${m.toFixed(1).padStart(5)}%  Calmar ${(c / m).toFixed(2).padStart(5)}`);
    }
  }
}
