#!/usr/bin/env node
/**
 * ai-shadow.mjs — AI 판단 트레이더 SHADOW 러너 (실주문 없음, 가상매매 기록·추적).
 *
 * 흐름: 전체 유동성 유니버스(거래대금 30억+)에서 촉매(공시) 뜬 종목 → 신호조립(ai-signals)
 *   → AI 판단(ai-judge: thesis·전략·확신도) → shadow 원장 기록. buy면 가상 포지션 오픈.
 *   매 실행마다 보유 가상포지션 mark-to-market + 목표/손절/보유기간 청산.
 * 검증: shadow 성과가 combo-v2 벤치마크를 몇 주간 이기면 실계좌 승격(그 전엔 실주문 절대 없음).
 * 비용통제: 촉매 타입 필터 + total_score 랭킹 + --max 상한(초과분 로그로 명시, 조용한 절단 금지).
 * 실행: node ai-shadow.mjs [--days 2] [--max 20] [--slots 5] [--per 2000000]
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFileSync } from 'fs';
import { assembleSignals } from './ai-signals.mjs';
import { judgeCandidate } from './ai-judge.mjs';
import { classifyDisclosure } from './ai-events.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DAYS = Number(argOf('--days', '2'));
const MAX = Number(argOf('--max', '20'));
const SLOTS = Number(argOf('--slots', '5'));
const PER = Number(argOf('--per', '2000000'));
const kst = () => new Date(Date.now() + 9 * 3600000);
const kstDate = () => kst().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/'/g, "''");
const jesc = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const LOG = join(__dirname, 'ai-shadow-log.txt');
const log = (m) => { const line = `[${kst().toISOString().slice(0, 19)}KST] ${m}`; console.log(line); try { appendFileSync(LOG, line + '\n'); } catch {} };

// AI 판단 대상 촉매 타입(매수 셋업 가능성 있는 것만 — 순수악재/노이즈 제외로 비용통제)
const BUY_TRIGGER = new Set(['무상증자', '자사주취득', '자사주소각', '수주계약', '현금배당', '기업가치제고', '흑자전환', '실적', '대량보유5%', '최대주주변경', '타법인투자', '경영중요사항', '주식양수도']);

const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`SQL: ${JSON.stringify(j).slice(0, 150)}`);
  return j;
};

async function ensureTables() {
  await q(`
    CREATE TABLE IF NOT EXISTS ai_shadow_decisions (
      id BIGSERIAL PRIMARY KEY, run_at TIMESTAMPTZ DEFAULT NOW(), decided_date TEXT,
      stock_code TEXT, name TEXT, sector TEXT, price NUMERIC,
      decision TEXT, conviction INT, catalyst TEXT,
      thesis JSONB, strategy JSONB, supporting JSONB, opposing JSONB, news_check TEXT, signals JSONB);
    ALTER TABLE ai_shadow_decisions ADD COLUMN IF NOT EXISTS analyst_check TEXT;   -- 2026-07-24 애널리스트 리포트 판단 추가
    ALTER TABLE ai_shadow_decisions ADD COLUMN IF NOT EXISTS analyst JSONB;        -- 집계 스냅샷(목표가·상하향·커버리지)
    CREATE TABLE IF NOT EXISTS ai_shadow_positions (
      id BIGSERIAL PRIMARY KEY, opened_at TIMESTAMPTZ DEFAULT NOW(), opened_date TEXT,
      stock_code TEXT, name TEXT, entry_price NUMERIC, qty INT, budget NUMERIC,
      target_pct NUMERIC, stop_pct NUMERIC, horizon_days INT, thesis_break JSONB,
      conviction INT, catalyst TEXT, thesis JSONB,
      status TEXT DEFAULT 'open', close_price NUMERIC, closed_at TIMESTAMPTZ, close_reason TEXT, pnl_pct NUMERIC);
    SELECT 1;`);
}

const lastClose = async (code) => { const r = await q(`SELECT close FROM stock_prices WHERE stock_code='${esc(code)}' ORDER BY date DESC LIMIT 1`); return r[0] ? Number(r[0].close) : null; };

// 보유 가상포지션 mark-to-market + 청산
async function markPositions() {
  const open = await q(`SELECT * FROM ai_shadow_positions WHERE status='open'`);
  let closed = 0, held = 0;
  for (const p of open) {
    const px = await lastClose(p.stock_code);
    if (px == null) { held++; continue; }
    const ret = (px / Number(p.entry_price) - 1) * 100;
    const heldDays = Math.floor((Date.parse(kstDate()) - Date.parse(p.opened_date)) / 86400000);
    let reason = null;
    if (ret >= Number(p.target_pct)) reason = 'target';
    else if (ret <= -Number(p.stop_pct)) reason = 'stop';
    else if (heldDays >= Number(p.horizon_days)) reason = 'time';
    if (reason) {
      await q(`UPDATE ai_shadow_positions SET status='closed', close_price=${px}, closed_at=NOW(),
        close_reason='${reason}', pnl_pct=${ret.toFixed(2)} WHERE id=${p.id}`);
      log(`  청산 ${p.name}(${p.stock_code}) ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% [${reason}] ${heldDays}일보유`);
      closed++;
    } else held++;
  }
  return { closed, held };
}

async function main() {
  log(`=== SHADOW 스캔 시작 (days=${DAYS} max=${MAX} slots=${SLOTS} per=${PER.toLocaleString()}) ===`);
  await ensureTables();

  // 1) 보유 포지션 정산
  const mk = await markPositions();
  const openCodesRows = await q(`SELECT stock_code FROM ai_shadow_positions WHERE status='open'`);
  const openCodes = new Set(openCodesRows.map(r => r.stock_code));
  let openCount = openCodes.size;
  log(`보유 정산: 청산 ${mk.closed} / 유지 ${mk.held} (현재 오픈 ${openCount}/${SLOTS})`);

  // 2) 촉매 후보 수집 (유동성 유니버스, 최근 DAYS일 공시)
  const rows = await q(`SELECT d.stock_code, d.report_nm, a.corp_name, a.total_score
    FROM stock_disclosures d JOIN stock_analysis a ON a.stock_code=d.stock_code
    WHERE d.rcept_dt >= '${daysAgo(DAYS)}' AND a.avg_turnover_20d >= 3e9 AND a.current_price >= 1000`);
  const byCode = new Map();
  for (const r of rows) {
    const c = classifyDisclosure(r.report_nm);
    if (!c.catalytic || !BUY_TRIGGER.has(c.type)) continue;
    const cur = byCode.get(r.stock_code) || { code: r.stock_code, name: r.corp_name, score: Number(r.total_score) || 0, types: new Set() };
    cur.types.add(c.type); byCode.set(r.stock_code, cur);
  }
  // 이미 오늘 판단했거나 보유중인 종목 제외
  const decidedRows = await q(`SELECT DISTINCT stock_code FROM ai_shadow_decisions WHERE decided_date='${kstDate()}'`);
  const decided = new Set(decidedRows.map(r => r.stock_code));
  let cands = [...byCode.values()].filter(c => !openCodes.has(c.code) && !decided.has(c.code));
  cands.sort((a, b) => b.score - a.score);
  const total = cands.length;
  const dropped = Math.max(0, total - MAX);
  cands = cands.slice(0, MAX);
  log(`촉매 후보 ${total}종목 → 판단대상 ${cands.length}${dropped ? ` (⚠️ ${dropped}종목은 --max 상한으로 이번 미판단)` : ''}`);

  // 3) 후보별 신호조립 + AI 판단 + 기록
  let buys = 0, skips = 0, errs = 0;
  for (const cd of cands) {
    try {
      const sig = await assembleSignals(cd.code, { dbQuery: q, days: DAYS + 5 });
      if (!sig || !sig.events.some(e => BUY_TRIGGER.has(e.type))) { log(`  ${cd.name}(${cd.code}) 촉매 재확인 실패 → 건너뜀`); continue; }
      const dec = judgeCandidate(sig);
      if (!dec) { errs++; log(`  ${cd.name}(${cd.code}) 판단 실패(null)`); continue; }
      await q(`INSERT INTO ai_shadow_decisions (decided_date,stock_code,name,sector,price,decision,conviction,catalyst,thesis,strategy,supporting,opposing,news_check,signals,analyst_check,analyst)
        VALUES ('${kstDate()}','${esc(cd.code)}','${esc(sig.name)}','${esc(sig.sector || '')}',${Number(sig.price) || 0},
        '${dec.decision}',${dec.conviction},'${esc(dec.catalyst)}',${jesc(dec.thesis)},${jesc(dec.strategy)},${jesc(dec.supporting)},${jesc(dec.opposing)},'${esc(dec.news_check || '')}',${jesc(sig.events.map(e => ({ d: e.date, t: e.type, p: e.polarity })))},'${esc(dec.analyst_check || '')}',${jesc(sig.analyst)})`);
      if (dec.decision === 'buy') {
        if (openCount >= SLOTS) { log(`  ${sig.name} BUY(확신${dec.conviction}) but 슬롯 만석 → 미오픈`); skips++; continue; }
        const px = Number(sig.price) || (await lastClose(cd.code));
        const qty = px ? Math.floor(PER / px) : 0;
        if (qty < 1) { log(`  ${sig.name} BUY but 수량0 → 미오픈`); continue; }
        const s = dec.strategy;
        await q(`INSERT INTO ai_shadow_positions (opened_date,stock_code,name,entry_price,qty,budget,target_pct,stop_pct,horizon_days,thesis_break,conviction,catalyst,thesis)
          VALUES ('${kstDate()}','${esc(cd.code)}','${esc(sig.name)}',${px},${qty},${qty * px},${s.target_pct},${s.stop_pct},${s.horizon_days},${jesc(s.thesis_break)},${dec.conviction},'${esc(dec.catalyst)}',${jesc(dec.thesis)})`);
        openCount++; buys++;
        log(`  ✅ BUY ${sig.name}(${cd.code}) ${qty}주 @${px.toLocaleString()} 확신${dec.conviction} 목표+${s.target_pct}%/손절-${s.stop_pct}%/${s.horizon_days}일 | ${dec.catalyst.slice(0, 50)}`);
      } else { skips++; log(`  skip ${sig.name}(${cd.code}) 확신${dec.conviction} — ${(dec.opposing[0] || dec.catalyst).slice(0, 60)}`); }
    } catch (e) { errs++; log(`  ${cd.name}(${cd.code}) 오류: ${String(e.message).slice(0, 80)}`); }
  }
  log(`=== 완료: BUY ${buys} / SKIP ${skips} / 오류 ${errs} | 오픈 ${openCount}/${SLOTS} ===`);
}
main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
