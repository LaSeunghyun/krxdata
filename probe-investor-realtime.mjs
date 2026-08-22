/**
 * probe-investor-realtime.mjs — 장중 투자자 수급(외국인·기관·개인) 실시간 조회 경로 실측 프로브
 *
 * ═══ 왜 ═══
 * 현재 수급은 `flow-snapshot.mjs` → KIS `FHKST01010900`(주식현재가 투자자)로 **장마감 후 일별**만 받는다.
 * 그래서 장중에는 "누가 팔고 누가 받는지"를 알 수 없다(2026-08-03 실측: 오늘 수급 없음, 07-31까지).
 * KIS 에 장중 경로가 있는지 문서 대신 **실호출로** 확인한다 — 문서 검색은 파라미터 조합을 못 알려준다.
 *
 * ═══ 후보 엔드포인트 ═══
 *  A) investor-trend-estimate  (HHPTJ04160200) 종목별 외인기관 추정가집계 — 종목 단위, 장중 추정
 *  B) foreign-institution-total (FHPTJ04400000) 국내기관·외국인 매매종목 가집계 — 시장 단위 순위, 장중 가집계
 *  C) comp-program-trade-today  (FHPPG04600101) 프로그램매매 종합현황(시간) — 최근 30분, 09:00~15:30
 *  D) inquire-investor          (FHKST01010900) 현재 쓰는 것 — 일별 30일 (대조 기준선)
 *
 * 파라미터 조합을 모르므로 여러 벌을 시도하고 rt_cd·msg1 을 그대로 찍는다.
 * 성공하면 output 의 키와 첫 행을 보여준다 → 그걸로 수집기를 설계한다.
 *
 * KIS 는 Toss 토큰과 무관 → 라이브 봇 세션 경합 없음. 읽기 전용.
 *
 * 실행: node probe-investor-realtime.mjs [종목코드]
 */
import 'dotenv/config';

const BASE = 'https://openapi.koreainvestment.com:9443';
const CODE = process.argv[2] ?? '005930';
let token = null;

async function getToken() {
  if (token && Date.now() < token.exp - 60_000) return token.v;
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`토큰 실패 ${r.status} ${j.error_description ?? ''}`);
  token = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return token.v;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function probe(label, path, trId, params) {
  await sleep(200);                                    // KIS 초당 거래건수 제한 회피
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let j, status = 0;
  try {
    const res = await fetch(u, {
      headers: {
        authorization: `Bearer ${await getToken()}`,
        appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET,
        tr_id: trId, custtype: 'P',
      },
      signal: AbortSignal.timeout(25_000),
    });
    status = res.status;
    j = await res.json();
  } catch (e) {
    console.log(`  ✗ ${label}: 통신실패 ${String(e.message).slice(0, 70)}`);
    return null;
  }
  if (j.rt_cd !== '0') {
    console.log(`  ✗ ${label}: rt_cd=${j.rt_cd} msg_cd=${j.msg_cd ?? ''} "${String(j.msg1 ?? status).trim()}"`);
    return null;
  }
  // output / output1 / output2 어디에 담기는지 모른다 → 있는 것을 전부 본다
  for (const key of ['output', 'output1', 'output2']) {
    const o = j[key];
    if (!o) continue;
    const arr = Array.isArray(o) ? o : [o];
    if (!arr.length) { console.log(`  · ${label} ${key}: 빈 배열`); continue; }
    console.log(`  ✓ ${label} ${key}: ${arr.length}행`);
    console.log(`      키: ${Object.keys(arr[0]).join(' ')}`);
    console.log(`      첫행: ${JSON.stringify(arr[0])}`);
    if (arr.length > 1) console.log(`      둘째행: ${JSON.stringify(arr[1])}`);
  }
  return j;
}

const kst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
console.log(`실행시각 KST ${kst} · 대상 ${CODE}\n`);

console.log('【D】 현행 기준선 — inquire-investor (FHKST01010900) 일별');
await probe('일별투자자', '/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900',
  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: CODE });

console.log('\n【A】 investor-trend-estimate (HHPTJ04160200) 종목별 외인기관 추정가집계');
for (const p of [
  { MKSC_SHRN_ISCD: CODE },
  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: CODE },
  { MKSC_SHRN_ISCD: CODE, FID_COND_MRKT_DIV_CODE: 'J' },
]) await probe(`params=${JSON.stringify(p)}`, '/uapi/domestic-stock/v1/quotations/investor-trend-estimate', 'HHPTJ04160200', p);

console.log('\n【B】 foreign-institution-total (FHPTJ04400000) 매매종목 가집계');
for (const p of [
  { FID_COND_MRKT_DIV_CODE: 'V', FID_COND_SCR_DIV_CODE: '16449', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_RANK_SORT_CLS_CODE: '0', FID_ETC_CLS_CODE: '0' },
  { FID_COND_MRKT_DIV_CODE: 'V', FID_COND_SCR_DIV_CODE: '16449', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '1', FID_RANK_SORT_CLS_CODE: '0', FID_ETC_CLS_CODE: '1' },
]) await probe(`params=${JSON.stringify(p)}`, '/uapi/domestic-stock/v1/quotations/foreign-institution-total', 'FHPTJ04400000', p);

console.log('\n【C】 comp-program-trade-today (FHPPG04600101) 프로그램매매 종합현황(시간)');
for (const p of [
  { FID_COND_MRKT_DIV_CODE: 'J', FID_MRKT_CLS_CODE: 'K', FID_INPUT_ISCD: '0000' },
  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: CODE },
  { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001' },
]) await probe(`params=${JSON.stringify(p)}`, '/uapi/domestic-stock/v1/quotations/comp-program-trade-today', 'FHPPG04600101', p);

console.log('\n【E】 종목별 실시간 프로그램매매 REST 대응 — program-trade-by-stock (FHPPG04650100)');
for (const p of [
  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: CODE },
]) await probe(`params=${JSON.stringify(p)}`, '/uapi/domestic-stock/v1/quotations/program-trade-by-stock', 'FHPPG04650100', p);
