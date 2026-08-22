/**
 * probe-investor-realtime2.mjs — 장중 수급 경로의 **신뢰도 정량화** (프로브 2차)
 *
 * 1차(probe-investor-realtime.mjs)에서 확인된 것:
 *   A) investor-trend-estimate (HHPTJ04160200) · params={MKSC_SHRN_ISCD} · output2 5행
 *      → bsop_hour_gb 1~5 시점별 외국인·기관 **가집계 수량**(fake = 가집계)
 *   B) foreign-institution-total (FHPTJ04400000) · 시장 전체 순매수 상위 30 · 기관 세분류까지
 *   E) program-trade-by-stock (FHPPG04650100) · 종목별 프로그램매매 **시각별 시계열**
 *
 * 이 프로브가 답할 질문 (전부 사전 선언):
 *   Q1. A의 가집계는 확정치(D)와 얼마나 다른가? — **외국인/기관 배분 오차**가 핵심이다.
 *       1차 실측(005930 08-03): 가집계 외 -5,727천주/기 -1,951천주 vs 확정 외 -3,896천주/기 -5,040천주.
 *       합계는 14% 오차인데 배분은 뒤집혀 있다. 이게 여러 종목에서 재현되면 A의 개별 값은 못 쓴다.
 *   Q2. E(프로그램매매)가 확정 외국인 순매수의 대리지표가 되는가?
 *       1차 실측(005930): 프로그램 -3,884,708주 vs 확정 외국인 -3,896,489주 (0.3% 차이).
 *       한 종목·한 날의 일치는 우연일 수 있다 → 여러 종목에서 상관을 본다.
 *   Q3. E의 시간 해상도는? bsop_hour 간격과 행 수.
 *   Q4. C(comp-program-trade-today)의 필수 파라미터는?
 *
 * 판정 기준(사전 선언):
 *   - Q1: 외국인 배분 오차 중위값 > 30% 면 "A의 종목별 외/기 구분은 신뢰 불가, 합계만 참고".
 *   - Q2: |프로그램 − 확정외국인| / |확정외국인| 중위값 < 20% 면 "대리지표로 검토 가치 있음".
 *     ※ 이건 검증이 아니라 **탐색**이다. 채택은 MC 백테를 거쳐야 한다.
 */
import 'dotenv/config';

const BASE = 'https://openapi.koreainvestment.com:9443';
let token = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getToken() {
  if (token && Date.now() < token.exp - 60_000) return token.v;
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`토큰 실패 ${r.status}`);
  token = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return token.v;
}

async function kis(path, trId, params) {
  await sleep(220);
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, {
    headers: {
      authorization: `Bearer ${await getToken()}`,
      appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET,
      tr_id: trId, custtype: 'P',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const j = await res.json();
  if (j.rt_cd !== '0') throw new Error(`${j.msg_cd ?? ''} ${String(j.msg1 ?? '').trim()}`);
  return j;
}

const n = (v) => Number(String(v ?? '0').replace(/^([+-])?0*/, '$1')) || 0;
const pct = (a, b) => (Math.abs(b) < 1 ? null : Math.abs(a - b) / Math.abs(b) * 100);
const med = (xs) => { const s = xs.filter(v => v != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// 보유 5종목 + 시총 상위 대형주 (대형주일수록 프로그램·외국인 비중이 커 대리지표 성립 가능성이 높다)
const CODES = [
  ['005930', '삼성전자'], ['000660', 'SK하이닉스'], ['005380', '현대차'], ['105560', 'KB금융'],
  ['207940', '삼성바이오'], ['029780', '삼성카드'], ['030200', 'KT'], ['033780', 'KT&G'], ['010950', 'S-Oil'],
];

console.log(`실행 KST ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}\n`);
console.log('=== Q1·Q2: 가집계(A) / 프로그램(E) vs 확정(D) 대조 · 당일 순매수 수량(천주) ===');
console.log('종목          확정외국인  확정기관 │ 가집계외  가집계기 │ 외배분오차 │ 프로그램   vs확정외');
console.log('─'.repeat(104));

const errFrgn = [], errProg = [];
for (const [code, name] of CODES) {
  let d, a, e;
  try {
    d = await kis('/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
  } catch (err) { console.log(`${name.padEnd(12)} 확정 조회 실패: ${err.message}`); continue; }
  const today = (d.output ?? [])[0];
  if (!today) { console.log(`${name.padEnd(12)} 확정 데이터 없음`); continue; }
  const dF = n(today.frgn_ntby_qty), dO = n(today.orgn_ntby_qty);

  let aF = null, aO = null;
  try {
    a = await kis('/uapi/domestic-stock/v1/quotations/investor-trend-estimate', 'HHPTJ04160200', { MKSC_SHRN_ISCD: code });
    const last = (a.output2 ?? []).sort((x, y) => n(y.bsop_hour_gb) - n(x.bsop_hour_gb))[0];
    if (last) { aF = n(last.frgn_fake_ntby_qty); aO = n(last.orgn_fake_ntby_qty); }
  } catch { /* 표시만 생략 */ }

  let pg = null;
  try {
    e = await kis('/uapi/domestic-stock/v1/quotations/program-trade-by-stock', 'FHPPG04650100',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
    const rows = (e.output ?? []);
    if (rows.length) pg = n(rows[0].whol_smtn_ntby_qty);
  } catch { /* 표시만 생략 */ }

  const eF = aF == null ? null : pct(aF, dF);
  const eP = pg == null ? null : pct(pg, dF);
  if (eF != null) errFrgn.push(eF);
  if (eP != null) errProg.push(eP);
  const k = (v) => v == null ? '     -' : (v / 1000).toFixed(0).padStart(6);
  console.log(
    `${name.padEnd(12)} ${k(dF)}   ${k(dO)}  │ ${k(aF)}   ${k(aO)}  │ ` +
    `${(eF == null ? '   -' : eF.toFixed(0) + '%').padStart(7)}    │ ${k(pg)}   ${(eP == null ? '   -' : eP.toFixed(0) + '%').padStart(6)}`
  );
}

console.log('\n=== 판정 ===');
const mF = med(errFrgn), mP = med(errProg);
console.log(`Q1 가집계 외국인 배분 오차 중위값: ${mF == null ? '측정불가' : mF.toFixed(0) + '%'} (n=${errFrgn.length})`
  + (mF == null ? '' : mF > 30 ? ' → ❌ 종목별 외/기 구분 신뢰 불가' : ' → 참고 가능'));
console.log(`Q2 프로그램 vs 확정외국인 오차 중위값: ${mP == null ? '측정불가' : mP.toFixed(0) + '%'} (n=${errProg.length})`
  + (mP == null ? '' : mP < 20 ? ' → ⭕ 대리지표 검토 가치 있음 (채택은 MC 백테 필요)' : ' → ❌ 대리지표 부적합'));

console.log('\n=== Q3: E(program-trade-by-stock) 시간 해상도 ===');
try {
  const e = await kis('/uapi/domestic-stock/v1/quotations/program-trade-by-stock', 'FHPPG04650100',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930' });
  const hrs = (e.output ?? []).map(r => String(r.bsop_hour));
  console.log(`  행 수 ${hrs.length} · 범위 ${hrs.at(-1)} ~ ${hrs[0]}`);
  console.log(`  시각 목록: ${hrs.join(' ')}`);
  const toSec = (h) => Number(h.slice(0, 2)) * 3600 + Number(h.slice(2, 4)) * 60 + Number(h.slice(4, 6));
  const gaps = hrs.slice(0, -1).map((h, i) => toSec(h) - toSec(hrs[i + 1]));
  console.log(`  간격(초): ${gaps.join(' ')}`);
} catch (err) { console.log(`  실패: ${err.message}`); }

console.log('\n=== Q4: C(comp-program-trade-today) 필수 파라미터 탐색 ===');
for (const p of [
  { FID_COND_MRKT_DIV_CODE: 'J', FID_MRKT_CLS_CODE: 'K', FID_SCTN_CLS_CODE: '0', FID_INPUT_ISCD: '0000' },
  { FID_COND_MRKT_DIV_CODE: 'J', FID_MRKT_CLS_CODE: 'K', FID_SCTN_CLS_CODE: '1', FID_INPUT_ISCD: '0000' },
  { FID_COND_MRKT_DIV_CODE: 'U', FID_MRKT_CLS_CODE: 'K', FID_SCTN_CLS_CODE: '0', FID_INPUT_ISCD: '0001' },
]) {
  try {
    const j = await kis('/uapi/domestic-stock/v1/quotations/comp-program-trade-today', 'FHPPG04600101', p);
    const o = j.output ?? j.output1 ?? j.output2;
    const arr = Array.isArray(o) ? o : [o];
    console.log(`  ✓ ${JSON.stringify(p)}\n     ${arr.length}행 · 키 ${Object.keys(arr[0] ?? {}).join(' ')}`);
    console.log(`     첫행 ${JSON.stringify(arr[0])}`);
    break;
  } catch (err) { console.log(`  ✗ ${JSON.stringify(p)} → ${err.message}`); }
}
