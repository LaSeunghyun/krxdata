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
import { scoreSignal } from './indicators.mjs';

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
const JOURNAL = join(__dirname, 'live-trade-journal.json');

const now = () => new Date(Date.now() + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19); // KST
const log = (msg) => { const line = `[${now()}] ${msg}`; console.log(line); appendFileSync(LOG, line + '\n'); };

// 레짐 게이트 (2026-07-19 회고 반영): BTC 일봉 종가 > MA50이면 진입 허용, 아니면 현금 대기.
// 백테스트에서 hi-break train을 +31.6%p 개선한 유일한 실증 장치. 진입·재진입·스윕 모두에 적용.
// 종목별 지표 기반 익절/손절 + 근거 산출 (2026-07-19 목표 반영). scoreSignal이 null이면 CLI 기본% fallback.
async function computeExits(market, entryPrice) {
  try {
    const cd = (await getDailyCandles(market, 70)).reverse();
    if (cd.length >= 61) {
      const s = scoreSignal(cd.map(b => b.close), cd.map(b => b.high), cd.map(b => b.low), cd.map(b => b.volume), cd.length - 1);
      if (s && s.stop > 0 && s.stop < entryPrice && s.target > entryPrice) {
        // 손절 -10% 하드캡: ATR 손절이 10% 넘으면 -10%로 제한 (고변동 파라볼릭 손실 폭주 방지)
        const rawStopPrice = entryPrice * (s.stop / s.entry);
        const stopPrice = Math.max(rawStopPrice, entryPrice * 0.90);
        const targetPrice = entryPrice * (s.target / s.entry);
        const capped = stopPrice > rawStopPrice;
        const realStopPct = (stopPrice / entryPrice - 1) * 100;
        const realRr = (targetPrice - entryPrice) / (entryPrice - stopPrice);
        return {
          stopPrice, targetPrice,
          rationale: s.signals.join(' + ') || '지표 근거 약함',
          score: s.score, rr: Number(realRr.toFixed(2)),
          basis: `손절 ${realStopPct.toFixed(1)}%${capped ? '(하드캡)' : ''} / 목표 +${s.targetPct.toFixed(1)}% (RR ${realRr.toFixed(1)}, score ${s.score})`,
        };
      }
    }
  } catch { /* fallback */ }
  // fallback: CLI 기본 (--tp/--stop)
  return {
    stopPrice: entryPrice * (1 - STOP_PCT / 100),
    targetPrice: TP_PCT > 0 ? entryPrice * (1 + TP_PCT / 100) : null,
    rationale: '지표 데이터 부족 → 기본 손익절 적용',
    score: null, rr: null, basis: `기본 손절 -${STOP_PCT}% / 목표 ${TP_PCT > 0 ? '+' + TP_PCT + '%' : '없음'}`,
  };
}

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
        const ex = await computeExits(p.market, fill.avg);
        state.positions.push({ market: p.market, name: p.name, book: p.book, ret7: (p.ret7 * 100).toFixed(1), qty: fill.vol, entry: fill.avg, spent: fill.funds + fill.fee, status: 'open', buyAt: Date.now(), stopPrice: ex.stopPrice, targetPrice: ex.targetPrice, rationale: ex.rationale });
        log(`매수 체결 ${p.book} ${p.market} ${fill.vol} @평균 ${Math.round(fill.avg).toLocaleString()}원 (${Math.round(fill.funds).toLocaleString()}원)`);
        log(`  [근거] ${ex.rationale} | ${ex.basis}`);
      } else log(`매수 실패/미체결 ${p.market} — 스킵`);
    } catch (e) { log(`매수 오류 ${p.market}: ${e.message.slice(0, 120)}`); }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
}

// 재진입 (2026-07-18 사용자 지시): 청산으로 생긴 현금을 같은 북 기준 재스캔 최상위 후보에 즉시 투입.
// 방금 청산한 마켓·현재 보유 마켓은 제외. 기간종료 청산에는 미적용.
async function reEnter(bookReq, excludeSet) {
  try {
    if (!(await btcRegimeOk())) { log(`재진입 보류 — 레짐 OFF(BTC<MA50), 현금 대기`); return; }
    // 학습 반영: 누적 성적으로 북 선택 조정 (표본 4건+·승률 25%p+ 차 시 나은 북으로)
    const { book, why } = preferBook(bookReq);
    if (book !== bookReq) log(`  [학습반영] 재진입 북 전환 ${bookReq}→${book} (${why})`);
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
    // 7일 순위 후보군(A=상위, B=하위) 중 지표 점수(scoreSignal) 최고를 선택하고, 최소 점수 게이트 적용.
    // 지표 점수 무시하고 저품질(score 32 등) 셋업 매수하던 문제 교정 — "지표로 거래" 목표에 부합.
    const MIN_SCORE = 50;
    const shortlist = (book.startsWith('A') ? scored.slice(0, 8) : scored.slice(-8)).reverse();
    let best = null;
    for (const cand of shortlist) {
      try {
        const cd = (await getDailyCandles(cand.market, 70)).reverse();
        if (cd.length < 61) continue;
        const s = scoreSignal(cd.map(b => b.close), cd.map(b => b.high), cd.map(b => b.low), cd.map(b => b.volume), cd.length - 1);
        if (s && (!best || s.score > best.score)) best = { ...cand, score: s.score };
      } catch { /* skip */ }
    }
    if (!best || best.score < MIN_SCORE) {
      log(`재진입 보류 — 지표 점수 게이트 미달(최고 ${best ? best.score : 'N/A'} < ${MIN_SCORE}), 현금 대기`);
      return;
    }
    const pick = best;
    log(`재진입 선정 ${pick.market} (지표점수 ${pick.score}/100, 7일 ${(pick.ret7 * 100).toFixed(1)}%)`);
    const order = await createUpbitOrder({ market: pick.market, side: 'bid', ord_type: 'price', price: String(budget) });
    const fill = await waitFill(order.uuid, `재진입 ${pick.market}`);
    if (fill && fill.vol > 0) {
      const ex = await computeExits(pick.market, fill.avg);
      // 학습 참고: 과거 이 셋업 근거가 반복 손실이면 로그로 경고 (매수 자체는 진행 — 표본 적을 때 과잉반응 방지)
      const past = pastSetupStats(ex.rationale);
      if (past && past.n >= 3 && past.wins / past.n < 0.34) log(`  [학습경고] 유사 근거 과거 ${past.wins}/${past.n}승 — 신뢰 낮음`);
      state.positions.push({ market: pick.market, name: pick.name, book, ret7: (pick.ret7 * 100).toFixed(1), qty: fill.vol, entry: fill.avg, spent: fill.funds + fill.fee, status: 'open', reentry: true, buyAt: Date.now(), stopPrice: ex.stopPrice, targetPrice: ex.targetPrice, rationale: ex.rationale });
      log(`재진입 매수 ${book} ${pick.market}(${pick.name}, 7일 ${(pick.ret7 * 100).toFixed(1)}%) @평균 ${fill.avg < 10 ? fill.avg.toFixed(4) : Math.round(fill.avg).toLocaleString()}원 (${Math.round(fill.funds).toLocaleString()}원)`);
      log(`  [근거] ${ex.rationale} | ${ex.basis}`);
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
      const retPct = ((fill.avg / p.entry - 1) * 100).toFixed(1);
      const holdMin = p.buyAt ? Math.round((Date.now() - p.buyAt) / 60000) : null;
      log(`매도 체결 ${p.book} ${p.market} @평균 ${Math.round(fill.avg ?? 0).toLocaleString()}원 (${reason}) PnL ${p.pnl >= 0 ? '+' : ''}${p.pnl.toLocaleString()}원 (${retPct}%${holdMin != null ? `, ${holdMin}분보유` : ''})`);
      if (p.rationale) log(`  [진입근거 복기] ${p.rationale}`);
      recordTrade(p, reason, retPct, holdMin);
    }
  } catch (e) { log(`매도 오류 ${p.market}: ${e.message.slice(0, 120)}`); }
};

// ── 학습 루프 (2026-07-19 사용자 지시): 매도마다 잘된/잘못된 이유 기록 → 다음 매수에 반영 ──
// journal: 북별 누적 성적. reEnter가 이걸 읽어 성적 나쁜 북을 회피(최소 표본 확보 후).
function loadJournal() {
  try { return JSON.parse(readFileSync(JOURNAL, 'utf8')); } catch { return { trades: [], books: {} }; }
}
// 과거 유사 근거(진입 지표 셋업)의 성적 — 첫 지표 토큰 기준 매칭. 매수 전 참고(리스크 헷지).
function pastSetupStats(rationale) {
  if (!rationale) return null;
  const key = rationale.split(' + ')[0]; // 대표 근거(예: 'MA정배열...')
  const j = loadJournal();
  const rel = j.trades.filter(t => t.rationale && t.rationale.startsWith(key.slice(0, 6)));
  if (!rel.length) return null;
  return { n: rel.length, wins: rel.filter(t => t.win).length };
}
function recordTrade(p, reason, retPct, holdMin) {
  const j = loadJournal();
  const win = p.pnl > 0;
  j.trades.push({ ts: now(), market: p.market, book: p.book, reason, retPct: Number(retPct), holdMin, pnl: p.pnl, win, reentry: !!p.reentry, rationale: p.rationale ?? null });
  const b = (j.books[p.book] ??= { n: 0, wins: 0, pnl: 0 });
  b.n++; if (win) b.wins++; b.pnl += p.pnl;
  writeFileSync(JOURNAL, JSON.stringify(j, null, 1));
  // 검토 로그: 잘된 것 / 잘못된 것 판정 + 북 누적 성적
  const verdict = win
    ? (reason.includes('익절') ? '✓ 잘됨(익절 규칙대로 이익 실현)' : `✓ 이익 마감(${reason})`)
    : (reason.includes('손절') ? '✗ 잘못됨(손절선 도달 — 진입 타이밍/종목 오판)' : reason.includes('기간') ? '△ 시간마감 손실(추세 안 나옴)' : `✗ 손실(${reason})`);
  const wr = Math.round(b.wins / b.n * 100);
  log(`  [검토] ${p.book} ${verdict} | 누적 ${p.book}: ${b.wins}/${b.n}승(${wr}%) 누적손익 ${b.pnl >= 0 ? '+' : ''}${b.pnl.toLocaleString()}원`);
}
// 재진입 북 선택 학습: 두 북 모두 최소 표본(4건+) 있고 한쪽 승률이 확연히 낮으면(≤25%p 차) 나은 북으로 전환
function preferBook(defaultBook) {
  const j = loadJournal();
  const A = j.books['A-모멘텀'], B = j.books['B-반등'];
  if (!A || !B || A.n < 4 || B.n < 4) return { book: defaultBook, why: '표본부족→기본유지' };
  const wrA = A.wins / A.n, wrB = B.wins / B.n;
  if (Math.abs(wrA - wrB) < 0.25) return { book: defaultBook, why: '북간 성적 유사→기본유지' };
  const better = wrA > wrB ? 'A-모멘텀' : 'B-반등';
  return { book: better, why: `학습: A${Math.round(wrA*100)}% vs B${Math.round(wrB*100)}% → ${better} 우선` };
}

const tpPct = state.tp ?? TP_PCT, stopPct = state.stop ?? STOP_PCT;
// 상태 복원 시 종목별 익절/손절 미설정 포지션(구버전 매수분) 백필 — 지표로 재계산
for (const p of state.positions.filter(x => x.status === 'open' && x.stopPrice == null)) {
  const ex = await computeExits(p.market, p.entry);
  p.stopPrice = ex.stopPrice; p.targetPrice = ex.targetPrice; p.rationale = p.rationale ?? ex.rationale;
  log(`[백필] ${p.market} 종목별 손익절 설정 — 손절 ${Math.round(p.stopPrice).toLocaleString()} / 목표 ${p.targetPrice ? Math.round(p.targetPrice).toLocaleString() : '없음'} (${ex.rationale})`);
}
if (state.positions.some(x => x.status === 'open')) writeFileSync(STATE, JSON.stringify(state, null, 1));
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
    // 종목별 지표 기반 손익절 (per-symbol) — 단 손절은 최대 -10% 하드캡(고변동 파라볼릭 ATR 손절 폭주 방지)
    const MAX_STOP_PCT = 10;
    const hardFloor = p.entry * (1 - MAX_STOP_PCT / 100);
    const effStop = p.stopPrice != null ? Math.max(p.stopPrice, hardFloor) : p.entry * (1 - stopPct / 100);
    const stopHit = t.price <= effStop;
    const tgtHit = p.targetPrice != null ? t.price >= p.targetPrice : (tpPct > 0 && t.price >= p.entry * (1 + tpPct / 100));
    if (ended) await sellAll(p, '기간종료');
    else if (stopHit) await sellAll(p, `손절(${Math.round((effStop / p.entry - 1) * 100)}%${p.stopPrice != null && p.stopPrice < hardFloor ? ' 하드캡' : ''})`);
    else if (tgtHit) await sellAll(p, `익절(종목별 ${p.targetPrice != null ? '+' + Math.round((p.targetPrice / p.entry - 1) * 100) + '%' : '+' + tpPct + '%'})`);
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
