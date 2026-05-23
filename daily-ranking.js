#!/usr/bin/env node
/**
 * daily-ranking.js
 * 매일 9시 실행: 전체 저평가 종목 랭킹 계산 + DB 저장 + 순위 변동 리포트
 */
import { readFileSync } from 'fs';
import { writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = join(__dirname, '.update-status.json');

function loadStatus() {
  try {
    if (existsSync(STATUS_FILE)) return JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
  } catch {}
  return { running: false, progress: 0, total: 2610, current: '대기 중', log: [] };
}

function patchStatus(patch) {
  try {
    const prev = loadStatus();
    writeFileSync(STATUS_FILE, JSON.stringify({ ...prev, ...patch }, null, 2), 'utf-8');
  } catch {}
}

const SUPABASE_URL = process.env.SUPABASE_URL || "https://onxkbuecwbcueuhwnowx.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ueGtidWVjd2JjdWV1aHdub3d4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDcyMjU3NDgsImV4cCI6MjA2MjgwMTc0OH0.r-7oRLJMaiWKiDB73A5XLhHFqSuNmXrQdv1QpxsEiJE";
const PUBLIC_KEY = process.env.PUBLIC_DATA_API_KEY || "buKN%2Fk5k1%2F0CaFK%2Bf2bgOyHrspRaL8NZE3sLKYtPIzKuvzMbE2W3MZJBkiL9djHpO3ugUgS3ph8rpuhX1PgG2w%3D%3D";
const PUBLIC_BASE = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService";
const DART_KEY = process.env.DART_API_KEY || "23a669211c9cbad873d5e65dcafa85de7626da92";

function today() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate()-n);
  return d.toISOString().slice(0,10).replace(/-/g,'');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SUPABASE_MANAGEMENT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "onxkbuecwbcueuhwnowx";

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_MANAGEMENT_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });
  return res.json();
}

async function upsert(table, rows, onConflict) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': `resolution=merge-duplicates,return=representation`,
      'on-conflict': onConflict
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`upsert ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

// 공공데이터 API 현재가 조회
async function getPublicDataQuote(stockCode) {
  try {
    const url = new URL(`${PUBLIC_BASE}/getStockPriceInfo`);
    url.searchParams.set("serviceKey", decodeURIComponent(PUBLIC_KEY));
    url.searchParams.set("resultType", "json");
    url.searchParams.set("numOfRows", "5");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("beginBasDt", daysAgo(7));
    url.searchParams.set("endBasDt", today());
    url.searchParams.set("likeIsinCd", `KR7${stockCode}`);
    const r = await fetch(url.toString());
    const data = await r.json();
    const items = data?.response?.body?.items?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    const item = arr.filter(r => r.srtnCd === stockCode).sort((a, b) => b.basDt.localeCompare(a.basDt))[0];
    if (!item) return null;
    return {
      price: parseInt(item.clpr, 10),
      market_cap: parseInt(item.mrktTotAmt, 10),
      base_date: item.basDt
    };
  } catch { return null; }
}

// STEP 1: 전체 종목 현재가 업데이트 (순차, 300ms 딜레이)
async function updatePrices() {
  const stocks = await dbQuery(`SELECT stock_code FROM stock_analysis WHERE market_cap_tril >= 0`);
  const codes = stocks.map(s => s.stock_code);
  console.log(`[가격 업데이트] ${codes.length}개 종목 시작`);
  patchStatus({ progress: 0, total: codes.length, current: `가격 업데이트 시작 (${codes.length}개)` });

  let updated = 0, skipped = 0;
  const BATCH = 50; // 50개씩 처리 후 로그
  for (const code of codes) {
    const q = await getPublicDataQuote(code);
    if (q && q.price > 0) {
      await upsert('stock_analysis', [{
        stock_code: code,
        current_price: q.price,
        market_cap_tril: parseFloat((q.market_cap / 1e12).toFixed(4)),
        updated_at: new Date().toISOString()
      }], 'stock_code');
      updated++;
    } else {
      skipped++;
    }
    await sleep(300);
    if ((updated + skipped) % BATCH === 0) {
      const done = updated + skipped;
      const pct = Math.round((done / codes.length) * 50); // 가격=0~50%
      console.log(`  진행: ${done}/${codes.length} (업데이트 ${updated}, 스킵 ${skipped})`);
      patchStatus({ progress: pct, current: `가격 업데이트 중 (${done}/${codes.length})` });
    }
  }
  console.log(`[가격 업데이트 완료] 업데이트 ${updated}, 스킵 ${skipped}`);
  patchStatus({ progress: 50, current: '가격 업데이트 완료' });
}

// STEP 2: 저평가 전체 랭킹 계산 + DB 저장
async function computeAndSaveRankings() {
  console.log(`[랭킹 계산] 시작`);
  patchStatus({ progress: 60, current: '랭킹 계산 중...' });
  const r = await dbQuery(`
    INSERT INTO daily_rankings (
      rank_date, rank, stock_code, corp_name, mrkt_ctg, sector,
      current_price, market_cap_tril, pbr, per, roe, op_margin, debt_ratio,
      undervalue_score, total_score, sector_avg_pbr, sector_avg_per
    )
    WITH scored AS (
      SELECT
        sa.stock_code,
        sa.corp_name,
        sa.mrkt_ctg,
        sa.sector,
        sa.current_price,
        sa.market_cap_tril,
        sa.total_score,
        sf.pbr,
        sf.per,
        sf.roe,
        sf.op_margin,
        sf.debt_ratio,
        ss.avg_pbr AS sector_avg_pbr,
        ss.avg_per AS sector_avg_per,
        ROUND((
          GREATEST(0, (1.0 - sf.pbr / NULLIF(ss.avg_pbr, 0)) * 40)
          + GREATEST(0, (1.0 - sf.per / NULLIF(ss.avg_per, 0)) * 30)
          + LEAST(30, sf.roe * 1.5)
        )::NUMERIC, 1) AS undervalue_score
      FROM stock_analysis sa
      JOIN stock_financials sf ON sa.stock_code = sf.stock_code AND sf.analysis_year = 2025
      LEFT JOIN sector_stats ss ON sa.sector = ss.sector AND sa.mrkt_ctg = ss.mrkt_ctg
      WHERE sa.current_price > 0
        AND sf.pbr > 0 AND sf.pbr < 100
        AND ss.avg_pbr IS NOT NULL
    )
    SELECT
      CURRENT_DATE,
      ROW_NUMBER() OVER (ORDER BY undervalue_score DESC NULLS LAST),
      stock_code, corp_name, mrkt_ctg, sector,
      current_price, market_cap_tril, pbr, per, roe, op_margin, debt_ratio,
      undervalue_score, total_score, sector_avg_pbr, sector_avg_per
    FROM scored
    WHERE undervalue_score IS NOT NULL
    ON CONFLICT (rank_date, stock_code) DO UPDATE SET
      rank = EXCLUDED.rank,
      undervalue_score = EXCLUDED.undervalue_score,
      current_price = EXCLUDED.current_price,
      market_cap_tril = EXCLUDED.market_cap_tril,
      pbr = EXCLUDED.pbr,
      per = EXCLUDED.per,
      roe = EXCLUDED.roe
    RETURNING rank, stock_code, corp_name, undervalue_score
  `);

  if (!Array.isArray(r)) { console.error("랭킹 오류:", r); return []; }
  console.log(`[랭킹 저장 완료] ${r.length}건`);
  patchStatus({ progress: 90, current: `랭킹 저장 완료 (${r.length}건)` });
  return r;
}

// STEP 3: 순위 변동 리포트 출력
async function printChangeReport() {
  const changes = await dbQuery(`
    SELECT
      rank_today,
      rank_yesterday,
      rank_change,
      stock_code,
      corp_name,
      mrkt_ctg,
      sector,
      current_price,
      prev_price,
      price_change,
      pbr,
      per,
      undervalue_score,
      score_change
    FROM rank_changes
    WHERE rank_today <= 50
    ORDER BY rank_today
  `);

  if (!Array.isArray(changes)) { console.log("변동 데이터 없음"); return; }

  console.log("\n========== 저평가 랭킹 TOP 50 ==========");
  console.log(`기준일: ${new Date().toLocaleDateString('ko-KR')}`);
  console.log("순위  변동  종목명              시장     섹터            현재가     PBR   PER   저평가점수  점수변동");
  console.log("─".repeat(100));

  for (const c of changes) {
    const change = c.rank_change === null ? "NEW" :
      c.rank_change > 0 ? `▲${c.rank_change}` :
      c.rank_change < 0 ? `▼${Math.abs(c.rank_change)}` : "─";
    const scoreChange = c.score_change !== null && c.score_change !== 0
      ? (c.score_change > 0 ? `+${c.score_change}` : `${c.score_change}`)
      : "";
    const priceStr = c.current_price.toLocaleString('ko-KR');
    console.log(
      `${String(c.rank_today).padStart(4)}  ${change.padEnd(5)}  ${c.corp_name.padEnd(18)}  ${c.mrkt_ctg.padEnd(7)}  ${(c.sector||'').slice(0,14).padEnd(14)}  ${priceStr.padStart(9)}원  ${String(c.pbr||'').padStart(5)}  ${String(c.per||'').padStart(6)}  ${String(c.undervalue_score||'').padStart(8)}  ${scoreChange}`
    );
  }

  // 순위 급등/급락 TOP 5
  const bigMovers = changes.filter(c => c.rank_change !== null && Math.abs(c.rank_change) >= 10);
  if (bigMovers.length > 0) {
    console.log("\n========== 순위 급변동 (±10위 이상) ==========");
    bigMovers.sort((a, b) => Math.abs(b.rank_change) - Math.abs(a.rank_change)).slice(0, 10).forEach(c => {
      const arrow = c.rank_change > 0 ? `▲${c.rank_change}위 상승` : `▼${Math.abs(c.rank_change)}위 하락`;
      console.log(`  ${c.corp_name} (${c.stock_code}): ${arrow} | PBR ${c.prev_pbr}→${c.pbr} | 점수 ${c.score_change > 0 ? '+' : ''}${c.score_change}`);
    });
  }
}

// MAIN
const args = process.argv.slice(2);
const skipPrice = args.includes('--skip-price');

// 상태 파일이 없거나 서버 외부에서 직접 실행할 때 초기화
const prevStatus = loadStatus();
if (!prevStatus.running) {
  patchStatus({
    running: true,
    mode: skipPrice ? 'ranking' : 'full',
    progress: 0,
    current: skipPrice ? '랭킹 업데이트 시작...' : '가격+랭킹 업데이트 시작...',
    startedAt: new Date().toISOString()
  });
}

try {
  if (!skipPrice) {
    await updatePrices();
  } else {
    console.log("[가격 업데이트 스킵]");
    patchStatus({ progress: 10, current: '가격 업데이트 스킵됨' });
  }
  await computeAndSaveRankings();
  await printChangeReport();
  const now = new Date().toLocaleString('ko-KR');
  console.log("\n[완료]", now);
  patchStatus({ running: false, progress: 100, current: '완료', lastDone: now });
} catch (e) {
  console.error("[오류]", e);
  patchStatus({ running: false, current: `오류: ${e.message}` });
  process.exit(1);
}
