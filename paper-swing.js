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
import { isTossConfigured, getDailyCandles, getKrMarketCalendar } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const CAPITAL = 10_000_000;
const FEE_BPS = 1.5, TAX_BPS = 15;
const MIN_PRICE = 2_000;

const STRATEGIES = {
  'swing-mom': { slots: 10 },
  'hi120':     { slots: 10, lookback: 120, trailPct: 10, maxHold: 60 },
  'rsi2':      { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },
  'overnight': { slots: 5 },
};

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
    SELECT 1
  `);
}
async function loadBooks() {
  const rows = await dbQuery(`SELECT data FROM paper_state WHERE k = 'books'`);
  if (rows.length && rows[0].data) return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  return Object.fromEntries(Object.keys(STRATEGIES).map(k => [k, { cash: CAPITAL, positions: {}, startedAt: kstDate() }]));
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
    `(${esc(t.ts)}::timestamptz, ${esc(t.strat)}, ${esc(t.type)}, ${esc(t.code)}, ${esc(t.name)}, ${num(t.qty)}, ${num(t.price)}, ${num(t.entry)}, ${num(t.pnl)}, ${esc(t.reason)})`
  ).join(',');
  await dbQuery(`INSERT INTO paper_trades (ts, strat, type, code, name, qty, price, entry, pnl, reason) VALUES ${vals}`);
  tradeQueue.length = 0;
}

// 일봉 캐시 (이번 실행 한정)
const barsCache = new Map();
async function bars(code, n = 130) {
  if (!barsCache.has(code)) {
    try { barsCache.set(code, (await getDailyCandles(code, n)).reverse()); } // 오름차순
    catch { barsCache.set(code, []); }
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
  recordTrade({ ts: kst().toISOString(), strat, type: 'sell', code, name: p.name, qty, price: fill, entry: p.entry, pnl, reason });
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
  recordTrade({ ts: kst().toISOString(), strat, type: 'buy', code, name, qty, price: fill });
  log(`🟢 [${strat}] 매수 ${name ?? code} ${qty}주 @${fill.toLocaleString()}`);
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
      executed++;
    }
  }
  log(`morning 완료 — 시가 집행 ${executed}건`);
}

// ── close: 종가 시그널 평가 ──────────────────────────────────
async function closePhase(books) {
  const universe = await momUniverse();
  const largeCaps = await dbQuery(`SELECT stock_code, corp_name FROM stock_analysis WHERE current_price >= ${MIN_PRICE} ORDER BY market_cap_tril DESC LIMIT 30`);
  const today = kstDate();
  const isMonday = kst().getUTCDay() === 1;

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
      if (strat === 'swing-mom') {
        if (close <= p.entry * 0.75) p.exitAtOpen = 'stop_loss';
        else if (!p.halfDone && close >= p.entry * 2) { p.exitAtOpen = 'half_profit'; p.exitQty = Math.floor(p.qty / 2); p.halfDone = true; }
        else if (isMonday && !universe.slice(0, 20).some(u => u.stock_code === code)) p.exitAtOpen = 'rebalance';
      } else if (strat === 'hi120') {
        if (close <= p.hi * (1 - cfg.trailPct / 100)) p.exitAtOpen = 'trailing';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      } else if (strat === 'rsi2') {
        const closes = list.map(b => b.close);
        const i = closes.length - 1;
        let ma5 = 0; const n = Math.min(5, closes.length);
        for (let j = i - n + 1; j <= i; j++) ma5 += closes[j];
        ma5 /= n;
        if (close <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (close > ma5) p.exitAtOpen = 'ma5_exit';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      // overnight 보유분은 morning에서 무조건 청산되므로 여기선 없음
    }
  }

  // 진입 시그널 (브리핑 반영 유니버스 uApplied + 쿨다운 slotCap)
  // swing-mom: 월요일 종가 리밸런스
  if (isMonday) {
    for (const u of uApplied.slice(0, 10)) {
      const book = books['swing-mom'];
      if (book.positions[u.stock_code] || Object.keys(book.positions).length >= slotCap('swing-mom')) continue;
      const t = lastBar(await bars(u.stock_code));
      if (t) paperBuy(books, 'swing-mom', u.stock_code, u.corp_name, t.close);
    }
  }
  // hi120: 모멘텀 top30 중 120일 신고가 돌파
  for (const u of uApplied) {
    const book = books['hi120'];
    if (book.positions[u.stock_code] || Object.keys(book.positions).length >= slotCap('hi120')) continue;
    const list = await bars(u.stock_code, 130);
    if (list.length < 122) continue;
    const i = list.length - 1;
    let prevHigh = 0;
    for (let j = i - 120; j < i; j++) prevHigh = Math.max(prevHigh, list[j].high);
    if (list[i].close > prevHigh) paperBuy(books, 'hi120', u.stock_code, u.corp_name, list[i].close);
  }
  // rsi2: 시총 상위 30 과매도 (악재 공시만 제외 — 섹터 후순위는 미적용, 역추세 특성)
  const badCodes = new Set((brief?.disclosures ?? []).filter(d => d.tone === 'bad').map(d => d.code));
  for (const r of largeCaps) {
    const book = books['rsi2'];
    if (badCodes.has(r.stock_code)) continue;
    if (book.positions[r.stock_code] || Object.keys(book.positions).length >= slotCap('rsi2')) continue;
    const list = await bars(r.stock_code, 10);
    if (list.length < 4) continue;
    const closes = list.map(b => b.close);
    if (rsi2val(closes, closes.length - 1) < STRATEGIES['rsi2'].rsiMax)
      paperBuy(books, 'rsi2', r.stock_code, r.corp_name, closes[closes.length - 1]);
  }
  // overnight: 모멘텀 top5 종가 매수 → 익일 시가 청산 예약
  for (const u of uApplied.slice(0, 5)) {
    const book = books['overnight'];
    if (book.positions[u.stock_code] || Object.keys(book.positions).length >= slotCap('overnight')) continue;
    const t = lastBar(await bars(u.stock_code));
    if (t) {
      paperBuy(books, 'overnight', u.stock_code, u.corp_name, t.close);
      if (books['overnight'].positions[u.stock_code]) books['overnight'].positions[u.stock_code].exitAtOpen = 'overnight_exit';
    }
  }

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
