import fetch from 'node-fetch';

const BASE = 'https://onxkbuecwbcueuhwnowx.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ueGtidWVjd2JjdWV1aHdub3d4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTE5Mjc5MCwiZXhwIjoyMDk0NzY4NzkwfQ.3Wa1E9tyMmsqxN1xGJTFFmrczkurWk-TC-PD4JuPPlM';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact' };

// Returns { data, total }
async function get(table, select, filter = '', limit = 10000, offset = 0) {
  const qs = [`select=${select}`, `limit=${limit}`, `offset=${offset}`, filter].filter(Boolean).join('&');
  const r = await fetch(`${BASE}/rest/v1/${table}?${qs}`, { headers: H });
  if (!r.ok) throw new Error(`${table} ${r.status}: ${await r.text()}`);
  const cr = r.headers.get('content-range');
  const total = cr ? parseInt(cr.split('/')[1], 10) : null;
  return { data: await r.json(), total };
}

// Count only (no data)
async function cnt(table, filter = '') {
  const qs = ['select=*', 'limit=1', filter].filter(Boolean).join('&');
  const r = await fetch(`${BASE}/rest/v1/${table}?${qs}`, { headers: H });
  const cr = r.headers.get('content-range');
  return cr ? parseInt(cr.split('/')[1], 10) : null;
}

// Fetch all rows with pagination
async function fetchAll(table, select, filter = '', pageSize = 1000) {
  let all = [], offset = 0, total = null;
  while (true) {
    const { data, total: t } = await get(table, select, filter, pageSize, offset);
    if (total === null) total = t;
    all = all.concat(data);
    offset += pageSize;
    if (all.length >= total) break;
    if (data.length === 0) break;
  }
  return { data: all, total };
}

const P = (cond) => cond === true ? '✅ PASS' : cond === false ? '❌ FAIL' : '⚠️  WARN';
const N = (v) => v === null || v === undefined ? 'N/A' : Number(v).toLocaleString();
const F = (v, d = 2) => v === null || v === undefined ? 'N/A' : Number(v).toFixed(d);

function avg(arr, key) {
  const vs = arr.map(r => r[key]).filter(v => v !== null && v !== undefined && isFinite(v));
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}

async function main() {
  const out = [];
  const log = s => { out.push(s); process.stdout.write(s + '\n'); };

  log('# KRXDATA 주식 스코어링 DB 감사 보고서');
  log(`> 감사 일시: ${new Date().toISOString()}\n`);

  // ═══════════════════════════════════════
  // 1. stocks
  // ═══════════════════════════════════════
  log('---\n## 1. stocks 테이블\n');

  const totalStocks    = await cnt('stocks');
  const kospiStocks    = await cnt('stocks', 'mrkt_ctg=eq.KOSPI');
  const kosdaqStocks   = await cnt('stocks', 'mrkt_ctg=eq.KOSDAQ');

  // duplicate check
  const { data: allCodes } = await fetchAll('stocks', 'stock_code');
  const codeFreq = {};
  for (const r of allCodes) codeFreq[r.stock_code] = (codeFreq[r.stock_code] || 0) + 1;
  const dupes = Object.entries(codeFreq).filter(([,v]) => v > 1);

  log('| 항목 | 값 | 기대치 | 상태 |');
  log('|------|-----|--------|------|');
  log(`| 총 종목 수 | ${N(totalStocks)} | ~2,610 | ${P(totalStocks >= 2500 && totalStocks <= 2700)} |`);
  log(`| KOSPI 종목 수 | ${N(kospiStocks)} | ~835 | ${P(kospiStocks >= 800 && kospiStocks <= 870)} |`);
  log(`| KOSDAQ 종목 수 | ${N(kosdaqStocks)} | ~1,775 | ${P(kosdaqStocks >= 1700 && kosdaqStocks <= 1850)} |`);
  log(`| stock_code 중복 수 | ${dupes.length} | 0 | ${P(dupes.length === 0)} |`);

  if (dupes.length > 0) {
    log(`\n> 중복 발견: ${dupes.slice(0,10).map(([k,v]) => `${k}(×${v})`).join(', ')}`);
  }

  // ═══════════════════════════════════════
  // 2. stock_analysis
  // ═══════════════════════════════════════
  log('\n---\n## 2. stock_analysis 테이블\n');

  const totalAna   = await cnt('stock_analysis');
  const kospiAna   = await cnt('stock_analysis', 'mrkt_ctg=eq.KOSPI');
  const kosdaqAna  = await cnt('stock_analysis', 'mrkt_ctg=eq.KOSDAQ');
  const secNull    = await cnt('stock_analysis', 'sector=is.null');
  const priceZero  = await cnt('stock_analysis', 'current_price=eq.0');
  const scoreZero  = await cnt('stock_analysis', 'total_score=eq.0');

  log('| 항목 | 값 | 기대치 | 상태 |');
  log('|------|-----|--------|------|');
  log(`| 총 분석 레코드 | ${N(totalAna)} | ~2,610 | ${P(totalAna >= 2500 && totalAna <= 2700)} |`);
  log(`| KOSPI 분석 수 | ${N(kospiAna)} | ~835 | ${P(kospiAna >= 800 && kospiAna <= 870)} |`);
  log(`| KOSDAQ 분석 수 | ${N(kosdaqAna)} | ~1,775 | ${P(kosdaqAna >= 1700 && kosdaqAna <= 1850)} |`);
  log(`| sector NULL 수 | ${N(secNull)} | 0 | ${P(secNull === 0)} |`);
  log(`| current_price = 0 수 | ${N(priceZero)} | - | ${priceZero === 0 ? '✅ PASS' : '⚠️  WARN (기지 이슈)'} |`);
  log(`| total_score = 0 수 | ${N(scoreZero)} | 0 | ${P(scoreZero === 0)} |`);

  // score distribution
  const { data: anaFull } = await fetchAll('stock_analysis', 'stock_code,corp_name,mrkt_ctg,total_score,sector,recommendation,current_price');
  const scores = anaFull.map(r => r.total_score).filter(v => v !== null);
  const minS = Math.min(...scores), maxS = Math.max(...scores);
  const avgS = scores.reduce((a,b)=>a+b,0) / scores.length;

  log(`| total_score 최솟값 | ${F(minS)} | - | - |`);
  log(`| total_score 최댓값 | ${F(maxS)} | - | - |`);
  log(`| total_score 평균 | ${F(avgS)} | - | - |`);
  log(`| total_score null 수 | ${anaFull.filter(r=>r.total_score===null).length} | 0 | ${P(anaFull.filter(r=>r.total_score===null).length === 0)} |`);

  // Recommendation distribution
  const recDist = {};
  for (const r of anaFull) {
    const k = r.recommendation || '(null)';
    recDist[k] = (recDist[k] || 0) + 1;
  }
  const recEntries = Object.entries(recDist).sort((a,b) => b[1]-a[1]);

  log('\n### 추천(recommendation) 분포\n');
  log('| 추천 | 종목 수 | 비율 |');
  log('|------|---------|------|');
  for (const [k, v] of recEntries) {
    // 값이 너무 길면 truncate
    const label = k.length > 40 ? k.slice(0, 40) + '…' : k;
    const pct = ((v / anaFull.length) * 100).toFixed(1);
    log(`| ${label} | ${N(v)} | ${pct}% |`);
  }

  // Top 10 by total_score
  const top10 = [...anaFull].sort((a,b) => (b.total_score||0) - (a.total_score||0)).slice(0, 10);
  log('\n### 총점 상위 10개 종목\n');
  log('| 순위 | 종목코드 | 기업명 | 시장 | 총점 | 섹터 |');
  log('|------|---------|-------|------|------|------|');
  top10.forEach((r, i) => {
    log(`| ${i+1} | ${r.stock_code} | ${r.corp_name} | ${r.mrkt_ctg} | ${F(r.total_score)} | ${r.sector || '-'} |`);
  });

  // ═══════════════════════════════════════
  // 3. stock_financials
  // ═══════════════════════════════════════
  log('\n---\n## 3. stock_financials 테이블\n');

  const fin25total  = await cnt('stock_financials', 'analysis_year=eq.2025');
  const fin26total  = await cnt('stock_financials', 'analysis_year=eq.2026');
  const fin25kospi  = await cnt('stock_financials', 'analysis_year=eq.2025&mrkt_ctg=eq.KOSPI');
  const fin25kosdaq = await cnt('stock_financials', 'analysis_year=eq.2025&mrkt_ctg=eq.KOSDAQ');
  const fin26kospi  = await cnt('stock_financials', 'analysis_year=eq.2026&mrkt_ctg=eq.KOSPI');
  const fin26kosdaq = await cnt('stock_financials', 'analysis_year=eq.2026&mrkt_ctg=eq.KOSDAQ');

  const rev25null   = await cnt('stock_financials', 'analysis_year=eq.2025&revenue=is.null');
  const rev26null   = await cnt('stock_financials', 'analysis_year=eq.2026&revenue=is.null');
  const op25null    = await cnt('stock_financials', 'analysis_year=eq.2025&op_income=is.null');
  const op26null    = await cnt('stock_financials', 'analysis_year=eq.2026&op_income=is.null');

  log('### 연도별 집계\n');
  log('| 항목 | 2025 | 기대 | 상태 | 2026 Q1 | 기대 | 상태 |');
  log('|------|------|------|------|---------|------|------|');
  log(`| 총 레코드 | ${N(fin25total)} | ~2,610 | ${P(fin25total >= 2500 && fin25total <= 2700)} | ${N(fin26total)} | ~2,526 | ${P(fin26total >= 2400 && fin26total <= 2650)} |`);
  log(`| KOSPI | ${N(fin25kospi)} | ~835 | ${P(fin25kospi >= 800 && fin25kospi <= 870)} | ${N(fin26kospi)} | ~835 | ${P(fin26kospi >= 800 && fin26kospi <= 870)} |`);
  log(`| KOSDAQ | ${N(fin25kosdaq)} | ~1,775 | ${P(fin25kosdaq >= 1700 && fin25kosdaq <= 1850)} | ${N(fin26kosdaq)} | ~1,775 | ${P(fin26kosdaq >= 1700 && fin26kosdaq <= 1850)} |`);
  log(`| revenue NULL | ${N(rev25null)} | 낮을수록 좋음 | ${rev25null === 0 ? '✅ PASS' : '⚠️  WARN'} | ${N(rev26null)} | 낮을수록 좋음 | ${rev26null === 0 ? '✅ PASS' : '⚠️  WARN'} |`);
  log(`| op_income NULL | ${N(op25null)} | 낮을수록 좋음 | ${op25null === 0 ? '✅ PASS' : '⚠️  WARN'} | ${N(op26null)} | 낮을수록 좋음 | ${op26null === 0 ? '✅ PASS' : '⚠️  WARN'} |`);

  // averages — fetch non-null debt_ratio + op_margin
  const { data: fin25data } = await fetchAll('stock_financials', 'debt_ratio,op_margin,revenue,op_income', 'analysis_year=eq.2025');
  const { data: fin26data } = await fetchAll('stock_financials', 'debt_ratio,op_margin,revenue,op_income', 'analysis_year=eq.2026');

  const avgDebt25 = avg(fin25data, 'debt_ratio');
  const avgOp25   = avg(fin25data, 'op_margin');
  const avgDebt26 = avg(fin26data, 'debt_ratio');
  const avgOp26   = avg(fin26data, 'op_margin');

  // revenue null counts (cross-check)
  const rev25NullCalc = fin25data.filter(r => r.revenue === null).length;
  const rev26NullCalc = fin26data.filter(r => r.revenue === null).length;
  const op25NullCalc  = fin25data.filter(r => r.op_income === null).length;
  const op26NullCalc  = fin26data.filter(r => r.op_income === null).length;

  log('\n### 재무 평균 지표 (non-null 기준)\n');
  log('| 지표 | 2025 | 2026 Q1 |');
  log('|------|------|---------|');
  log(`| avg debt_ratio (%) | ${F(avgDebt25)} | ${F(avgDebt26)} |`);
  log(`| avg op_margin (%) | ${F(avgOp25)} | ${F(avgOp26)} |`);

  log('\n### NULL 상세 (로컬 집계 교차 확인)\n');
  log('| 항목 | 2025 | 2026 Q1 |');
  log('|------|------|---------|');
  log(`| revenue null (로컬집계) | ${N(rev25NullCalc)} | ${N(rev26NullCalc)} |`);
  log(`| op_income null (로컬집계) | ${N(op25NullCalc)} | ${N(op26NullCalc)} |`);

  // ═══════════════════════════════════════
  // 4. stock_analysis_history
  // ═══════════════════════════════════════
  log('\n---\n## 4. stock_analysis_history 테이블\n');

  const totalHist  = await cnt('stock_analysis_history');
  const kospiHist  = await cnt('stock_analysis_history', 'mrkt_ctg=eq.KOSPI');
  const kosdaqHist = await cnt('stock_analysis_history', 'mrkt_ctg=eq.KOSDAQ');

  // get run IDs and snapshot range without loading all 6067 rows — use limit & order
  const { data: latestSnap } = await get('stock_analysis_history', 'snapshot_at,analysis_run_id', '', 1, 0);
  const { data: firstSnap }  = await get('stock_analysis_history', 'snapshot_at,analysis_run_id', 'order=snapshot_at.asc', 1, 0);

  // Count distinct run_ids — fetch just that column (6067 rows)
  const { data: histRuns } = await fetchAll('stock_analysis_history', 'analysis_run_id');
  const uniqueRuns = new Set(histRuns.map(r => r.analysis_run_id));

  // Latest run stats
  const latestRunId = latestSnap[0]?.analysis_run_id;
  const latestRunCount = latestRunId ? histRuns.filter(r => r.analysis_run_id === latestRunId).length : 0;

  log('| 항목 | 값 | 상태 |');
  log('|------|-----|------|');
  log(`| 총 히스토리 레코드 | ${N(totalHist)} | ${totalHist > 0 ? '✅ PASS' : '⚠️  WARN'} |`);
  log(`| KOSPI 히스토리 | ${N(kospiHist)} | - |`);
  log(`| KOSDAQ 히스토리 | ${N(kosdaqHist)} | - |`);
  log(`| 고유 analysis_run_id 수 | ${uniqueRuns.size} | ${uniqueRuns.size > 0 ? '✅ PASS' : '⚠️  WARN'} |`);
  log(`| 최초 snapshot_at | ${firstSnap[0]?.snapshot_at ?? 'N/A'} | - |`);
  log(`| 최신 snapshot_at | ${latestSnap[0]?.snapshot_at ?? 'N/A'} | - |`);
  log(`| 최신 run 레코드 수 | ${N(latestRunCount)} | ${latestRunCount >= 2500 ? '✅ PASS' : '⚠️  WARN'} |`);

  log('\n### analysis_run_id 목록\n');
  log('| run_id | 레코드 수 |');
  log('|--------|---------|');
  const runFreq = {};
  for (const r of histRuns) runFreq[r.analysis_run_id] = (runFreq[r.analysis_run_id] || 0) + 1;
  for (const [k, v] of Object.entries(runFreq).sort((a,b) => b[1]-a[1])) {
    log(`| ${k} | ${N(v)} |`);
  }

  // ═══════════════════════════════════════
  // 5. stock_disclosures
  // ═══════════════════════════════════════
  log('\n---\n## 5. stock_disclosures 테이블\n');

  const totalDisc = await cnt('stock_disclosures');

  const { data: dateAsc }  = await get('stock_disclosures', 'rcept_dt', 'order=rcept_dt.asc', 1, 0);
  const { data: dateDesc } = await get('stock_disclosures', 'rcept_dt', 'order=rcept_dt.desc', 1, 0);

  log('| 항목 | 값 | 상태 |');
  log('|------|-----|------|');
  log(`| 총 공시 레코드 | ${N(totalDisc)} | ${totalDisc > 0 ? '✅ PASS' : '⚠️  WARN'} |`);
  log(`| 최초 rcept_dt | ${dateAsc[0]?.rcept_dt ?? 'N/A'} | - |`);
  log(`| 최신 rcept_dt | ${dateDesc[0]?.rcept_dt ?? 'N/A'} | - |`);

  // top 5 per stock_code — aggregate from full dataset
  const { data: discAll } = await fetchAll('stock_disclosures', 'stock_code,rcept_no,report_nm');
  const discFreq = {};
  for (const r of discAll) discFreq[r.stock_code] = (discFreq[r.stock_code] || 0) + 1;
  const top5disc = Object.entries(discFreq).sort((a,b) => b[1]-a[1]).slice(0, 5);

  // unique stock count
  const uniqueDiscStocks = Object.keys(discFreq).length;

  log(`| 공시 있는 종목 수 | ${N(uniqueDiscStocks)} | - | - |`);

  log('\n### 공시 건수 상위 5개 종목\n');
  log('| 순위 | 종목코드 | 공시 건수 |');
  log('|------|---------|---------|');
  top5disc.forEach(([k, v], i) => log(`| ${i+1} | ${k} | ${N(v)} |`));

  // report type distribution
  const typeDist = {};
  for (const r of discAll) {
    const nm = r.report_nm || '(null)';
    // group roughly by first 10 chars
    const key = nm.length > 20 ? nm.slice(0,20) + '…' : nm;
    typeDist[key] = (typeDist[key] || 0) + 1;
  }
  const topTypes = Object.entries(typeDist).sort((a,b)=>b[1]-a[1]).slice(0,10);

  log('\n### 공시 유형 상위 10개 (report_nm 기준)\n');
  log('| 공시 유형 | 건수 |');
  log('|---------|------|');
  for (const [k, v] of topTypes) log(`| ${k} | ${N(v)} |`);

  // ═══════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════
  log('\n---\n## 종합 요약 및 평가\n');

  const issues = [];
  const warns = [];

  // stocks
  if (totalStocks < 2500 || totalStocks > 2700) issues.push(`stocks 총 종목 수 이상(${totalStocks})`);
  if (dupes.length > 0) issues.push(`stock_code 중복 ${dupes.length}건`);

  // analysis
  if (totalAna < 2500 || totalAna > 2700) issues.push(`stock_analysis 총 수 이상(${totalAna})`);
  if (secNull > 0) issues.push(`sector NULL ${secNull}건`);
  if (scoreZero > 0) issues.push(`total_score=0 인 종목 ${scoreZero}건`);
  if (priceZero > 0) warns.push(`current_price=0 인 종목 ${priceZero}건 (기지 이슈)`);

  // financials
  if (fin25total < 2500 || fin25total > 2700) issues.push(`stock_financials 2025 레코드 이상(${fin25total})`);
  if (fin26total < 2400 || fin26total > 2650) warns.push(`stock_financials 2026 레코드 ${fin26total}건 (기대치 ~2,526 근방)`);
  if (rev25NullCalc > 0) warns.push(`2025 revenue NULL ${rev25NullCalc}건`);
  if (op25NullCalc > 0) warns.push(`2025 op_income NULL ${op25NullCalc}건`);
  if (rev26NullCalc > 0) warns.push(`2026 revenue NULL ${rev26NullCalc}건`);
  if (op26NullCalc > 0) warns.push(`2026 op_income NULL ${op26NullCalc}건`);

  // history
  if (totalHist === 0) issues.push('stock_analysis_history 비어 있음');
  if (latestRunCount < 2500) warns.push(`최신 run 레코드 수 ${latestRunCount}건 (2610 미만)`);

  // disclosures
  if (totalDisc === 0) issues.push('stock_disclosures 비어 있음');

  log('| 테이블 | 레코드 수 | 핵심 이슈 |');
  log('|--------|----------|---------|');
  log(`| stocks | ${N(totalStocks)} | 중복 ${dupes.length}건 |`);
  log(`| stock_analysis | ${N(totalAna)} | sector null ${N(secNull)}, score=0 ${N(scoreZero)} |`);
  log(`| stock_financials | 2025: ${N(fin25total)} / 2026: ${N(fin26total)} | rev null 2025:${N(rev25NullCalc)} 2026:${N(rev26NullCalc)} |`);
  log(`| stock_analysis_history | ${N(totalHist)} | run 수 ${uniqueRuns.size}, 최신 run ${N(latestRunCount)}건 |`);
  log(`| stock_disclosures | ${N(totalDisc)} | 기간 ${dateAsc[0]?.rcept_dt}~${dateDesc[0]?.rcept_dt} |`);

  log('');
  if (issues.length === 0) {
    log('### ✅ 심각한 이슈 없음');
  } else {
    log('### ❌ 발견된 이슈');
    for (const s of issues) log(`- ${s}`);
  }
  log('');
  if (warns.length > 0) {
    log('### ⚠️  경고 항목');
    for (const s of warns) log(`- ${s}`);
  }

  log('\n> 감사 완료.');
}

main().catch(e => { console.error(e); process.exit(1); });
