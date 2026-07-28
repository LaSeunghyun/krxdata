import 'dotenv/config';
import { readFileSync } from 'fs';
import { getInvestorDaily } from './kis-api.js';

const BASE = 'https://openapi.koreainvestment.com:9443';
const tok = JSON.parse(readFileSync('./.kis-token.json', 'utf8')).value;

// 1) 애널리스트 의견 — 과거 구간 직접 요청이 되는가? (FHKST663300C0는 DATE_1/DATE_2를 받음)
console.log('=== 1. 애널리스트 의견 과거 조회 (삼성전자) ===');
async function opinionRange(code, d1, d2) {
  const u = new URL(BASE + '/uapi/domestic-stock/v1/quotations/invest-opinion');
  for (const [k, v] of Object.entries({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16633', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2 })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { authorization: `Bearer ${tok}`, appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET, tr_id: 'FHKST663300C0', custtype: 'P' } });
  const j = await r.json();
  const dates = [...new Set((j.output ?? []).map(x => x.stck_bsop_date))].sort();
  return { rt: j.rt_cd, msg: j.msg1, n: (j.output ?? []).length, dates };
}
for (const [d1, d2] of [['20230101', '20230630'], ['20240101', '20240630'], ['20250101', '20250630'], ['20260101', '20260630']]) {
  const r = await opinionRange('005930', d1, d2);
  console.log(`  ${d1}~${d2}: rt=${r.rt} n=${r.n} ${r.n ? `범위 ${r.dates[0]}~${r.dates[r.dates.length - 1]}` : r.msg}`);
}

// 2) 수급 — KIS 종목별 투자자동향 반환 범위
console.log('\n=== 2. KIS 수급(getInvestorDaily) 반환 범위 ===');
const inv = await getInvestorDaily('005930');
const idates = inv.map(x => x.date).sort();
console.log(`  n=${inv.length} 범위 ${idates[0]}~${idates[idates.length - 1]}`);

// 3) KRX 정보데이터시스템 — 과거 투자자별 매매동향(장기 히스토리)
console.log('\n=== 3. KRX data.krx.co.kr 개별종목 투자자별 매매동향 과거조회 ===');
try {
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT02303',
    locale: 'ko_KR', isuCd: 'KR7005930003', strtDd: '20240101', endDd: '20240131',
    askBizTpCd: 'T', trdVolVal: '2', tabTpCd: '1',
  });
  const r = await fetch('http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'Mozilla/5.0', Referer: 'http://data.krx.co.kr/' },
    body, signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  const rows = j.output ?? j.OutBlock_1 ?? [];
  console.log(`  http=${r.status} rows=${rows.length}`);
  console.log(rows.length ? '  샘플: ' + JSON.stringify(rows[0]).slice(0, 400) : '  raw: ' + JSON.stringify(j).slice(0, 300));
} catch (e) { console.log('  실패:', e.message); }
