#!/usr/bin/env node
/**
 * live-day.mjs — 1일 실거래 세션 (업비트, 사용자 지시 2026-07-18)
 *   룰: 최근 7일 데이터 선정 — A북 7일수익률 상위3(모멘텀) + B북 하위3(반등), 동일비중 시장가 매수.
 *       10초 폴링 감시, 손절 -3% 즉시 시장가 매도, 익절·트레일 없음, --hours 후 전량 청산.
 *   실행: node live-day.mjs --plan          # 선정만 하고 주문 플랜 출력·저장 (주문 없음)
 *         node live-day.mjs --go [--hours 24]  # 저장된 플랜 집행 + 감시 (백그라운드 권장)
 *   ※ 76개 백테스트 검증에서 엣지 미확인 상태의 실거래 — 사용자 명시 결정. 1일 결과는 통계적 무의미.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getKrwMarkets, getTickers, getDailyCandles, getUpbitAccounts, createUpbitOrder, getUpbitOrder } from './upbit-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HOURS = Number(argOf('--hours', 24));
const UNTIL = argOf('--until', null); // ISO (예: 2026-07-19T11:00:00+09:00) — HOURS보다 우선
const STOP_PCT = Number(argOf('--stop', 3));
const TP_PCT = Number(argOf('--tp', 0)); // 0=익절 없음. 승률 목표용: --tp 2 --stop 15 (백테스트 승률 80~83% 구조)
const POLL_MS = 10_000;
const MIN_TURN_24H = 50e8;
const PLAN = join(__dirname, 'live-day-plan.json');
const STATE = join(__dirname, 'live-day-state.json');
const LOG = join(__dirname, 'live-day-log.txt');

const now = () => new Date(Date.now() + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19); // KST
const log = (msg) => { const line = `[${now()}] ${msg}`; console.log(line); appendFileSync(LOG, line + '\n'); };

// 레짐 게이트 (2026-07-19 회고 반영): BTC 일봉 종가 > MA50이면 진입 허용, 아니면 현금 대기.
// 백테스트에서 hi-break train을 +31.6%p 개선한 유일한 실증 장치. 진입·재진입·스윕 모두에 적용.
async function btcRegimeOk() {
  try {
    const c = (await getDailyCandles('KRW-BTC', 51)).reverse();
    if (c.length < 51) return true; // 데이터 부족 시 게이트 미적용(보수적으로 진입 허용)
    const ma50 = c.slice(-50).reduce((s, b) => s + b.close, 0) / 50;
    return c[c.length - 1].close > ma50;
  } catch { return true; }
}

async function waitFill(uuid, tag) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1200));
    const o = await getUpbitOrder(uuid);
    if (o.state === 'done' || o.state === 'cancel') {
      const funds = (o.trades ?? []).reduce((s, t) => s + Number(t.funds), 0);
      const vol = (o.trades ?? []).reduce((s, t) => s + Number(t.volume), 0);
      return { funds, vol, fee: Number(o.paid_fee), avg: vol > 0 ? funds / vol : null };
    }
  }
  log(`경고: ${tag} 주문 ${uuid} 30회 폴링 내 미체결`);
  return null;
}

// ── PLAN 모드: 선정 + 플랜 저장 ─────────────────────────────────
if (argv.includes('--plan')) {
  const accounts = await getUpbitAccounts();
  const krw = Math.floor(Number(accounts.find(a => a.currency === 'KRW')?.balance ?? 0));
  const regime = await btcRegimeOk();
  if (!regime) {
    log(`레짐 게이트 OFF — BTC < MA50(약세장) → 신규 진입 보류, 현금 대기. (KRW ${krw.toLocaleString()}원)`);
    writeFileSync(PLAN, JSON.stringify({ createdAt: now(), krw, per: 0, picks: [], regimeBlocked: true }, null, 1));
    console.log('\n=== 레짐 게이트 OFF: 약세장이라 신규 진입 안 함 (현금 유지) ===');
    process.exit(0);
  }
  log(`플랜 생성 — KRW ${krw.toLocaleString()}원, 레짐 ON(BTC>MA50), 유니버스 스캔(24h 거래대금 ${MIN_TURN_24H / 1e8}억+, 유의 제외)`);
  const markets = await getKrwMarkets();
  const scored = [];
  for (const m of markets) {
    if (m.warning) continue;
    try {
      const c = (await getDailyCandles(m.market, 8)).reverse();
      if (c.length < 8) continue;
      if (c[c.length - 1].turnover < MIN_TURN_24H) continue;
      scored.push({ market: m.market, name: m.korean_name, ret7: c[c.length - 1].close / c[0].close - 1 });
    } catch { /* skip */ }
  }
  scored.sort((a, b) => b.ret7 - a.ret7);
  const picks = [
    ...scored.slice(0, 3).map(p => ({ ...p, book: 'A-모멘텀' })),
    ...scored.slice(-3).reverse().map(p => ({ ...p, book: 'B-반등' })),
  ];
  const per = Math.floor(krw * 0.995 / picks.length);
  const plan = { createdAt: now(), krw, per, picks };
  writeFileSync(PLAN, JSON.stringify(plan, null, 1));
  console.log('\n=== 매수 플랜 (미집행) ===');
  for (const p of picks) console.log(`${p.book}  ${p.market.padEnd(10)} ${(p.name ?? '').padEnd(12)} 7일 ${(p.ret7 * 100).toFixed(1).padStart(6)}%  →  ${per.toLocaleString()}원 시장가 매수`);
  console.log(`총 투입 ${ (per * picks.length).toLocaleString() }원 / 보유 ${krw.toLocaleString()}원 | 손절 -3% 연속감시 | ${HOURS}시간 후 전량 청산`);
  process.exit(0);
}

// ── GO 모드: 플랜 집행 + 감시 ───────────────────────────────────
if (!argv.includes('--go')) { console.log('사용법: --plan 또는 --go'); process.exit(1); }

let state;
if (existsSync(STATE)) {
  state = JSON.parse(readFileSync(STATE, 'utf8'));
  state.sweeping = false; // 재시작 시 스윕 플래그 초기화 (중단 잔재 방지)
  log(`상태 복원 — 종료예정 ${state.endsAt}, 포지션 ${state.positions.filter(p => p.status === 'open').length}개`);
} else {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
  const ageMin = (Date.now() - new Date(plan.createdAt.replace(' ', 'T'))) / 60_000;
  if (ageMin > 30) { log(`플랜이 ${Math.round(ageMin)}분 전 것 — --plan 재실행 필요`); process.exit(1); }
  const endsAtMs = UNTIL ? new Date(UNTIL).getTime() : Date.now() + HOURS * 3_600_000;
  state = { startedAt: now(), endsAtMs, endsAt: new Date(endsAtMs + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) + ' KST', tp: TP_PCT, stop: STOP_PCT, positions: [], btcBench: null };
  log(`실매수 집행 시작 — ${plan.picks.length}종목 × ${plan.per.toLocaleString()}원`);
  for (const p of plan.picks) {
    try {
      const order = await createUpbitOrder({ market: p.market, side: 'bid', ord_type: 'price', price: String(plan.per) });
      const fill = await waitFill(order.uuid, `매수 ${p.market}`);
      if (fill && fill.vol > 0) {
        state.positions.push({ market: p.market, name: p.name, book: p.book, ret7: (p.ret7 * 100).toFixed(1), qty: fill.vol, entry: fill.avg, spent: fill.funds + fill.fee, status: 'open' });
        log(`매수 체결 ${p.book} ${p.market} ${fill.vol} @평균 ${Math.round(fill.avg).toLocaleString()}원 (${Math.round(fill.funds).toLocaleString()}원+수수료${Math.round(fill.fee)}원)`);
      } else log(`매수 실패/미체결 ${p.market} — 스킵`);
    } catch (e) { log(`매수 오류 ${p.market}: ${e.message.slice(0, 120)}`); }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
}

// 재진입 (2026-07-18 사용자 지시): 청산으로 생긴 현금을 같은 북 기준 재스캔 최상위 후보에 즉시 투입.
// 방금 청산한 마켓·현재 보유 마켓은 제외. 기간종료 청산에는 미적용.
async function reEnter(book, excludeSet) {
  try {
    if (!(await btcRegimeOk())) { log(`재진입 보류 — 레짐 OFF(BTC<MA50), 현금 대기`); return; }
    const accounts = await getUpbitAccounts();
    const krw = Math.floor(Number(accounts.find(a => a.currency === 'KRW')?.balance ?? 0));
    const budget = Math.floor(krw * 0.995);
    if (budget < 5_500) { log(`재진입 스킵 — 가용현금 부족 (${krw.toLocaleString()}원)`); return; }
    log(`재진입 스캔 (${book}) — 예산 ${budget.toLocaleString()}원`);
    const markets = await getKrwMarkets();
    const scored = [];
    for (const m of markets) {
      if (m.warning || excludeSet.has(m.market)) continue;
      try {
        const c = (await getDailyCandles(m.market, 8)).reverse();
        if (c.length < 8 || c[c.length - 1].turnover < MIN_TURN_24H) continue;
        scored.push({ market: m.market, name: m.korean_name, ret7: c[c.length - 1].close / c[0].close - 1 });
      } catch { /* skip */ }
    }
    if (!scored.length) { log('재진입 후보 없음'); return; }
    scored.sort((a, b) => b.ret7 - a.ret7);
    const pick = book.startsWith('A') ? scored[0] : scored[scored.length - 1];
    const order = await createUpbitOrder({ market: pick.market, side: 'bid', ord_type: 'price', price: String(budget) });
    const fill = await waitFill(order.uuid, `재진입 ${pick.market}`);
    if (fill && fill.vol > 0) {
      state.positions.push({ market: pick.market, name: pick.name, book, ret7: (pick.ret7 * 100).toFixed(1), qty: fill.vol, entry: fill.avg, spent: fill.funds + fill.fee, status: 'open', reentry: true });
      log(`재진입 매수 ${book} ${pick.market}(${pick.name}, 7일 ${(pick.ret7 * 100).toFixed(1)}%) ${fill.vol} @평균 ${fill.avg < 10 ? fill.avg.toFixed(4) : Math.round(fill.avg).toLocaleString()}원 (${Math.round(fill.funds).toLocaleString()}원)`);
    }
  } catch (e) { log(`재진입 오류: ${e.message.slice(0, 120)}`); }
}

const sellAll = async (p, reason) => {
  try {
    const accounts = await getUpbitAccounts();
    const cur = p.market.replace('KRW-', '');
    const bal = accounts.find(a => a.currency === cur)?.balance;
    if (!bal || Number(bal) <= 0) { p.status = 'closed'; p.pnl = 0; return; }
    const order = await createUpbitOrder({ market: p.market, side: 'ask', ord_type: 'market', volume: bal });
    const fill = await waitFill(order.uuid, `매도 ${p.market}`);
    if (fill) {
      const proceeds = fill.funds - fill.fee;
      p.status = 'closed'; p.exit = fill.avg; p.pnl = Math.round(proceeds - p.spent);
      log(`매도 체결 ${p.book} ${p.market} @평균 ${Math.round(fill.avg ?? 0).toLocaleString()}원 (${reason}) PnL ${p.pnl >= 0 ? '+' : ''}${p.pnl.toLocaleString()}원`);
    }
  } catch (e) { log(`매도 오류 ${p.market}: ${e.message.slice(0, 120)}`); }
};

const tpPct = state.tp ?? TP_PCT, stopPct = state.stop ?? STOP_PCT;
while (true) {
  const open = state.positions.filter(p => p.status === 'open');
  const ended = Date.now() >= state.endsAtMs;
  if (!open.length) break;
  let tick;
  try { tick = await getTickers([...new Set([...open.map(p => p.market), 'KRW-BTC'])]); }
  catch (e) { log(`시세 실패(재시도): ${e.message.slice(0, 60)}`); await new Promise(r => setTimeout(r, POLL_MS)); continue; }
  if (state.btcBench == null && tick.get('KRW-BTC')) state.btcBench = tick.get('KRW-BTC').price;
  for (const p of open) {
    const t = tick.get(p.market);
    if (!t) continue;
    if (ended) await sellAll(p, '기간종료');
    else if (t.price <= p.entry * (1 - stopPct / 100)) await sellAll(p, `손절 -${stopPct}%`);
    else if (tpPct > 0 && t.price >= p.entry * (1 + tpPct / 100)) await sellAll(p, `익절 +${tpPct}%`);
    // 청산 직후 재진입 (기간종료 제외)
    if (!ended && p.status === 'closed') {
      const exclude = new Set([p.market, ...state.positions.filter(x => x.status === 'open').map(x => x.market)]);
      await reEnter(p.book, exclude);
    }
  }
  // 유휴 현금 스윕 (2026-07-18 사용자 지시): 청산 이벤트와 무관하게 가용 현금이 있으면 즉시 투입.
  // 대상 북 = 현재 포지션 수가 적은 쪽 (동률이면 A). 직전 청산 마켓은 reEnter의 exclude로 이미 보호됨.
  if (!ended && !state.sweeping) {
    state.sweeping = true;
    try {
      const accounts = await getUpbitAccounts();
      const idleKrw = Math.floor(Number(accounts.find(a => a.currency === 'KRW')?.balance ?? 0));
      if (idleKrw >= 5_500) {
        const openNow = state.positions.filter(x => x.status === 'open');
        const cntA = openNow.filter(x => x.book.startsWith('A')).length;
        const cntB = openNow.filter(x => x.book.startsWith('B')).length;
        const book = cntA <= cntB ? 'A-모멘텀' : 'B-반등';
        const lastClosed = [...state.positions].reverse().find(x => x.status === 'closed');
        const exclude = new Set([...(lastClosed ? [lastClosed.market] : []), ...openNow.map(x => x.market)]);
        log(`유휴현금 ${idleKrw.toLocaleString()}원 감지 → ${book} 재진입`);
        await reEnter(book, exclude);
      }
    } catch (e) { log(`유휴현금 스윕 오류: ${e.message.slice(0, 100)}`); }
    state.sweeping = false;
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
  if (ended) continue; // 종료 국면: 남은 포지션 청산 재시도
  await new Promise(r => setTimeout(r, POLL_MS));
}

log('=== 1일 실거래 최종 결과 ===');
const accounts = await getUpbitAccounts();
const krwEnd = Math.round(Number(accounts.find(a => a.currency === 'KRW')?.balance ?? 0));
let btcRet = null;
try { const t = await getTickers(['KRW-BTC']); btcRet = state.btcBench ? (t.get('KRW-BTC').price / state.btcBench - 1) * 100 : null; } catch {}
for (const p of state.positions) log(`${p.book} ${p.market}: PnL ${p.pnl >= 0 ? '+' : ''}${(p.pnl ?? 0).toLocaleString()}원 (진입 ${Math.round(p.entry).toLocaleString()} → 청산 ${p.exit ? Math.round(p.exit).toLocaleString() : '-'})`);
const totalPnl = state.positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
log(`합계 PnL ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}원 | 최종 KRW ${krwEnd.toLocaleString()}원 | BTC 벤치마크 ${btcRet != null ? btcRet.toFixed(2) + '%' : 'N/A'}`);
log('※ 1일 표본은 통계적 무의미 — 이 결과로 전략 판단을 바꾸지 않는다');
writeFileSync(STATE, JSON.stringify(state, null, 1));
