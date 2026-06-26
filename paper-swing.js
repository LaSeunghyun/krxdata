#!/usr/bin/env node
/**
 * paper-swing.js — 스윙 전략 페이퍼 포워드 러너 (실주문 없음)
 *   백테스트(backtest-swing.mjs)와 동일 규칙을 매일 실데이터로 전진 검증.
 *   전략 4종 × 가상 자본 각 1,000만원: swing-mom · hi120 · rsi2 · overnight
 *
 *   페이즈 (KST 자동 감지):
 *     morning (09:00~11:30): 전일 예약된 시가 청산 집행 (오늘 시가)
 *     close   (15:30~):      당일 종가 시그널 평가 → 종가 매수 기록 + 익일 시가 청산 예약
 *
 *   상태·체결·자산곡선: Supabase paper_state / paper_trades / paper_equity
 *   (Actions 러너가 휘발성이라 파일 대신 DB 영속화)
 *   GitHub Actions: 09:03 랭킹 잡 뒤(morning), 15:45 크론(close)
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { pickBuyCandidates, allocateSlots } from './slot-alloc.js';
import {
  isTossConfigured, getDailyCandles, getKrMarketCalendar,
  getAccounts, getHoldings, getBuyingPower, getPricesMap, createOrder, getOrder, cancelOrder,
} from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const CAPITAL = 10_000_000;
const FEE_BPS = 1.5, TAX_BPS = 15;
const MIN_PRICE = 2_000;

// 백테스트(2023~2026) 검증 결과 반영: swing-mom·overnight 탈락, combo(v2) 추가
const STRATEGIES = {
  'hi120': { slots: 10, lookback: 120, trailPct: 10, maxHold: 60 },
  'rsi2':  { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },
  // combo: 레짐 적응형 (UP: hi120 6+rsi2 4 / NEUTRAL: hi120 2+rsi2 6 / DOWN: rsi2 4만)
  // 사유 분석 반영 룰: hi120 돌파폭 3%+만, rsi2 서브 최대보유 5일
  'combo': { slots: 10, rsiMax: 10, stopPct: 7, maxHoldR: 5, lookback: 120, trailPct: 8, maxHoldH: 60, minBreakout: 3, rsiDays: 2, tp1R: 1, rsiMa: 3, tp2R: 2 },
};
const COMBO_CAPS = { UP: { hi120: 6, rsi2: 4 }, NEUTRAL: { hi120: 2, rsi2: 6 }, DOWN: { hi120: 0, rsi2: 4 } };

const kst = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstDate = () => kst().toISOString().slice(0, 10).replace(/-/g, '');
const kstHM = () => kst().toISOString().slice(11, 16);
const log = (...a) => console.log(`[paper ${kstHM()}]`, ...a);

function tickSize(p) {
  if (p < 2_000) return 1;
  if (p < 5_000) return 5;
  if (p < 20_000) return 10;
  if (p < 50_000) return 50;
  if (p < 200_000) return 100;
  if (p < 500_000) return 500;
  return 1_000;
}
const tickUp = (p) => Math.round(p / tickSize(p)) * tickSize(p) + tickSize(p);
const tickDn = (p) => Math.round(p / tickSize(p)) * tickSize(p) - tickSize(p);
function netPnl(entry, exit, qty) {
  const gross = (exit - entry) * qty;
  const fees = (entry + exit) * qty * (FEE_BPS / 10_000) + exit * qty * (TAX_BPS / 10_000);
  return Math.round(gross - fees);
}

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}

async function ensureTables() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS paper_state (k TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS paper_trades (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ, strat TEXT, type TEXT,
      code TEXT, name TEXT, qty INT, price NUMERIC, entry NUMERIC, pnl NUMERIC, reason TEXT);
    CREATE TABLE IF NOT EXISTS paper_equity (date TEXT, strat TEXT, equity NUMERIC, ret NUMERIC,
      positions INT, PRIMARY KEY (date, strat));
    CREATE TABLE IF NOT EXISTS paper_journal (date TEXT PRIMARY KEY, data JSONB, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS paper_market_brief (date TEXT PRIMARY KEY, data JSONB, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS ctx JSONB;
    SELECT 1
  `);
}
async function loadBooks() {
  const rows = await dbQuery(`SELECT data FROM paper_state WHERE k = 'books'`);
  const saved = rows.length && rows[0].data
    ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data)
    : {};
  const books = {};
  for (const k of Object.keys(STRATEGIES)) {
    books[k] = saved[k] ?? { cash: CAPITAL, positions: {}, startedAt: kstDate() };
  }
  // 폐지된 전략 북: 보유분 종가 청산 기록 후 제거
  for (const [k, book] of Object.entries(saved)) {
    if (STRATEGIES[k]) continue;
    for (const [code, p] of Object.entries(book.positions ?? {})) {
      const t = lastBar(await bars(code, 3));
      const tmp = { [k]: book };
      paperSell(tmp, k, code, t?.close ?? p.entry, 'strategy_removed');
    }
    log(`전략 폐지: ${k} (최종 현금 ${Math.round(book.cash).toLocaleString()}원 기록 후 제거)`);
  }
  return books;
}
async function saveBooks(b) {
  const json = JSON.stringify(b).replace(/\$/g, ''); // dollar-quote 충돌 방지 ($ 미사용 데이터)
  await dbQuery(`INSERT INTO paper_state (k, data, updated_at) VALUES ('books', $j$${json}$j$::jsonb, NOW())
                 ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
}
const tradeQueue = [];
const recordTrade = (t) => tradeQueue.push(t);
async function flushTrades() {
  if (!tradeQueue.length) return;
  const esc = (s) => s == null ? 'NULL' : `$s$${String(s).replace(/\$/g, '')}$s$`;
  const num = (v) => Number.isFinite(v) ? v : 'NULL';
  const vals = tradeQueue.map(t =>
    `(${esc(t.ts)}::timestamptz, ${esc(t.strat)}, ${esc(t.type)}, ${esc(t.code)}, ${esc(t.name)}, ${num(t.qty)}, ${num(t.price)}, ${num(t.entry)}, ${num(t.pnl)}, ${esc(t.reason)}, ${t.ctx ? `$j$${JSON.stringify(t.ctx).replace(/\$/g, '')}$j$::jsonb` : 'NULL'})`
  ).join(',');
  await dbQuery(`INSERT INTO paper_trades (ts, strat, type, code, name, qty, price, entry, pnl, reason, ctx) VALUES ${vals}`);
  tradeQueue.length = 0;
}

// 일봉 캐시 (이번 실행 한정)
const barsCache = new Map();
let barsFailCount = 0;
async function bars(code, n = 130) {
  if (!barsCache.has(code)) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { barsCache.set(code, (await getDailyCandles(code, n)).reverse()); lastErr = null; break; } // 오름차순
      catch (e) { lastErr = e; if (attempt === 0) await new Promise(r => setTimeout(r, 800)); } // 전이성 401/네트워크 1회 재시도
    }
    // 실패 시 조용히 []로 스킵하던 동작 → 로그로 가시화 (close 페이즈 종목 누락 추적용)
    if (lastErr) { barsFailCount++; barsCache.set(code, []); log(`⚠️ 일봉 조회 실패 ${code}: ${lastErr.message} — 스킵(시그널 누락 가능, 누적 ${barsFailCount}건)`); }
  }
  return barsCache.get(code);
}
const lastBar = (list) => list[list.length - 1];

function paperSell(books, strat, code, fillRaw, reason, qtyArg) {
  const book = books[strat];
  const p = book.positions[code];
  if (!p) return;
  const qty = qtyArg ?? p.qty;
  const fill = tickDn(fillRaw);
  const pnl = netPnl(p.entry, fill, qty);
  book.cash += fill * qty;
  recordTrade({ ts: kst().toISOString(), strat, type: 'sell', code, name: p.name, qty, price: fill, entry: p.entry, pnl, reason, ctx: { ...(p.ctx ?? {}), hold: p.holdDays ?? 0 } });
  log(`${pnl >= 0 ? '🔵' : '🔴'} [${strat}] 매도 ${p.name ?? code} ${qty}주 @${fill.toLocaleString()} (${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}원, ${reason})`);
  p.qty -= qty;
  if (p.qty < 1) delete book.positions[code];
}
function paperBuy(books, strat, code, name, fillRaw, meta = {}) {
  const book = books[strat];
  const budget = Math.floor((book.cash + Object.values(book.positions).reduce((s, p) => s + p.entry * p.qty, 0)) / STRATEGIES[strat].slots);
  const fill = tickUp(fillRaw);
  const qty = Math.floor(Math.min(budget, book.cash) / fill);
  if (qty < 1) return;
  book.cash -= fill * qty;
  book.positions[code] = { name, qty, entry: fill, entryDay: kstDate(), hi: fill, holdDays: 0, ...meta };
  recordTrade({ ts: kst().toISOString(), strat, type: 'buy', code, name, qty, price: fill, ctx: meta.ctx });
  log(`🟢 [${strat}] 매수 ${name ?? code} ${qty}주 @${fill.toLocaleString()}${meta.ctx ? ` (${Object.entries(meta.ctx).map(([k2, v]) => k2 + '=' + v).join(', ')})` : ''}`);
}

function rsi2val(closes, i) {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) {
    const ch = closes[j] - closes[j - 1];
    if (ch > 0) up += ch; else dn -= ch;
  }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}

// PIT 모멘텀 top30 (stock_prices — 매일 갱신됨)
async function momUniverse() {
  return dbQuery(`
    SELECT t.stock_code, sa.corp_name, sa.sector,
           (MAX(CASE WHEN rn = 1 THEN close END)::NUMERIC
            / NULLIF(MAX(CASE WHEN rn = 61 THEN close END), 0) - 1) * 100 AS ret60
    FROM (
      SELECT stock_code, close, ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
      FROM stock_prices WHERE date >= TO_CHAR(CURRENT_DATE - 180, 'YYYYMMDD')
    ) t
    JOIN stock_analysis sa ON sa.stock_code = t.stock_code
    WHERE rn IN (1, 61) AND sa.market_cap_tril >= 0.1 AND sa.current_price >= ${MIN_PRICE}
    GROUP BY t.stock_code, sa.corp_name, sa.sector
    HAVING (MAX(CASE WHEN rn = 1 THEN close END)::NUMERIC
            / NULLIF(MAX(CASE WHEN rn = 61 THEN close END), 0) - 1) * 100 > 0
    ORDER BY ret60 DESC
    LIMIT 30
  `);
}

// ── 마켓 브리핑: 섹터 강도 + 저평가 + 공시 스캔 ────────────────
const GOOD_DISCLOSURE = ['단일판매', '공급계약', '잠정실적', '무상증자', '자기주식취득', '자사주', '특허'];
const BAD_DISCLOSURE = ['유상증자', '전환사채', '신주인수권부사채', '감자', '소송', '거래정지', '불성실', '관리종목', '횡령', '배임'];

async function buildMarketBrief(books, universe, largeCaps) {
  const today = kstDate();
  // ① 섹터 강도 (5d/20d 중앙값) + 평균 PBR — "강한 섹터 중 저평가" 식별
  const sectors = await dbQuery(`
    WITH px AS (
      SELECT stock_code, close, ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) rn
      FROM stock_prices WHERE date >= TO_CHAR(CURRENT_DATE - 60, 'YYYYMMDD')
    ),
    stk AS (
      SELECT p1.stock_code,
             (p1.close::NUMERIC / NULLIF(p6.close, 0) - 1) * 100 AS ret5,
             (p1.close::NUMERIC / NULLIF(p21.close, 0) - 1) * 100 AS ret20
      FROM px p1
      JOIN px p6 ON p6.stock_code = p1.stock_code AND p6.rn = 6
      JOIN px p21 ON p21.stock_code = p1.stock_code AND p21.rn = 21
      WHERE p1.rn = 1
    )
    SELECT sa.sector, COUNT(*) n,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stk.ret5)::NUMERIC, 2) AS ret5,
           ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stk.ret20)::NUMERIC, 2) AS ret20,
           ROUND(AVG(ss.avg_pbr)::NUMERIC, 2) AS avg_pbr
    FROM stk
    JOIN stock_analysis sa ON sa.stock_code = stk.stock_code
    LEFT JOIN sector_stats ss ON ss.sector = sa.sector AND ss.mrkt_ctg = sa.mrkt_ctg
    WHERE sa.sector IS NOT NULL
    GROUP BY sa.sector HAVING COUNT(*) >= 10
    ORDER BY ret20 DESC
  `);

  // ② 후보·보유 종목 공시 스캔 (전일~당일, DART)
  const held = new Set();
  for (const book of Object.values(books)) for (const code of Object.keys(book.positions)) held.add(code);
  const watch = [...new Set([...universe.map(u => u.stock_code), ...largeCaps.map(r => r.stock_code), ...held])];
  const disclosures = [];
  if (process.env.DART_API_KEY) {
    const bgn = new Date(Date.now() + 9 * 3600 * 1000); bgn.setUTCDate(bgn.getUTCDate() - 3);
    const bgnStr = bgn.toISOString().slice(0, 10).replace(/-/g, '');
    for (const code of watch) {
      try {
        const r = await fetch(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${process.env.DART_API_KEY}&stock_code=${code}&bgn_de=${bgnStr}&end_de=${today}&page_count=10`,
          { signal: AbortSignal.timeout(10_000) });
        const d = await r.json();
        for (const item of d?.list ?? []) {
          const title = item.report_nm ?? '';
          const good = GOOD_DISCLOSURE.some(k => title.includes(k));
          const bad = BAD_DISCLOSURE.some(k => title.includes(k));
          if (good || bad) disclosures.push({ code, name: item.corp_name, date: item.rcept_dt, title: title.trim().slice(0, 50), tone: bad ? 'bad' : 'good' });
        }
        await new Promise(r2 => setTimeout(r2, 120)); // DART rate limit
      } catch { /* 개별 실패 무시 */ }
    }
  }

  const strong = sectors.slice(0, 3);
  const weak = sectors.slice(-3).reverse();
  const valueInStrong = sectors.filter(s => Number(s.ret20) > 0 && Number(s.avg_pbr) > 0 && Number(s.avg_pbr) < 1.5).slice(0, 3);
  const notes = [
    `[섹터 강세 TOP3] ${strong.map(s => `${s.sector}(20d ${s.ret20 >= 0 ? '+' : ''}${s.ret20}%)`).join(', ')}`,
    `[섹터 약세 TOP3] ${weak.map(s => `${s.sector}(20d ${s.ret20}%)`).join(', ')}`,
    `[강세+저PBR 섹터] ${valueInStrong.length ? valueInStrong.map(s => `${s.sector}(PBR ${s.avg_pbr})`).join(', ') : '해당 없음'}`,
    `[호재 공시] ${disclosures.filter(d => d.tone === 'good').map(d => `${d.name}: ${d.title}`).join(' | ') || '없음'}`,
    `[악재 공시] ${disclosures.filter(d => d.tone === 'bad').map(d => `${d.name}: ${d.title}`).join(' | ') || '없음'}`,
  ].join('\n');

  const data = { sectors, disclosures };
  await dbQuery(`INSERT INTO paper_market_brief (date, data, notes) VALUES ('${today}', $j$${JSON.stringify(data).replace(/\$/g, '')}$j$::jsonb, $n$${notes.replace(/\$/g, '')}$n$)
                 ON CONFLICT (date) DO UPDATE SET data = EXCLUDED.data, notes = EXCLUDED.notes`);
  console.log('\n===== 마켓 브리핑 =====\n' + notes + '\n');
  return data;
}

async function loadTodayBrief() {
  const rows = await dbQuery(`SELECT data FROM paper_market_brief WHERE date = '${kstDate()}'`);
  if (!rows.length) return null;
  return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
}

// 브리핑 기계 반영: 악재 공시 제외 + 약세 하위 섹터 후순위
function applyBrief(universe, brief, sectorOf) {
  if (!brief) return universe;
  const badCodes = new Set(brief.disclosures.filter(d => d.tone === 'bad').map(d => d.code));
  const weakSectors = new Set(brief.sectors.slice(-Math.max(1, Math.floor(brief.sectors.length * 0.2))).map(s => s.sector));
  const kept = universe.filter(u => {
    if (badCodes.has(u.stock_code)) { log(`  브리핑 제외(악재 공시): ${u.corp_name}`); return false; }
    return true;
  });
  return [...kept.filter(u => !weakSectors.has(sectorOf.get(u.stock_code))), ...kept.filter(u => weakSectors.has(sectorOf.get(u.stock_code)))];
}

// ── 매매 일지: 당일 체결 정리 + 규칙 기반 분석 ─────────────────
async function buildJournal() {
  const today = kstDate();
  const trades = await dbQuery(`SELECT * FROM paper_trades WHERE ts >= '${fmtIso(today)}T00:00:00+09:00' ORDER BY ts`);
  const sells = trades.filter(t => t.type === 'sell');
  const buys = trades.filter(t => t.type === 'buy');
  const lines = [];

  for (const t of sells) {
    const retPct = ((t.price / t.entry - 1) * 100).toFixed(1);
    let why = { stop_loss: '손절', half_profit: '+100% 절반익절', rebalance: '주간 리밸런스 이탈', trailing: '고점 대비 트레일링', ma5_exit: 'MA5 회귀 익절', max_hold: '보유기간 만료', overnight_exit: '오버나이트 청산' }[t.reason] ?? t.reason;
    if (t.reason === 'stop_loss' && Number(retPct) < -28) why += ' (갭하락 시가 집행 — 스톱 미끄러짐)';
    lines.push(`  ${Number(t.pnl) >= 0 ? '🔵' : '🔴'} [${t.strat}] ${t.name ?? t.code} ${t.qty}주 ${Number(t.entry).toLocaleString()}→${Number(t.price).toLocaleString()} (${retPct}%, ${Number(t.pnl) >= 0 ? '+' : ''}${Number(t.pnl).toLocaleString()}원) — ${why}`);
  }
  if (buys.length) lines.push(`  진입 ${buys.length}건: ` + buys.map(t => `[${t.strat}] ${t.name ?? t.code}`).join(', '));

  // 전략별 최근 10거래 성적 → 다음 날 참고 (승률 30% 미만 + 5거래 이상 = 쿨다운 대상)
  const recent = await dbQuery(`
    SELECT strat, COUNT(*) n, COUNT(*) FILTER (WHERE pnl > 0) w, ROUND(SUM(pnl)) sum_pnl
    FROM (SELECT strat, pnl, ROW_NUMBER() OVER (PARTITION BY strat ORDER BY ts DESC) rn
          FROM paper_trades WHERE type = 'sell') t
    WHERE rn <= 10 GROUP BY strat
  `);
  for (const r of recent) {
    const wr = Math.round(r.w / r.n * 100);
    const cold = r.n >= 5 && wr < 30;
    lines.push(`  [${r.strat}] 최근 ${r.n}거래 승률 ${wr}% 누적 ${Number(r.sum_pnl).toLocaleString()}원${cold ? ' ⚠️ 쿨다운: 내일 신규 슬롯 절반' : ''}`);
  }

  // 조건별 누적 성적 → 해야할 것/하지말아야할 것 (ctx 기록 기반, 표본 10건 이상)
  const conds = await dbQuery(`
    SELECT COALESCE(ctx->>'sub', strat) sub, ctx->>'regime' regime,
           COUNT(*) n, COUNT(*) FILTER (WHERE pnl > 0) w, ROUND(SUM(pnl)) sum_pnl
    FROM paper_trades WHERE type = 'sell' AND ctx IS NOT NULL AND ctx->>'regime' IS NOT NULL
    GROUP BY 1, 2 HAVING COUNT(*) >= 10
    ORDER BY COUNT(*) FILTER (WHERE pnl > 0)::NUMERIC / COUNT(*) DESC
  `);
  if (conds.length) {
    lines.push('  ── 조건별 누적 (전진 검증) ──');
    for (const c of conds) {
      const wr = Math.round(c.w / c.n * 100);
      const mark = wr >= 55 && Number(c.sum_pnl) > 0 ? '✅' : (wr < 40 || Number(c.sum_pnl) < 0) ? '⛔' : '·';
      lines.push(`  ${mark} ${c.sub} × ${c.regime}: n=${c.n} 승률 ${wr}% 누적 ${Number(c.sum_pnl).toLocaleString()}원`);
    }
  }
  const notes = lines.length ? lines.join('\n') : '  (당일 체결 없음)';
  const data = { sells, buys: buys.map(b => ({ strat: b.strat, code: b.code, name: b.name })), recent };
  await dbQuery(`INSERT INTO paper_journal (date, data, notes) VALUES ('${today}', $j$${JSON.stringify(data).replace(/\$/g, '')}$j$::jsonb, $n$${notes.replace(/\$/g, '')}$n$)
                 ON CONFLICT (date) DO UPDATE SET data = EXCLUDED.data, notes = EXCLUDED.notes`);
  console.log('\n===== 매매 일지 (' + today + ') =====\n' + notes + '\n');
  return recent;
}
const fmtIso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

async function loadPrevJournalCooldown() {
  const rows = await dbQuery(`SELECT data FROM paper_journal WHERE date < '${kstDate()}' ORDER BY date DESC LIMIT 1`);
  if (!rows.length) return new Set();
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  const cold = new Set();
  for (const r of data?.recent ?? []) {
    if (Number(r.n) >= 5 && r.w / r.n < 0.3) cold.add(r.strat);
  }
  if (cold.size) log(`전일 일지 쿨다운 적용: ${[...cold].join(', ')} (신규 슬롯 절반)`);
  return cold;
}

// ── morning: 전일 일지 출력 → 마켓 브리핑 생성 → 시가 청산 집행 ──
async function morningPhase(books) {
  // 전일 매매 일지 참고 출력
  const prev = await dbQuery(`SELECT date, notes FROM paper_journal ORDER BY date DESC LIMIT 1`);
  if (prev.length) console.log(`\n===== 전일 매매 일지 (${prev[0].date}) =====\n${prev[0].notes}\n`);
  // 마켓 브리핑 (당일 진입 판단용 — close 페이즈가 읽음)
  try {
    const universe = await momUniverse();
    const largeCaps = await dbQuery(`SELECT stock_code, corp_name FROM stock_analysis WHERE current_price >= ${MIN_PRICE} ORDER BY market_cap_tril DESC LIMIT 30`);
    await buildMarketBrief(books, universe, largeCaps);
  } catch (e) { log(`브리핑 생성 실패 (비치명): ${e.message}`); }

  let executed = 0;
  for (const [strat, book] of Object.entries(books)) {
    for (const [code, p] of Object.entries({ ...book.positions })) {
      if (!p.exitAtOpen) continue;
      const list = await bars(code, 3);
      const today = lastBar(list);
      if (!today || String(today.timestamp).slice(0, 10).replace(/-/g, '') !== kstDate()) {
        log(`[${strat}] ${code} 오늘 봉 없음 — 집행 보류`); continue;
      }
      paperSell(books, strat, code, today.open, p.exitAtOpen, p.exitQty);
      if (book.positions[code]) { delete book.positions[code].exitAtOpen; delete book.positions[code].exitQty; } // 부분익절 잔량 보호
      executed++;
    }
  }
  log(`morning 완료 — 시가 집행 ${executed}건`);
  // LIVE 큐 실주문 집행 (가드: 주문당 10만원·일 3건·live_halt 플래그)
  try { await executeLiveQueue(); } catch (e) { log(`LIVE 집행 오류 (비치명): ${e.message}`); }
}

// ── close: 종가 시그널 평가 ──────────────────────────────────
// ── 텔레그램 보고 (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID 미설정 시 무동작) ──
async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { log(`텔레그램 전송 실패: ${e.message}`); }
}

// ── LIVE: 실주문 집행 (소액 검증) ─────────────────────────────
// 흐름: close 페이즈가 실보유를 combo 룰로 판정 → live_queue 적재 → morning 페이즈가 실주문 집행
// 가드: 주문당 10만원 상한, 하루 최대 3주문, paper_state k='live_halt' 존재 시 전면 중단
const LIVE_MAX_ORDER_VALUE = 100_000;
const LIVE_MAX_ORDERS_PER_DAY = 3;
const LIVE_SLOTS = 2; // 라이브 슬롯 수 (MC3 I17 slots2 정합 — evaluateLiveHoldings·executeLiveQueue 공용)

// MC3 I2 채택 (2026-06-13): ATR(14) 역비례 사이징 — 소액 계좌 MC에서 원금손실 12.5%→0.8%
// 변동성 높은 돌파주 예산 축소 (atrSize 4% / ATR%, 0.5~1.5 클램프 — backtest-swing.mjs atrMult 동일)
const LIVE_ATR_SIZE = 4;
function liveAtrMult(list) {
  if (!list || list.length < 16) return 1;
  let tr = 0;
  for (let j = list.length - 14; j < list.length; j++) {
    const b = list[j], pc = list[j - 1].close;
    tr += Math.max(b.high - (b.low ?? b.close), Math.abs(b.high - pc), Math.abs((b.low ?? b.close) - pc));
  }
  const atrPct = (tr / 14) / list[list.length - 1].close * 100;
  if (!(atrPct > 0)) return 1;
  return Math.min(1.5, Math.max(0.5, LIVE_ATR_SIZE / atrPct));
}

async function loadStateKey(k, dflt) {
  const rows = await dbQuery(`SELECT data FROM paper_state WHERE k = '${k}'`);
  if (!rows.length || rows[0].data == null) return dflt;
  return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
}
async function saveStateKey(k, data) {
  await dbQuery(`INSERT INTO paper_state (k, data, updated_at) VALUES ('${k}', $j$${JSON.stringify(data).replace(/\$/g, '')}$j$::jsonb, NOW())
                 ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
}

async function waitLiveFill(seq, orderId, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const o = await getOrder(seq, orderId).catch(() => null);
    if (o?.status === 'FILLED') return o;
    if (['REJECTED', 'CANCELED', 'CANCEL_REJECTED'].includes(o?.status)) return null;
    await new Promise(r => setTimeout(r, 3_000));
  }
  try { await cancelOrder(seq, orderId); } catch {}
  return null;
}

async function executeLiveQueue() {
  if (await loadStateKey('live_halt', null)) { log('LIVE 중단 플래그(live_halt) — 집행 생략'); return; }
  const queue = await loadStateKey('live_queue', []);
  if (!queue.length) { log('LIVE 큐 비어있음'); return; }
  const accounts = await getAccounts();
  const seq = accounts[0]?.accountSeq;
  if (seq == null) { log('LIVE 계좌 조회 실패 — 집행 보류'); return; }

  log(`LIVE 큐 ${queue.length}건 집행 시작 (계좌 ${accounts[0].accountNo})`);
  const remaining = [];
  let executed = 0;
  const meta = await loadStateKey('live_meta', {});
  const cashAtStart = Number((await getBuyingPower(seq, { currency: 'KRW' }).catch(() => null))?.cashBuyingPower ?? 0);

  // SELL 먼저 집행 — 현금 확보 후 BUY 배분
  for (const o of queue) {
    if (o.side !== 'SELL') continue; // BUY는 allocateSlots 블록에서 별도 집행
    if (executed >= LIVE_MAX_ORDERS_PER_DAY) { remaining.push(o); continue; }
    try {
      const px = (await getPricesMap([o.code])).get(o.code)?.price ?? 0;
      if (!(px > 0)) { log(`LIVE ${o.code} 현재가 조회 실패 — 보류`); remaining.push(o); continue; }
      const qty = o.qty;
      if (px * qty > LIVE_MAX_ORDER_VALUE) { log(`LIVE 주문가치 상한 초과 (${(px * qty).toLocaleString()}원 > ${LIVE_MAX_ORDER_VALUE.toLocaleString()}) — 스킵`); continue; }

      // 매도(청산)는 즉시 체결 위해 시장가 유지
      const order = await createOrder(seq, { symbol: o.code, side: o.side, orderType: 'MARKET', quantity: String(qty) });
      const fill = await waitLiveFill(seq, order.orderId);
      if (!fill) { log(`LIVE ${o.side} ${o.name ?? o.code} 미체결/거부 — 다음 회차 보류`); remaining.push(o); continue; }
      executed++;
      const fillPrice = Number(fill.filledPrice ?? fill.averageFilledPrice ?? fill.price ?? px);
      recordTrade({ ts: kst().toISOString(), strat: 'live', type: 'sell', code: o.code, name: o.name, qty, price: fillPrice, entry: o.entry ?? null, pnl: o.entry ? netPnl(o.entry, fillPrice, qty) : null, reason: o.reason, ctx: o.ctx });
      log(`💰 LIVE 매도 ${o.name ?? o.code} ${qty}주 @${fillPrice.toLocaleString()} (${o.reason})`);
      const stratLine = `전략: ${o.ctx?.sub ?? 'combo'}` +
        (o.ctx?.regime ? ` · ${o.ctx.regime} 레짐` : '') +
        (o.ctx?.breakoutPct ? ` · 돌파 +${o.ctx.breakoutPct}%` : '') +
        (o.ctx?.atrMult ? ` · ATR×${o.ctx.atrMult}` : '');
      let pnlLine = '';
      if (o.entry) {
        const pnl = netPnl(o.entry, fillPrice, qty);
        const pct = pnl / (Number(o.entry) * qty) * 100;
        pnlLine = `\n실현손익: ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}원 (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) | 매수 평단 ${Number(o.entry).toLocaleString()}원 → 매도 ${fillPrice.toLocaleString()}원`;
      }
      await notifyTelegram(
        `💰 [실주문 체결] 매도 ${o.name ?? o.code} ${qty}주 @${fillPrice.toLocaleString()}원 (총 ${(fillPrice * qty).toLocaleString()}원)\n` +
        `${stratLine}\n사유: ${o.reason}` + pnlLine);
      delete meta[o.code];
    } catch (e) {
      log(`LIVE 주문 오류 — 안전 중단: ${e.message}`);
      await saveStateKey('live_halt', { reason: e.message, at: kst().toISOString() });
      await notifyTelegram(`⛔ [실주문 오류 — 전면 중단] ${e.message}\n다음 액션 지시가 있을 때까지 매수/매도를 중단합니다.`);
      remaining.push(o);
      break;
    }
  }

  // BUY: 매도 집행 후 매수가능금액·현재가로 allocateSlots 재배분 (MC3 I17 차순위 분산)
  const buyOrders = queue.filter(o => o.side === 'BUY');
  const halted = await loadStateKey('live_halt', null);
  if (buyOrders.length && executed < LIVE_MAX_ORDERS_PER_DAY && !halted) {
    // ① SELL 집행됐으면 매도대금이 매수가능금액에 반영될 때까지 대기 (토스 결제 지연 — 최대 180초)
    //    같은 회차 매도→매수(슬롯 교체) 시 매도대금 미반영으로 매수가 0주 스킵되던 문제 해소
    if (executed > 0) {
      for (let w = 0; w < 36; w++) {
        const c = Number((await getBuyingPower(seq, { currency: 'KRW' }).catch(() => null))?.cashBuyingPower ?? 0);
        if (c > cashAtStart) { log(`매도대금 반영 확인 (${cashAtStart.toLocaleString()}→${c.toLocaleString()}원)`); break; }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    const holdings = await getHoldings(seq).catch(() => null);
    const heldNow = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR').length;
    const cashNow = Number((await getBuyingPower(seq, { currency: 'KRW' }).catch(() => null))?.cashBuyingPower ?? 0);
    const eqNow = Number(holdings?.marketValue?.amount?.krw ?? 0) + cashNow;
    // 현재가로 후보 가격 갱신 (지정가)
    const priced = [];
    for (const o of buyOrders) {
      const px = (await getPricesMap([o.code])).get(o.code)?.price ?? o.close ?? 0;
      if (px > 0) priced.push({ code: o.code, name: o.name, price: px, atrMult: o.atrMult ?? 1, ctx: o.ctx });
    }
    const allocations = allocateSlots(priced, heldNow, LIVE_SLOTS, eqNow, cashNow);
    for (const a of allocations) {
      if (executed >= LIVE_MAX_ORDERS_PER_DAY) break;
      if (a.price * a.qty > LIVE_MAX_ORDER_VALUE) { log(`LIVE 주문가치 상한 초과 — ${a.name} 스킵`); continue; }
      const ctx = priced.find(p => p.code === a.code)?.ctx;
      if (process.env.LIVE_DRY_RUN === '1') { log(`[DRY] BUY ${a.name} ${a.qty}주 @${a.price.toLocaleString()} 지정가 (heldNow=${heldNow}, cashNow=${cashNow.toLocaleString()})`); executed++; continue; }
      try {
        const order = await createOrder(seq, { symbol: a.code, side: 'BUY', orderType: 'LIMIT', price: String(a.price), quantity: String(a.qty) });
        const fill = await waitLiveFill(seq, order.orderId);
        if (!fill) { log(`LIVE 매수 ${a.name} 미체결 — 보류`); remaining.push(buyOrders.find(o => o.code === a.code)); continue; }
        executed++;
        const fp = Number(fill.filledPrice ?? fill.averageFilledPrice ?? fill.price ?? a.price);
        recordTrade({ ts: kst().toISOString(), strat: 'live', type: 'buy', code: a.code, name: a.name, qty: a.qty, price: fp, entry: null, pnl: null, reason: '차순위 분산 매수', ctx });
        meta[a.code] = { sub: ctx?.sub ?? 'hi120', name: a.name, entry: fp, entryDay: kstDate(), hi: fp, holdDays: 0, ctx };
        log(`💰 LIVE 매수 ${a.name} ${a.qty}주 @${fp.toLocaleString()} (지정가)`);
        await notifyTelegram(`💰 [실주문 체결] 매수 ${a.name} ${a.qty}주 @${fp.toLocaleString()}원 (차순위 분산)`);
      } catch (e) {
        log(`LIVE 매수 주문 오류 — 안전 중단: ${e.message}`);
        await saveStateKey('live_halt', { reason: e.message, at: kst().toISOString() });
        await notifyTelegram(`⛔ [실주문 오류 — 전면 중단] ${e.message}`);
        remaining.push(buyOrders.find(o => o.code === a.code));
        break;
      }
    }
    // ② 빈 슬롯 남았는데 배분 안 된 BUY 후보 처리:
    //   - 일시적 현금 부족(가격 ≤ 슬롯예산): 보존 → 다음 회차(매도대금 반영 후) 재시도
    //   - 영구 불가(가격 > 슬롯예산×atrMult, 1주도 못 삼): 제거 (재큐잉 무한루프·슬롯 점거 방지) ★버그 수정 2026-06-19
    const slotBudgetNow = Math.floor(eqNow / LIVE_SLOTS);
    const needed = (LIVE_SLOTS - heldNow) - allocations.length;
    if (needed > 0) {
      const allocatedCodes = new Set(allocations.map(a => a.code));
      let saved = 0;
      for (const o of buyOrders) {
        if (allocatedCodes.has(o.code) || remaining.includes(o)) continue;
        const px = priced.find(p => p.code === o.code)?.price ?? o.close ?? 0;
        // 영구 불가 판정도 풀 슬롯예산 기준 (ATR는 수량 스케일일 뿐 — 1주가 풀예산에 들어오면 살림)
        if (px * 1.01 > slotBudgetNow) { log(`LIVE 매수 제거(예산초과 영구) — ${o.name} ${px.toLocaleString()}원 > 슬롯 ${slotBudgetNow.toLocaleString()}`); continue; } // 큐에서 드롭
        if (saved >= needed) continue;
        remaining.push(o); saved++; log(`LIVE 매수 보류(현금부족, 가격 OK) — ${o.name} 다음 회차 재시도`);
      }
    }
  }

  await saveStateKey('live_queue', remaining);
  await saveStateKey('live_meta', meta);
}

// close 페이즈: 실보유를 combo 룰로 판정 → 큐 적재
async function evaluateLiveHoldings(regime, uApplied, badCodes, largeCaps = []) {
  if (await loadStateKey('live_halt', null)) return;
  const accounts = await getAccounts().catch(() => []);
  const seq = accounts[0]?.accountSeq;
  if (seq == null) return;
  const holdings = await getHoldings(seq).catch(() => null);
  const items = holdings?.items ?? [];

  // ── 서킷브레이커: 원금 대비 -30% 이상 손실 → 전면 중단 + 텔레그램 보고 ──
  const bpNow = await getBuyingPower(seq, { currency: 'KRW' }).catch(() => null);
  const totalNow = Number(holdings?.marketValue?.amount?.krw ?? 0) + Number(bpNow?.cashBuyingPower ?? 0);
  let baseline = await loadStateKey('live_baseline', null);
  if (!baseline) { baseline = { value: totalNow, at: kstDate() }; await saveStateKey('live_baseline', baseline); log(`LIVE 원금 기준선 설정: ${totalNow.toLocaleString()}원`); }
  if (baseline.value > 0 && totalNow <= baseline.value * 0.7) {
    await saveStateKey('live_halt', { reason: `원금 대비 -30% 도달 (${baseline.value.toLocaleString()} → ${totalNow.toLocaleString()})`, at: kst().toISOString() });
    await saveStateKey('live_queue', []); // 대기 주문 전부 취소
    await notifyTelegram(
      `🚨 [서킷브레이커] 원금 대비 -30% 손실 도달\n` +
      `기준 원금: ${baseline.value.toLocaleString()}원 (${baseline.at})\n현재 평가: ${totalNow.toLocaleString()}원 (${((totalNow / baseline.value - 1) * 100).toFixed(1)}%)\n` +
      `모든 매수/매도를 중단했습니다. 다음 액션을 지시해 주세요 (Claude 세션에서 "라이브 재개" / "전량 청산" 등).`);
    log('🚨 서킷브레이커 발동 — 전면 중단');
    return;
  }

  const meta = await loadStateKey('live_meta', {});
  const queue = await loadStateKey('live_queue', []);
  const queuedCodes = new Set(queue.map(q => q.code));
  const cfg = STRATEGIES['combo'];

  for (const it of items) {
    if (it.marketCountry !== 'KR' || queuedCodes.has(it.symbol)) continue;
    const m = meta[it.symbol] ?? { sub: 'hi120', name: it.name, entry: Number(it.averagePurchasePrice), entryDay: '00000000', hi: Number(it.lastPrice), holdDays: 999 };
    const list = await bars(it.symbol);
    const t = lastBar(list);
    if (!t) continue;
    m.holdDays = (m.holdDays ?? 0) + 1;
    m.hi = Math.max(m.hi ?? 0, t.high);
    let exitReason = null;
    if (m.sub === 'rsi2') {
      const closes = list.map(b => b.close);
      const i = closes.length - 1;
      let ma5 = 0; const n = Math.min(cfg.rsiMa || 5, closes.length);
      for (let j = i - n + 1; j <= i; j++) ma5 += closes[j];
      ma5 /= n;
      if (t.close <= m.entry * (1 - cfg.stopPct / 100)) exitReason = 'stop_loss';
      else if (t.close > ma5) exitReason = 'ma5_exit';
      else if (m.holdDays >= cfg.maxHoldR) exitReason = 'max_hold';
    } else {
      // 1R(+8%) 절반 익절 → 잔량 트레일링 (C7 채택)
      if (cfg.tp1R > 0 && !m.halfDone && t.close >= m.entry * (1 + cfg.trailPct / 100 * cfg.tp1R) && Math.floor(Number(it.quantity) / 2) >= 1) {
        m.halfDone = true;
        queue.push({ side: 'SELL', code: it.symbol, name: it.name, qty: Math.floor(Number(it.quantity) / 2), entry: Number(it.averagePurchasePrice), reason: 'tp_half', ctx: { ...(m.ctx ?? {}), sub: m.sub, regime } });
        log(`LIVE 절반익절 예약: ${it.name} — 익일 시가 집행`);
      }
      // 2R 도달 시 잔량 절반 추가 익절 (C14 채택)
      else if (cfg.tp2R > 0 && m.halfDone && !m.qtrDone && t.close >= m.entry * (1 + cfg.trailPct / 100 * cfg.tp2R) && Math.floor(Number(it.quantity) / 2) >= 1) {
        m.qtrDone = true;
        queue.push({ side: 'SELL', code: it.symbol, name: it.name, qty: Math.floor(Number(it.quantity) / 2), entry: Number(it.averagePurchasePrice), reason: 'tp_quarter', ctx: { ...(m.ctx ?? {}), sub: m.sub, regime } });
        log(`LIVE 2R 추가익절 예약: ${it.name} — 익일 시가 집행`);
      }
      else if (t.close <= m.hi * (1 - cfg.trailPct / 100)) exitReason = 'trailing';
      else if (m.holdDays >= cfg.maxHoldH) exitReason = 'max_hold';
    }
    if (exitReason) {
      queue.push({ side: 'SELL', code: it.symbol, name: it.name, qty: Number(it.quantity), entry: Number(it.averagePurchasePrice), reason: exitReason, ctx: { ...(m.ctx ?? {}), sub: m.sub, regime } });
      log(`LIVE 매도 예약: ${it.name} (${exitReason}) — 익일 시가 집행`);
    }
    meta[it.symbol] = m;
  }

  // 신규 진입: 현금 있고 미보유면 combo 최상위 시그널 1건 (소액 계좌라 1슬롯)
  const bp = await getBuyingPower(seq, { currency: 'KRW' }).catch(() => null);
  const cash = Number(bp?.cashBuyingPower ?? 0);
  const heldCodes = new Set(items.map(i => i.symbol));
  const willSell = new Set(queue.filter(q => q.side === 'SELL').map(q => q.code));
  // MC3 I17 (2026-06-13): 라이브 slots 정합. 기존 단일슬롯(현금 전액 집중)은 de facto slots1 —
  // 40시드 MC 원금손실 35% vs 동결 검증 구성 slots2 2.5% (paired z=3.79). slots2로 정합:
  //   ① 슬롯당 예산 = floor(equity/SLOTS) (backtest budget()=floor(equity/slots)와 동일, 집행부에서 현금 재클램프)
  //   ② 보유 < SLOTS면 빈 슬롯 수만큼 진입 (기존 hasOpenSlot은 보유 0일 때만 = 사실상 slots1)
  const heldKeep = [...heldCodes].filter(c => !willSell.has(c)).length; // 청산 예약 안 한 보유 종목 수
  const slotsToFill = LIVE_SLOTS - heldKeep - queue.filter(q => q.side === 'BUY').length;
  if (slotsToFill > 0 && (cash > MIN_PRICE || willSell.size > 0)) {
    // 버그 수정(2026-06-18): 기존 라이브는 "UP 레짐 + hi120 돌파"만 진입 →
    //   combo 설계의 rsi2(과매도 반등) 경로가 통째로 누락 → 비-UP장에서 매수 0 (매도만 발생).
    //   페이퍼/백테스트 combo와 동일하게 레짐 캡(COMBO_CAPS) 기반 hi120+rsi2 둘 다 후보 적재.
    //   hi120 = 돌파 모멘텀(UP 한정), rsi2 = 과매도 반등(전 레짐, NEUTRAL/DOWN 주력).
    const caps = COMBO_CAPS[regime];
    const HEADROOM = 3;
    const ranked = [];
    const seen = new Set([...heldCodes, ...queuedCodes]);
    // 버그 수정(2026-06-19): hi120 후보에 affordability 게이트 누락 → 비싼 모멘텀주(48k·187k)가
    //   큐를 영구 점거(qty 0 재큐잉) → 슬롯 막혀 저렴한 rsi2 진입 불가 → "매수 또 안 됨".
    //   allocateSlots 집행 상한 = slotBudget×atrMult 이므로, 그 안에 1주가 안 들어오는 후보는 큐잉 금지.
    const slotBudget = Math.floor(totalNow / LIVE_SLOTS);
    // 진입 가능 판정 = 풀 슬롯예산으로 1주 매수 가능?  (ATR 사이징은 집행부에서 수량에만 적용, 1주 미만 불가)
    // 버그 수정(2026-06-19 #2 — 고변동성장 rsi2 공백): atrMult(0.5)로 게이트하면 슬롯예산 23.7k라도
    //   상한 11.8k → 20k 우량 과매도주가 전부 배제돼 폭락장 매수 0. 백테스트는 항상 진입(ATR는 수량만)
    //   하므로 라이브도 1주 진입은 보장하고 ATR는 수량 스케일에만 쓴다. allocateSlots에 1주 floor 추가.
    const affordable = (close) => close * 1.01 <= slotBudget; // 풀 예산으로 1주 가능?
    // hi120: UP 레짐 + 캡 허용 시 (돌파는 상승장에서만 엣지 — MC3 I4)
    if (regime === 'UP' && caps.hi120 > 0) {
      for (const u of uApplied) {
        if (seen.has(u.stock_code)) continue;
        const sig = await hi120SignalG(u.stock_code);
        if (sig && sig.breakoutPct >= cfg.minBreakout) {
          if (!affordable(sig.close)) { log(`LIVE hi120 제외(예산초과): ${u.corp_name} ${sig.close.toLocaleString()}원 > 슬롯 ${slotBudget.toLocaleString()}`); continue; }
          ranked.push({ code: u.stock_code, name: u.corp_name, close: sig.close, atrMult: liveAtrMult(await bars(u.stock_code)), sub: 'hi120', breakoutPct: sig.breakoutPct });
          seen.add(u.stock_code);
        }
        if (ranked.length >= slotsToFill + HEADROOM) break;
      }
    }
    // rsi2: 전 레짐 (과매도 반등). 비-UP장 매수의 핵심 경로.
    //   소액 계좌: 우량 중저가 유니버스(시총≥3000억 + 가격≤슬롯예산) — 계좌 커지면 상한 자동 상승.
    if (caps.rsi2 > 0 && rsi2SignalG) {
      const priceCeiling = Math.max(slotBudget, MIN_PRICE * 3); // 최소 6,000원까진 후보 확보
      const rsiUniverse = await dbQuery(`
        SELECT stock_code, corp_name FROM stock_analysis
        WHERE current_price >= ${MIN_PRICE} AND current_price <= ${priceCeiling}
          AND market_cap_tril >= 0.3
        ORDER BY market_cap_tril DESC LIMIT 40
      `).catch(() => []);
      log(`LIVE rsi2 유니버스: 시총≥3000억 & 가격≤${priceCeiling.toLocaleString()}원 ${rsiUniverse.length}종목`);
      for (const r of rsiUniverse) {
        if (seen.has(r.stock_code) || badCodes.has(r.stock_code)) continue;
        const sig = await rsi2SignalG(r.stock_code, cfg.rsiDays ?? 1);
        if (sig) {
          if (!affordable(sig.close)) { log(`LIVE rsi2 제외(예산초과): ${r.corp_name} ${sig.close.toLocaleString()}원 > 슬롯 ${slotBudget.toLocaleString()}`); continue; }
          ranked.push({ code: r.stock_code, name: r.corp_name, close: sig.close, atrMult: liveAtrMult(await bars(r.stock_code)), sub: 'rsi2', rsi: sig.rsi });
          seen.add(r.stock_code);
        }
        if (ranked.length >= slotsToFill + HEADROOM + 3) break;
      }
    }
    if (ranked.length) {
      const candidates = pickBuyCandidates(ranked, badCodes, slotsToFill + HEADROOM);
      for (const c of candidates) {
        const reason = c.sub === 'hi120' ? `combo hi120 돌파 +${c.breakoutPct.toFixed(1)}%` : `combo rsi2 과매도 (RSI2 ${Math.round(c.rsi)})`;
        const ctx = c.sub === 'hi120'
          ? { sub: 'hi120', regime, breakoutPct: c.breakoutPct.toFixed(1), atrMult: c.atrMult.toFixed(2) }
          : { sub: 'rsi2', regime, rsi: Math.round(c.rsi).toString(), atrMult: c.atrMult.toFixed(2) };
        queue.push({ side: 'BUY', code: c.code, name: c.name, close: c.close, atrMult: c.atrMult, reason, ctx });
        log(`LIVE 매수 후보 적재: ${c.name} (${reason}, ATR×${c.atrMult.toFixed(2)})`);
      }
    } else {
      log(`LIVE 신규 진입 후보 없음 — 레짐 ${regime}, hi120/rsi2 시그널 미발생`);
    }
  }
  await saveStateKey('live_queue', queue);
  await saveStateKey('live_meta', meta);
}
let hi120SignalG = null; // closePhase에서 주입 (단독/콤보 공용 시그널 함수 재사용)
let rsi2SignalG = null;  // closePhase에서 주입 (rsi2 과매도 시그널 — 라이브 진입용)

// 시장 레짐 (005930, 당일 종가): UP / NEUTRAL / DOWN
async function marketRegime() {
  const list = await bars('005930', 70);
  if (list.length < 61) return 'NEUTRAL';
  const closes = list.map(b => b.close);
  const i = closes.length - 1;
  const avg = (n) => closes.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  const ma20 = avg(20), ma60 = avg(60);
  const ret5 = (closes[i] / closes[i - 5] - 1) * 100;
  if (closes[i] > ma20 && ma20 > ma60) return 'UP';
  if (closes[i] < ma20 && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}

async function closePhase(books) {
  const universe = await momUniverse();
  const largeCaps = await dbQuery(`SELECT stock_code, corp_name FROM stock_analysis WHERE current_price >= ${MIN_PRICE} ORDER BY market_cap_tril DESC LIMIT 30`);
  const today = kstDate();
  const regime = await marketRegime();
  log(`시장 레짐: ${regime} (combo 슬롯 — hi120 ${COMBO_CAPS[regime].hi120} / rsi2 ${COMBO_CAPS[regime].rsi2})`);

  // 마켓 브리핑 적용 (morning에 생성된 것 로드, 없으면 즉석 생성)
  const brief = (await loadTodayBrief()) ?? (await buildMarketBrief(books, universe, largeCaps).catch(() => null));
  const sectorOf = new Map(universe.map(u => [u.stock_code, u.sector]));
  const uApplied = applyBrief(universe, brief, sectorOf);
  // 전일 일지 쿨다운: 최근 10거래 승률 30% 미만 전략은 신규 슬롯 절반
  const cold = await loadPrevJournalCooldown();
  const slotCap = (strat) => cold.has(strat) ? Math.ceil(STRATEGIES[strat].slots / 2) : STRATEGIES[strat].slots;

  // 보유 포지션 공통: 보유일 + 고점 갱신 + 청산 판정
  for (const [strat, book] of Object.entries(books)) {
    const cfg = STRATEGIES[strat];
    for (const [code, p] of Object.entries(book.positions)) {
      const list = await bars(code);
      const t = lastBar(list);
      if (!t) continue;
      p.holdDays = (p.holdDays ?? 0) + 1;
      p.hi = Math.max(p.hi ?? 0, t.high);
      const close = t.close;
      const sub = strat === 'combo' ? p.sub : strat; // combo는 서브 전략 규칙 적용
      if (sub === 'hi120') {
        const trail = cfg.trailPct;
        const maxH = strat === 'combo' ? cfg.maxHoldH : cfg.maxHold;
        if (cfg.tp1R > 0 && !p.halfDone && close >= p.entry * (1 + trail / 100 * cfg.tp1R) && Math.floor(p.qty / 2) >= 1) {
          p.exitAtOpen = 'tp_half'; p.exitQty = Math.floor(p.qty / 2); p.halfDone = true;
        }
        // 2R 도달 시 잔량 절반 추가 익절 (C14 채택)
        else if (cfg.tp2R > 0 && p.halfDone && !p.qtrDone && close >= p.entry * (1 + trail / 100 * cfg.tp2R) && Math.floor(p.qty / 2) >= 1) {
          p.exitAtOpen = 'tp_quarter'; p.exitQty = Math.floor(p.qty / 2); p.qtrDone = true;
        }
        else if (close <= p.hi * (1 - trail / 100)) p.exitAtOpen = 'trailing';
        else if (p.holdDays >= maxH) p.exitAtOpen = 'max_hold';
      } else if (sub === 'rsi2') {
        const closes = list.map(b => b.close);
        const i = closes.length - 1;
        let ma5 = 0; const n = Math.min(cfg.rsiMa || 5, closes.length);
        for (let j = i - n + 1; j <= i; j++) ma5 += closes[j];
        ma5 /= n;
        const maxH = strat === 'combo' ? cfg.maxHoldR : cfg.maxHold;
        if (close <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (close > ma5) p.exitAtOpen = 'ma5_exit';
        else if (p.holdDays >= maxH) p.exitAtOpen = 'max_hold';
      }
    }
  }

  // 진입 시그널 (브리핑 반영 유니버스 uApplied + 쿨다운 slotCap)
  const badCodes = new Set((brief?.disclosures ?? []).filter(d => d.tone === 'bad').map(d => d.code));

  // hi120 신고가 돌파 시그널 수집 헬퍼 (단독·combo 공용)
  async function hi120Signal(code) {
    const list = await bars(code, 130);
    if (list.length < 122) return null;
    const i = list.length - 1;
    let prevHigh = 0;
    for (let j = i - 120; j < i; j++) prevHigh = Math.max(prevHigh, list[j].high);
    if (list[i].close <= prevHigh) return null;
    return { close: list[i].close, breakoutPct: ((list[i].close / prevHigh - 1) * 100) };
  }
  async function rsi2Signal(code, days = 1) {
    const list = await bars(code, 10);
    if (list.length < 5) return null;
    const closes = list.map(b => b.close);
    const r = rsi2val(closes, closes.length - 1);
    if (r >= 10) return null;
    if (days > 1 && rsi2val(closes, closes.length - 2) >= 10) return null; // 연속 과매도 요구
    return { close: closes[closes.length - 1], rsi: r };
  }

  // hi120 단독: 모멘텀 top30 중 신고가 돌파
  for (const u of uApplied) {
    const book = books['hi120'];
    if (book.positions[u.stock_code] || Object.keys(book.positions).length >= slotCap('hi120')) continue;
    const sig = await hi120Signal(u.stock_code);
    if (sig) paperBuy(books, 'hi120', u.stock_code, u.corp_name, sig.close, { ctx: { regime, breakoutPct: sig.breakoutPct.toFixed(1) } });
  }
  // rsi2 단독: 시총 상위 30 과매도 (악재 공시 제외)
  for (const r of largeCaps) {
    const book = books['rsi2'];
    if (badCodes.has(r.stock_code)) continue;
    if (book.positions[r.stock_code] || Object.keys(book.positions).length >= slotCap('rsi2')) continue;
    const sig = await rsi2Signal(r.stock_code);
    if (sig) paperBuy(books, 'rsi2', r.stock_code, r.corp_name, sig.close, { ctx: { regime, rsi: sig.rsi.toFixed(0) } });
  }
  // combo: 레짐 캡 + 사유 분석 룰 (hi120 돌파폭 3%+, rsi2 maxHold 5)
  {
    const book = books['combo'];
    const caps = COMBO_CAPS[regime];
    const countSub = (sub) => Object.values(book.positions).filter(p => p.sub === sub).length;
    for (const u of uApplied) {
      if (countSub('hi120') >= Math.min(caps.hi120, slotCap('combo')) || book.positions[u.stock_code]) continue;
      const sig = await hi120Signal(u.stock_code);
      if (sig && sig.breakoutPct >= STRATEGIES['combo'].minBreakout)
        paperBuy(books, 'combo', u.stock_code, u.corp_name, sig.close, { sub: 'hi120', ctx: { sub: 'hi120', regime, breakoutPct: sig.breakoutPct.toFixed(1) } });
    }
    for (const r of largeCaps) {
      if (countSub('rsi2') >= caps.rsi2 || badCodes.has(r.stock_code) || book.positions[r.stock_code]) continue;
      const sig = await rsi2Signal(r.stock_code, STRATEGIES['combo'].rsiDays ?? 1);
      if (sig) paperBuy(books, 'combo', r.stock_code, r.corp_name, sig.close, { sub: 'rsi2', ctx: { sub: 'rsi2', regime, rsi: sig.rsi.toFixed(0) } });
    }
  }

  // LIVE: 실보유 종가 판정 → 익일 시가 주문 큐 적재
  hi120SignalG = hi120Signal;
  rsi2SignalG = rsi2Signal;
  try { await evaluateLiveHoldings(regime, uApplied, badCodes, largeCaps); } catch (e) { log(`LIVE 판정 오류 (비치명): ${e.message}`); }

  // 장 마감 텔레그램 보고 (자산 현황 + 예약 주문)
  try {
    const queueNow = await loadStateKey('live_queue', []);
    const eqLines = [];
    for (const [strat, book] of Object.entries(books)) {
      let eq = book.cash;
      for (const [code, p] of Object.entries(book.positions)) {
        const t2 = lastBar(await bars(code));
        eq += (t2?.close ?? p.entry) * p.qty;
      }
      eqLines.push(`${strat}: ${((eq / CAPITAL - 1) * 100).toFixed(2)}% (보유 ${Object.keys(book.positions).length})`);
    }
    // LIVE 누적 현황: 실현손익 합계 + 오늘 체결
    let liveLine = '';
    try {
      const agg = await dbQuery(`SELECT COALESCE(SUM(pnl), 0) AS total, COUNT(*) FILTER (WHERE pnl IS NOT NULL) AS sells,
                                        COUNT(*) FILTER (WHERE pnl > 0) AS wins FROM paper_trades WHERE strat = 'live'`);
      const a = agg[0] ?? {};
      if (Number(a.sells) > 0) liveLine = `LIVE 누적 실현손익: ${Number(a.total) >= 0 ? '+' : ''}${Number(a.total).toLocaleString()}원 (매도 ${a.sells}건, 승 ${a.wins})\n`;
    } catch { /* 비치명 */ }
    await notifyTelegram(
      `📊 [장 마감 보고 ${kstDate()}] 레짐 ${regime}\n` +
      `페이퍼: ${eqLines.join(' | ')}\n` + liveLine +
      (queueNow.length ? `내일 시가 실주문 예약: ${queueNow.map(q => `${q.side === 'BUY' ? '매수' : '매도'} ${q.name ?? q.code} ${q.qty}주 (${q.reason})`).join(' / ')}` : '내일 실주문 예약 없음'));
  } catch (e) { log(`마감 보고 실패 (비치명): ${e.message}`); }

  // 자산 곡선 기록
  const eqVals = [];
  for (const [strat, book] of Object.entries(books)) {
    let eq = book.cash;
    for (const [code, p] of Object.entries(book.positions)) {
      const t = lastBar(await bars(code));
      eq += (t?.close ?? p.entry) * p.qty;
    }
    eqVals.push(`('${today}', '${strat}', ${Math.round(eq)}, ${((eq / CAPITAL - 1) * 100).toFixed(2)}, ${Object.keys(book.positions).length})`);
    log(`[${strat}] 자산 ${eq.toLocaleString()}원 (${((eq / CAPITAL - 1) * 100).toFixed(2)}%) | 보유 ${Object.keys(book.positions).length}`);
  }
  await dbQuery(`INSERT INTO paper_equity (date, strat, equity, ret, positions) VALUES ${eqVals.join(',')}
                 ON CONFLICT (date, strat) DO UPDATE SET equity = EXCLUDED.equity, ret = EXCLUDED.ret, positions = EXCLUDED.positions`);
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  if (!isTossConfigured()) throw new Error('TOSS_CLIENT_ID/SECRET 미설정');
  if (process.env.LIVE_QUEUE_ONLY === '1') {
    await ensureTables();
    log('=== LIVE_QUEUE_ONLY: executeLiveQueue 수동 집행 (morning/close 로직 생략) ===');
    await executeLiveQueue();
    await flushTrades();
    return;
  }
  // 휴장 체크
  try {
    const cal = await getKrMarketCalendar();
    const todayCal = Array.isArray(cal) ? cal.find(d => String(d.date).replace(/-/g, '') === kstDate()) : null;
    if (todayCal && !todayCal.integrated && !todayCal.regularMarket) { log('휴장일 — 종료'); return; }
  } catch { /* 캘린더 실패는 비치명 */ }

  await ensureTables();
  const books = await loadBooks();
  const hm = kstHM();
  let phase = null;
  if (hm >= '09:00' && hm < '11:30') {
    phase = 'morning';
    log('=== morning 페이즈 (일지·브리핑·시가 집행) ===');
    await morningPhase(books);
  } else if (hm >= '15:30') {
    phase = 'close';
    log('=== close 페이즈 (종가 시그널) ===');
    await closePhase(books);
  } else {
    log(`장중(${hm}) — 페이즈 아님, 종료`);
    return;
  }
  await flushTrades();
  await saveBooks(books);
  if (phase === 'close') await buildJournal(); // 체결 flush 후 당일 일지 작성
}

main().catch(e => { console.error('[paper 오류]', e); process.exit(1); });
