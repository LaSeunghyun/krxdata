import 'dotenv/config';
import { readFileSync } from 'fs';

const BASE = 'https://openapi.koreainvestment.com:9443';
const tok = JSON.parse(readFileSync('./.kis-token.json', 'utf8')).value;

async function opinionRange(code, d1, d2) {
  const u = new URL(BASE + '/uapi/domestic-stock/v1/quotations/invest-opinion');
  for (const [k, v] of Object.entries({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16633', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2 })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { authorization: `Bearer ${tok}`, appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET, tr_id: 'FHKST663300C0', custtype: 'P' } });
  const j = await r.json();
  const dates = [...new Set((j.output ?? []).map(x => x.stck_bsop_date))].sort();
  return { rt: j.rt_cd, n: (j.output ?? []).length, dates, tr_cont: r.headers.get('tr_cont') };
}

console.log('=== 한 번에 받을 수 있는 최대 범위 (삼성전자) ===');
for (const [d1, d2] of [['20230101', '20261231'], ['20240101', '20261231'], ['20250101', '20261231']]) {
  const r = await opinionRange('005930', d1, d2);
  console.log(`  ${d1}~${d2}: n=${r.n} ${r.n ? `실제 ${r.dates[0]}~${r.dates[r.dates.length - 1]}` : ''} tr_cont=${r.tr_cont ?? '-'}`);
}

console.log('\n=== 커버리지 적은 종목도 되나 (가온전선/중소형) ===');
for (const code of ['000500', '062040']) {
  const r = await opinionRange(code, '20230101', '20261231');
  console.log(`  ${code}: n=${r.n} ${r.n ? `${r.dates[0]}~${r.dates[r.dates.length - 1]}` : '없음'}`);
}

console.log('\n=== KRX 수급 재시도(세션 쿠키 확보 후) ===');
try {
  const jar = [];
  const g = await fetch('http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020103', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000),
  });
  const sc = g.headers.getSetCookie?.() ?? [];
  for (const c of sc) jar.push(c.split(';')[0]);
  console.log(`  세션 GET http=${g.status} cookies=${jar.length}`);
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT02303', locale: 'ko_KR',
    isuCd: 'KR7005930003', isuCd2: 'KR7005930003', strtDd: '20240102', endDd: '20240131',
    askBizTpCd: 'T', trdVolVal: '2', tabTpCd: '1', money: '1', csvxls_isNo: 'false',
  });
  const r = await fetch('http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020103',
      Cookie: jar.join('; '),
      'X-Requested-With': 'XMLHttpRequest',
    }, body, signal: AbortSignal.timeout(20000),
  });
  const txt = await r.text();
  console.log(`  POST http=${r.status} len=${txt.length}`);
  console.log('  ' + txt.slice(0, 350));
} catch (e) { console.log('  실패:', e.message); }
