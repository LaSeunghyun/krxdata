#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { toKstDateKey } from './trading-time.mjs';
import {
  buildImprovementLoop,
  formatImprovementLoopReport,
} from './forecast-improvement-loop.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const days = numericArg('--days', 90);

for (const k of ['SUPABASE_MANAGEMENT_KEY', 'SUPABASE_PROJECT_REF']) {
  if (!process.env[k]) {
    console.error(`환경변수 미설정: ${k}`);
    process.exit(1);
  }
}

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB query failed');
  return data;
}

const esc = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const jsonb = (o) => (o == null ? 'NULL' : `$j$${JSON.stringify(o).replace(/\$/g, '')}$j$::jsonb`);

async function fetchVerifiedMarketRows(windowDays) {
  const safeDays = Math.max(1, Math.min(365, Math.trunc(Number(windowDays) || 90)));
  return dbQuery(`
    SELECT fl.id, fl.run_id, fl.market_layer, fl.target_kind, fl.sector,
           fl.target_start_date, fl.target_end_date, fl.target_start_hm, fl.target_end_hm,
           fl.forecast_median, fl.forecast_low, fl.forecast_high,
           fl.probability_up, fl.probability_flat, fl.probability_down,
           fl.flat_band, fl.sigma, fl.call_direction, fl.baselines,
           fv.actual_return, fv.structural_miss, fv.error_cause
    FROM forecast_verification fv
    JOIN forecast_ledger fl ON fl.id = fv.ledger_id
    WHERE fl.target_kind = 'market'
      AND fl.target_end_date >= TO_CHAR(CURRENT_DATE - ${safeDays}, 'YYYYMMDD')
    ORDER BY fl.target_end_date, fl.id`);
}

async function main() {
  const rows = await fetchVerifiedMarketRows(days);
  const loop = buildImprovementLoop(rows);
  const today = toKstDateKey();
  const payload = { date: today, days, dry, ...loop };

  if (!dry) {
    await dbQuery(`
      INSERT INTO paper_state (k, data, updated_at)
      VALUES (${esc(`fc_improvement_loop:${today}`)}, ${jsonb(payload)}, NOW()),
             ('fc_improvement_loop:latest', ${jsonb(payload)}, NOW())
      ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
  }

  console.log(formatImprovementLoopReport(loop));
  if (dry) console.log('\n[DRY] paper_state 저장 생략');
}

function numericArg(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

main().catch(e => {
  console.error(`[forecast-improvement] 실패: ${e.message}`);
  process.exit(1);
});
