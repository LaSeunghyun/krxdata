#!/usr/bin/env node
/**
 * measure-slippage.mjs — 횡단면 잔차 스캘핑 **라이브 섀도우 검증**(무자본 기본) (2026-08-04)
 *
 * ── 어떻게 여기까지 왔나 ──────────────────────────────────────────────────────
 * 1) 백테에서 잔차 −5% 신호가 조건을 통과했다(순승률 69.1% · EV +0.113%).
 * 2) 마지막 관문 = 체결 품질. `f = (체결가−진입봉시가)/(진입봉 고저폭)`, **f ≥ 0.18 이면 EV ≤ 0**.
 * 3) **소액 실주문을 기다릴 필요가 없었다** — `stock-live` 저널에 실체결가가 이미 쌓여 있었다.
 *    실측 10건 → **중위 f 0.429 = 크로싱 진입 기각**(EV −0.52%). 지정가 대비 체결은 전부 유리했으므로
 *    체결이 나쁜 게 아니라 **"건너면 봉 위쪽에 붙는다"는 구조** 문제였다.
 * 4) 그래서 **건너지 않는 진입**(패시브 지정가)으로 백테를 다시 돌렸다 → **통과**:
 *      잔차−5% · 패시브 시가−0.1% · TP2% · 무손절 · 상한10분
 *      **순승률 67.2% · EV +0.103% · IS +0.102 / OOS +0.105 · n=469** (비용 0.30% = 진입측 틱 미지출)
 *
 * ── 그래서 지금 검증할 것 ─────────────────────────────────────────────────────
 * 남은 미지수는 "체결가가 나쁜가"가 아니라 **"패시브 지정가가 실제로 체결되는가"** 다.
 * 그건 **주문 없이 잴 수 있다** → 이 스크립트의 기본 모드가 섀도우다(`--go` 를 줘야 실주문).
 *   ① 체결 여부 — 백테와 **같은 판정식**(저가가 지정가 아래로 통과). 다르면 대조가 성립하지 않는다
 *   ② 체결까지 걸린 분 · ③ 신호 시점 호가창(스프레드·depth·지정가가 매수1호가 대비 어디)
 *   ④ 체결분의 HOLD_MIN 분 성과 → 백테 EV 와 대조
 * 판정: **실측 체결률이 백테 가정(≈89%)에 근접**하고 체결분 성과가 백테와 어긋나지 않으면 전제 성립.
 *
 * ── 안전장치 (실주문 모드에서만 의미. 섀도우는 주문 자체가 없다) ──────────────
 *   · `--go` 없으면 **섀도우**(주문 안 함) — 기본값
 *   · 1주문 ORDER_KRW · 하루 MAX_ORDERS 건 · 동시보유 MAX_CONCURRENT 종목
 *   · 매수 즉시 `.bot-exclude.json` 등록 → **stock-live 자동봇이 절대 안 건드림**. 매도 시 해제
 *   · 자동봇 보유종목·LIVE_EXCLUDE·이미 측정한 종목은 스킵
 *   · HOLD_MIN 분 뒤 무조건 청산(전략의 상한 10분과 동일). 손절 없음 = 백테와 동일 구조
 *   · 주문 오류 ERR_MAX 회면 그날 중단
 *
 * ── 라이브 봇과의 자원 경합 (중요) ────────────────────────────────────────────
 * 토스 API·토큰을 stock-live 와 **공유**한다. 과거 401 토큰경합으로 봇이 멈춘 전례가 있다.
 * 그래서 스캔 유니버스를 `--uni` 로 줄일 수 있게 했고, 기본은 정규장 중 `--window` 구간만 돈다.
 * ★ 스캔 1회 = getPricesMap 이 200개씩 **배치**라 uni=150 이면 **HTTP 1요청(~105ms)**. 종목당 105ms 가 아니다
 *   (그건 getDailyCandles 처럼 종목별 호출일 때). 즉 API 부하는 5분당 1~2요청 = 무시할 수준.
 *
 * 실행: node measure-slippage.mjs        ← **섀도우(무자본)**. 30분마다 텔레그램 중간보고
 *       node measure-slippage.mjs --go   실주문(현재 미사용)
 */
import dotenv from 'dotenv';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);
import { getAccounts, getHoldings, getBuyingPower, getPricesMap, getCandles1m, getOrderbook, createOrder, getOrder, cancelOrder } from './toss-api.js';
import { LIVE_EXCLUDE } from './strategy-contract.mjs';
import { readBotExclude, addBotExclude, removeBotExclude } from './bot-exclude.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const GO = argv.includes('--go');
/**
 * ★ 2026-08-04 전환 — **섀도우(무자본) 라이브 검증이 기본이다.**
 *
 * 왜 바뀌었나: 라이브 저널 실체결 10건으로 f 를 재보니 **크로싱 진입은 중위 f 0.429(허용 0.18)** 로 기각이었다.
 * 그런데 **패시브 진입**(시가 −0.1% 지정가, 안 건너감)으로 백테를 다시 돌리니 조건을 통과했다:
 *   순승률 67.2% · EV +0.103% · IS +0.102 / OOS +0.105 · n=469 (비용 0.30% = 진입측 틱 미지출 반영)
 * 즉 검증해야 할 대상이 "체결가가 얼마나 나쁜가"에서 **"패시브 지정가가 실제로 체결되는가"** 로 바뀌었다.
 * 그건 **주문 없이도 잴 수 있다** — 신호 시점 호가창을 남기고, 이후 분봉 경로로 체결 여부를 판정하면 된다.
 *
 * SHADOW 모드가 재는 것(전부 무자본):
 *   ① 패시브 체결 여부 — 지정가(시가−PASSIVE%) 아래로 저가가 통과했는가 (백테 가정과 **같은 판정식**)
 *   ② 체결까지 걸린 시간 · ③ 신호 시점 호가창(스프레드·depth) — 지정가가 매수1호가 안쪽인지
 *   ④ 체결됐다면 그 뒤 HOLD_MIN 분 성과 → 백테 EV 와 대조
 * 백테의 체결 가정(`저가 < 지정가`)이 실제 호가 상황에서 성립하는지가 유일한 미지수이고, 이게 그 답을 준다.
 */
const SHADOW = !GO;                                   // --go 없으면 섀도우(주문 없음)
const PASSIVE = Number(argOf('--passive', 0.1));      // 진입 지정가 = 진입봉 시가 −X%
const FILLWIN = Number(argOf('--fillwin', 5));        // 체결 대기(분)

// ── 상한 (전부 보수적 기본값) ─────────────────────────────────
const ORDER_KRW = Number(argOf('--krw', 100_000));      // 1주문 금액
const MAX_ORDERS = Number(argOf('--maxorders', 6));      // 하루 최대 주문
const MAX_CONCURRENT = Number(argOf('--maxconc', 2));    // 동시 보유
const HOLD_MIN = Number(argOf('--hold', 10));            // 보유(분) — 백테 상한 10분과 동일
const RESID = Number(argOf('--resid', 5)) / 100;         // 잔차 임계
/**
 * 스캔 유니버스 크기. **백테 채택본과 같은 281 이 기본**이다(2026-08-06 150→281).
 * 150 은 시총 상위로 좁힌 값인데, 그 유니버스로 백테를 재현하면 IS 77.6%/+0.463 → **OOS 42.9%/−0.804** 로
 * 무너진다(`diag-scalp-attrib.mjs --unitop 150 --mktn 150`, n=88·OOS n=21 — 표본이 작아 근거는 약하지만
 * 채택본이 281 이었으므로 되돌리는 쪽이 맞다). 대형주는 변동성이 낮아 10분 안에 TP(+2%)가 안 나온다:
 * 백테 변동성 하위 Q1 승률 54.8%·EV −0.273 vs 상위 Q5 76.3%.
 * 조회는 200개 배치라 281 이어도 HTTP 2요청(~210ms) — 지연 손익분기 106초에 영향 없다.
 */
const UNI = Number(argOf('--uni', 281));                 // 스캔 유니버스 크기
const WIN0 = argOf('--from', '0930'), WIN1 = argOf('--to', '1130');  // 엣지가 가장 컸던 구간
const ERR_MAX = 3;
const TF_MIN = 5;
const OUT = join(__dirname, 'slippage-measure.jsonl');
const STATE = join(__dirname, '.slippage-state.json');

/**
 * `minResid` = 이 변형이 신호로 인정하는 잔차 하한(%). 스캔은 **가장 느슨한 값**으로 돌고,
 * 각 변형은 자기 임계를 넘는 신호만 가져간다. 그래야 −4~−5% 구간 신호를 −4% 변형만 취한다.
 *
 * ⚠️ 잔차 −4% 는 **크로싱 진입 백테에서 OOS 가 무너진 이력**이 있다(IS +0.160 / OOS −0.122).
 *   패시브로는 안 재봤으므로 시험 대상이지만, 통과해도 그 이력을 잊지 말 것.
 */
const VARIANTS = [
  { name: 'base',    minResid: 5, passive: 0.1, fillWin: 5, hold: 10, tp: 2.0, cost: 0.30, btEv: 0.103, btWr: 67.2 }, // 백테 통과본
  { name: 'deep',    minResid: 5, passive: 0.3, fillWin: 5, hold: 10, tp: 2.0, cost: 0.30, btEv: null,  btWr: null }, // 더 깊은 지정가
  { name: 'hold30',  minResid: 5, passive: 0.1, fillWin: 5, hold: 30, tp: 2.0, cost: 0.30, btEv: 0.248, btWr: 75.3 }, // 백테 EV 최고
  { name: 'quick',   minResid: 5, passive: 0.1, fillWin: 3, hold: 10, tp: 2.0, cost: 0.30, btEv: null,  btWr: null }, // 대기 짧게(선택편의↓)
  { name: 'r4',      minResid: 4, passive: 0.1, fillWin: 5, hold: 10, tp: 2.0, cost: 0.30, btEv: null,  btWr: null }, // 잔차 완화(표본↑, OOS 이력 주의)
  { name: 'cross',   minResid: 5, passive: 0,   fillWin: 0, hold: 10, tp: 2.0, cost: 0.42, btEv: null,  btWr: null }, // 대조군: 크로싱(기각본)
];
/** 스캔 임계 = 가장 느슨한 변형. 이걸 안 낮추면 −4% 변형이 볼 신호가 애초에 안 잡힌다. */
const SCAN_RESID = Math.min(...VARIANTS.map(v => v.minResid));

const kst = () => new Date(Date.now() + 9 * 3_600_000);
const hm = () => { const d = kst(); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0'); };
const today = () => kst().toISOString().slice(0, 10);
const ts = () => kst().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${ts()}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadState() {
  try { if (existsSync(STATE)) { const s = JSON.parse(readFileSync(STATE, 'utf8')); if (s.day === today()) return s; } } catch { /* */ }
  return { day: today(), orders: 0, errs: 0, done: [] };
}
function saveState(s) { try { writeFileSync(STATE, JSON.stringify(s)); } catch { /* */ } }
let state = loadState();

async function dbQuery(sql) {
  // 라이브 봇(stock-live.mjs:135)과 **동일한 경로**를 쓴다. rpc/exec_sql 은 이 프로젝트에 없다.
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`db ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// 휴장일(공휴일)은 실행 안 함 — cron 이 평일만 돌아 주말은 없지만 평일 공휴일이 새는 구멍이었다 (2026-08-16)
{
  const { isTradingDayKST } = await import('./market-day.mjs');
  if (!(await isTradingDayKST())) { log('휴장일 — 종료'); process.exit(0); }
}

log(`=== 스캘핑 라이브 검증 ${GO ? "**실주문 모드**" : "(섀도우 — 주문 없음, 무자본)"} ===`);
log(`스캔잔차 ≤ −${Math.min(RESID * 100, SCAN_RESID).toFixed(0)}% (변형별 임계 ${[...new Set(VARIANTS.map(v => v.minResid))].sort().map(x => `−${x}%`).join(",")}) · 유니버스 ${UNI} · 창 ${WIN0}~${WIN1} · 1주문 ${ORDER_KRW.toLocaleString()}원 · 하루 ${MAX_ORDERS}건 · 동시 ${MAX_CONCURRENT} · 보유 ${HOLD_MIN}분`);
log(`진입 = 패시브 지정가 시가−${PASSIVE}% · 체결대기 ${FILLWIN}분 (건너지 않음)`);
log(`판정 기준: **실측 체결률이 백테 가정(≈89%)에 근접** ∧ 체결분 ${HOLD_MIN}분 성과가 백테와 어긋나지 않을 것`);

const accounts = await getAccounts();
const seq = accounts?.[0]?.accountSeq;
if (seq == null) { log('계좌 조회 실패 — 중단'); process.exit(1); }

// 유니버스 (라이브 봇과 동일 기준: 유동성 필터 + 시총 상위)
const rows = await dbQuery(`SELECT stock_code,corp_name FROM stock_analysis WHERE current_price>=2000 AND avg_turnover_20d>=3000000000 ORDER BY market_cap_tril DESC NULLS LAST LIMIT ${UNI}`);
const universe = rows.map(r => ({ code: r.stock_code, name: r.corp_name }));
log(`유니버스 ${universe.length}종목 로드`);

const open = new Map();   // code → {qty, entryTs, orderId, limitPx, signalPx, name}
const pending = [];       // 섀도우: 판정 대기 신호
const settled = [];       // 섀도우: 판정 끝난 건 (30분 중간보고 집계용)

/** 텔레그램 알림 — stock-live.mjs 와 같은 방식(curl). 세션이 끊겨도 사용자가 받을 수 있게. */
async function tgNotify(text) {
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) return;
  try {
    const t = String(text ?? '');
    for (let i = 0; i < t.length; i += 3800) {
      await execFileP('curl', ['-4', '-s', '-m', '20', '-X', 'POST', '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ chat_id: C, text: t.slice(i, i + 3800) }),
        `https://api.telegram.org/bot${T}/sendMessage`], { timeout: 25_000 });
    }
  } catch (e) { log(`텔레그램 실패: ${String(e.message).slice(0, 80)}`); }
}

/**
 * 30분 중간보고 — 사용자 요청. **누적 집계**를 보낸다(그때그때 이벤트가 아니라).
 * 핵심 판정지표를 매번 같이 실어 진행 중에도 방향을 볼 수 있게 한다:
 *   체결률(백테 가정 89% 대비) · 체결분 평균 총수익 · 비용차감 EV · 승률
 * 비용 0.30% = 수수료0.03 + 세금0.15 + 청산측 틱0.12 (패시브라 진입측 틱은 안 낸다).
 */
const SHADOW_COST = 0.30;
/**
 * ★ 가상 계좌 — 사용자 요청("500만원으로 시작했다 치고 누적 순익").
 *
 * 사이징 모델(명시해야 숫자가 정직하다):
 *   · 1건당 = **현재 자본 / SLOTS**. 라이브 시스템의 `LIVE_SLOTS=5` 와 같은 분산 기준.
 *   · **복리** — 순익이 자본에 반영돼 다음 건 크기가 바뀐다.
 *   · 비용 0.30% 왕복을 건마다 차감(수수료0.03 + 거래세0.15 + 청산측 틱0.12. 패시브라 진입측 틱은 없다).
 *   · ⚠️ **동시보유를 무시한다** — 신호가 겹치면 둘 다 1슬롯을 받는다. 보유가 10분뿐이라
 *     실제로 5슬롯이 동시에 차는 일은 드물지만, 겹치는 날엔 이 모델이 자본을 과대 배분한다.
 *     즉 누적 순익은 **약간 낙관** 쪽이다.
 *   · 미체결 건은 자본을 쓰지 않는다(비용도 0).
 */
const CAPITAL0 = Number(argOf('--capital', 5_000_000));
const SLOTS = Number(argOf('--slots', 5));
/**
 * ★ 변형 5종 동시 검증 (2026-08-04, 사용자 요청 "다섯개 한번에").
 *   주문이 없으니 자본 제약이 없다 → **같은 신호 스트림에 5개 설정을 동시에 물린다.**
 *   같은 시장 조건에서 비교되므로 **페어드 대조**가 되어 순차 테스트보다 통계력이 훨씬 높다.
 *
 *   `cross` 는 대조군이다 — 크로싱 진입(실측 f 0.429 로 이미 기각된 것). 이게 같이 지면
 *   "패시브가 낫다"가 라이브에서도 실증된다. 대조군 없이 패시브만 돌리면 비교 대상이 없다.
 *
 *   ⚠️ 비용이 변형마다 다르다: 패시브는 진입측 틱을 안 내므로 0.30%, 크로싱은 0.42%.
 */

/** 변형마다 **독립 가상계좌**. 같은 신호를 각자 방식으로 처리했을 때의 누적을 나란히 본다. */
const acct = Object.fromEntries(VARIANTS.map(v => [v.name, { cap: CAPITAL0, fills: [], tried: 0 }]));
/** 판정 대기 = 가장 긴 변형(fillWin+hold) 기준. 짧게 잡으면 긴 변형이 봉 부족으로 틀린다. */
const MAX_RESOLVE_MIN = Math.max(...VARIANTS.map(v => v.fillWin + v.hold));

function bookVariant(vname, vres) {
  const a = acct[vname];
  if (vres.skipped) return null;   // 이 변형의 임계 밖 = 시도 자체가 아니다
  a.tried++;
  if (!vres.filled) return null;
  const size = Math.floor(a.cap / SLOTS);
  const pnl = Math.round(size * vres.netPct / 100);
  a.cap += pnl;
  a.fills.push({ pnl, size, netPct: vres.netPct, why: vres.why });
  vres.simSize = size; vres.simPnl = pnl; vres.simCapAfter = a.cap;
  return { size, pnl };
}

/**
 * ★ 이탈 진단 + **사전선언 가설 맵** (2026-08-04, 사용자 요청 "안 좋으면 가설 세워 재테스트").
 *
 * ⚠️ 설계 원칙 — **라이브에서 파라미터를 바꾸지 않는다.**
 *   30분 시점의 표본은 2~5건이다. 그걸로 튜닝하면 노이즈를 쫓는 것이고, 이 저장소 전적이 3승 39패다.
 *   라이브 섀도우는 **사전선언 설정 하나를 끝까지** 돌린다(그래야 백테와 대조가 성립).
 *   라이브가 하는 일은 "어느 지표가 얼마나 어긋났나"를 알려주는 것뿐이고,
 *   **가설 검정은 3.4년 백테에서** 한다(거기는 n 이 충분하다).
 *
 * 그래서 이탈 판정에 **표본오차**를 같이 쓴다. |관측−기대| > 2×SE 일 때만 이탈로 부른다.
 *   체결률 SE = √(p(1−p)/n)   ·   EV SE = σ/√n (σ 는 관측 순수익 표준편차)
 *   ※ EV 는 σ 가 ~1% 라 n=5 면 SE 0.45% — **EV 0.103% 판정은 원리상 며칠 걸린다.** 30분 단위로 EV 를 판정하지 않는다.
 *
 * 가설은 **미리** 적어둔다(사후에 만들면 그게 과적합이다):
 *   H1 체결률 << 89%  → "저가 통과"만으로는 큐 우선순위 때문에 실제 체결이 안 된다
 *                       → 백테 체결판정을 1틱 더 보수적으로 바꿔 재검정
 *   H2 체결률 >> 89%  → 백테가 오히려 보수적이었다. 확인만(전략에 유리한 방향이라 서둘러 채택 금지)
 *   H3 체결분 성과 << 백테 → 체결된 건이 선택편의(더 빠진 것)다
 *                       → 백테에서 "체결분만"의 성과를 따로 떼어 같은 편의가 있는지 대조
 *   H4 신호 빈도 << 예상 → 유니버스·임계 문제 → uni 150→281 · 잔차 −5%→−4% 로 재검정
 *   H5 신호 0건        → 가설 이전에 **배선 의심**. 계측부터 확인(잔차 분포·시장요인 산출)
 */
const BT = { fillRate: 89, ev: 0.103, wr: 67.2, sigPerDay: 5 };
function diagnose(f, n, evObs, evSd, v = { btEv: BT.ev }) {
  const out = [];
  if (n >= 3) {
    const p = f.length / n, se = Math.sqrt(Math.max(1e-9, p * (1 - p) / n)) * 100;
    const d = p * 100 - BT.fillRate;
    if (Math.abs(d) > 2 * se) out.push(`체결률 ${d > 0 ? '초과' : '미달'} ${d.toFixed(0)}%p (2SE ${(2 * se).toFixed(0)}%p) → ${d < 0 ? 'H1' : 'H2'}`);
  }
  if (f.length >= 5 && Number.isFinite(evSd) && evSd > 0) {
    const se = evSd / Math.sqrt(f.length);
    const d = evObs - (v.btEv ?? BT.ev);
    if (Math.abs(d) > 2 * se) out.push(`EV ${d > 0 ? '초과' : '미달'} ${d.toFixed(3)}%p (2SE ${(2 * se).toFixed(3)}%p) → ${d < 0 ? 'H3' : '확인만'}`);
    else out.push(`EV 판정불가 — 표본오차 2SE ${(2 * se).toFixed(3)}%p 가 차이 ${Math.abs(d).toFixed(3)}%p 보다 크다 (n=${f.length})`);
  } else if (f.length) out.push(`EV 판정불가 — 체결 ${f.length}건 (최소 5건 필요)`);
  return out;
}

async function report30(force = false) {
  const now = Date.now();
  if (!force && now - lastReportAt < 30 * 60_000) return;
  lastReportAt = now;
  const n = settled.length;
  const won = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString()}`;
  const lines = [];
  let diagAll = [];
  for (const v of VARIANTS) {
    const a = acct[v.name];
    const fl = a.fills;
    const fr = a.tried ? fl.length / a.tried * 100 : null;
    const ev = fl.length ? fl.reduce((s, x) => s + x.netPct, 0) / fl.length : null;
    const wr = fl.length ? fl.filter(x => x.netPct > 0).length / fl.length * 100 : null;
    const pnl = a.cap - CAPITAL0;
    lines.push(`${v.name.padEnd(7)}${(a.tried ? `${fl.length}/${a.tried}` : '0/0').padStart(6)}` +
      `${(fr != null ? fr.toFixed(0) + '%' : '-').padStart(6)}` +
      `${(ev != null ? (ev >= 0 ? '+' : '') + ev.toFixed(3) : '-').padStart(8)}` +
      `${(wr != null ? wr.toFixed(0) + '%' : '-').padStart(6)}` +
      `${won(pnl).padStart(10)}원`);
    // 이탈 진단은 **백테 기대값이 있는 변형**만(없는 건 비교 기준이 없다)
    if (v.btEv != null) {
      const evSd = fl.length > 1 ? Math.sqrt(fl.reduce((s, x, _, arr) => s + (x.netPct - arr.reduce((p, q) => p + q.netPct, 0) / arr.length) ** 2, 0) / fl.length) : NaN;
      diagAll = diagAll.concat(diagnose(fl, a.tried, ev ?? 0, evSd, v).map(d => `[${v.name}] ${d}`));
    }
  }
  const bestV = VARIANTS.map(v => ({ v, pnl: acct[v.name].cap - CAPITAL0 })).sort((a, b) => b.pnl - a.pnl)[0];
  const msg = `📊 스캘핑 섀도우 5종 (${ts().slice(11)}) · 각 시작 ${(CAPITAL0 / 10000).toLocaleString()}만원\n` +
    `신호 ${n + pending.length}건 (판정 ${n} · 대기 ${pending.length})` +
    (n >= 3 ? ` · ${((n + pending.length) / Math.max(0.5, elapsedH())).toFixed(1)}건/시간` : '') + `\n` +
    `${'설정'.padEnd(7)}${'체결'.padStart(6)}${'률'.padStart(6)}${'EV%'.padStart(8)}${'승률'.padStart(6)}${'누적'.padStart(11)}\n` +
    lines.join('\n') + `\n` +
    (n ? `▶ 선두 **${bestV.v.name}** ${won(bestV.pnl)}원\n` : '') +
    `[백테] base EV +0.103·승률 67.2 / hold30 EV +0.248·75.3 / 체결률 89%\n` +
    (diagAll.length ? `━━ 이탈 진단 ━━\n${diagAll.map(d => `· ${d}`).join('\n')}\n` : '') +
    `※ 주문 없음 · 라이브 설정은 안 바꾼다(가설검정은 백테) · 동시보유 미반영 → 누적은 약간 낙관`;
  log(msg.replace(/\n/g, ' | '));
  // ★ 2026-08-16 (사용자 "너무 길고 복잡해"): 30분 중간보고는 로그에만 남긴다.
  //   텔레그램은 종료 시(force) 1회, 요점 3~4줄만 — 전문 표·진단은 measure-slippage.log 에 그대로 있다.
  if (!force) return;
  const evLead = (() => { const fl = acct[bestV.v.name].fills; return fl.length ? (fl.reduce((s, x) => s + x.netPct, 0) / fl.length).toFixed(3) : '-'; })();
  const brief = `📊 스캘핑 섀도우 마감 · 신호 ${n + pending.length}건(판정 ${n})\n` +
    (n ? `선두 ${bestV.v.name}: 누적 ${won(bestV.pnl)}원 · EV ${evLead}%\n` : '오늘 판정 완료 신호 없음\n') +
    (diagAll.length ? `⚠️ 백테 이탈 ${diagAll.length}건 — 로그 확인 필요\n` : '백테 이탈 신호 없음\n') +
    `(상세 표는 measure-slippage.log)`;
  await tgNotify(brief);
}
let lastReportAt = Date.now();
const SESSION_T0 = Date.now();
const elapsedH = () => (Date.now() - SESSION_T0) / 3_600_000;
let prevClose = null;     // 직전 5분봉 종가 맵
/**
 * ★ 2026-08-06 신설 — `prevClose` 스냅샷을 찍은 시각(HHMM). **백테와 신호 정의를 맞추기 위한 것**이다.
 *
 * 백테(`backtest-xs-scalp.mjs`)는 `for (i=1; ...)` 이라 **당일 첫 5분봉(09:00~09:04)을 기준선으로 쓰는 신호를
 * 구조적으로 배제**한다(이전 봉이 없다). 그런데 라이브는 09:00 첫 스캔에서 prevClose 를 채우고 09:05 에
 * 신호를 내므로 그 기준선이 **시초가**다 = 백테가 한 번도 검증하지 않은 유형.
 *
 * 재현 측정(`diag-scalp-attrib.mjs --firstbar`, 2026-08-06): 281종목 n=136 **EV −0.372%**(승률 54.4%·TP율 49%),
 * 시총150 조합 n=16 **EV −0.508%**. 채택본(+0.103%)과 부호가 반대다.
 * 섀도우 1·2일차 신호 11건 중 **8건이 이 유형**이었고 base 6건 중 5건이 여기서 나왔다.
 *
 * ⚠️ 장중 재기동 시에는 prevClose 가 09:00 이 아닌 시각에 찍히므로 **정상 신호**다 → 시각으로 판정해야지
 *   "세션 첫 신호 스캔"으로 판정하면 재기동 때 멀쩡한 신호를 버린다.
 */
let prevCloseHm = null;
/** 개장 첫 봉(09:00~09:04)을 기준선으로 하는 스캔인가 = 백테 미검증 유형인가. */
const isOpenBaseline = (h) => h != null && h >= '0900' && h < '0905';

/**
 * 섀도우 판정 — 신호 후 (FILLWIN+HOLD_MIN) 분이 지난 건을 분봉으로 확정한다.
 * **백테(`backtest-xs-scalp.mjs --passive`)와 글자 그대로 같은 판정식**을 쓴다:
 *   체결 = 진입봉부터 FILLWIN 분 안에 **저가가 지정가 아래로 통과**(터치만으로는 불충분 — 큐 우선순위 보수 가정)
 *   성과 = 체결 시점부터 HOLD_MIN 분 뒤 종가 (익절 TP 는 여기서 안 건다 — 원자료를 남기고 집계에서 적용)
 * 두 경로가 다른 식을 쓰면 대조가 성립하지 않는다. 일치가 목적이다.
 */

/**
 * 한 신호를 **변형별로** 해석한다. 백테(`backtest-xs-scalp.mjs`)와 같은 판정식:
 *   체결 = fillWin 분 내 **저가가 지정가 아래로 통과**(크로싱은 진입봉 시가에 즉시 체결)
 *   청산 = TP(고가가 진입×(1+tp/100) 도달) 우선, 아니면 hold 분 뒤 종가 (손절 없음)
 * ※ TP 를 여기서 적용해야 백테 `tponly` 와 대조가 성립한다. 종가만 보면 다른 전략을 재는 것이다.
 */
async function resolveShadow(rec) {
  const cd = await getCandles1m(rec.code, 200);                 // 최신순
  const asc = [...cd].reverse().map(b => ({ t: Date.parse(b.timestamp), o: +b.open, h: +b.high, l: +b.low, c: +b.close }));
  const i0 = asc.findIndex(b => b.t >= rec.sigAtMs);            // 신호 직후 첫 분봉 = 진입봉
  if (i0 < 0) return { resolved: false, why: '진입봉 미발견' };
  const entryBar = asc[i0];
  const out = [];
  for (const v of VARIANTS) {
    // 이 변형의 잔차 임계를 못 넘는 신호는 **이 변형에겐 신호가 아니다**(tried 에도 안 센다)
    if (rec.resid > -v.minResid) { out.push({ name: v.name, skipped: true }); continue; }
    let fi = -1, entry = null;
    if (v.passive > 0) {
      const lim = entryBar.o * (1 - v.passive / 100);
      for (let k = i0; k < Math.min(asc.length, i0 + v.fillWin); k++) { if (asc[k].l < lim) { fi = k; entry = lim; break; } }
    } else { fi = i0; entry = entryBar.o; }   // 크로싱: 진입봉 시가 즉시
    if (fi < 0 || !(entry > 0)) { out.push({ name: v.name, filled: false }); continue; }
    const tpPx = entry * (1 + v.tp / 100);
    let exit = null, why = 'TIME';
    for (let k = fi; k < Math.min(asc.length, fi + v.hold); k++) {
      if (asc[k].h >= tpPx) { exit = tpPx; why = 'TP'; break; }
    }
    if (exit == null) exit = asc[Math.min(asc.length - 1, fi + v.hold)].c;
    out.push({
      name: v.name, filled: true, entry: Math.round(entry), exit: Math.round(exit), why,
      fillMinAfter: fi - i0,
      grossPct: +(((exit / entry) - 1) * 100).toFixed(4),
      netPct: +((((exit / entry) - 1) * 100) - v.cost).toFixed(4),
      f: entryBar.h > entryBar.l ? +(((entry - entryBar.o) / (entryBar.h - entryBar.l)).toFixed(3)) : null,
    });
  }
  return { resolved: true, entryBarOpen: entryBar.o, variants: out };
}

/**
 * ★ 호가창 기반 **무위험 슬리피지 추정**. 주문을 내지 않고도 "지금 시장가로 사면 얼마에 체결되나"를 계산한다.
 *   드라이런에서도 이게 돌기 때문에 **돈을 걸기 전에 f 를 먼저 볼 수 있다.**
 *   또한 소액(10만원) 실체결은 실제 운용 크기(슬롯 ~300만원)의 슬리피지를 **과소평가**하므로,
 *   같은 호가창으로 큰 금액도 함께 시뮬레이션해 크기 효과를 분리한다.
 *
 *   응답 스키마를 모르므로 방어적으로 파싱한다(배열형 {asks:[{price,quantity}]} · 평탄형 askPrice1/askQty1 둘 다).
 */
function parseAsks(ob) {
  if (!ob) return [];
  const arr = ob.asks ?? ob.askLevels ?? ob.sellLevels ?? null;
  if (Array.isArray(arr) && arr.length) {
    return arr.map(a => ({ px: Number(a.price ?? a.px ?? a.askPrice), qty: Number(a.quantity ?? a.qty ?? a.volume ?? a.askQuantity) }))
      .filter(x => x.px > 0 && x.qty > 0).sort((a, b) => a.px - b.px);
  }
  const out = [];
  for (let i = 1; i <= 10; i++) {
    const px = Number(ob[`askPrice${i}`] ?? ob[`ask${i}Price`]);
    const qty = Number(ob[`askQuantity${i}`] ?? ob[`askQty${i}`] ?? ob[`ask${i}Quantity`]);
    if (px > 0 && qty > 0) out.push({ px, qty });
  }
  return out.sort((a, b) => a.px - b.px);
}
function parseBestBid(ob) {
  if (!ob) return null;
  const arr = ob.bids ?? ob.bidLevels ?? ob.buyLevels ?? null;
  if (Array.isArray(arr) && arr.length) return Number(arr[0].price ?? arr[0].px ?? arr[0].bidPrice) || null;
  return Number(ob.bidPrice1 ?? ob.bid1Price) || null;
}
/** 호가를 위에서부터 먹어 금액 krw 만큼 살 때의 평균 체결가. 호가가 모자라면 소진분까지만. */
function simFill(asks, krw) {
  let spent = 0, shares = 0;
  for (const lv of asks) {
    const canKrw = lv.px * lv.qty;
    const take = Math.min(canKrw, krw - spent);
    if (take <= 0) break;
    shares += take / lv.px; spent += take;
    if (spent >= krw - 1) break;
  }
  return { avgPx: shares > 0 ? spent / shares : null, filledKrw: spent, exhausted: spent < krw - 1 };
}

/** 진입봉(1분) 을 사후 조회해 f_entry 산출. 체결 시각이 속한 1분봉을 쓴다. */
async function measureF(code, fillPx, fillAtMs) {
  try {
    const cd = await getCandles1m(code, 30);          // 최신순
    const target = cd.find(b => {
      const t = new Date(b.timestamp).getTime();
      return fillAtMs >= t && fillAtMs < t + 60_000;
    }) ?? cd[0];
    if (!target) return null;
    const rng = Number(target.high) - Number(target.low);
    const f = rng > 0 ? (fillPx - Number(target.open)) / rng : null;
    return { barOpen: Number(target.open), barHigh: Number(target.high), barLow: Number(target.low), rng, f };
  } catch { return null; }
}

while (true) {
  const t = hm();
  if (t >= '1520') { log('세션 종료 — 잔여 청산 후 종료'); break; }
  /**
   * ★ 섀도우에서는 `open` 이 **항상 비어 있다**(주문을 안 하므로). 그래서 이 조기 continue 를
   *   `open.size` 만으로 판단하면 창 종료(WIN1) 이후 **판정 대기건(pending)이 영원히 해석되지 않는다.**
   *   → 섀도우면 pending 도 함께 본다.
   */
  if (t < WIN0 || t > WIN1) {
    if (!open.size && !(SHADOW && pending.length)) { await sleep(30_000); continue; }
  }

  if (SHADOW) await report30();
  // ── 섀도우 판정 대기건 확정 ────────────────────────────────
  for (let i = pending.length - 1; i >= 0; i--) {
    const r = pending[i];
    /**
     * ★ 대기시간은 **가장 긴 변형** 기준이어야 한다. r.holdMin(10) 을 쓰면 16분 뒤 판정하는데
     *   `hold30` 은 35분치 봉이 필요하다 → 봉이 모자라 마지막 봉으로 청산가를 잡아 **조용히 틀린 값**이 된다.
     *   (변형 동시검증으로 바꾸면서 생긴 결함. 단일 설정일 땐 맞는 식이었다.)
     */
    if (Date.now() - r.sigAtMs < (MAX_RESOLVE_MIN + 1) * 60_000) continue;
    try {
      const res = await resolveShadow(r);
      if (!res.resolved) { log(`섀도우 판정 실패 ${r.name}: ${res.why}`); pending.splice(i, 1); continue; }
      Object.assign(r, res);
      settled.push(r);
      const parts = [];
      for (const vr of res.variants) {
        bookVariant(vr.name, vr);
        if (vr.skipped) continue;
        parts.push(vr.filled
          ? `${vr.name} ${vr.netPct >= 0 ? "+" : ""}${vr.netPct}%(${vr.why},${vr.simPnl >= 0 ? "+" : ""}${vr.simPnl.toLocaleString()}원)`
          : `${vr.name} 미체결`);
      }
      appendFileSync(OUT, JSON.stringify(r) + "\n");
      log(`[판정] ${r.name}(${r.code}) 잔차${r.resid}% · ` + parts.join(" | "));
      pending.splice(i, 1);
    } catch (e) { log(`섀도우 판정 오류 ${r.code}: ${String(e.message).slice(0, 120)}`); }
  }

  // ── 보유분 만기 청산 ────────────────────────────────────────
  /**
   * ★ 미체결이면 open 에서 지우면 안 된다. 손절이 없는 구조라 방치된 포지션은 무한 노출이 되고,
   *   bot-exclude 도 풀려 자동봇이 meta 없는 보유로 인식해 경보만 낸다(청산 주체가 사라진다).
   *   → **실제 보유수량이 0 이 된 것을 확인한 뒤에만** open 에서 제거하고 bot-exclude 를 푼다.
   *   미체결이면 기존 주문을 취소하고 다음 사이클에 더 공격적인 가격으로 재시도한다.
   */
  for (const [code, p] of [...open.entries()]) {
    if (Date.now() - p.entryTs < HOLD_MIN * 60_000) continue;
    if (!GO) { log(`[DRY] 청산 시점 도달 ${p.name}(${code})`); open.delete(code); continue; }
    try {
      if (p.sellOrderId) { try { await cancelOrder(seq, p.sellOrderId); } catch { /* 이미 체결·소멸 */ } }
      const pm = await getPricesMap([code]);
      const px = Number(pm?.get?.(code)?.price ?? 0);
      if (!(px > 0)) { log(`청산 보류 ${code}: 현재가 조회 실패 — 다음 사이클 재시도`); continue; }
      // 재시도할수록 공격적으로 (−0.5% → −1.5% → −3% …). 크로싱 지정가라 유동성만 있으면 즉시 체결.
      const aggr = 0.995 - 0.01 * (p.sellTries ?? 0);
      const lpx = Math.max(1, Math.floor(px * Math.max(0.90, aggr)));
      const o = await createOrder(seq, { symbol: code, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(p.qty) });
      p.sellOrderId = o?.orderId ?? o?.id;
      p.sellTries = (p.sellTries ?? 0) + 1;
      log(`청산 주문 ${p.name}(${code}) ${p.qty}주 @${lpx.toLocaleString()} (${p.sellTries}회째, 주문 ${p.sellOrderId})`);
      // 체결 확인 — 보유수량이 실제로 0 이 되었는지로 판정(주문 상태보다 사실에 가깝다)
      let cleared = false;
      for (let k = 0; k < 10; k++) {
        await sleep(2000);
        const h = await getHoldings(seq).catch(() => null);
        const still = (h?.items ?? []).find(x => x.symbol === code && Number(x.quantity) > 0);
        if (!still) { cleared = true; break; }
      }
      if (cleared) { removeBotExclude(code); open.delete(code); log(`  청산 확인 ${p.name}(${code})`); }
      else log(`  ⚠️ 미체결 ${p.name}(${code}) — bot-exclude 유지, 다음 사이클 더 공격적으로 재시도`);
    } catch (e) { log(`청산 오류 ${code}: ${String(e.message).slice(0, 150)} — 보유 유지, 재시도`); }
  }

  if (t < WIN0 || t > WIN1) { await sleep(30_000); continue; }
  if (state.errs >= ERR_MAX) { log(`오류 ${state.errs}회 — 오늘 중단`); await sleep(60_000); continue; }
  /**
   * ★ 하드 가드 — `--to` 로 못 넘긴다. 진입 후 HOLD_MIN 뒤 청산이 **종가 단일가(15:20~15:30)** 에 걸리면
   *   크로싱 지정가가 의도대로 작동하지 않아 미체결 → 오버나이트가 된다. 무손절 구조라 그건 허용 못 한다.
   *   마지막 진입 = 15:15 − HOLD_MIN − 여유 5분. (예: hold 10분 → 15:00 이후 신규 진입 금지)
   */
  const lastEntry = 15 * 60 + 15 - HOLD_MIN - 5;                       // 분 단위
  const nowMin = Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
  if (nowMin > lastEntry) {
    if (!state.lateNoted) { log(`신규 진입 마감 (${String(Math.floor(lastEntry / 60)).padStart(2, '0')}${String(lastEntry % 60).padStart(2, '0')} 이후 금지 — 청산이 종가단일가에 걸리는 것 방지). 보유분 청산만 계속`); state.lateNoted = true; saveState(state); }
    // ※ 여기서 cur 을 건드리지 않는다 — cur 은 아래 스캔 블록에서 선언되므로 TDZ ReferenceError 가 난다.
    //   이 시점 이후로는 신규 진입이 없으므로 prevClose 가 낡아도 무해하다.
    await sleep(30_000); continue;
  }

  // ── 스캔: 5분 수익률 → 횡단면 잔차 ──────────────────────────
  const scanT0 = Date.now();
  let px;
  try { px = await getPricesMap(universe.map(u => u.code)); }
  catch (e) { log(`시세 조회 실패: ${String(e.message).slice(0, 100)}`); await sleep(30_000); continue; }
  const scanMs = Date.now() - scanT0;
  const cur = new Map();
  for (const u of universe) { const v = Number(px?.get?.(u.code)?.price ?? 0); if (v > 0) cur.set(u.code, v); }

  if (prevClose && cur.size >= 20) {
    const rets = [];
    for (const [c, v] of cur) { const p0 = prevClose.get(c); if (p0 > 0) rets.push([c, v / p0 - 1]); }
    const mkt = rets.reduce((a, [, r]) => a + r, 0) / Math.max(1, rets.length);
    // ★ 스캔은 **가장 느슨한 변형 임계**로 돈다. 변형별 취사선택은 판정 단계에서.
    const scanTh = Math.min(RESID * 100, SCAN_RESID) / 100;
    const cands = rets.map(([c, r]) => ({ code: c, resid: r - mkt })).filter(x => x.resid <= -scanTh).sort((a, b) => a.resid - b.resid);
    if (cands.length) log(`신호 ${cands.length}건 (시장 ${(mkt * 100).toFixed(2)}%, 스캔 ${(scanMs / 1000).toFixed(1)}s): ` +
      cands.slice(0, 3).map(x => `${universe.find(u => u.code === x.code)?.name ?? x.code} ${(x.resid * 100).toFixed(2)}%`).join(' · '));

    /**
     * ★ 개장 기준선 신호는 **버린다**(위 `prevCloseHm` 주석 참조 — 백테 미검증 유형, 재현 EV 음수).
     *   단 **계산은 끝까지 하고 로그로 남긴다**: 나중에 "버린 게 옳았나"를 이 로그만으로 검증할 수 있어야 한다.
     *   조용히 continue 하면 그 판단이 데이터로 남지 않는다.
     */
    if (isOpenBaseline(prevCloseHm)) {
      if (cands.length) log(`  ↳ [폐기] 위 ${cands.length}건은 기준선이 **시초가**(prev ${prevCloseHm})라 백테 미검증 유형 — 진입 안 함. ` +
        cands.slice(0, 5).map(x => `${universe.find(u => u.code === x.code)?.name ?? x.code} ${(x.resid * 100).toFixed(2)}%`).join(' · '));
      prevClose = cur; prevCloseHm = t;
      await sleep(Math.max(1_000, TF_MIN * 60_000 - (Date.now() - scanT0)));
      continue;
    }

    const held = new Set((await getHoldings(seq).catch(() => null))?.items?.map(i => i.symbol) ?? []);
    const botEx = readBotExclude();
    for (const cd of cands) {
      if (state.orders >= MAX_ORDERS || open.size >= MAX_CONCURRENT) break;
      if (held.has(cd.code) || botEx.has(cd.code) || LIVE_EXCLUDE.has(cd.code) || state.done.includes(cd.code) || open.has(cd.code)) continue;
      const u = universe.find(x => x.code === cd.code);
      const sigPx = cur.get(cd.code);
      const rec = { ts: ts(), day: today(), code: cd.code, name: u?.name, resid: +(cd.resid * 100).toFixed(3), mktRet: +(mkt * 100).toFixed(3), signalPx: sigPx, scanMs, dry: !GO };
      // ★ 호가창 스냅샷 — 주문 없이도 슬리피지를 추정한다(드라이런에서도 실행).
      try {
        const ob = await getOrderbook(cd.code);
        const asks = parseAsks(ob), bid = parseBestBid(ob);
        if (asks.length) {
          const small = simFill(asks, ORDER_KRW);
          const slot = simFill(asks, 3_000_000);          // 실제 운용 슬롯 크기(equity/5 근사)
          rec.ob = {
            bestAsk: asks[0].px, bestBid: bid,
            spreadPct: bid > 0 ? +((asks[0].px / bid - 1) * 100).toFixed(4) : null,
            depthKrw: +asks.reduce((a, l) => a + l.px * l.qty, 0).toFixed(0),
            estSmallPx: small.avgPx, estSmallSlipPct: small.avgPx ? +((small.avgPx / sigPx - 1) * 100).toFixed(4) : null,
            estSlotPx: slot.avgPx, estSlotSlipPct: slot.avgPx ? +((slot.avgPx / sigPx - 1) * 100).toFixed(4) : null,
            slotExhausted: slot.exhausted,
          };
          log(`  호가 ${u?.name}: 스프레드 ${rec.ob.spreadPct ?? '?'}% · 추정슬리피지 10만 ${rec.ob.estSmallSlipPct ?? '?'}% / 300만 ${rec.ob.estSlotSlipPct ?? '?'}%${slot.exhausted ? ' (호가소진)' : ''}`);
        } else if (!rec.obWarned) { log(`  호가 파싱 실패 ${cd.code} — 원본 키: ${Object.keys(ob ?? {}).slice(0, 8).join(',')}`); rec.obRaw = JSON.stringify(ob ?? {}).slice(0, 400); }
      } catch (e) { log(`  호가 조회 실패 ${cd.code}: ${String(e.message).slice(0, 100)}`); }
      if (SHADOW) {
        // 섀도우: 주문 없이 신호·호가만 남기고, 체결여부·성과는 나중에 분봉으로 확정한다.
        rec.passivePct = PASSIVE; rec.fillWin = FILLWIN; rec.holdMin = HOLD_MIN; rec.sigAtMs = Date.now();
        // 지정가가 매수1호가 안쪽인지(= 큐에 서야 하는지) 즉시 판정 — 호가창이 있을 때만 알 수 있는 정보
        if (rec.ob?.bestBid > 0) {
          const lim = sigPx * (1 - PASSIVE / 100);
          rec.limitPx = Math.round(lim);
          rec.limitVsBid = +((lim / rec.ob.bestBid - 1) * 100).toFixed(4);   // >0 이면 매수1호가 위 = 즉시 체결 가능성
        }
        pending.push(rec);
        log(`[섀도우] ${u?.name}(${cd.code}) 잔차 ${(cd.resid * 100).toFixed(2)}% · 현재가 ${sigPx.toLocaleString()}` +
          `${rec.ob?.spreadPct != null ? ` · 스프레드 ${rec.ob.spreadPct}%` : ''} — 변형 ${VARIANTS.length}종 동시, ${FILLWIN + 30}분 내 판정`);
        state.done.push(cd.code); state.orders++; saveState(state);
        continue;
      }
      try {
        const lpx = Math.ceil(sigPx * 1.005);          // 상향 크로싱 지정가 (라이브 봇 limitBuyPx 와 동일 관행)
        const qty = Math.floor(ORDER_KRW * 0.999 / lpx);
        if (qty < 1) { log(`스킵 ${cd.code}: 1주가(${lpx.toLocaleString()}) > 예산`); continue; }
        const bp = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
        if (lpx * qty > bp) { log(`현금 부족 (필요 ${(lpx * qty).toLocaleString()} > ${bp.toLocaleString()}) — 중단`); state.errs = ERR_MAX; break; }
        const ordT0 = Date.now();
        const o = await createOrder(seq, { symbol: cd.code, side: 'BUY', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const oid = o?.orderId ?? o?.id;
        addBotExclude(cd.code);                        // ★ 자동봇 격리
        // 체결 확인 (최대 30초)
        let fillPx = null, fillAt = null;
        for (let k = 0; k < 15; k++) {
          await sleep(2000);
          try {
            const st = await getOrder(seq, oid);
            const fq = Number(st?.filledQuantity ?? st?.executedQuantity ?? 0);
            if (fq > 0) { fillPx = Number(st?.averageFilledPrice ?? st?.avgPrice ?? lpx); fillAt = Date.now(); break; }
          } catch { /* */ }
        }
        const lat = Date.now() - ordT0;
        const f = fillPx ? await measureF(cd.code, fillPx, fillAt) : null;
        Object.assign(rec, { limitPx: lpx, qty, orderId: oid, fillPx, fillLatMs: lat, ...(f ?? {}) });
        appendFileSync(OUT, JSON.stringify(rec) + '\n');
        state.orders++; state.done.push(cd.code); saveState(state);
        if (fillPx) {
          open.set(cd.code, { qty, entryTs: Date.now(), orderId: oid, limitPx: lpx, signalPx: sigPx, name: u?.name });
          log(`매수 ${u?.name}(${cd.code}) ${qty}주 지정가 ${lpx.toLocaleString()} → 체결 ${fillPx.toLocaleString()} · ` +
            `**f=${f?.f != null ? f.f.toFixed(3) : '?'}** (봉 시가 ${f?.barOpen?.toLocaleString() ?? '?'} 폭 ${f?.rng?.toLocaleString() ?? '?'}) · 지연 ${(lat / 1000).toFixed(1)}s`);
        } else {
          log(`미체결 ${u?.name}(${cd.code}) — 30초 내 미체결, 기록만 남김`);
          removeBotExclude(cd.code);
        }
      } catch (e) {
        state.errs++; saveState(state);
        log(`매수 오류 ${cd.code} (${state.errs}/${ERR_MAX}): ${String(e.message).slice(0, 200)}`);
      }
    }
  }
  prevClose = cur; prevCloseHm = t;
  await sleep(TF_MIN * 60_000 - (Date.now() - scanT0));
}

/**
 * 종료 시 잔여 청산 — **오버나이트 금지**가 이 측정의 전제다(백테는 세션 내 청산).
 * 강도를 올려가며 최대 4회 시도하고, **보유수량 0 을 확인한 뒤에만** bot-exclude 를 푼다.
 * 끝내 미체결이면 bot-exclude 를 **유지**하고 크게 경보한다 — 자동봇에 넘기면 meta 없는 고아 보유가 된다.
 */
for (const [code, p] of open.entries()) {
  if (!GO) continue;
  let cleared = false;
  for (let tryN = 0; tryN < 4 && !cleared; tryN++) {
    try {
      if (p.sellOrderId) { try { await cancelOrder(seq, p.sellOrderId); } catch { /* */ } }
      const pm = await getPricesMap([code]);
      const px = Number(pm?.get?.(code)?.price ?? 0);
      if (!(px > 0)) { await sleep(3000); continue; }
      const lpx = Math.max(1, Math.floor(px * (0.99 - 0.01 * tryN)));   // −1% → −4% 크로싱
      const o = await createOrder(seq, { symbol: code, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(p.qty) });
      p.sellOrderId = o?.orderId ?? o?.id;
      log(`종료 청산 ${p.name}(${code}) ${p.qty}주 @${lpx.toLocaleString()} (${tryN + 1}/4)`);
      for (let k = 0; k < 8; k++) {
        await sleep(2500);
        const h = await getHoldings(seq).catch(() => null);
        if (!(h?.items ?? []).find(x => x.symbol === code && Number(x.quantity) > 0)) { cleared = true; break; }
      }
    } catch (e) { log(`종료 청산 오류 ${code} (${tryN + 1}/4): ${String(e.message).slice(0, 150)}`); }
  }
  if (cleared) { removeBotExclude(code); log(`  청산 확인 ${p.name}(${code})`); }
  else log(`🚨 청산 실패 ${p.name}(${code}) ${p.qty}주 — **오버나이트 보유 발생**. bot-exclude 유지(자동봇 미개입). 수동 처리 필요`);
}
if (SHADOW) await report30(true);   // 종료 시 최종보고
log(`종료 — 오늘 주문 ${state.orders}건 · 기록 ${OUT}`);
