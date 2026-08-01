/**
 * trader-smoke-test.mjs — ai-trader 스모크 테스트.
 *   --print-prompt        실제 buildPrompt 출력 (외부에서 claude 에 넣는 용도)
 *   --parse <file>        claude 응답을 실제 parseDecision 에 통과 (권한 경계 검증 포함)
 *   (인자 없음)           consultTrader 전체 경로 — VM(Linux)에서 flock·메모리가드 포함 실행
 */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const { consultTrader, buildPrompt, parseDecision } = await import('./ai-trader.mjs');

// 사용자 시나리오 4개를 한 컨텍스트에 넣었다: 폭락·과매도(DOWN) / 슬롯 만석 / 손절선 임박 종목 /
// 갈아타기 후보 존재 / 연패 직후. AI 가 sell·defer·buy 를 동시에 낼 수 있는 상황.
const ctx = {
  today: '2026-08-01', nowKst: '2026-08-01 10:00:00', regime: 'DOWN', hardStopPct: 15,
  cands: [
    { code: '005930', name: '삼성전자', sub: 'rsi2', px: 61000, conviction: 4.2, rsi2: 6.3, dd20: -8.2, volRatio: 1.8, sector: '반도체복합' },
    { code: '017670', name: 'SK텔레콤', sub: 'rsi2', px: 52000, conviction: 4.8, rsi2: 4.4, dd20: -3.1, volRatio: 2.1, sector: '통신' },
    { code: '000660', name: 'SK하이닉스', sub: 'rsi2', px: 1300000, conviction: 3.1, rsi2: 8.9, dd20: -12.5, volRatio: 0.9, sector: '반도체복합' },
  ],
  forecast: { dir: 'down', up: 28, down: 57, conf: 62, median: -0.9, session: 'KRX_REGULAR',
    drivers: { us: '나스닥 -2.1% 반도체 주도 하락, 필라델피아 반도체지수 -3.4%', issues: '엔캐리 청산 우려 재점화' } },
  cash: 1_400_000, perSlot: 1_200_000, bigCount: 4, slots: 5, rotateLeft: 2,
  holdings: [
    { code: '000150', name: '두산', sub: 'hi120', sector: '지주·발전설비', ret_pct: 16.9, near_stop: false, exit_reserved: '부분익절 tp2 +12%', stop_deferred: null },
    { code: '011070', name: 'LG이노텍', sub: 'rsi2', sector: '전자부품', ret_pct: -13.1, near_stop: true, exit_reserved: null, stop_deferred: null },
    { code: '161390', name: '한국타이어', sub: 'rsi2', sector: '자동차부품', ret_pct: -1.2, near_stop: false, exit_reserved: null, stop_deferred: null },
    { code: '443060', name: 'HD현대마린솔루션', sub: 'hi120', sector: '조선·기계', ret_pct: 0.4, near_stop: false, exit_reserved: null, stop_deferred: null },
  ],
  recentSells: [
    { name: '두산퓨얼셀', ret: -5.2, reason: '하드손절 -7%', ts: '2026-07-29 09:10:00' },
    { name: '카카오', ret: -3.1, reason: 'MA3회귀 익절', ts: '2026-07-30 08:05:00' },
  ],
};

// 시나리오 B — 만석(5/5) + 현금 거의 없음 + 강한 신규 후보 + 모멘텀 죽은 보유분.
//   사용자 요청 "살 종목 생겼다 → 모멘텀 없는 걸 청산 → 판다 → 새로 산다"가 성립해야 하는 상황.
const ctxFull = {
  ...ctx, regime: 'UP', cash: 90_000, bigCount: 5, perSlot: 1_200_000, rotate: (await import('./strategy-contract.mjs')).AI_TRADER.rotate, rotateLeft: 2,
  forecast: { dir: 'up', up: 58, down: 26, conf: 61, median: +0.7, session: 'KRX_REGULAR',
    drivers: { us: '나스닥 +1.8%, 반도체 강세 주도', issues: '금리 인하 기대 확대' } },
  cands: [
    { code: '000660', name: 'SK하이닉스', sub: 'hi120', px: 1400000, conviction: 8.4, breakout: 8.4, dd20: 12.1, volRatio: 2.6, sector: '반도체복합' },
    { code: '017670', name: 'SK텔레콤', sub: 'rsi2', px: 52000, conviction: 3.2, rsi2: 6.8, dd20: -2.0, volRatio: 1.1, sector: '통신' },
  ],
  holdings: [
    { code: '000150', name: '두산', sub: 'hi120', sector: '지주·발전설비', ret_pct: 16.9, near_stop: false, exit_reserved: '부분익절 tp2 +12%', stop_deferred: null, ca_hold: false, hold_days: 5 },
    { code: '161390', name: '한국타이어', sub: 'rsi2', sector: '자동차부품', ret_pct: 0.3, near_stop: false, exit_reserved: null, stop_deferred: null, ca_hold: false, hold_days: 4 },
    { code: '443060', name: 'HD현대마린솔루션', sub: 'hi120', sector: '조선·기계', ret_pct: 0.4, near_stop: false, exit_reserved: null, stop_deferred: null, ca_hold: false, hold_days: 6 },
    { code: '005930', name: '삼성전자', sub: 'rsi2', sector: '반도체복합', ret_pct: -11.5, near_stop: false, exit_reserved: null, stop_deferred: null, ca_hold: false, hold_days: 3 },
    { code: '034020', name: '두산에너빌리티', sub: 'rsi2', sector: '발전설비', ret_pct: -0.8, near_stop: false, exit_reserved: null, stop_deferred: null, ca_hold: false, hold_days: 2 },
  ],
};
const argv = process.argv.slice(2);
const CTX = argv.includes('--full') ? ctxFull : ctx;
if (argv[0] === '--print-prompt') { console.log(buildPrompt(CTX)); process.exit(0); }
if (argv[0] === '--parse') {
  const dec = parseDecision(readFileSync(argv[1], 'utf8'), CTX);
  console.log('parseDecision →', JSON.stringify(dec, null, 1));
  process.exit(dec ? 0 : 1);
}
const log = (m) => console.log('[log]', m);
const notify = (m) => console.log('[tg-would-send]', String(m).slice(0, 400));
let r = consultTrader(ctx, { log, notify });
console.log('1st →', r.mode, r.reason ?? '');
const t0 = Date.now();
for (let i = 0; i < 80; i++) {
  await new Promise(s => setTimeout(s, 3000));
  r = consultTrader(ctx, { log, notify });
  if (r.mode !== 'hold') break;
}
console.log(`final(${((Date.now() - t0) / 1000).toFixed(0)}s) →`, JSON.stringify({
  mode: r.mode, buy: [...(r.buy ?? [])], sell: [...(r.sell ?? [])], defer: [...(r.defer ?? [])],
  skipAll: r.skipAll ?? null, strategy: r.strategy ?? null,
}, null, 1));
process.exit(0);
