import fetch from 'node-fetch';

const SUPABASE_URL = 'https://onxkbuecwbcueuhwnowx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ueGtidWVjd2JjdWV1aHdub3d4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTE5Mjc5MCwiZXhwIjoyMDk0NzY4NzkwfQ.3Wa1E9tyMmsqxN1xGJTFFmrczkurWk-TC-PD4JuPPlM';

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'count=exact',
};

async function query(path, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${path}${params ? '?' + params : ''}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const contentRange = res.headers.get('content-range');
  const data = await res.json();
  return { data, contentRange };
}

async function rpc(fn, body = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${fn} HTTP ${res.status}: ${text}`);
  }
  return await res.json();
}

// Get count only
async function count(table, filter = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1${filter ? '&' + filter : ''}`;
  const res = await fetch(url, { headers: { ...headers, Prefer: 'count=exact' } });
  const cr = res.headers.get('content-range');
  if (!cr) return null;
  const total = cr.split('/')[1];
  return total === '*' ? null : parseInt(total, 10);
}

// Get data with count
async function queryCount(table, select, filter = '') {
  const params = `select=${select}${filter ? '&' + filter : ''}&limit=10000`;
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, { headers: { ...headers, Prefer: 'count=exact' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const cr = res.headers.get('content-range');
  const total = cr ? parseInt(cr.split('/')[1], 10) : null;
  const data = await res.json();
  return { data, total };
}

function status(label, pass) {
  return pass === true ? `✅ PASS` : pass === false ? `❌ FAIL` : `⚠️ WARN`;
}

function num(n) { return n === null ? 'N/A' : n.toLocaleString(); }

async function main() {
  const lines = [];
  const log = (...args) => { lines.push(args.join(' ')); console.log(...args); };

  log('# KRXDATA 주식 스코어링 DB 감사 보고서');
  log(`> 감사 일시: ${new Date().toISOString()}`);
  log('');

  // ─────────────────────────────────────────
  // 1. stocks table
  // ─────────────────────────────────────────
  log('---');
  log('## 1. stocks 테이블');
  log('');

  try {
    const totalStocks = await count('stocks');
    const kospiCount = await count('stocks', 'mrkt_ctg=eq.KOSPI');
    const kosdaqCount = await count('stocks', 'mrkt_ctg=eq.KOSDAQ');

    log(`| 항목 | 값 | 상태 |`);
    log(`|------|-----|------|`);
    log(`| 총 종목 수 | ${num(totalStocks)} | ${status('total', totalStocks >= 2500 && totalStocks <= 2700)} |`);
    log(`| KOSPI 종목 수 | ${num(kospiCount)} | ${status('kospi', kospiCount >= 800 && kospiCount <= 870)} |`);
    log(`| KOSDAQ 종목 수 | ${num(kosdaqCount)} | ${status('kosdaq', kosdaqCount >= 1700 && kosdaqCount <= 1850)} |`);

    // Duplicate check on stock_code
    const { data: allCodes } = await queryCount('stocks', 'stock_code');
    const codeCounts = {};
    for (const r of allCodes) {
      codeCounts[r.stock_code] = (codeCounts[r.stock_code] || 0) + 1;
    }
    const dupes = Object.entries(codeCounts).filter(([, v]) => v > 1);
    log(`| stock_code 중복 수 | ${dupes.length} | ${status('dupes', dupes.length === 0)} |`);

    if (dupes.length > 0) {
      log('');
      log(`> 중복 stock_code: ${dupes.slice(0, 10).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }

    log('');
    log(`**총계:** ${num(totalStocks)}개 (KOSPI ${num(kospiCount)} + KOSDAQ ${num(kosdaqCount)})`);
  } catch (e) {
    log(`> ❌ ERROR: ${e.message}`);
  }

  // ─────────────────────────────────────────
  // 2. stock_analysis table
  // ─────────────────────────────────────────
  log('');
  log('---');
  log('## 2. stock_analysis 테이블');
  log('');

  try {
    const totalAnalysis = await count('stock_analysis');
    const kospiAnalysis = await count('stock_analysis', 'mrkt_ctg=eq.KOSPI');
    const kosdaqAnalysis = await count('stock_analysis', 'mrkt_ctg=eq.KOSDAQ');
    const sectorNull = await count('stock_analysis', 'sector=is.null');
    const zeroPrice = await count('stock_analysis', 'current_price=eq.0');
    const zeroScore = await count('stock_analysis', 'total_score=eq.0');

    log(`| 항목 | 값 | 상태 |`);
    log(`|------|-----|------|`);
    log(`| 총 분석 레코드 | ${num(totalAnalysis)} | ${status('total', totalAnalysis >= 2500 && totalAnalysis <= 2700)} |`);
    log(`| KOSPI 분석 수 | ${num(kospiAnalysis)} | ${status('kospi', kospiAnalysis >= 800 && kospiAnalysis <= 870)} |`);
    log(`| KOSDAQ 분석 수 | ${num(kosdaqAnalysis)} | ${status('kosdaq', kosdaqAnalysis >= 1700 && kosdaqAnalysis <= 1850)} |`);
    log(`| sector NULL 수 | ${num(sectorNull)} | ${status('sector', sectorNull === 0)} |`);
    log(`| current_price = 0 수 | ${num(zeroPrice)} | ${zeroPrice === 0 ? '✅ PASS' : '⚠️ WARN (known issue)'} |`);
    log(`| total_score = 0 수 | ${num(zeroScore)} | ${status('zero_score', zeroScore === 0)} |`);

    // total_score stats — fetch all scores
    const { data: scoreData } = await queryCount('stock_analysis', 'total_score,mrkt_ctg');
    const scores = scoreData.map(r => r.total_score).filter(s => s !== null);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    log(`| total_score 최솟값 | ${minScore.toFixed(2)} | - |`);
    log(`| total_score 최댓값 | ${maxScore.toFixed(2)} | - |`);
    log(`| total_score 평균 | ${avgScore.toFixed(2)} | - |`);

    log('');

    // Recommendation distribution
    const { data: recData } = await queryCount('stock_analysis', 'recommendation');
    const recDist = {};
    for (const r of recData) {
      const k = r.recommendation || '(null)';
      recDist[k] = (recDist[k] || 0) + 1;
    }
    log('### 추천 분포 (recommendation)');
    log('');
    log('| 추천 | 종목 수 |');
    log('|------|---------|');
    for (const [k, v] of Object.entries(recDist).sort((a, b) => b[1] - a[1])) {
      log(`| ${k} | ${num(v)} |`);
    }

    log('');

    // Top 10 by total_score
    const { data: top10 } = await queryCount('stock_analysis', 'stock_code,corp_name,mrkt_ctg,total_score,sector&order=total_score.desc&limit=10');
    log('### 총점 상위 10개 종목');
    log('');
    log('| 순위 | 종목코드 | 기업명 | 시장 | 총점 | 섹터 |');
    log('|------|---------|-------|------|------|------|');
    for (let i = 0; i < Math.min(10, top10.length); i++) {
      const r = top10[i];
      log(`| ${i + 1} | ${r.stock_code} | ${r.corp_name} | ${r.mrkt_ctg} | ${r.total_score?.toFixed(2)} | ${r.sector || '-'} |`);
    }
  } catch (e) {
    log(`> ❌ ERROR: ${e.message}`);
  }

  // ─────────────────────────────────────────
  // 3. stock_financials table
  // ─────────────────────────────────────────
  log('');
  log('---');
  log('## 3. stock_financials 테이블');
  log('');

  try {
    const total2025 = await count('stock_financials', 'analysis_year=eq.2025');
    const total2026 = await count('stock_financials', 'analysis_year=eq.2026');

    const kospi2025 = await count('stock_financials', 'analysis_year=eq.2025&mrkt_ctg=eq.KOSPI');
    const kosdaq2025 = await count('stock_financials', 'analysis_year=eq.2025&mrkt_ctg=eq.KOSDAQ');
    const kospi2026 = await count('stock_financials', 'analysis_year=eq.2026&mrkt_ctg=eq.KOSPI');
    const kosdaq2026 = await count('stock_financials', 'analysis_year=eq.2026&mrkt_ctg=eq.KOSDAQ');

    const rev2025Null = await count('stock_financials', 'analysis_year=eq.2025&revenue=is.null');
    const rev2026Null = await count('stock_financials', 'analysis_year=eq.2026&revenue=is.null');
    const op2025Null = await count('stock_financials', 'analysis_year=eq.2025&op_income=is.null');
    const op2026Null = await count('stock_financials', 'analysis_year=eq.2026&op_income=is.null');

    log('### 연도별 집계');
    log('');
    log('| 항목 | 2025 | 2026 |');
    log('|------|------|------|');
    log(`| 총 레코드 | ${num(total2025)} | ${num(total2026)} |`);
    log(`| KOSPI | ${num(kospi2025)} | ${num(kospi2026)} |`);
    log(`| KOSDAQ | ${num(kosdaq2025)} | ${num(kosdaq2026)} |`);
    log(`| revenue NULL | ${num(rev2025Null)} | ${num(rev2026Null)} |`);
    log(`| op_income NULL | ${num(op2025Null)} | ${num(op2026Null)} |`);
    log(`| 2025 기대치(~2610) | ${status('2025', total2025 >= 2500 && total2025 <= 2700)} | - |`);
    log(`| 2026 기대치(~2526) | - | ${status('2026', total2026 >= 2400 && total2026 <= 2650)} |`);

    // Averages for 2025
    const { data: fin2025 } = await queryCount('stock_financials', 'debt_ratio,op_margin', 'analysis_year=eq.2025&debt_ratio=not.is.null');
    const { data: fin2026 } = await queryCount('stock_financials', 'debt_ratio,op_margin', 'analysis_year=eq.2026&debt_ratio=not.is.null');

    const avg = (arr, key) => {
      const vals = arr.map(r => r[key]).filter(v => v !== null && isFinite(v));
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };

    const avgDebt2025 = avg(fin2025, 'debt_ratio');
    const avgOp2025 = avg(fin2025, 'op_margin');
    const avgDebt2026 = avg(fin2026, 'debt_ratio');
    const avgOp2026 = avg(fin2026, 'op_margin');

    log('');
    log('### 재무 평균 (non-null 기준)');
    log('');
    log('| 지표 | 2025 | 2026 Q1 |');
    log('|------|------|---------|');
    log(`| avg debt_ratio | ${avgDebt2025?.toFixed(2) ?? 'N/A'} | ${avgDebt2026?.toFixed(2) ?? 'N/A'} |`);
    log(`| avg op_margin | ${avgOp2025?.toFixed(2) ?? 'N/A'} | ${avgOp2026?.toFixed(2) ?? 'N/A'} |`);
  } catch (e) {
    log(`> ❌ ERROR: ${e.message}`);
  }

  // ─────────────────────────────────────────
  // 4. stock_analysis_history table
  // ─────────────────────────────────────────
  log('');
  log('---');
  log('## 4. stock_analysis_history 테이블');
  log('');

  try {
    const totalHistory = await count('stock_analysis_history');
    const kospiHistory = await count('stock_analysis_history', 'mrkt_ctg=eq.KOSPI');
    const kosdaqHistory = await count('stock_analysis_history', 'mrkt_ctg=eq.KOSDAQ');

    // Distinct run IDs and latest snapshot
    const { data: runData } = await queryCount('stock_analysis_history', 'analysis_run_id,snapshot_at&order=snapshot_at.desc&limit=10000');
    const runIds = new Set(runData.map(r => r.analysis_run_id));
    const latestSnapshot = runData[0]?.snapshot_at;

    log(`| 항목 | 값 | 상태 |`);
    log(`|------|-----|------|`);
    log(`| 총 히스토리 레코드 | ${num(totalHistory)} | ${totalHistory > 0 ? '✅ PASS' : '⚠️ WARN'} |`);
    log(`| KOSPI 히스토리 | ${num(kospiHistory)} | - |`);
    log(`| KOSDAQ 히스토리 | ${num(kosdaqHistory)} | - |`);
    log(`| 고유 analysis_run_id 수 | ${runIds.size} | ${runIds.size > 0 ? '✅ PASS' : '⚠️ WARN'} |`);
    log(`| 최근 snapshot_at | ${latestSnapshot ?? 'N/A'} | - |`);
  } catch (e) {
    log(`> ❌ ERROR: ${e.message}`);
  }

  // ─────────────────────────────────────────
  // 5. stock_disclosures table
  // ─────────────────────────────────────────
  log('');
  log('---');
  log('## 5. stock_disclosures 테이블');
  log('');

  try {
    const totalDisc = await count('stock_disclosures');

    // Date range
    const { data: dateData } = await queryCount('stock_disclosures', 'rcept_dt&order=rcept_dt.asc&limit=1');
    const { data: dateDataDesc } = await queryCount('stock_disclosures', 'rcept_dt&order=rcept_dt.desc&limit=1');
    const minDate = dateData[0]?.rcept_dt;
    const maxDate = dateDataDesc[0]?.rcept_dt;

    log(`| 항목 | 값 | 상태 |`);
    log(`|------|-----|------|`);
    log(`| 총 공시 레코드 | ${num(totalDisc)} | ${totalDisc > 0 ? '✅ PASS' : '⚠️ WARN'} |`);
    log(`| 가장 이른 rcept_dt | ${minDate ?? 'N/A'} | - |`);
    log(`| 가장 최근 rcept_dt | ${maxDate ?? 'N/A'} | - |`);

    // Top 5 most disclosed stocks — fetch all and aggregate
    const { data: discData } = await queryCount('stock_disclosures', 'stock_code');
    const discCounts = {};
    for (const r of discData) {
      discCounts[r.stock_code] = (discCounts[r.stock_code] || 0) + 1;
    }
    const top5 = Object.entries(discCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    log('');
    log('### 공시 건수 상위 5개 종목');
    log('');
    log('| 순위 | 종목코드 | 공시 건수 |');
    log('|------|---------|---------|');
    for (let i = 0; i < top5.length; i++) {
      log(`| ${i + 1} | ${top5[i][0]} | ${num(top5[i][1])} |`);
    }
  } catch (e) {
    log(`> ❌ ERROR: ${e.message}`);
  }

  // ─────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────
  log('');
  log('---');
  log('## 요약 및 전체 평가');
  log('');
  log('| 테이블 | 주요 결과 | 종합 상태 |');
  log('|--------|----------|---------|');
  log('| stocks | 전체 종목 수, 시장별 분류, 중복 여부 확인 | 위 결과 참조 |');
  log('| stock_analysis | 점수 통계, 추천 분포, 상위 종목 | 위 결과 참조 |');
  log('| stock_financials | 연도별 레코드 수, 재무 평균 | 위 결과 참조 |');
  log('| stock_analysis_history | 스냅샷 이력 및 최신 날짜 | 위 결과 참조 |');
  log('| stock_disclosures | 총 공시 수, 날짜 범위, 상위 종목 | 위 결과 참조 |');
  log('');
  log('> 감사 완료. 위 체크리스트에서 ❌ FAIL 또는 ⚠️ WARN 항목을 중점 검토하세요.');
}

main().catch(e => { console.error(e); process.exit(1); });
