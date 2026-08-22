/**
 * probe-investor-realtime3.mjs — 2차 프로브의 **측정기준 오류 수정판**
 *
 * 2차에서 상대오차 |추정−확정|/|확정| 의 중위값으로 판정했는데, 분모가 0 근처인 종목이
 * 지표를 지배했다(KT 확정 외국인 -0천주 → 오차 1344%, KT&G +5천주 → 429%).
 * 절대오차는 각각 4천주·23천주로 무의미하게 작다. 즉 **판정이 아니라 0 나눗셈을 본 것**이다.
 *
 * 고친 기준:
 *   1) 절대오차(천주)를 그대로 본다.
 *   2) 거래량 정규화 오차 = |추정−확정| / 당일거래량 — 규모와 무관하게 비교 가능하다.
 *   3) 수급이 유의미한 종목만 따로 본다(|확정 외국인| ≥ 당일거래량의 3%).
 *      수급이 없는 종목은 애초에 수급 신호를 쓸 대상이 아니다.
 *
 * 판정(사전 선언):
 *   - 거래량 정규화 오차 중위값 < 2%p 면 "실무적으로 쓸 만하다".
 *   - 유의미군에서만 성립하면 "유의미군 한정 사용" 으로 조건부 채택 검토.
 *   ※ 어느 쪽이든 **탐색 결과**다. 전략 반영은 MC 백테를 거쳐야 한다.
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
      authorization: `Bearer ${await getToken()}`, appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET, tr_id: trId, custtype: 'P',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const j = await res.json();
  if (j.rt_cd !== '0') throw new Error(`${j.msg_cd ?? ''} ${String(j.msg1 ?? '').trim()}`);
  return j;
}
const n = (v) => Number(String(v ?? '0').replace(/^([+-])?0*/, '$1')) || 0;
const med = (xs) => { const s = xs.filter(v => v != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

const CODES = [
  ['005930', '삼성전자'], ['000660', 'SK하이닉스'], ['005380', '현대차'], ['105560', 'KB금융'],
  ['035420', 'NAVER'], ['051910', 'LG화학'], ['068270', '셀트리온'], ['012330', '현대모비스'],
  ['207940', '삼성바이오'], ['029780', '삼성카드'], ['030200', 'KT'], ['033780', 'KT&G'], ['010950', 'S-Oil'],
];

console.log(`실행 KST ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}\n`);
console.log('단위: 천주 · 정규화오차 = |추정−확정| / 당일거래량');
console.log('종목          거래량   확정외국인 │ 가집계외 절대오차 정규화 │ 프로그램 절대오차 정규화 │ 유의미');
console.log('─'.repeat(108));

const rows = [];
for (const [code, name] of CODES) {
  let dF = null, vol = null, aF = null, pg = null;
  try {
    const d = await kis('/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
    const t = (d.output ?? [])[0];
    if (!t) continue;
    dF = n(t.frgn_ntby_qty);
  } catch { continue; }
  try {
    const e = await kis('/uapi/domestic-stock/v1/quotations/program-trade-by-stock', 'FHPPG04650100',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
    const r0 = (e.output ?? [])[0];
    if (r0) { pg = n(r0.whol_smtn_ntby_qty); vol = n(r0.acml_vol); }
  } catch { /* skip */ }
  try {
    const a = await kis('/uapi/domestic-stock/v1/quotations/investor-trend-estimate', 'HHPTJ04160200', { MKSC_SHRN_ISCD: code });
    const last = (a.output2 ?? []).sort((x, y) => n(y.bsop_hour_gb) - n(x.bsop_hour_gb))[0];
    if (last) aF = n(last.frgn_fake_ntby_qty);
  } catch { /* skip */ }
  if (vol == null || vol <= 0) continue;

  const absA = aF == null ? null : Math.abs(aF - dF);
  const absP = pg == null ? null : Math.abs(pg - dF);
  const nrmA = absA == null ? null : absA / vol * 100;
  const nrmP = absP == null ? null : absP / vol * 100;
  const meaningful = Math.abs(dF) / vol >= 0.03;
  rows.push({ name, dF, vol, aF, pg, nrmA, nrmP, meaningful });

  const k = (v) => v == null ? '     -' : (v / 1000).toFixed(0).padStart(6);
  const p = (v) => v == null ? '    -' : (v.toFixed(1) + '%').padStart(6);
  console.log(`${name.padEnd(12)} ${k(vol)}  ${k(dF)}   │ ${k(aF)} ${k(absA)} ${p(nrmA)} │ ${k(pg)} ${k(absP)} ${p(nrmP)} │ ${meaningful ? '  ●' : '  ·'}`);
}

const sig = rows.filter(r => r.meaningful);
console.log('\n=== 판정 (정규화오차 중위값) ===');
for (const [label, set] of [['전체', rows], [`유의미군(|외국인|≥거래량 3%)`, sig]]) {
  const a = med(set.map(r => r.nrmA)), p = med(set.map(r => r.nrmP));
  console.log(`${label} n=${set.length}`);
  console.log(`  가집계(A) : ${a == null ? '측정불가' : a.toFixed(2) + '%p'}${a == null ? '' : a < 2 ? '  ⭕ 쓸 만함' : '  ❌ 오차 큼'}`);
  console.log(`  프로그램(E): ${p == null ? '측정불가' : p.toFixed(2) + '%p'}${p == null ? '' : p < 2 ? '  ⭕ 쓸 만함' : '  ❌ 오차 큼'}`);
}
console.log('\n※ 이건 하루·13종목 탐색이다. 채택 판단에는 여러 날 표본과 MC 백테가 필요하다.');
