/**
 * probe-investor-market.mjs — **시장 단위** 투자자별 매매동향의 장중 갱신 주기 실측
 *
 * ═══ 배경 (2026-08-03 조사) ═══
 * KRX 는 종목별 투자자 가집계를 하루 **5회만** 낸다: 09:30(외국인만)·10:00·11:30·13:20·14:30.
 * 확정은 15:35·18:00(NXT 20:05). KIS `HHPTJ04160200` 의 bsop_hour_gb 1~5 가 정확히 이 시각이다.
 * → 종목별 초/분 단위 투자자 데이터는 "API 를 못 찾은 것"이 아니라 **거래소가 만들지 않는다**.
 *
 * 남은 질문: **시장 단위**(KOSPI/KOSDAQ 합계)는 더 촘촘한가?
 * HTS 의 "투자자별 매매동향" 창은 장중 수시로 갱신되는 것처럼 보이므로 시장 단위 고빈도 피드가
 * 있을 가능성이 있다. 있으면 최소한 시장 레짐 판단에는 쓸 수 있다.
 *
 * 후보 엔드포인트(문서 대신 실호출로 확인):
 *   - inquire-investor-time-by-market / investor-trend-by-market 등 경로 변형
 *   - tr_id FHPTJ04030000 (시장별 투자자매매동향(시세)) · FHPTJ04040000 (시간별 투자자매매동향)
 *
 * 성공 시 output 의 시각 필드를 뽑아 **간격**을 재는 것이 목적이다.
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

async function probe(path, trId, params) {
  await sleep(230);
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const tag = `${path.split('/').pop()} [${trId}] ${JSON.stringify(params)}`;
  let j;
  try {
    const res = await fetch(u, {
      headers: {
        authorization: `Bearer ${await getToken()}`, appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET, tr_id: trId, custtype: 'P',
      },
      signal: AbortSignal.timeout(25_000),
    });
    j = await res.json();
  } catch (e) { console.log(`  ✗ ${tag}\n      통신실패 ${String(e.message).slice(0, 60)}`); return null; }
  if (j.rt_cd !== '0') { console.log(`  ✗ ${tag}\n      ${j.msg_cd ?? ''} "${String(j.msg1 ?? '').trim()}"`); return null; }
  for (const key of ['output', 'output1', 'output2']) {
    const o = j[key];
    if (!o) continue;
    const arr = Array.isArray(o) ? o : [o];
    if (!arr.length) continue;
    console.log(`  ✓ ${tag}`);
    console.log(`      ${key}: ${arr.length}행 · 키 ${Object.keys(arr[0]).join(' ')}`);
    console.log(`      첫행 ${JSON.stringify(arr[0])}`);
    // 시각처럼 보이는 필드를 찾아 간격을 잰다
    const timeKey = Object.keys(arr[0]).find(k => /hour|time|tm|hm/i.test(k));
    if (timeKey && arr.length > 2) {
      const ts = arr.map(r => String(r[timeKey]));
      console.log(`      시각(${timeKey}): ${ts.slice(0, 12).join(' ')}${ts.length > 12 ? ' …' : ''}`);
    }
  }
  return j;
}

console.log(`실행 KST ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}\n`);

console.log('【시장별 투자자매매동향 — 경로·TR 조합 탐색】');
const paths = [
  '/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market',
  '/uapi/domestic-stock/v1/quotations/investor-trend-by-market',
  '/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market',
  '/uapi/domestic-stock/v1/quotations/investor-trade-by-market',
];
const trs = ['FHPTJ04030000', 'FHPTJ04040000'];
const paramSets = [
  { FID_INPUT_ISCD: '0001', FID_INPUT_ISCD_1: 'KSP' },
  { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001' },
  { FID_INPUT_ISCD: '0001' },
];
for (const p of paths) for (const t of trs) for (const ps of paramSets) await probe(p, t, ps);

console.log('\n【대조: 종목별 가집계 시점 = KRX 공표 5회인지 확인 (005930)】');
const a = await probe('/uapi/domestic-stock/v1/quotations/investor-trend-estimate', 'HHPTJ04160200', { MKSC_SHRN_ISCD: '005930' });
if (a?.output2) {
  console.log('      bsop_hour_gb → KRX 공표시각 대응 가설: 1=09:30(외국인만) 2=10:00 3=11:30 4=13:20 5=14:30');
  for (const r of a.output2) console.log(`        gb=${r.bsop_hour_gb}  외 ${Number(r.frgn_fake_ntby_qty)}  기 ${Number(r.orgn_fake_ntby_qty)}`);
}
