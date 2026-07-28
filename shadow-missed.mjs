/**
 * shadow-missed.mjs — **미진입 평가(counterfactual)**: "안 산 것 중에 사야 했던 게 있었나" (2026-07-27)
 *
 * 계기: 노타(486990) 저점 15,130 → 3일 +43.8%. 라이브봇은 07-20에 RSI2=0.0·레짐 DOWN으로 **자격이 있었는데**
 *   거래량비 0.39x < rsiVolMin 1.25에서 걸렸다. 실제 거래만 평가하면 이런 "놓친 기회"가 영원히 안 보인다.
 *
 * 방법: 일봉 3.4년 전체 유니버스에서 "이후 N일 내 +M% 이상 간 날"을 찾고, **그날 어느 게이트가 막았는지** 집계한다.
 *   → "어느 필터가 큰 상승을 가장 많이 놓치는가"가 나온다.
 * 한계(정직히): 분봉 게이트(VWAP 위·저점상승·되돌림)는 과거 재현 불가 → **일봉으로 계산되는 게이트만** 평가한다.
 *   노타를 막은 게 일봉 게이트(거래량비)였으므로 이 범위로도 핵심 질문엔 답한다.
 *   생존편향: 현재 상장 종목만 → 놓친 기회 건수는 낙관(폐지된 종목의 급등은 안 잡힘).
 *
 * 실행: node shadow-missed.mjs [--fwd 5] [--gain 20] [--from 20230102] [--top 15]
 */
import { createReadStream } from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FWD = Number(argOf('--fwd', 5));        // 이후 며칠 안에
const GAIN = Number(argOf('--gain', 20));     // 몇 % 이상 오르면 "놓친 기회"
const FROM = String(argOf('--from', '20230102'));
const TOPN = Number(argOf('--top', 15));
const MIN_TURNOVER = 30e8;

const C = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => { if (!l.trim()) return; try { const j = JSON.parse(l); if (j.c?.length >= 200) C.set(j.code, j); } catch {} });
  rl.on('close', res);
});
const mkt = C.get('005930');
const mIdx = new Map(mkt.d.map((d, i) => [d, i]));

// 날짜별 시장 상태 사전계산 (레짐 + 20일 수익률)
const dayMkt = new Map();
for (let i = 130; i < mkt.d.length; i++) {
  const avg = (n) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += mkt.c[k]; return s / n; };
  const ma20 = avg(20), ma60 = avg(60), ret5 = (mkt.c[i] / mkt.c[i - 5] - 1) * 100;
  const reg = (mkt.c[i] > ma20 && ma20 > ma60) ? 'UP' : ((mkt.c[i] < ma20 && ret5 < -3) ? 'DOWN' : 'NEUTRAL');
  dayMkt.set(mkt.d[i], { reg, ret20: mkt.c[i] / mkt.c[i - 20] - 1 });
}
console.log(`종목 ${C.size} · 기준 "${FWD}일 내 +${GAIN}% 이상" · ${FROM}~${mkt.d.at(-1)}`);

const rsi2 = (j, i) => { let g = 0, l = 0; for (let k = i - 1; k <= i; k++) { const ch = j.c[k] - j.c[k - 1]; if (ch > 0) g += ch; else l -= ch; } return l === 0 ? 100 : 100 - 100 / (1 + (g / 2) / (l / 2)); };

// 룰별 게이트 정의 — 전부 **일봉으로 계산 가능한 것만**
function gatesOf(j, i, m) {
  const n = { };
  let ma20 = 0; for (let k = i - 19; k <= i; k++) ma20 += j.c[k]; ma20 /= 20;
  let ma60 = 0; for (let k = i - 59; k <= i; k++) ma60 += j.c[k]; ma60 /= 60;
  let hi120 = 0; for (let k = i - 119; k <= i; k++) hi120 = Math.max(hi120, j.h[k]);
  let av = 0; for (let k = i - 20; k < i; k++) av += j.v[k]; av /= 20;
  let tv = 0; for (let k = i - 19; k <= i; k++) tv += j.c[k] * j.v[k]; tv /= 20;
  const dayRet = (j.c[i] / j.c[i - 1] - 1) * 100;
  const volRatio = av > 0 ? j.v[i] / av : 0;
  const rs20 = ((j.c[i] / j.c[i - 20] - 1) - m.ret20) * 100;
  const r2 = rsi2(j, i);

  n.공통 = [];
  if (tv < MIN_TURNOVER) n.공통.push('유동성 30억미만');
  if (j.c[i] < 2000) n.공통.push('저가주');

  n.B_rs = [...n.공통];
  if (dayRet <= 0) n.B_rs.push('전일대비 음수');
  if (j.c[i] < ma20) n.B_rs.push('MA20 아래');
  if (rs20 <= 0) n.B_rs.push('시장대비 약세');

  n.A_hi120 = [...n.B_rs];
  if (j.c[i] / hi120 < 0.90) n.A_hi120.push('120일고가 -10%초과');

  n.D_nochase = [...n.B_rs];
  if (dayRet > 8) n.D_nochase.push('당일 8%초과 추격');

  n.C_self = [...n.공통];
  if (!(j.c[i] > ma20 && ma20 > ma60)) n.C_self.push('종목레짐 UP아님');

  // 라이브봇 실제 룰
  n['라이브_rsi2'] = [...n.공통];
  if (r2 >= 10) n['라이브_rsi2'].push('RSI2 10이상');
  if (volRatio < 1.25) n['라이브_rsi2'].push('거래량비 1.25미만');
  if (m.reg === 'NEUTRAL') n['라이브_rsi2'].push('레짐 NEUTRAL(스킵)');

  n['라이브_hi120'] = [...n.공통];
  if (m.reg !== 'UP') n['라이브_hi120'].push('레짐 UP아님');
  let prevHi = 0; for (let k = i - 120; k < i; k++) prevHi = Math.max(prevHi, j.h[k]);
  if ((j.c[i] / prevHi - 1) * 100 < 3) n['라이브_hi120'].push('돌파 3%미만');

  // V_bounce(2026-07-27): "노타형" 바닥반등 — 오늘 실측 5종목의 공통 조건을 그대로 소급 적용.
  //   ① 20일 최저가가 최근 5일 이내 ② 그 저점 대비 반등 ≥15% ③ 120일고가 대비 ≤80% ④ 거래량 ≥1.5x
  n.V_bounce = [...n.공통];
  {
    let lo = Infinity, loI = i;
    for (let k = i - 19; k <= i; k++) if (j.l[k] < lo) { lo = j.l[k]; loI = k; }
    const since = i - loI;
    if (!(since >= 1 && since <= 5)) n.V_bounce.push('저점 5일내 아님');
    if ((j.c[i] / lo - 1) * 100 < 15) n.V_bounce.push('반등 15%미만');
    if (j.c[i] / hi120 > 0.80) n.V_bounce.push('하락폭 부족(고가비 80%초과)');
    if (volRatio < 1.5) n.V_bounce.push('거래량 1.5x미만');
  }

  return { gates: n, dayRet, volRatio, rs20, r2, ma20, hi120 };
}

const RULES = ['라이브_rsi2', '라이브_hi120', 'A_hi120', 'B_rs', 'C_self', 'D_nochase', 'V_bounce'];
const block = {};        // rule → gate → count (큰 상승을 막은 게이트)
const caught = {};       // rule → 큰 상승 중 통과 건수
const passed = {};       // rule → **전체** 종목-일 중 통과 건수 (정밀도 분모)
const cases = [];
let total = 0, universe = 0;
const BASE = { up: 0, dn: 0, n: 0 };   // 비교군: 유동성 통과 전체(랜덤 매수) 비대칭
const fwdSum = {};       // rule → {up, dn, n} 통과일의 이후 상승여력/하락위험 평균 (RR 계산)
for (const r of RULES) { block[r] = {}; caught[r] = 0; passed[r] = 0; fwdSum[r] = { up: 0, dn: 0, n: 0 }; }

for (const [code, j] of C) {
  const n = j.c.length;
  for (let i = 130; i + FWD < n; i++) {
    if (j.d[i] < FROM) continue;
    const m = dayMkt.get(j.d[i]);
    if (!m) continue;
    // 유동성 미달은 애초에 투자 대상이 아니므로 분모에서 제외
    let tv = 0; for (let k = i - 19; k <= i; k++) tv += j.c[k] * j.v[k];
    if (tv / 20 < MIN_TURNOVER) continue;
    universe++;
    /* BASE 누적은 fwd 계산 후 */
    let fwdHi = 0, fwdLo = Infinity;
    for (let k = i + 1; k <= i + FWD; k++) { fwdHi = Math.max(fwdHi, j.h[k]); fwdLo = Math.min(fwdLo, j.l[k]); }
    const fwd = (fwdHi / j.c[i] - 1) * 100;
    const fwdDn = (fwdLo / j.c[i] - 1) * 100;
    BASE.up += fwd; BASE.dn += fwdDn; BASE.n++;
    const big = fwd >= GAIN;
    if (big) total++;
    // ★ 정밀도를 재려면 큰 상승뿐 아니라 **모든 날**의 통과 여부를 알아야 한다.
    //   포착률(recall)만 보면 "다 사는 룰"이 최고로 보인다 — 리프트로 봐야 판별력이 나온다.
    const g = gatesOf(j, i, m);
    for (const r of RULES) {
      const ok = g.gates[r].length === 0;
      if (ok) { passed[r]++; fwdSum[r].up += fwd; fwdSum[r].dn += fwdDn; fwdSum[r].n++; }
      if (!big) continue;
      if (ok) caught[r]++;
      else for (const f of g.gates[r]) block[r][f] = (block[r][f] ?? 0) + 1;
    }
    if (big && fwd >= GAIN * 2) cases.push({ code, d: j.d[i], fwd, dayRet: g.dayRet, volRatio: g.volRatio, r2: g.r2, reg: m.reg, blockedRsi2: g.gates['라이브_rsi2'].join('+') || '통과' });
  }
}

const baseRate = total / universe * 100;   // 아무 날이나 사면 큰 상승을 만날 확률
console.log(`\n=== 유동성 통과 종목-일 ${universe.toLocaleString()}건 중 큰 상승(${FWD}일 내 +${GAIN}%) ${total.toLocaleString()}건 = 기저확률 ${baseRate.toFixed(1)}% ===`);
console.log('\n── 룰별 포착률(recall) vs 적중률(precision) vs 리프트 ──');
console.log('   리프트 = 적중률 / 기저확률. 1.0이면 랜덤과 같다 = 판별력 0.');
console.log('룰               통과일수   포착   포착률   적중률   리프트');
for (const r of RULES) {
  const prec = passed[r] ? caught[r] / passed[r] * 100 : 0;
  const lift = baseRate > 0 ? prec / baseRate : 0;
  console.log(`${r.padEnd(14)} ${String(passed[r]).padStart(8)} ${String(caught[r]).padStart(6)}  ${(caught[r] / total * 100).toFixed(1).padStart(6)}%  ${prec.toFixed(1).padStart(6)}%  ${lift.toFixed(2).padStart(6)}`);
}

// ★ 상승확률(리프트)만 보면 안 된다: 크게 오를 확률이 높은 종목은 크게 빠질 확률도 높다.
//   실제 손익을 가르는 건 **비대칭(RR)**이다. 통과일의 이후 여력/위험 평균으로 본다.
console.log('\n── 통과일의 이후 5일 비대칭 (여기가 진짜 기준) ──');
console.log('룰               평균여력  평균위험    RR    통과일수');
const allDays = { up: 0, dn: 0, n: 0 };
for (const r of RULES) {
  const f = fwdSum[r];
  if (!f.n) continue;
  const up = f.up / f.n, dn = f.dn / f.n;
  console.log(`${r.padEnd(14)} ${('+' + up.toFixed(2) + '%').padStart(8)}  ${(dn.toFixed(2) + '%').padStart(8)}  ${(up / Math.abs(dn)).toFixed(2).padStart(5)}  ${String(f.n).padStart(8)}`);
}
console.log(`${'(기저=랜덤)'.padEnd(14)} ${('+' + (BASE.up / BASE.n).toFixed(2) + '%').padStart(8)}  ${(BASE.dn / BASE.n).toFixed(2).padStart(7)}%  ${((BASE.up / BASE.n) / Math.abs(BASE.dn / BASE.n)).toFixed(2).padStart(5)}  ${String(BASE.n).padStart(8)}`);

console.log('\n── 어느 게이트가 큰 상승을 가장 많이 막았나 ──');
for (const r of RULES) {
  const rows = Object.entries(block[r]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!rows.length) continue;
  console.log(`${r}:`);
  for (const [g, c] of rows) console.log(`   ${g.padEnd(22)} ${String(c).padStart(6)}건  ${(c / total * 100).toFixed(1)}%`);
}

console.log(`\n── 특히 큰 기회(+${GAIN * 2}% 이상) ${cases.length}건 중 최근 ${TOPN}건 ──`);
console.log('종목    날짜      이후최대  당일비   거래량비  RSI2   레짐      라이브rsi2 차단사유');
for (const c of cases.sort((a, b) => b.d.localeCompare(a.d)).slice(0, TOPN)) {
  console.log(`${c.code}  ${c.d}  ${('+' + c.fwd.toFixed(1) + '%').padStart(7)}  ${((c.dayRet >= 0 ? '+' : '') + c.dayRet.toFixed(1) + '%').padStart(6)}  ${c.volRatio.toFixed(2).padStart(6)}x  ${c.r2.toFixed(1).padStart(5)}  ${c.reg.padEnd(8)}  ${c.blockedRsi2}`);
}
console.log('\n⚠️ 분봉 게이트(VWAP·저점상승·되돌림)는 과거 재현 불가 → 일봉 게이트만 평가. 생존편향으로 건수는 낙관.');
