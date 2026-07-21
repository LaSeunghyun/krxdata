#!/usr/bin/env node
/**
 * forecast-skill.mjs — 실 원장+검증(forecast_ledger⋈forecast_verification)에서 예측 skill 계량 +
 *   harvest 규칙 활성화 게이트 판정. 감이 아니라 "검증된 적중률"로 shadow→live 전환을 결정.
 *
 *   실행: node forecast-skill.mjs [--days 60]
 *   활성화 조건(전부 충족 시 ACTIVATE 권고):
 *     ① 하락경보(bearish) 표본 ≥ MIN_ALERTS
 *     ② 경보→실제하락 적중률 ≥ 시장 base rate + EDGE_PP (우연 이상)
 *     ③ 경보→실제하락 적중률 ≥ HIT_FLOOR (절대 하한)
 *   bearish 재구성 = stock-live isBearish 동일: call=='down' OR (prob_down-prob_up≥15 & conf≥50)
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DAYS = Number(argOf('--days', '60'));
const PROBDIFF = 15, MINCONF = 50;         // FORECAST_GUARD 기본과 동일
const MIN_ALERTS = 20, EDGE_PP = 7, HIT_FLOOR = 55; // 활성화 게이트

async function dbQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j?.message ?? 'DB');
  return j;
}
const isBearish = (up, down, conf, call) => call === 'down' || (down - up >= PROBDIFF && conf >= MINCONF);

const rows = await dbQuery(`
  SELECT fl.sector, fl.call_direction, fl.probability_up, fl.probability_down, fl.confidence,
         fv.actual_return, fv.actual_class, fv.direction_hit, fv.abs_error, fv.structural_miss
  FROM forecast_verification fv JOIN forecast_ledger fl ON fl.id = fv.ledger_id
  WHERE fl.target_kind='market'
    AND fl.target_end_date >= TO_CHAR(CURRENT_DATE - ${DAYS}, 'YYYYMMDD')`);

if (!rows.length) { console.log(`검증된 시장예측 0건 (원장 축적 대기). 활성화: HOLD`); process.exit(0); }

const n = rows.length;
const dirHit = rows.filter(r => r.direction_hit).length / n;
const baseDown = rows.filter(r => r.actual_class === 'down').length / n; // 시장 하락 base rate
const structMiss = rows.filter(r => r.structural_miss).length;

const alerts = rows.filter(r => isBearish(Number(r.probability_up), Number(r.probability_down), Number(r.confidence), r.call_direction));
const aN = alerts.length;
const aHit = aN ? alerts.filter(r => r.actual_class === 'down').length / aN : 0;

console.log(`=== 예측 skill (최근 ${DAYS}일, 시장예측 ${n}건) ===`);
console.log(`방향 적중률        ${(dirHit * 100).toFixed(0)}%   (시장 하락 base rate ${(baseDown * 100).toFixed(0)}%)`);
console.log(`구조적 미스(2%p↑)  ${structMiss}건`);
console.log(`하락경보 표본       ${aN}건`);
console.log(`경보→실제하락 적중  ${aN ? (aHit * 100).toFixed(0) + '%' : '-'}   (base rate 대비 ${aN ? ((aHit - baseDown) * 100).toFixed(0) : '-'}%p)`);

// 활성화 게이트
const cond1 = aN >= MIN_ALERTS;
const cond2 = aHit >= baseDown + EDGE_PP / 100;
const cond3 = aHit >= HIT_FLOOR / 100;
const activate = cond1 && cond2 && cond3;
console.log(`\n활성화 게이트:`);
console.log(`  ① 경보표본 ≥ ${MIN_ALERTS}         ${cond1 ? '✅' : '❌'} (${aN})`);
console.log(`  ② 적중률 ≥ base+${EDGE_PP}%p       ${cond2 ? '✅' : '❌'} (${(aHit * 100).toFixed(0)}% vs ${(baseDown * 100 + EDGE_PP).toFixed(0)}%)`);
console.log(`  ③ 적중률 ≥ ${HIT_FLOOR}%            ${cond3 ? '✅' : '❌'} (${(aHit * 100).toFixed(0)}%)`);
console.log(`\n판정: ${activate ? '🟢 ACTIVATE 권고 — FORECAST_GUARD.shadow=false 전환 검토' : '🔴 HOLD (shadow 유지) — 예측력 미검증/미달'}`);
