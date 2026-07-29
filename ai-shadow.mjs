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
// ★ 2026-07-29: 진입가를 판단 시점 실제 가격으로 잡기 위해 KIS를 쓴다.
//   KIS는 라이브봇(Toss)과 다른 API라 **토큰 경합이 없다**(Toss 토큰은 단일 인스턴스).
import { getMinuteBars } from './kis-api.js';
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
    -- ★ 2026-07-29: 진입가 출처 감사 + 벤치마크 청산 트랙(AI 청산과 병행 기록).
    --   AI가 정한 target/stop/horizon과 고정규칙을 동시에 굴려 "선택"과 "청산"의 기여를 분리한다.
    ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS entry_src TEXT;
    ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_status TEXT DEFAULT 'open';
    ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_hi NUMERIC;
    ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_close_price NUMERIC;
    ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_closed_at TIMESTAMPTZ;
    ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_reason TEXT;
    ALTER TABLE ai_shadow_positions ADD COLUMN IF NOT EXISTS bench_pnl_pct NUMERIC;
    SELECT 1;`);
}

const lastClose = async (code) => { const r = await q(`SELECT close FROM stock_prices WHERE stock_code='${esc(code)}' ORDER BY date DESC LIMIT 1`); return r[0] ? Number(r[0].close) : null; };

/**
 * ★ 2026-07-29 신규 — 판단 시점의 **실제 체결 가능 가격**.
 *   기존엔 진입가를 `sig.price || lastClose()`로 잡았는데 둘 다 일봉 스냅샷이라 08:47에 낼 수 없는 값이었다.
 *   실측(6건): 기록가와 진입일 시가의 차이 평균 -0.50%(비관 편향) — 크지는 않지만 벤치마크와 비교하려면
 *   가격 규약이 같아야 한다. combo-v2 라이브는 장중 실시간가로 사므로 여기도 실시간가를 쓴다.
 *   반환: { px, src } — src는 감사용('kis_1m' | 'sig' | 'lastclose')
 */
async function tradablePrice(code, sigPrice) {
  try {
    const r = await getMinuteBars(code);
    const px = Number(r?.now) || Number(r?.bars?.at(-1)?.c) || 0;
    if (px > 0) return { px, src: 'kis_1m' };
  } catch { /* 장전·휴장·레이트리밋 → 폴백 */ }
  if (Number(sigPrice) > 0) return { px: Number(sigPrice), src: 'sig' };
  const lc = await lastClose(code);
  return lc ? { px: lc, src: 'lastclose' } : { px: 0, src: 'none' };
}

/** 벤치마크 청산 규칙 (combo-v2 hi120과 동일 파라미터). AI가 정한 target/stop/horizon과 **병행 기록**해
 *  AI의 기여를 "종목 선택"만으로 분리 측정한다. AI 파라미터는 지우지 않는다(정보 보존). */
const BENCH = { trail: 6, hard: 7, tp1: 6, tp2: 12, maxHold: 20 };

// 보유 가상포지션 mark-to-market + 청산
async function markPositions() {
  // 벤치마크 트랙이 아직 열려 있는 건도 계속 평가해야 하므로 status='open' 만으로 거르지 않는다.
  const open = await q(`SELECT * FROM ai_shadow_positions WHERE status='open' OR bench_status='open'`);
  let closed = 0, held = 0, bClosed = 0;
  for (const p of open) {
    const px = await lastClose(p.stock_code);
    if (px == null) { held++; continue; }
    const entry = Number(p.entry_price);
    const ret = (px / entry - 1) * 100;
    const heldDays = Math.floor((Date.parse(kstDate()) - Date.parse(p.opened_date)) / 86400000);

    // ── AI 트랙 (AI가 정한 target/stop/horizon) ──
    if (p.status === 'open') {
      let reason = null;
      if (ret >= Number(p.target_pct)) reason = 'target';
      else if (ret <= -Number(p.stop_pct)) reason = 'stop';
      else if (heldDays >= Number(p.horizon_days)) reason = 'time';
      if (reason) {
        await q(`UPDATE ai_shadow_positions SET status='closed', close_price=${px}, closed_at=NOW(),
          close_reason='${reason}', pnl_pct=${ret.toFixed(2)} WHERE id=${p.id}`);
        log(`  청산[AI] ${p.name}(${p.stock_code}) ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% [${reason}] ${heldDays}일보유`);
        closed++;
      } else held++;
    }

    // ── 벤치마크 트랙 (고정규칙: 트레일 6% / 하드 -7% / 만기 20일. 부분익절은 미적용 — 단일 손익 추적) ──
    //   AI 청산과 **독립적으로** 굴린다. AI가 이미 팔았어도 벤치마크는 계속 들고 간다.
    if ((p.bench_status ?? 'open') === 'open') {
      const bhi = Math.max(Number(p.bench_hi ?? entry), px);
      let br = null;
      if (ret <= -BENCH.hard) br = 'hard';
      else if (px <= bhi * (1 - BENCH.trail / 100)) br = `trail(고점${Math.round(bhi).toLocaleString()})`;
      else if (heldDays >= BENCH.maxHold) br = 'time';
      if (br) {
        await q(`UPDATE ai_shadow_positions SET bench_status='closed', bench_close_price=${px}, bench_closed_at=NOW(),
          bench_reason='${esc(br)}', bench_pnl_pct=${ret.toFixed(2)}, bench_hi=${bhi} WHERE id=${p.id}`);
        log(`  청산[벤치] ${p.name}(${p.stock_code}) ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% [${br}] ${heldDays}일보유`);
        bClosed++;
      } else {
        await q(`UPDATE ai_shadow_positions SET bench_hi=${bhi} WHERE id=${p.id}`);
      }
    }
  }
  return { closed, held, bClosed };
}

async function main() {
  log(`=== SHADOW 스캔 시작 (days=${DAYS} max=${MAX} slots=${SLOTS} per=${PER.toLocaleString()}) ===`);
  await ensureTables();

  // 1) 보유 포지션 정산
  const mk = await markPositions();
  const openCodesRows = await q(`SELECT stock_code FROM ai_shadow_positions WHERE status='open'`);
  const openCodes = new Set(openCodesRows.map(r => r.stock_code));
  let openCount = openCodes.size;
  log(`보유 정산: AI청산 ${mk.closed} / 벤치청산 ${mk.bClosed} / 유지 ${mk.held} (현재 오픈 ${openCount}/${SLOTS})`);

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
        const { px, src: pxSrc } = await tradablePrice(cd.code, sig.price);
        const qty = px ? Math.floor(PER / px) : 0;
        if (qty < 1) { log(`  ${sig.name} BUY but 수량0 → 미오픈`); continue; }
        const s = dec.strategy;
        await q(`INSERT INTO ai_shadow_positions (opened_date,stock_code,name,entry_price,qty,budget,target_pct,stop_pct,horizon_days,thesis_break,conviction,catalyst,thesis)
          VALUES ('${kstDate()}','${esc(cd.code)}','${esc(sig.name)}',${px},${qty},${qty * px},${s.target_pct},${s.stop_pct},${s.horizon_days},${jesc(s.thesis_break)},${dec.conviction},'${esc(dec.catalyst)}',${jesc(dec.thesis)})`);
        openCount++; buys++;
        log(`  ✅ BUY ${sig.name}(${cd.code}) ${qty}주 @${px.toLocaleString()}[${pxSrc}] 확신${dec.conviction} 목표+${s.target_pct}%/손절-${s.stop_pct}%/${s.horizon_days}일 | ${dec.catalyst.slice(0, 50)}`);
      } else { skips++; log(`  skip ${sig.name}(${cd.code}) 확신${dec.conviction} — ${(dec.opposing[0] || dec.catalyst).slice(0, 60)}`); }
    } catch (e) { errs++; log(`  ${cd.name}(${cd.code}) 오류: ${String(e.message).slice(0, 80)}`); }
  }
  log(`=== 완료: BUY ${buys} / SKIP ${skips} / 오류 ${errs} | 오픈 ${openCount}/${SLOTS} ===`);
}
main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
