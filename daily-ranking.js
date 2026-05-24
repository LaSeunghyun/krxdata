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

// 공공데이터 API 현재가 + 52주 고저가 조회
async function getPublicDataQuote(stockCode, fetch52w = false) {
  try {
    const url = new URL(`${PUBLIC_BASE}/getStockPriceInfo`);
    url.searchParams.set("serviceKey", decodeURIComponent(PUBLIC_KEY));
    url.searchParams.set("resultType", "json");
    url.searchParams.set("numOfRows", fetch52w ? "260" : "5");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("beginBasDt", fetch52w ? daysAgo(365) : daysAgo(7));
    url.searchParams.set("endBasDt", today());
    url.searchParams.set("likeIsinCd", `KR7${stockCode}`);
    const r = await fetch(url.toString());
    const data = await r.json();
    const items = data?.response?.body?.items?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    const filtered = arr.filter(r => r.srtnCd === stockCode).sort((a, b) => b.basDt.localeCompare(a.basDt));
    const item = filtered[0];
    if (!item) return null;
    const result = {
      price: parseInt(item.clpr, 10),
      market_cap: parseInt(item.mrktTotAmt, 10),
      base_date: item.basDt
    };
    if (fetch52w && filtered.length > 1) {
      const prices = filtered.map(i => parseInt(i.clpr, 10)).filter(p => p > 0);
      result.high_52w = Math.max(...prices);
      result.low_52w  = Math.min(...prices);
    }
    return result;
  } catch { return null; }
}

// STEP 1: 전체 종목 현재가 + 52주 고저가 업데이트
// 수정: REST API(anon key) → management API(dbQuery) SQL 방식으로 전환
// 이유: anon key 만료 시 upsert 401 → 52주 데이터 미갱신 문제 해결
async function updatePrices() {
  const stocks = await dbQuery(`SELECT stock_code FROM stock_analysis WHERE market_cap_tril >= 0`);
  const codes = stocks.map(s => s.stock_code);
  console.log(`[가격 업데이트] ${codes.length}개 종목 시작 (52주 고저가 항상 갱신)`);
  patchStatus({ progress: 0, total: codes.length, current: `가격 업데이트 시작 (${codes.length}개)` });

  let updated = 0, skipped = 0;
  const BATCH     = 50;   // 진행 로그 주기
  const SQL_BATCH = 200;  // SQL upsert 묶음 크기

  const buffer = []; // { code, price, cap, high, low }

  async function flushBuffer() {
    if (!buffer.length) return;
    const vals = buffer.map(r =>
      `('${r.code}', ${r.price}, ${r.cap}` +
      (r.high != null ? `, ${r.high}, ${r.low}, NOW()` : `, NULL, NULL, NOW()`) +
      `)`
    ).join(',\n');
    await dbQuery(`
      INSERT INTO stock_analysis
        (stock_code, current_price, market_cap_tril, high_52w, low_52w, week52_updated_at)
      VALUES ${vals}
      ON CONFLICT (stock_code) DO UPDATE SET
        current_price     = EXCLUDED.current_price,
        market_cap_tril   = EXCLUDED.market_cap_tril,
        high_52w          = COALESCE(EXCLUDED.high_52w, stock_analysis.high_52w),
        low_52w           = COALESCE(EXCLUDED.low_52w,  stock_analysis.low_52w),
        week52_updated_at = COALESCE(EXCLUDED.week52_updated_at, stock_analysis.week52_updated_at),
        updated_at        = NOW()
    `);
    buffer.length = 0;
  }

  for (const code of codes) {
    const q = await getPublicDataQuote(code, true); // 항상 52주 갱신
    if (q && q.price > 0) {
      buffer.push({
        code,
        price: q.price,
        cap: parseFloat((q.market_cap / 1e12).toFixed(4)),
        high: q.high_52w ?? null,
        low:  q.low_52w  ?? null,
      });
      updated++;
    } else {
      skipped++;
    }
    await sleep(300);

    const done = updated + skipped;
    if (buffer.length >= SQL_BATCH) await flushBuffer();
    if (done % BATCH === 0) {
      const pct = Math.round((done / codes.length) * 50);
      console.log(`  진행: ${done}/${codes.length} (업데이트 ${updated}, 스킵 ${skipped})`);
      patchStatus({ progress: pct, current: `가격 업데이트 중 (${done}/${codes.length})` });
    }
  }
  await flushBuffer(); // 나머지 flush
  console.log(`[가격 업데이트 완료] 업데이트 ${updated}, 스킵 ${skipped}`);
  patchStatus({ progress: 50, current: '가격 업데이트 완료' });
}

// STEP 2: 저평가 전체 랭킹 계산 + DB 저장
async function computeAndSaveRankings() {
  console.log(`[랭킹 계산] 시작`);
  patchStatus({ progress: 60, current: '랭킹 계산 중...' });
  // 오늘 데이터 초기화 후 재삽입 (이전 실행 잔여 데이터 제거)
  await dbQuery(`DELETE FROM daily_rankings WHERE rank_date = CURRENT_DATE`);

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
        -- 52주 위치 (0~1, 높을수록 고점에 가까움)
        CASE
          WHEN sa.high_52w > sa.low_52w
          THEN (sa.current_price - sa.low_52w)::NUMERIC / NULLIF(sa.high_52w - sa.low_52w, 0)
          ELSE 0.5
        END AS price_position_52w,
        ROUND((
          -- [가치 25pt] 섹터 PBR 할인율: 백분위 기반 연속 점수
          GREATEST(0, LEAST(25, (1.0 - sf.pbr / NULLIF(ss.avg_pbr, 0)) * 25))
          -- [가치 15pt] 섹터 PER 할인율
          + GREATEST(0, LEAST(15, (1.0 - sf.per / NULLIF(ss.avg_per, 0)) * 15))
          -- [수익성 15pt] ROE
          + LEAST(15, sf.roe * 0.75)
          -- [모멘텀 15pt] 52주 위치 기반 연속 점수 (저점 근접 = 역발상 매수 신호)
          + CASE
              WHEN sa.high_52w > sa.low_52w AND sa.low_52w > 0 THEN
                GREATEST(0, LEAST(15,
                  (1.0 - (sa.current_price - sa.low_52w)::NUMERIC / NULLIF(sa.high_52w - sa.low_52w, 0)) * 15
                ))
              ELSE 7.5  -- 52주 데이터 없으면 중간값
            END
          -- [품질 10pt] 영업이익률
          + LEAST(10, GREATEST(0, sf.op_margin * 0.5))
          -- [성장성 20pt] 영업이익 YoY 성장률 (신규)
          + CASE
              WHEN sf.op_income_yoy IS NULL THEN 0
              WHEN sf.op_income_yoy > 50  THEN 20
              WHEN sf.op_income_yoy > 20  THEN 15
              WHEN sf.op_income_yoy > 0   THEN 10
              WHEN sf.op_income_yoy > -20 THEN 3
              ELSE 0
            END
          -- [부채비율 페널티 -15pt max] 보수적 리스크 조정
          - CASE
              WHEN sf.debt_ratio IS NULL   THEN 0
              WHEN sf.debt_ratio > 200     THEN 15
              WHEN sf.debt_ratio > 150     THEN 10
              WHEN sf.debt_ratio > 100     THEN 5
              ELSE 0
            END
        )::NUMERIC, 1) AS undervalue_score
      FROM stock_analysis sa
      JOIN stock_financials sf ON sa.stock_code = sf.stock_code AND sf.analysis_year = 2025
      LEFT JOIN sector_stats ss ON sa.sector = ss.sector AND sa.mrkt_ctg = ss.mrkt_ctg
      WHERE sa.current_price > 0
        AND sf.pbr > 0 AND sf.pbr < 100
        AND ss.avg_pbr IS NOT NULL
        -- 하드 필터: 부채비율 300% 초과 제거
        AND (sf.debt_ratio IS NULL OR sf.debt_ratio < 300)
        -- 하드 필터: ROE 음수(적자) 제거 / 바이오는 ROE > 5% 강화
        AND (
          (sa.sector NOT LIKE '%바이오%' AND sa.sector NOT LIKE '%의약%' AND sf.roe > 0)
          OR (sa.sector LIKE '%바이오%' OR sa.sector LIKE '%의약%') AND sf.roe > 5
        )
        -- 하드 필터: 영업이익률 > 2% (적자 직전 제거)
        AND sf.op_margin > 2
        -- 하드 필터: 시총 1,000억 미만 제거 (500억→1,000억 보수적 강화)
        AND sa.market_cap_tril >= 0.1
        -- 하드 필터: 52주 위치 70% 초과(모멘텀 하락 구간) 제거
        AND (
          sa.high_52w IS NULL OR sa.low_52w IS NULL OR sa.high_52w = sa.low_52w
          OR (sa.current_price - sa.low_52w)::NUMERIC / NULLIF(sa.high_52w - sa.low_52w, 0) < 0.7
        )
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

// STEP 2.1: op_income_yoy 계산 — 2024/2025 op_income 교차 업데이트
async function calcOpIncomeYoy() {
  const r = await dbQuery(`
    UPDATE stock_financials f25
    SET op_income_yoy = ROUND(
      (f25.op_income - f24.op_income)::NUMERIC / NULLIF(ABS(f24.op_income), 0) * 100,
      1
    )
    FROM stock_financials f24
    WHERE f25.stock_code     = f24.stock_code
      AND f25.analysis_year  = 2025
      AND f24.analysis_year  = 2024
      AND f25.op_income      IS NOT NULL
      AND f24.op_income      IS NOT NULL
      AND f24.op_income     != 0
      AND f25.op_income_yoy  IS NULL
  `);
  // 2023→2024도 동일 처리
  await dbQuery(`
    UPDATE stock_financials f24
    SET op_income_yoy = ROUND(
      (f24.op_income - f23.op_income)::NUMERIC / NULLIF(ABS(f23.op_income), 0) * 100,
      1
    )
    FROM stock_financials f23
    WHERE f24.stock_code     = f23.stock_code
      AND f24.analysis_year  = 2024
      AND f23.analysis_year  = 2023
      AND f24.op_income      IS NOT NULL
      AND f23.op_income      IS NOT NULL
      AND f23.op_income     != 0
      AND f24.op_income_yoy  IS NULL
  `);
  const remaining = await dbQuery(
    `SELECT COUNT(*) cnt FROM stock_financials WHERE analysis_year=2025 AND op_income_yoy IS NULL`
  );
  console.log(`[YoY 계산 완료] 남은 NULL: ${remaining[0]?.cnt ?? '?'}건 (2024 데이터 없는 종목)`);
}

// 목표가 계산 (Codex v4: 1M 계수 보수화 0.20→0.10, 달성률 제고)
// score 80 → 1M: +8.0%, 3M: +32.0%, 1Y: +64.0%
// score 60 → 1M: +6.0%, 3M: +24.0%, 1Y: +48.0%
function calcTargetPrice(currentPrice, undervalueScore, period = '1m') {
  if (!currentPrice || !undervalueScore || undervalueScore <= 0) return null;
  const coeff = period === '1y' ? 0.80 : period === '3m' ? 0.40 : 0.10;
  return Math.round(currentPrice * (1 + (undervalueScore / 100) * coeff));
}

// 매크로 레짐 게이트: 삼성전자(005930) KOSPI 프록시 기준 시장 상태 판단
// ETF API 미지원으로 삼성전자(KOSPI 비중 ~30%) 사용
async function checkMarketRegime() {
  try {
    const url = new URL(`${PUBLIC_BASE}/getStockPriceInfo`);
    url.searchParams.set("serviceKey", decodeURIComponent(PUBLIC_KEY));
    url.searchParams.set("resultType", "json");
    url.searchParams.set("numOfRows", "25");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("beginBasDt", daysAgo(30));
    url.searchParams.set("endBasDt", today());
    url.searchParams.set("likeIsinCd", "KR7005930");
    const r = await fetch(url.toString());
    const data = await r.json();
    const items = data?.response?.body?.items?.item ?? [];
    const arr = (Array.isArray(items) ? items : [items])
      .filter(i => i.srtnCd === '005930')
      .sort((a, b) => b.basDt.localeCompare(a.basDt));
    if (arr.length < 6) return { status: 'unknown', warn: false };
    const latest  = parseInt(arr[0].clpr, 10);
    const day5ago = parseInt(arr[5].clpr, 10);
    const ma20    = arr.slice(0, Math.min(arr.length, 20))
                       .reduce((s, i) => s + parseInt(i.clpr, 10), 0) / Math.min(arr.length, 20);
    const ret5d   = ((latest - day5ago) / day5ago) * 100;
    const belowMA = latest < ma20;
    const warn    = belowMA && ret5d < -3;
    return { latest, ma20: Math.round(ma20), ret5d: ret5d.toFixed(2), belowMA, warn };
  } catch { return { status: 'error', warn: false }; }
}

// ─────────────────────────────────────────────────────────────
// STEP 2.5: 빅배스 턴어라운드 감시 (Stage 1 — 모니터링 전용)
// 합의된 3단계 로드맵:
//   Stage 1 (현재): DART 잠정실적 감지 → 감시 목록 출력 (랭킹 미편입)
//   Stage 2 (3개월 후): 감시 목록 백테스트 → 수익률 검증
//   Stage 3 (검증 후): --enable-recovery 플래그로 Codex 4조건 필터 완화 활성화
// ─────────────────────────────────────────────────────────────

/**
 * 빅배스 후보 조건 (SQL):
 *   Condition 1: 2025 op_margin < 0  (직전 연도 일회성 적자)
 *   Condition 2: 2024 op_margin > 0  (전전 연도 흑자 — 구조적 부실 아님)
 *   Condition 4: debt_ratio < 350%   (재무 붕괴 방어)
 *
 * 추가 조건 (DART):
 *   Condition 3: 최근 6개월 내 잠정실적 공시 존재 → 회복 확인
 *
 * Stage 3 활성화 시 추가:
 *   → 랭킹 편입 + 불확실성 페널티 -10pt 부과
 */
async function detectBigBathRecovery() {
  try {
    // Condition 1 + 2 + 4: DB에서 후보 추출
    const candidates = await dbQuery(`
      SELECT sa.stock_code, sa.corp_name, sa.mrkt_ctg, sa.sector,
             sa.current_price, sa.market_cap_tril,
             sf25.op_margin  AS op_margin_2025,
             sf25.roe        AS roe_2025,
             sf25.debt_ratio AS debt_ratio,
             sf24.op_margin  AS op_margin_2024
      FROM stock_analysis sa
      JOIN stock_financials sf25 ON sa.stock_code = sf25.stock_code AND sf25.analysis_year = 2025
      JOIN stock_financials sf24 ON sa.stock_code = sf24.stock_code AND sf24.analysis_year = 2024
      WHERE sf25.op_margin < 0
        AND sf24.op_margin > 0
        AND (sf25.debt_ratio IS NULL OR sf25.debt_ratio < 350)
        AND sa.market_cap_tril >= 0.1
        AND sa.current_price > 0
      ORDER BY sa.market_cap_tril DESC
      LIMIT 50
    `);

    if (!Array.isArray(candidates) || candidates.length === 0) return [];

    // Condition 3: DART 잠정실적 공시 체크 (순차, rate limit 주의)
    const recovered = [];
    for (const s of candidates) {
      try {
        const bgn = daysAgo(180);
        const end = today();
        const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_KEY}` +
                    `&stock_code=${s.stock_code}&bgn_de=${bgn}&end_de=${end}&page_count=10`;
        const r   = await fetch(url);
        const d   = await r.json();
        const items = d?.list ?? [];

        const hit = items.find(i =>
          i.report_nm.includes('잠정실적') ||
          i.report_nm.includes('영업(잠정)') ||
          i.report_nm.includes('잠정)실적')  ||
          i.report_nm.includes('잠정 실적')
        );

        if (hit) {
          recovered.push({
            ...s,
            disclosure_date:  hit.rcept_dt,
            disclosure_title: hit.report_nm.trim(),
          });
        }
        await sleep(150); // DART rate limit
      } catch { /* 개별 오류 무시 */ }
    }

    return recovered;
  } catch (e) {
    console.error('[빅배스 감지 오류]', e.message);
    return [];
  }
}

function printRecoveryWatch(candidates) {
  if (!candidates.length) {
    console.log('\n[턴어라운드 감시] 해당 종목 없음 (Condition 1~4 미충족)');
    return;
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  🔄 빅배스 턴어라운드 감시 목록  [Stage 1 — 모니터링 전용, 랭킹 미편입]       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  console.log('  ※ 2025 영업 적자(필터 탈락) + 2024 흑자 + 잠정실적 공시 확인 종목');
  console.log('  ※ Stage 3 활성화(--enable-recovery) 전까지 관찰만 수행\n');
  console.log('종목명            코드    시총(억)  2025이익률  2024이익률  부채비율  잠정실적 공시');
  console.log('─'.repeat(105));

  for (const c of candidates) {
    const cap = (c.market_cap_tril * 1000).toFixed(0);
    console.log(
      `${c.corp_name.slice(0, 14).padEnd(16)} ${c.stock_code}  ` +
      `${String(cap + '억').padStart(8)}  ` +
      `${String((c.op_margin_2025 ?? '-') + '%').padStart(10)}  ` +
      `${String((c.op_margin_2024 ?? '-') + '%').padStart(10)}  ` +
      `${String((c.debt_ratio ?? '-') + '%').padStart(8)}  ` +
      `${c.disclosure_date}: ${c.disclosure_title.slice(0, 25)}`
    );
  }

  console.log(`\n  → 감지 ${candidates.length}건 | 3개월 백테스트 후 --enable-recovery 플래그로 편입 활성화`);
  console.log('  → Stage 3 편입 시 스코어에 불확실성 페널티 -10pt 자동 부과');
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
      score_change,
      sector_avg_pbr
    FROM rank_changes
    WHERE rank_today <= 50
    ORDER BY rank_today
  `);

  if (!Array.isArray(changes)) { console.log("변동 데이터 없음"); return; }

  console.log("\n========== 저평가 랭킹 TOP 20 (매수 포트폴리오) ==========");
  console.log(`기준일: ${new Date().toLocaleDateString('ko-KR')}`);
  console.log("순위  변동  종목명              시장   섹터          현재가   1M목표(+%)   3M목표(+%)   1Y목표(+%)  점수  비중");
  console.log("─".repeat(125));

  const top20 = changes.filter(c => c.rank_today <= 20);
  for (const c of top20) {
    const change = c.rank_change === null ? "NEW" :
      c.rank_change > 0 ? `▲${c.rank_change}` :
      c.rank_change < 0 ? `▼${Math.abs(c.rank_change)}` : "─";
    const t1m = calcTargetPrice(c.current_price, c.undervalue_score, '1m');
    const t3m = calcTargetPrice(c.current_price, c.undervalue_score, '3m');
    const t1y = calcTargetPrice(c.current_price, c.undervalue_score, '1y');
    const fmt = (t, base) => t ? `${t.toLocaleString()}(+${((t-base)/base*100).toFixed(1)}%)` : '-';
    const weight = c.rank_today <= 10 ? '10%' : ' 5%';
    console.log(
      `${String(c.rank_today).padStart(3)}  ${change.padEnd(5)} ${c.corp_name.slice(0,14).padEnd(16)} ${c.mrkt_ctg.padEnd(6)} ${(c.sector||'').slice(0,12).padEnd(13)} ` +
      `${c.current_price.toLocaleString('ko-KR').padStart(8)}  ` +
      `${fmt(t1m,c.current_price).padStart(14)}  ${fmt(t3m,c.current_price).padStart(14)}  ${fmt(t1y,c.current_price).padStart(14)}  ` +
      `${String(c.undervalue_score||'').padStart(5)}  ${weight}`
    );
  }

  console.log("\n  [리밸런싱 규칙] 스톱로스 -25% 즉시청산 | +100% 절반익절 | 반기(6개월) 전체 재스크리닝");

  // TOP 21~50 간략 표시
  const rest = changes.filter(c => c.rank_today > 20 && c.rank_today <= 50);
  if (rest.length > 0) {
    console.log("\n---------- TOP 21~50 (관찰 대상) ----------");
    console.log("순위  변동  종목명              시장   현재가     PBR   점수");
    console.log("─".repeat(65));
    for (const c of rest) {
      const change = c.rank_change === null ? "NEW" :
        c.rank_change > 0 ? `▲${c.rank_change}` :
        c.rank_change < 0 ? `▼${Math.abs(c.rank_change)}` : "─";
      console.log(
        `${String(c.rank_today).padStart(3)}  ${change.padEnd(5)} ${c.corp_name.slice(0,14).padEnd(16)} ${c.mrkt_ctg.padEnd(6)} ` +
        `${c.current_price.toLocaleString('ko-KR').padStart(8)}  ${String(c.pbr||'').padStart(5)} ${String(c.undervalue_score||'').padStart(5)}`
      );
    }
  }

  // 순위 급변동
  const bigMovers = changes.filter(c => c.rank_change !== null && Math.abs(c.rank_change) >= 10);
  if (bigMovers.length > 0) {
    console.log("\n========== 순위 급변동 (±10위 이상) ==========");
    bigMovers.sort((a, b) => Math.abs(b.rank_change) - Math.abs(a.rank_change)).slice(0, 10).forEach(c => {
      const arrow = c.rank_change > 0 ? `▲${c.rank_change}위 상승` : `▼${Math.abs(c.rank_change)}위 하락`;
      console.log(`  ${c.corp_name} (${c.stock_code}): ${arrow} | PBR ${c.pbr} | 점수변동 ${c.score_change > 0 ? '+' : ''}${c.score_change}`);
    });
  }
}

// MAIN
const args           = process.argv.slice(2);
const skipPrice      = args.includes('--skip-price');
const enableRecovery = args.includes('--enable-recovery'); // Stage 3: 3개월 백테스트 완료 후 활성화

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
    await updatePrices(skipPrice);
  } else {
    console.log("[가격 업데이트 스킵]");
    patchStatus({ progress: 10, current: '가격 업데이트 스킵됨' });
  }
  // 매크로 레짐 게이트 체크
  const regime = await checkMarketRegime();
  if (regime.warn) {
    console.log("\n⚠️  [매크로 경고] 시장 위험 구간 감지!");
    console.log(`   KODEX200: ${regime.latest?.toLocaleString()}원 / 20MA: ${regime.ma20?.toLocaleString()}원 (MA 하향)`);
    console.log(`   5일 수익률: ${regime.ret5d}% (임계값 -3% 초과)`);
    console.log("   → 신규 진입 보류 권고. 기존 보유 종목 스톱로스 확인 필요.\n");
  } else if (regime.latest) {
    console.log(`[시장 체크] KODEX200 ${regime.latest?.toLocaleString()}원 / 20MA ${regime.ma20?.toLocaleString()}원 / 5일수익률 ${regime.ret5d}% — 정상`);
  }

  // op_income_yoy 계산 (데이터 있는 경우 자동 갱신)
  await calcOpIncomeYoy();

  await computeAndSaveRankings();
  await printChangeReport();

  // Stage 1: 빅배스 턴어라운드 감시 (항상 실행)
  console.log('\n[턴어라운드 감시] 빅배스 후보 탐색 중...');
  const recoveryWatch = await detectBigBathRecovery();
  printRecoveryWatch(recoveryWatch);

  if (enableRecovery) {
    // Stage 3: --enable-recovery 플래그 활성 시 경고 (아직 SQL 미구현 — 백테스트 후 적용)
    console.log('\n⚠️  [--enable-recovery] Stage 3 플래그 감지. 백테스트 검증 완료 후 SQL 필터 완화 적용 예정.');
  }

  const now = new Date().toLocaleString('ko-KR');
  console.log("\n[완료]", now);
  patchStatus({ running: false, progress: 100, current: '완료', lastDone: now });
} catch (e) {
  console.error("[오류]", e);
  patchStatus({ running: false, current: `오류: ${e.message}` });
  process.exit(1);
}
