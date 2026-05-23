import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// .env 파싱
const envContent = readFileSync('C:/claudeT/files/.env', 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) env[m[1]] = m[2].trim();
}

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY;

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'count=exact'
};

async function query(table, params = '', countOnly = false) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: {
      ...headers,
      ...(countOnly ? { 'Prefer': 'count=exact', 'Range': '0-0' } : { 'Prefer': 'count=exact' })
    }
  });
  const count = res.headers.get('content-range');
  const data = await res.json();
  return { data, count, status: res.status };
}

async function getCount(table, filter = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${filter ? '?' + filter + '&' : '?'}select=*&limit=1`;
  const res = await fetch(url, {
    headers: { ...headers, 'Prefer': 'count=exact', 'Range': '0-0' }
  });
  const range = res.headers.get('content-range');
  // content-range: 0-0/1234 or 0-0/*
  if (range) {
    const m = range.match(/\/(\d+)/);
    if (m) return parseInt(m[1]);
  }
  return null;
}

async function getData(table, select, filter = '', limit = 1000, offset = 0) {
  let params = `select=${select}`;
  if (filter) params += `&${filter}`;
  params += `&limit=${limit}&offset=${offset}`;
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const t = await res.text();
    console.error(`ERROR ${res.status} for ${table}: ${t}`);
    return [];
  }
  return res.json();
}

function sep(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function sub(title) {
  console.log(`\n  ▶ ${title}`);
}

// ─── 메인 검증 ───────────────────────────────────────────────
sep('SUPABASE 주식 스코어링 데이터 전수 검증');
console.log(`  대상: ${SUPABASE_URL}`);
console.log(`  일시: ${new Date().toLocaleString('ko-KR')}`);

// ────────────────────────────────────────────────────────────
// 1. stock_analysis
// ────────────────────────────────────────────────────────────
sep('1. stock_analysis');

// 전체 레코드 수
const totalCount = await getCount('stock_analysis');
console.log(`  전체 레코드 수: ${totalCount?.toLocaleString() ?? '조회 실패'}`);

// KOSPI / KOSDAQ 별
const kospiCount = await getCount('stock_analysis', 'mrkt_ctg=eq.KOSPI');
const kosdaqCount = await getCount('stock_analysis', 'mrkt_ctg=eq.KOSDAQ');
const otherMrktCount = await getCount('stock_analysis', 'mrkt_ctg=not.in.(KOSPI,KOSDAQ)');
console.log(`  - KOSPI: ${kospiCount?.toLocaleString() ?? '?'}`);
console.log(`  - KOSDAQ: ${kosdaqCount?.toLocaleString() ?? '?'}`);
console.log(`  - 기타(KOSPI/KOSDAQ 외): ${otherMrktCount ?? '?'}`);

// generated_at 날짜별 분포 — 전체 수집
sub('generated_at 날짜 분포');
let genDates = [];
let genOffset = 0;
while (true) {
  const batch = await getData('stock_analysis', 'generated_at', 'order=generated_at.desc', 1000, genOffset);
  genDates = genDates.concat(batch);
  if (batch.length < 1000) break;
  genOffset += 1000;
}
if (genDates.length > 0) {
  const dateCounts = {};
  for (const r of genDates) {
    const d = r.generated_at ? r.generated_at.slice(0, 10) : 'null';
    dateCounts[d] = (dateCounts[d] || 0) + 1;
  }
  const sorted = Object.entries(dateCounts).sort((a, b) => b[0].localeCompare(a[0]));
  const show = sorted.slice(0, 10);
  for (const [d, c] of show) console.log(`    ${d}: ${c}건`);
  if (sorted.length > 10) console.log(`    ... (${sorted.length}개 날짜)`);
  console.log(`  ※ 최신 날짜: ${sorted[0]?.[0] ?? 'N/A'}`);
}

// total_score 이상치
sub('total_score 이상치');
const nullScore = await getCount('stock_analysis', 'total_score=is.null');
const zeroScore = await getCount('stock_analysis', 'total_score=eq.0');
const negScore = await getCount('stock_analysis', 'total_score=lt.0');
const over100 = await getCount('stock_analysis', 'total_score=gt.100');
console.log(`    null: ${nullScore ?? '?'}건`);
console.log(`    0: ${zeroScore ?? '?'}건`);
console.log(`    음수(<0): ${negScore ?? '?'}건`);
console.log(`    100 초과: ${over100 ?? '?'}건`);

// short_score + long_score vs total_score (전체)
sub('short_score + long_score ≠ total_score 불일치');
let scoreRows = [];
{ let off = 0;
  while (true) {
    const b = await getData('stock_analysis', 'stock_code,total_score,short_score,long_score', '', 1000, off);
    scoreRows = scoreRows.concat(b); if (b.length < 1000) break; off += 1000;
  }
}
let mismatch = [];
for (const r of scoreRows) {
  if (r.short_score !== null && r.long_score !== null && r.total_score !== null) {
    const sum = Math.round((r.short_score + r.long_score) * 100) / 100;
    const tot = Math.round(r.total_score * 100) / 100;
    if (Math.abs(sum - tot) > 0.5) {
      mismatch.push({ code: r.stock_code, total: r.total_score, short: r.short_score, long: r.long_score, sum });
    }
  }
}
console.log(`    검사 샘플: ${scoreRows.length}건 / 불일치: ${mismatch.length}건`);
if (mismatch.length > 0 && mismatch.length <= 5) {
  for (const m of mismatch) console.log(`    ⚠ ${m.code}: total=${m.total}, short+long=${m.short}+${m.long}=${m.sum}`);
} else if (mismatch.length > 5) {
  for (const m of mismatch.slice(0, 5)) console.log(`    ⚠ ${m.code}: total=${m.total}, short+long=${m.short}+${m.long}=${m.sum}`);
  console.log(`    ... 외 ${mismatch.length - 5}건`);
}

// detail 컬럼 null/빈 객체
sub('detail 컬럼 null/빈 건수');
const nullDetail = await getCount('stock_analysis', 'detail=is.null');
console.log(`    null: ${nullDetail ?? '?'}건`);
// 빈 객체 {} 는 PostgREST로 직접 필터 어려워 샘플 확인
const detailRows = await getData('stock_analysis', 'stock_code,detail', '', 500);
let emptyDetail = 0;
for (const r of detailRows) {
  if (r.detail && typeof r.detail === 'object' && Object.keys(r.detail).length === 0) emptyDetail++;
}
console.log(`    빈 객체({}): ${emptyDetail}건 (${detailRows.length}건 샘플 기준)`);

// sector null 건수 및 섹터별 분포
sub('sector 분포');
const nullSector = await getCount('stock_analysis', 'sector=is.null');
console.log(`    null 건수: ${nullSector ?? '?'}`);
let sectorRows = [];
{ let off = 0;
  while (true) {
    const b = await getData('stock_analysis', 'sector', '', 1000, off);
    sectorRows = sectorRows.concat(b); if (b.length < 1000) break; off += 1000;
  }
}
const sectorMap = {};
for (const r of sectorRows) {
  const s = r.sector ?? '(null)';
  sectorMap[s] = (sectorMap[s] || 0) + 1;
}
const sectorSorted = Object.entries(sectorMap).sort((a, b) => b[1] - a[1]);
for (const [s, c] of sectorSorted.slice(0, 15)) console.log(`    ${s}: ${c}건`);
if (sectorSorted.length > 15) console.log(`    ... (총 ${sectorSorted.length}개 섹터)`);

// mrkt_ctg 값 확인
sub('mrkt_ctg 값 목록');
let mrktRows = [];
{ let off = 0;
  while (true) {
    const b = await getData('stock_analysis', 'mrkt_ctg', '', 1000, off);
    mrktRows = mrktRows.concat(b); if (b.length < 1000) break; off += 1000;
  }
}
const mrktMap = {};
for (const r of mrktRows) {
  const v = r.mrkt_ctg ?? '(null)';
  mrktMap[v] = (mrktMap[v] || 0) + 1;
}
for (const [k, v] of Object.entries(mrktMap)) console.log(`    "${k}": ${v}건`);

// corp_name null/빈
sub('corp_name null/빈 건수');
const nullCorpName = await getCount('stock_analysis', 'corp_name=is.null');
console.log(`    null: ${nullCorpName ?? '?'}건`);

// current_price, market_cap_tril 0인 건수
sub('current_price / market_cap_tril = 0 건수');
const zeroPrice = await getCount('stock_analysis', 'current_price=eq.0');
const zeroMktCap = await getCount('stock_analysis', 'market_cap_tril=eq.0');
const nullPrice = await getCount('stock_analysis', 'current_price=is.null');
const nullMktCap = await getCount('stock_analysis', 'market_cap_tril=is.null');
console.log(`    current_price=0: ${zeroPrice ?? '?'}건 / null: ${nullPrice ?? '?'}건`);
console.log(`    market_cap_tril=0: ${zeroMktCap ?? '?'}건 / null: ${nullMktCap ?? '?'}건`);

// recommendation 분포
sub('recommendation 값 분포');
let recRows = [];
{ let off = 0;
  while (true) {
    const b = await getData('stock_analysis', 'recommendation', '', 1000, off);
    recRows = recRows.concat(b); if (b.length < 1000) break; off += 1000;
  }
}
const recMap = {};
for (const r of recRows) {
  const v = r.recommendation ?? '(null)';
  recMap[v] = (recMap[v] || 0) + 1;
}
for (const [k, v] of Object.entries(recMap).sort((a, b) => b[1] - a[1])) {
  console.log(`    "${k}": ${v}건`);
}

// 중복 stock_code (전체)
sub('stock_code 중복 확인');
let allCodes = [];
{ let off = 0;
  while (true) {
    const b = await getData('stock_analysis', 'stock_code', '', 1000, off);
    allCodes = allCodes.concat(b); if (b.length < 1000) break; off += 1000;
  }
}
const codeSet = {};
for (const r of allCodes) {
  codeSet[r.stock_code] = (codeSet[r.stock_code] || 0) + 1;
}
const dupCodes = Object.entries(codeSet).filter(([, c]) => c > 1);
console.log(`    전체 종목코드: ${Object.keys(codeSet).length}개`);
console.log(`    중복 종목코드: ${dupCodes.length}건`);
if (dupCodes.length > 0 && dupCodes.length <= 10) {
  for (const [code, cnt] of dupCodes) console.log(`    ⚠ ${code}: ${cnt}건`);
}

// ────────────────────────────────────────────────────────────
// 2. stock_financials
// ────────────────────────────────────────────────────────────
sep('2. stock_financials');

const finTotal = await getCount('stock_financials');
console.log(`  전체 레코드 수: ${finTotal?.toLocaleString() ?? '조회 실패'}`);

// 연도별 레코드 수 (analysis_year 컬럼)
sub('analysis_year별 레코드 수');
for (const yr of ['2022', '2023', '2024', '2025']) {
  const cnt = await getCount('stock_financials', `analysis_year=eq.${yr}`);
  console.log(`    ${yr}: ${cnt ?? '?'}건`);
}

// revenue/op_income/net_income null 비율
sub('revenue / op_income / net_income null 비율');
const finRows = await getData('stock_financials', 'stock_code,analysis_year,revenue,op_income,net_income,debt_ratio', '', 2000);
let nullRev = 0, nullOp = 0, nullNet = 0, nullDebt = 0;
for (const r of finRows) {
  if (r.revenue === null) nullRev++;
  if (r.op_income === null) nullOp++;
  if (r.net_income === null) nullNet++;
  if (r.debt_ratio === null) nullDebt++;
}
const ft = finRows.length;
console.log(`    (샘플 ${ft}건 기준)`);
console.log(`    revenue null: ${nullRev}건 (${ft > 0 ? ((nullRev/ft)*100).toFixed(1) : 0}%)`);
console.log(`    op_income null: ${nullOp}건 (${ft > 0 ? ((nullOp/ft)*100).toFixed(1) : 0}%)`);
console.log(`    net_income null: ${nullNet}건 (${ft > 0 ? ((nullNet/ft)*100).toFixed(1) : 0}%)`);
console.log(`    debt_ratio null: ${nullDebt}건 (${ft > 0 ? ((nullDebt/ft)*100).toFixed(1) : 0}%)`);

// stock_analysis에 있는 종목인데 stock_financials에 없는 종목
sub('stock_analysis 종목 중 stock_financials 미수록 종목');
const finCodes = new Set(finRows.map(r => r.stock_code));
const analysisCodes = Object.keys(codeSet);
const missingFin = analysisCodes.filter(c => !finCodes.has(c));
console.log(`    stock_analysis 종목 수: ${analysisCodes.length}`);
console.log(`    stock_financials 종목 수: ${finCodes.size}`);
console.log(`    미수록 종목 수: ${missingFin.length}`);
if (missingFin.length > 0 && missingFin.length <= 10) {
  console.log(`    미수록 예시: ${missingFin.join(', ')}`);
} else if (missingFin.length > 10) {
  console.log(`    미수록 예시: ${missingFin.slice(0, 10).join(', ')} ... 외 ${missingFin.length - 10}건`);
}

// ────────────────────────────────────────────────────────────
// 3. stock_disclosures
// ────────────────────────────────────────────────────────────
sep('3. stock_disclosures');

const discTotal = await getCount('stock_disclosures');
console.log(`  전체 건수: ${discTotal?.toLocaleString() ?? '조회 실패'}`);

// rcept_dt 최신 날짜
sub('rcept_dt 최신 날짜 분포 (최근 7건)');
const discRecent = await getData('stock_disclosures', 'rcept_dt,stock_code,report_nm', 'order=rcept_dt.desc', 7);
for (const r of discRecent) {
  console.log(`    ${r.rcept_dt} | ${r.stock_code} | ${r.report_nm?.slice(0, 40)}`);
}
const has20260522 = discRecent.some(r => r.rcept_dt && r.rcept_dt.replace(/-/g, '') >= '20260522');
console.log(`  ✔ 2026-05-22 데이터 존재 여부: ${has20260522 ? '있음' : '없음 (확인 필요)'}`);
const cnt20260522 = await getCount('stock_disclosures', 'rcept_dt=gte.20260522');
console.log(`  2026-05-22 이후 건수: ${cnt20260522 ?? '?'}`);

// stock_code null/빈
sub('stock_code null/빈 건수');
const nullDiscCode = await getCount('stock_disclosures', 'stock_code=is.null');
console.log(`    null: ${nullDiscCode ?? '?'}건`);

// rcept_no 중복 (dcm_no 대신 rcept_no 컬럼 사용)
sub('rcept_no 중복 확인');
const discRows = await getData('stock_disclosures', 'stock_code,rcept_no', '', 2000);
const dcmMap = {};
for (const r of discRows) {
  if (r.rcept_no) dcmMap[r.rcept_no] = (dcmMap[r.rcept_no] || 0) + 1;
}
const dupDcm = Object.entries(dcmMap).filter(([, c]) => c > 1);
console.log(`    샘플 ${discRows.length}건 중 rcept_no 중복: ${dupDcm.length}건`);
if (dupDcm.length > 0 && dupDcm.length <= 5) {
  for (const [d, c] of dupDcm) console.log(`    ⚠ rcept_no=${d}: ${c}건`);
}

// ────────────────────────────────────────────────────────────
// 4. stock_disclosure_sentiments
// ────────────────────────────────────────────────────────────
sep('4. stock_disclosure_sentiments');

const sentTotal = await getCount('stock_disclosure_sentiments');
console.log(`  전체 건수: ${sentTotal?.toLocaleString() ?? '조회 실패'}`);
console.log(`  stock_disclosures 전체: ${discTotal?.toLocaleString() ?? '?'}`);
if (sentTotal !== null && discTotal !== null) {
  const diff = sentTotal - discTotal;
  console.log(`  차이: ${diff >= 0 ? '+' : ''}${diff}건 (${diff === 0 ? '일치' : diff > 0 ? '감성분석이 더 많음' : '공시가 더 많음'})`);
}

// sentiment 값 분포
sub('sentiment 값 분포');
let sentRows = [];
{ let off = 0;
  while (true) {
    const b = await getData('stock_disclosure_sentiments', 'sentiment', '', 1000, off);
    sentRows = sentRows.concat(b); if (b.length < 1000) break; off += 1000;
  }
}
const sentMap = {};
for (const r of sentRows) {
  const v = r.sentiment ?? '(null)';
  sentMap[v] = (sentMap[v] || 0) + 1;
}
for (const [k, v] of Object.entries(sentMap).sort((a, b) => b[1] - a[1])) {
  console.log(`    "${k}": ${v}건`);
}

// ────────────────────────────────────────────────────────────
// 5. stock_analysis_history
// ────────────────────────────────────────────────────────────
sep('5. stock_analysis_history');

const histTotal = await getCount('stock_analysis_history');
console.log(`  전체 건수: ${histTotal?.toLocaleString() ?? '조회 실패'}`);

// stock_analysis와 stock_code 커버리지
sub('stock_analysis vs stock_analysis_history stock_code 커버리지');
let histRows = [];
{ let off = 0;
  while (true) {
    const b = await getData('stock_analysis_history', 'stock_code', '', 1000, off);
    histRows = histRows.concat(b); if (b.length < 1000) break; off += 1000;
  }
}
const histCodes = new Set(histRows.map(r => r.stock_code));
const analysisOnlySet = new Set(analysisCodes);
const inAnalysisNotHist = analysisCodes.filter(c => !histCodes.has(c));
const inHistNotAnalysis = [...histCodes].filter(c => !analysisOnlySet.has(c));
console.log(`  stock_analysis 종목코드 수: ${analysisCodes.length}`);
console.log(`  stock_analysis_history 종목코드 수 (샘플): ${histCodes.size}`);
console.log(`  stock_analysis에만 있는 코드: ${inAnalysisNotHist.length}건`);
console.log(`  stock_analysis_history에만 있는 코드: ${inHistNotAnalysis.length}건`);
if (inAnalysisNotHist.length > 0 && inAnalysisNotHist.length <= 10) {
  console.log(`  분석에만 있는 예시: ${inAnalysisNotHist.join(', ')}`);
}
if (inHistNotAnalysis.length > 0 && inHistNotAnalysis.length <= 10) {
  console.log(`  이력에만 있는 예시: ${inHistNotAnalysis.join(', ')}`);
}

// history 날짜 분포 (snapshot_at 컬럼)
sub('history snapshot_at 날짜 분포');
const histDates = await getData('stock_analysis_history', 'snapshot_at,stock_code', 'order=snapshot_at.desc', 500);
const histDateMap = {};
for (const r of histDates) {
  const d = r.snapshot_at ? r.snapshot_at.slice(0, 10) : 'null';
  histDateMap[d] = (histDateMap[d] || 0) + 1;
}
const histDateSorted = Object.entries(histDateMap).sort((a, b) => b[0].localeCompare(a[0]));
for (const [d, c] of histDateSorted.slice(0, 10)) console.log(`    ${d}: ${c}건`);

// ────────────────────────────────────────────────────────────
// 최종 요약
// ────────────────────────────────────────────────────────────
sep('최종 상태 요약');

function status(label, level, note) {
  const icon = level === 'OK' ? '✅ 정상' : level === 'WARN' ? '⚠️  주의' : '❌ 오류';
  console.log(`  ${icon}  ${label}`);
  if (note) console.log(`         → ${note}`);
}

// stock_analysis
const saStatus = (nullScore > 0 || negScore > 0 || over100 > 0 || dupCodes.length > 0 || mismatch.length > 0)
  ? (nullScore > 10 || dupCodes.length > 0 ? 'ERROR' : 'WARN')
  : 'OK';
status(
  'stock_analysis',
  saStatus,
  saStatus !== 'OK'
    ? `nullScore=${nullScore}, 음수=${negScore}, 100초과=${over100}, 중복코드=${dupCodes.length}, score불일치=${mismatch.length}`
    : `총 ${totalCount}건 (KOSPI:${kospiCount}, KOSDAQ:${kosdaqCount})`
);

// stock_financials
const sfStatus = (missingFin.length > 50) ? 'WARN' : 'OK';
status(
  'stock_financials',
  sfStatus,
  sfStatus !== 'OK'
    ? `stock_analysis 미수록 종목 ${missingFin.length}건`
    : `총 ${finTotal}건, 미수록 ${missingFin.length}건`
);

// stock_disclosures
const sdStatus = (nullDiscCode > 0 || dupDcm.length > 0) ? 'WARN' : 'OK';
status(
  'stock_disclosures',
  sdStatus,
  sdStatus !== 'OK'
    ? `null stock_code=${nullDiscCode}, dcm_no중복=${dupDcm.length}`
    : `총 ${discTotal}건, 최신 ${discRecent[0]?.rcept_dt ?? 'N/A'}`
);

// stock_disclosure_sentiments
const sdsStatus = (sentTotal !== discTotal) ? (Math.abs((sentTotal ?? 0) - (discTotal ?? 0)) > 100 ? 'ERROR' : 'WARN') : 'OK';
status(
  'stock_disclosure_sentiments',
  sdsStatus,
  sdsStatus !== 'OK'
    ? `공시 ${discTotal}건 vs 감성분석 ${sentTotal}건 (차이 ${(sentTotal??0)-(discTotal??0)}건)`
    : `공시/감성분석 수 일치 (${sentTotal}건)`
);

// stock_analysis_history
const sahStatus = (histTotal === 0 || histTotal === null) ? 'ERROR' : (inAnalysisNotHist.length > analysisCodes.length * 0.5 ? 'WARN' : 'OK');
status(
  'stock_analysis_history',
  sahStatus,
  sahStatus !== 'OK'
    ? `전체 ${histTotal}건, 분석에 없는 코드 ${inAnalysisNotHist.length}건`
    : `총 ${histTotal}건`
);

console.log('\n');
