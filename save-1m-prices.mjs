/**
 * save-1m-prices.mjs — 분봉기반 연구용(스캘핑 등) 1분봉 장기누적 (2026-07-24 등록).
 *   토스 1분봉은 실측 ~8거래일까지만 조회 가능 → 매일 이 스크립트로 당일치를 Supabase에 영구 적재해
 *   장기 표본을 쌓는다. stock_prices_1m (stock_code, ts) PK, 멱등(ON CONFLICT DO NOTHING).
 *
 *   ⚠ 실행 시점 중요: 라이브봇(stock-live.mjs) marketOpen()=08:00~20:00 KST 동안 signalScanLoop가
 *   토스를 상시 사용 중이고, rateSlot() 페이서가 프로세스별 독립이라 동시 실행 시 429 경합 발생(실측 확인,
 *   2026-07-24). 반드시 20:00 KST 이후(cron 20:15 권장)에만 실행 — 장중 수동 실행 금지.
 *
 * 실행: node save-1m-prices.mjs [--top 30]
 * env: SUPABASE_MANAGEMENT_KEY, SUPABASE_PROJECT_REF, TOSS_CLIENT_ID/SECRET
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!MGMT_KEY || !PROJECT_REF) { console.error('SUPABASE_MANAGEMENT_KEY/PROJECT_REF 미설정'); process.exit(1); }

const argv = process.argv.slice(2);
const argOf = (k, dflt) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : dflt; };
const TOP_N = Number(argOf('--top', 30));

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}

async function ensureTable() {
  await dbQuery(`CREATE TABLE IF NOT EXISTS stock_prices_1m (
    stock_code TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL,
    open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC, volume BIGINT,
    PRIMARY KEY (stock_code, ts)
  )`);
}

async function insertRows(rows) {
  const CHUNK = 1_000;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const vals = rows.slice(i, i + CHUNK)
      .filter(r => Number.isFinite(r.close) && r.close > 0)
      .map(r => `('${r.code}','${r.ts}',${r.open},${r.high},${r.low},${r.close},${r.volume})`).join(',');
    if (!vals) continue;
    await dbQuery(`INSERT INTO stock_prices_1m (stock_code, ts, open, high, low, close, volume) VALUES ${vals} ON CONFLICT (stock_code, ts) DO NOTHING`);
    done += Math.min(CHUNK, rows.length - i);
  }
  return done;
}

const { isTossConfigured, getCandles1m } = await import('./toss-api.js');
if (!isTossConfigured()) { console.error('TOSS_CLIENT_ID/SECRET 미설정'); process.exit(1); }

await ensureTable();

const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
const TODAY = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`;
console.log(`[save-1m-prices] ${TODAY} 당일 1분봉 적재 시작 (상위 ${TOP_N}종목)`);

const universe = await dbQuery(`SELECT stock_code, corp_name FROM stock_analysis WHERE current_price>=2000 AND avg_turnover_20d>=3e9 ORDER BY avg_turnover_20d DESC LIMIT ${TOP_N}`);
console.log(`[save-1m-prices] 유니버스 ${universe.length}종목`);

const rows = [];
let ok = 0, fail = 0;
for (const { stock_code, corp_name } of universe) {
  try {
    const bars = await getCandles1m(stock_code, 500, null); // 당일치(NXT 포함 여유있게 500봉 요청 후 날짜필터)
    for (const b of bars) {
      if (!String(b.timestamp).startsWith(TODAY)) continue;
      rows.push({ code: stock_code, ts: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
    ok++;
  } catch (e) {
    fail++;
    console.log(`  ${corp_name}(${stock_code}) 실패: ${String(e.message).slice(0, 80)}`);
  }
}
const inserted = await insertRows(rows);
console.log(`[save-1m-prices] 완료 — 성공 ${ok}/${universe.length}종목(실패 ${fail}), 후보 ${rows.length}행 중 적재 시도 ${inserted}행 (중복 제외)`);
