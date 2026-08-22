/**
 * diag-live-winrate.mjs — 라이브 실계좌 승률·손익 실측 (stock-live-journal.json)
 *
 * ═══ 주의 — 이 수치에는 알려진 편향이 있다 ═══
 * 2026-08-03 에 발견·수정한 결함: `getOrder` 의 체결가가 `execution.averageFilledPrice` 에 있는데
 * 코드가 top-level 만 읽어서 **매도 21건이 전부 지정가(limitPx)로 기록**됐다.
 * 매도는 보통 지정가 이상으로 체결되므로(LG이노텍 기록 503,000 vs 실제 505,000) 그 구간의
 * 수익률은 **과소 기록**돼 있다. 즉 실제 승률·손익은 아래보다 **약간 좋다**.
 * 수정 이후 매도는 `fillSrc:'actual'` 로 남으므로 그 필드로 구분해 따로도 집계한다.
 *
 * ═══ 승률을 두 방식으로 낸다 (섞으면 안 된다) ═══
 *  ① 매도 이벤트 기준 — 부분익절(tp1/tp2)이 한 포지션에 여러 매도를 만들어 **승을 부풀린다**
 *     (익절은 정의상 +, 잔량 청산이 −여도 2건 중 1승으로 세어짐).
 *  ② 포지션 기준 — 종목별로 매도 전체를 합쳐 실현손익 부호로 판정. 이게 실제 성적에 가깝다.
 *
 * 비교 기준: 07-29 목표수색 커밋의 진짜 홀드아웃(2026-06-12~07-21, 28거래일) 실측
 *   live 실계좌 건당 +2,670원 · 승률 45% (4트랙 중 유일한 플러스)
 *
 * 실행: node diag-live-winrate.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const F = join(__dirname, 'stock-live-journal.json');
if (!existsSync(F)) { console.error(`저널 없음: ${F}`); process.exit(1); }
const trades = (JSON.parse(readFileSync(F, 'utf8')).trades ?? []);
if (!trades.length) { console.error('거래 0건'); process.exit(1); }

/**
 * ★ 2026-08-04: 수동(텔레그램) 주문 기록을 함께 읽는다.
 *
 * tg-order.mjs 가 recordTrade 를 호출하지 않아 수동 매매가 저널에서 통째로 빠져 있었다
 * (08-04 실측: 매수만 있고 매도 기록이 없는 종목 8개). 그래서 봇 저널만 본 승률은 편향이다.
 * 같은 파일에 쓰면 stock-live 의 read-modify-write 와 경합하므로 별 파일(append-only)로 분리했고,
 * 여기서 합쳐 본다.
 *
 * 단 성질이 다르다: 수동 기록은 **주문**이고 체결가를 모른다(kind:'order').
 * 봇 기록은 체결 확인 후의 값이다. 그래서 승률에 섞지 않고 **따로 집계해 나란히** 보여준다 —
 * 섞으면 "지정가 기준 수익률"과 "체결 기준 수익률"이 한 숫자에 들어가 다시 편향이 된다.
 */
const MF = join(__dirname, 'manual-trades.jsonl');
const manual = existsSync(MF)
  ? readFileSync(MF, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const buys = trades.filter(t => t.side === 'BUY');
const sells = trades.filter(t => t.side === 'SELL');
const won = (n) => `${Math.round(n).toLocaleString()}원`;
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

console.log(`=== 라이브 실계좌 거래 실측 ===`);
console.log(`기간 ${trades[0].ts.slice(0, 10)} ~ ${trades.at(-1).ts.slice(0, 10)} · 매수 ${buys.length}건 · 매도 ${sells.length}건\n`);

// ── ① 매도 이벤트 기준 ────────────────────────────────────────────────────
const evWin = sells.filter(s => Number(s.ret) > 0).length;
const evPnl = sells.map(s => (Number(s.px) - Number(s.entry)) * Number(s.qty));
const evSum = evPnl.reduce((a, b) => a + b, 0);
console.log('【① 매도 이벤트 기준】 (부분익절이 승을 부풀린다 — 참고용)');
console.log(`  ${sells.length}건 중 ${evWin}승 ${sells.length - evWin}패 = 승률 ${(evWin / sells.length * 100).toFixed(0)}%`);
console.log(`  실현손익 합계 ${won(evSum)} · 건당 ${won(evSum / sells.length)}`);
console.log(`  평균 수익률 ${pct(sells.reduce((a, s) => a + Number(s.ret), 0) / sells.length)}`);

// ── ② 포지션 기준 ─────────────────────────────────────────────────────────
// 종목별 매도를 합친다. 같은 종목을 여러 번 사고팔았으면 한 덩어리로 합쳐지는 한계가 있다
// (재진입 전례: 두산퓨얼셀 4회). 그건 아래 재진입 표기로 드러낸다.
const byCode = new Map();
for (const s of sells) {
  const k = s.code;
  if (!byCode.has(k)) byCode.set(k, { name: s.name, n: 0, pnl: 0, qty: 0, cost: 0, reasons: [] });
  const e = byCode.get(k);
  e.n++; e.qty += Number(s.qty);
  e.pnl += (Number(s.px) - Number(s.entry)) * Number(s.qty);
  e.cost += Number(s.entry) * Number(s.qty);
  e.reasons.push(String(s.reason ?? '').slice(0, 18));
}
const pos = [...byCode.entries()].map(([code, e]) => ({ code, ...e, retPct: e.cost > 0 ? e.pnl / e.cost * 100 : 0 }))
  .sort((a, b) => b.pnl - a.pnl);
const pWin = pos.filter(p => p.pnl > 0).length;
const pSum = pos.reduce((a, p) => a + p.pnl, 0);

console.log(`\n【② 포지션 기준】 (매도 종목 ${pos.length}개 · 실제 성적에 가깝다)`);
console.log(`  ${pos.length}종목 중 ${pWin}승 ${pos.length - pWin}패 = 승률 ${(pWin / pos.length * 100).toFixed(0)}%`);
console.log(`  실현손익 합계 ${won(pSum)} · 종목당 ${won(pSum / pos.length)}`);

console.log(`\n  종목별 (매도 ${pos.length}종목)`);
console.log(`  종목            매도횟수  수익률   실현손익        사유`);
console.log('  ' + '─'.repeat(78));
for (const p of pos) {
  console.log(`  ${String(p.name).slice(0, 14).padEnd(15)} ${String(p.n).padStart(5)}   ${pct(p.retPct).padStart(7)} ${won(p.pnl).padStart(13)}   ${[...new Set(p.reasons)].join(', ').slice(0, 30)}`);
}

// ── 체결가 기록 편향 구분 ─────────────────────────────────────────────────
const actual = sells.filter(s => s.fillSrc === 'actual');
const limitFb = sells.filter(s => s.fillSrc !== 'actual');
console.log(`\n【체결가 기록 신뢰도】`);
console.log(`  실제 체결가(fillSrc=actual) ${actual.length}건 · 지정가 폴백 ${limitFb.length}건`);
if (limitFb.length) {
  console.log(`  → 폴백 ${limitFb.length}건은 08-03 수정 전 기록이라 수익률이 **과소**다(매도는 지정가 이상 체결).`);
  console.log(`     즉 위 승률·손익은 실제보다 약간 낮게 나온 값이다.`);
}
if (actual.length) {
  const aw = actual.filter(s => Number(s.ret) > 0).length;
  console.log(`  실제체결 ${actual.length}건만: ${aw}승 ${actual.length - aw}패 (승률 ${(aw / actual.length * 100).toFixed(0)}%)`);
}

/**
 * ── 매수는 있고 매도 기록이 없는 종목 ──
 * 두 종류가 섞여 있어 반드시 갈라야 한다. 안 가르면 "미기록 처분"을 과대계상한다:
 *   (a) 아직 보유 중 → 정상. 승률에 미반영일 뿐이다.
 *   (b) 처분됐는데 기록이 없음 → **결함의 흔적**(텔레그램 수동 매도 미기록).
 * 현재 보유는 ai-trader-decisions.jsonl 의 마지막 판단 holdings 로 기계적으로 읽는다
 * (하드코딩하면 다음에 틀린다).
 */
const LEDGER = join(__dirname, 'ai-trader-decisions.jsonl');
let heldNow = null;
if (existsSync(LEDGER)) {
  const recs = readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r?.ok && Array.isArray(r.holdings));
  if (recs.length) heldNow = new Set(recs.at(-1).holdings.map(h => h.code));
}
const noSell = new Set(buys.map(b => b.code));
for (const s of sells) noSell.delete(s.code);
const stillHeld = heldNow ? [...noSell].filter(c => heldNow.has(c)) : [];
const missing = heldNow ? [...noSell].filter(c => !heldNow.has(c)) : [...noSell];

console.log(`\n【매도 기록 없는 종목】 ${noSell.size}종목`);
if (!heldNow) {
  console.log(`  ⚠️ AI 원장이 없어 보유/처분을 가를 수 없다 — 아래는 둘이 섞인 목록이다.`);
  for (const c of noSell) console.log(`  ${String(buys.filter(x => x.code === c).at(-1)?.name ?? c)}`);
} else {
  console.log(`  · 현재 보유 중 ${stillHeld.length}종목 (정상 — 승률 미반영):`);
  for (const c of stillHeld) {
    const b = buys.filter(x => x.code === c).at(-1);
    console.log(`      ${String(b?.name ?? c).padEnd(15)} 매수 ${b?.ts?.slice(0, 10)} @${Number(b?.px ?? 0).toLocaleString()} × ${b?.qty}주`);
  }
  console.log(`  · 처분됐는데 매도 기록 없음 **${missing.length}종목** ← 수동매도 미기록 결함의 흔적:`);
  for (const c of missing) {
    const b = buys.filter(x => x.code === c).at(-1);
    console.log(`      ${String(b?.name ?? c).padEnd(15)} 매수 ${b?.ts?.slice(0, 10)} @${Number(b?.px ?? 0).toLocaleString()} × ${b?.qty}주 → 손익 불명`);
  }
}

// ── 수동(텔레그램) 주문 ────────────────────────────────────────────────────
console.log(`\n【수동(텔레그램) 주문 기록】 ${manual.length}건`);
if (!manual.length) {
  console.log(`  없음. tg-order.mjs 기록은 2026-08-04 부터 시작이므로 그 이전 수동 매매는 복구할 수 없다.`);
  console.log(`  → 위 승률은 여전히 **봇 자동경로만**의 값이다. 아래 미기록 처분 종목을 보라.`);
} else {
  const mb = manual.filter(m => m.side === 'BUY'), ms = manual.filter(m => m.side === 'SELL');
  console.log(`  매수 ${mb.length}건 · 매도 ${ms.length}건 (전부 kind=order — **체결가 아님**)`);
  const withRet = ms.filter(m => typeof m.retAtLimit === 'number');
  if (withRet.length) {
    const w = withRet.filter(m => m.retAtLimit > 0).length;
    console.log(`  지정가 기준 ${withRet.length}건 중 ${w}승 ${withRet.length - w}패 · 평균 ${pct(withRet.reduce((a, m) => a + m.retAtLimit, 0) / withRet.length)}`);
    console.log(`  ※ 지정가 기준이라 근사다. orderId 로 브로커 체결가를 대조해야 확정된다.`);
  }
  for (const m of manual.slice(-8)) {
    console.log(`  ${m.ts} ${String(m.side).padEnd(4)} ${String(m.name ?? m.code).padEnd(14)} 지정가 ${Number(m.limitPx ?? 0).toLocaleString().padStart(9)} × ${String(m.qty ?? '?').padStart(4)}주${m.retAtLimit != null ? ` (${pct(m.retAtLimit)})` : ''}`);
  }
}

console.log(`\n【비교 기준】 07-29 홀드아웃(06-12~07-21) 실측: 건당 +2,670원 · 승률 45%`);
console.log(`※ 표본 ${sells.length} 매도 / ${pos.length} 포지션. 성과 판정에는 너무 작다 — 추세 확인용이다.`);
console.log(`※ 남은 편향 2건: (1) 08-04 이전 수동 매매는 기록이 없어 복구 불가 —`);
console.log(`   처분됐는데 매도 기록 없는 ${missing.length}종목이 그 흔적이다(손익 부호 불명 → 승률이 위/아래 어느 쪽으로도 움직일 수 있다).`);
console.log(`   (2) 07-29 14:37 이전 매도는 qty 필드가 없어 원화 손익 계산 불가.`);
