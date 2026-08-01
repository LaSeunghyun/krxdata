#!/usr/bin/env node
/**
 * stock-live.mjs — 주식 실계좌 단일 연속 트레이더 (토스, 2026-07-20 사용자 지시).
 *   08:00~20:00(NXT 포함) 연속 감시, combo-v2 신호 진입, LIVE_SLOTS=5 분산(uni420, 2026-07-24 재조정)
 *   + 확신도 집중(강신호 시 현금 50%). 단일 프로세스라 이중주문 없음.
 *   ※ 기존 스케줄러 phase(PaperMorning/PaperClose)는 이중주문 방지 위해 비활성화해야 함.
 *
 *   진입: 레짐(005930 MA20/60) → UP:hi120/rsi2, NEUTRAL:hi120만(rsi2 스킵), DOWN:rsi2.
 *         시총상위·유동성 필터 → dd20·거부백오프 등 기계 필터 → ★AI 종합판단(ai-trader.mjs) 승인분만.
 *   AI 판단(2026-08-01): 매수승인(후보 부분집합) · 청산권고(→종가판정 예약) · 손절 1세션 유예.
 *         이벤트 기반 재판단(레짐전환·후보변화·손절선 임박). claude 는 flock 으로 telegram-agent 와 배타.
 *   청산(2026-07-29 종가판정 체계 · 장중 무개입): 15:35 종가판정 → 익일 집행.
 *         rsi2: 하드손절 -15% / MA3 회귀 익절 / 5거래일 만기. hi120: 부분익절 +6/+12%(갭정책 시 +10/+20)
 *         / 트레일 -6%(갭정책 시 -10%) / 60거래일 만기. + 수급붕괴 청산(하루 1회) + CA서킷.
 *   실행: node stock-live.mjs --plan   (미리보기, 주문 없음)
 *         node stock-live.mjs --go     (집행+연속감시, 백그라운드)
 */
import dotenv from 'dotenv';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAccounts, getHoldings, getBuyingPower, getPricesMap, getDailyCandles, createOrder, getOrder, cancelOrder } from './toss-api.js';
import { LIVE_SLOTS, LIVE_UNIVERSE_LIMIT, CONVICTION_SIZING, FORECAST_GUARD, PARTIAL_TP, CA_GUARD, LIVE_EXCLUDE, CAPITAL_DEPLOY, SECTOR_CAP, SECTOR_OVERRIDE, applySectorOverride, RSI_ENTRY_FILTER, FLOW_EXIT, AI_TRADER } from './strategy-contract.mjs';
import { buildLiveCandidates } from './live-parity.mjs';
import { readBotExclude } from './bot-exclude.mjs';
import { executeBuy, executeSell } from './tg-order.mjs';
import { consultTrader, clearRotate } from './ai-trader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const argv = process.argv.slice(2);
const POLL_MS = 30_000;
// ★ 2026-07-30 하드손절 7% → 15% (사용자 결정). 근거와 한계를 같이 남긴다.
//
//   발단: 실현 저널 21건 분석에서 손실 전액이 손절류였다 —
//     트레일손절 14건 0승 -60.8%p · 하드손절 1건 -13.6%p(선은 -7%인데 갭으로 2배 체결)
//     · 부분익절 5건 5승 +33.5%p. (트레일은 2026-07-29 배포로 이미 제거)
//
//   ★ 이 세션 전체 검증의 전제 결함을 먼저 발견했다: 모든 MC를 `--to 20260611` 로 돌렸는데
//     07-24 까지 늘리면 기준선이 무너진다 — CAGR 26.2%→17.3% · MDD 25.7%→**43.3%**.
//     즉 **현 국면의 실제 MDD 는 26% 가 아니라 43%** 이고, 손절은 폭락에서 작동하는 장치이므로
//     폭락이 없는 구간으로 손절 축을 검증한 것 자체가 무효였다.
//
//   폭락 포함 구간(~20260724) 단일경로:
//     stop 7%(현행) CAGR 17.3% · MDD 43.3%    ← 가장 나쁘다
//     stop 10%      CAGR 13.8% · MDD 45.4%
//     **stop 15%    CAGR 32.8% · MDD 29.3%**  ← 채택
//     손절 없음     CAGR 29.8% · MDD 33.0%    ← 완전 제거는 폭락에서 MDD가 더 나쁘다
//   즉 방향은 "7%는 너무 좁다"가 맞지만 최적점은 **없음이 아니라 넓음**이다.
//   rsi2 는 maxHoldR 5(5거래일 만기)가 노출을 이미 제한하므로 넓은 손절이 무한 위험이 아니다.
//
//   ※ 한계: 위 근거는 **단일경로**다. 30시드 MC(mc-stop-crash.mjs, 폭락 포함 구간)가 확정 근거이고
//     비단조성(7→10 악화→15 급개선→99 소폭악화)이 있어 경로 노이즈 가능성이 남아 있다.
const TRAIL_PCT = 6, HARD_STOP_PCT = 15;  // 고점 -6% 트레일(hi120 전용) / 진입 -15% 하드손절
const RSI_MAX = 10, MIN_TURNOVER = 3e9, MIN_PRICE = 2_000;
// rsi2 만기 (백테 combo-v2 maxHoldR과 동일). 종가판정에서 holdDays >= 이 값이면 청산 예약.
const MAX_HOLD_R = 5;
// hi120 만기 = 백테 combo-v2 maxHoldH. 60거래일이라 사실상 거의 안 걸리지만 검증값 그대로 둔다.
const MAX_HOLD_H = 60;
// ★ rsi2 익절 이동평균 일수 = 백테 combo-v2 `rsiMa: 3`. **MA3이지 MA5가 아니다.**
//   2026-07-29 최초 배포에서 MA5로 잘못 넣었다. 하락 계열에서 MA5는 오래된 고가를 물고 있어
//   현재가보다 12~14% 위에 떠 버리고 익절이 사실상 발동하지 않는다(실측: 5종목 전원).
//   10시드 MC(1승9패)·이웃값 검사는 전부 rsiMa=3으로 돌린 결과이므로 라이브도 3이어야 한다.
const RSI_MA_N = 3;
const RSI2_JUDGE_HHMM = 1535;   // 종가 판정 시각 — KRX 종가 동시호가(15:20~15:30) 종료 후
// 동일 종목 매수가 4xx로 연속 거부되면 당일 후보에서 제외 (07-28 프리마켓 31회 낭비 방지). 매도엔 미적용.
const ORDER_ERR_MAX = 3;
const STATE = join(__dirname, 'stock-live-state.json');
const JOURNAL = join(__dirname, 'stock-live-journal.json');
const LOG = join(__dirname, 'stock-live-log.txt');
const kst = () => new Date(Date.now() + 9 * 3_600_000);
const now = () => kst().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => { const l = `[${now()}] ${m}`; console.log(l); appendFileSync(LOG, l + '\n'); };
// 08:00~20:00 KST (NXT 프리·애프터 포함) · 평일만.
// ★ 2026-08-01 요일 가드 추가: 기존엔 시각만 봐서 **주말에도 메인루프·신호스캔이 12시간 돌았다.**
//   금요일 일봉으로 만든 rsi2 신호가 주말 내내 동일하게 살아 있어 매수 시도 → 토스 4xx 거부가 반복되고
//   (07-28 프리마켓 422 × 31회 전례), AI 판단까지 붙으면 비거래일에 claude 를 하루 24회 호출하고
//   원장에 거래 불가능한 판단이 섞여 사후측정이 오염된다.
//   ※ 공휴일은 여기서 못 잡는다 — AI 판단 쪽은 최신 일봉이 stale 하면 자연히 후보가 안 생기고,
//     주문은 거래소가 거부한다(orderErr 백오프가 당일 3회로 제한). 완전 차단은 캘린더 연동 필요.
const marketOpen = () => { const k = kst(); const d = k.getUTCDay(), h = k.getUTCHours(); return d >= 1 && d <= 5 && h >= 8 && h < 20; };
// KR 호가단위(2023 개편) — LIMIT 주문가는 틱에 맞아야 함
function tick(p) { if (p < 2_000) return 1; if (p < 5_000) return 5; if (p < 20_000) return 10; if (p < 50_000) return 50; if (p < 200_000) return 100; if (p < 500_000) return 500; return 1_000; }
const roundTick = (p) => Math.round(p / tick(p)) * tick(p);
// NXT 애프터마켓은 MARKET 거부 → LIMIT만. 스프레드 크로싱 지정가로 시장가처럼 즉시 체결 유도.
const limitBuyPx = (p) => { const t = tick(p); return Math.round((p * 1.005) / t) * t; };   // 현재가 +0.5% 올림틱 (매수 체결 유도)
const limitSellPx = (p) => { const t = tick(p); return Math.round((p * 0.995) / t) * t; };  // 현재가 -0.5% 내림틱 (매도 체결 유도)

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
function rsi2(c) { const i = c.length - 1; if (i < 2) return 50; let up = 0, dn = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; } return up + dn === 0 ? 50 : (up / (up + dn)) * 100; }

/**
 * ★ 2026-07-29 배포: 당일 시가 갭 조건부 청산폭 (사용자 제안 "장 30분 보고 전략 고르기")
 *
 * 갭 ↔ 30분수익률 상관 0.865(005930 1분봉 83일) → 갭이 30분의 대용. 일봉 시가로 868일 검증.
 * 정책: G1 갭하락(<-0.5%) · G2 보통 → trail 10%/tp1 +10%/tp2 +20%. G3 갭상승(>+0.5%) → 현행 유지.
 *
 * 검증 (사전 선언 기준 전부 통과 — 07-29 45+변종 중 유일):
 *   IS  MC Calmar 1.19→1.77(+49%) 시드 8승2패 · MDD 16.22→16.03
 *   OOS MC Calmar 2.87→4.67(+63%) 시드 9승1패 · MDD 18.43→17.48
 *   이웃값 trail8 실패(1.12) < trail10 최고 < trail12 통과(1.60) = 봉우리
 *   구조   G1만 적용 실패(6승4패/5승5패) → G1+G2 둘 다 필요
 *   워크포워드 9개 독립 창 6승2패1동 · CAGR 98.5→133.4% · MDD 동일
 *   경계민감도 ±0.2/0.3/0.5/0.8 **전부 OOS 통과**(Calmar 4.31~4.73·시드 9~10승) = 경계에 안 끼워졌다
 *
 * 왜 갭상승만 현행인가: 전역 trail10은 07-29 아침에 기각됐다(OOS MDD 14.7→34.3%). 그 낙폭의 출처가
 *   갭상승 날이었다(G3에서 IS -10,786 vs 기준 +2,152 — 이미 오른 걸 사니 되돌림을 다 맞는다).
 *   G1은 +16,692/+70,339, G2는 +11,170/+27,361. 전역 적용이 둘을 섞어 상쇄했고 조건부로 살아났다.
 *
 * ★ 적용 범위: **hi120 청산에만** 작용한다(rsi2는 하드손절·MA3·만기라 트레일이 없다).
 *   hi120 캡이 UP 6/NEUTRAL 0/DOWN 0이므로 **레짐 UP일 때만 효과**. 배포 시점 레짐 DOWN → 즉시 노출 0.
 * ★ 의미론: 진입 시점 갭으로 결정해 **포지션 메타에 고정 저장**한다. 장중 스위칭이 아니다(검증 런과 동일).
 *   meta 유실 시 `?? 전역값` 폴백으로 현행 동작에 안전하게 복귀한다.
 */
const GAP_BOUND = 0.5;
let gapCache = { day: null, params: null };
async function gapPolicyToday(today) {
  if (gapCache.day === today) return gapCache.params;
  const dflt = { trailPct: TRAIL_PCT, tp1Pct: PARTIAL_TP.tp1Pct, tp2Pct: PARTIAL_TP.tp2Pct, bin: null };
  try {
    const cd = (await getDailyCandles('005930', 3)).reverse();   // newest-first → reverse
    if (!Array.isArray(cd) || cd.length < 2) return dflt;
    const last = cd.at(-1), prev = cd.at(-2);
    // 당일 봉이 아니면 판단 불가 → 현행 폴백 (추측 금지)
    if (barDay(last.timestamp) !== today.replace(/-/g, '')) { gapCache = { day: today, params: dflt }; return dflt; }
    const g = (Number(last.open) / Number(prev.close) - 1) * 100;
    if (!Number.isFinite(g)) return dflt;
    const bin = g < -GAP_BOUND ? 'G1' : g < GAP_BOUND ? 'G2' : 'G3';
    const p = (bin === 'G3')
      ? { ...dflt, bin, gapPct: g }
      : { trailPct: 10, tp1Pct: 10, tp2Pct: 20, bin, gapPct: g };
    gapCache = { day: today, params: p };
    log(`갭정책 ${today} 시가갭 ${(g >= 0 ? '+' : '') + g.toFixed(2)}% → ${bin} · trail ${p.trailPct}% · tp ${p.tp1Pct}/${p.tp2Pct}%${bin === 'G3' ? ' (현행 유지)' : ' ★오버라이드'}`);
    return p;
  } catch (e) { log(`갭정책 조회 실패(현행 사용): ${String(e.message).slice(0, 60)}`); return dflt; }
}

async function regimeOf() {
  // 2026-07-23: HMA(30) 실험 롤백 — SMA20/60 복원. HMA는 slots=10 백테선 우위였으나 진짜 live 설정
  //   (slots=3·tp+4/8) MC 5시드 재검증서 SMA가 CAGR +2.9%p 우위(4/5)·MDD 동률 → HMA 검증 실패(설정 아티팩트).
  const cd = await getDailyCandles('005930', 70);
  if (!Array.isArray(cd) || cd.length < 61) return 'NEUTRAL'; // ★ 캔들 부족 시 안전 가드
  const c = cd.reverse().map(b => b.close); // ★버그수정 2026-07-22: getDailyCandles는 newest-first → reverse 필수. 안 하면 ~70일 전(4월) 데이터로 레짐 계산했음(pickCandidate는 이미 reverse). 레짐게이트·skipNeutral 전부 영향.
  const i = c.length - 1; const avg = (n) => c.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  const ma20 = avg(20), ma60 = avg(60), ret5 = (c[i] / c[i - 5] - 1) * 100;
  if (c[i] > ma20 && ma20 > ma60) return 'UP';
  if (c[i] < ma20 && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}

// combo-v2 진입 후보: 레짐별 rsi2 과매도(전 레짐) + hi120 신고가돌파(UP만). cashCeil로 살 수 있는 것만.
// 각 후보에 conviction(0~10) 부여 → 확신도 내림차순 반환(사이징은 호출부에서).
const SCAN_CONCURRENCY = 15; // 2026-07-26 최적화: 동시배치 15개로 스캔 속도 향상
async function pickCandidate(cashCeil, heldSet = new Set()) {
  const regime = await regimeOf();
  const rows = await dbQuery(`SELECT stock_code,corp_name,current_price,sector FROM stock_analysis WHERE current_price>=${MIN_PRICE} AND current_price<${Math.floor(cashCeil)} AND avg_turnover_20d>=${MIN_TURNOVER} ORDER BY market_cap_tril DESC LIMIT ${LIVE_UNIVERSE_LIMIT}`);
  const dynExclude = readBotExclude(); // 텔레그램 수동매수 종목 = 봇 재매수 금지
  const targets = rows.filter(r => !heldSet.has(r.stock_code) && !LIVE_EXCLUDE.has(r.stock_code) && !dynExclude.has(r.stock_code)); // 보유·제외·수동관리 스킵
  const signals = [];
  for (let i = 0; i < targets.length; i += SCAN_CONCURRENCY) {
    const batch = targets.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(async (r) => {
      try {
        const cd = (await getDailyCandles(r.stock_code, 122)).reverse(); // 122일로 최적화하여 패치 지연 최소화
        if (!Array.isArray(cd) || cd.length < 61) return null;
        const cl = cd.map(b => b.close), px = cl[cl.length - 1];
        if (px >= cashCeil) return null;
        const rv = rsi2(cl);
        // ★ 2026-07-30: 20일 점대점 낙폭 하한(RSI_ENTRY_FILTER.maxDd20). -50% 초과는 종목-일 표에서
        //   유일한 음수 버킷이고 시총 상위(=이 봇의 모집단)에서 가장 나쁘다. 근거·한계는 strategy-contract 주석.
        //   ※ 아래 dd20 은 rsi2 후보에만 쓴다(hi120 은 신고가 돌파라 애초에 해당 없음).
        const dd20 = cl.length > 20 ? (px / cl[cl.length - 21] - 1) * 100 : 0;
        const dd20Block = RSI_ENTRY_FILTER.maxDd20 > 0 && dd20 < -RSI_ENTRY_FILTER.maxDd20;
        // 투매 확인용 거래량비: 당일 / 최근20일 평균
        const vols = cd.map(b => Number(b.volume) || 0);
        const prev20 = vols.slice(-21, -1); const avgVol = prev20.length ? prev20.reduce((a, b) => a + b, 0) / prev20.length : 0;
        const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 1;
        let brk = 0;
        if (regime === 'UP') {
          let hh = 0; const startJ = Math.max(0, cl.length - 121); for (let j = startJ; j < cl.length - 1; j++) hh = Math.max(hh, cd[j]?.high ?? 0);
          brk = hh > 0 ? (px / hh - 1) * 100 : 0;
        }
        return { code: r.stock_code, name: r.corp_name, px, rsi: rv, rsi2: rv, breakoutPct: brk, breakout: brk, sector: r.sector, volRatio, dd20, dd20Block };
      } catch { return null; } // skip
    }));
    for (const s of results) if (s) signals.push(s);
  }
  // 캠페인 승자: rsi2 매수 시 투매 거래량 확인(rsiVolMin) + NEUTRAL 레짐 rsi2 스킵
  let cands = buildLiveCandidates(signals, { regime, rsiMax: RSI_MAX, minBreakout: 3, rsiVolMin: RSI_ENTRY_FILTER.volMin });
  if (RSI_ENTRY_FILTER.skipNeutral && regime === 'NEUTRAL') cands = cands.filter(c => c.sub !== 'rsi2');
  // ★ 2026-07-30: 20일낙폭 -50% 초과 rsi2 후보 배제. 차단 건은 1회 로그로 남긴다 —
  //   "발동한 적 없다"를 나중에 데이터로 확인할 수 있어야 한다(구 --rsimaxdd20 40 이 그걸 못 해서 미규명으로 남았다).
  {
    const blocked = cands.filter(c => c.sub === 'rsi2' && c.dd20Block);
    if (blocked.length) log(`낙폭배제 ${blocked.length}종목 (20일 -${RSI_ENTRY_FILTER.maxDd20}% 초과): ${blocked.slice(0, 5).map(c => `${c.name} ${c.dd20.toFixed(1)}%`).join(' · ')}`);
    cands = cands.filter(c => !(c.sub === 'rsi2' && c.dd20Block));
  }
  const rsiCount = cands.filter(c => c.sub === 'rsi2').length;
  const hiCount = cands.filter(c => c.sub === 'hi120').length;
  return { regime, cands, pick: cands[0] ?? null, rsiCount, hiCount };
}

// 시작 계좌 조회: 네트워크 블립("fetch failed")에 즉사하지 않도록 재시도(최대 10회, 지수백오프).
// keeper 5분 thrash 방지 + 시작 직후 포지션 무감시 구간 최소화.
async function getAccountsResilient() {
  for (let i = 0; i < 10; i++) {
    try { return await getAccounts(); }
    catch (e) {
      const wait = Math.min(30_000, 3_000 * (i + 1));
      log(`시작 계좌 조회 실패(${i + 1}/10, ${wait / 1000}s 후 재시도): ${String(e.message).slice(0, 60)}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return null;
}
const accounts = await getAccountsResilient();
const seq = accounts?.[0]?.accountSeq;
if (seq == null) { log('토스 계좌 조회 실패(10회 소진) — 중단, keeper 재기동 대기'); process.exit(1); }

// code→sector 맵 (1회 로드, Supabase stock_analysis). 실패 시 빈 맵 = 캡 무효화(안전 기본).
// ★ 2026-08-01: SECTOR_CAP.enabled 조건을 뺐다. AI 판단이 "보유와 같은 섹터 과집중"을 근거로
//   쓰는데 SECTOR_CAP 이 false 라 맵이 {} 였고, 그러면 AI 가 보유 섹터를 **종목명으로 추정**해야 했다.
//   SECTOR_OVERRIDE 가 문서화한 함정이 바로 그것이다(SK스퀘어는 DB조차 '금융'이지만 실제 반도체 프록시).
//   섹터캡이 꺼져 있으므로 현재 유일한 섹터 방어선이 AI 판단이다 → 정확한 라벨을 반드시 줘야 한다.
let SECTOR = {};
{
  try {
    // ★ 2026-07-30: stock_analysis.sector 가 SK스퀘어→금융·LG전자→반도체 등으로 틀려 있어
    //   보정 맵을 덮어쓴다(도출 근거는 strategy-contract.mjs SECTOR_OVERRIDE 주석 = 잔차상관 실측).
    SECTOR = applySectorOverride(Object.fromEntries((await dbQuery(`SELECT stock_code, sector FROM stock_analysis`)).map(r => [r.stock_code, r.sector])));
    const ov = Object.entries(SECTOR_OVERRIDE).filter(([c]) => SECTOR[c]);
    log(`섹터맵 로드 ${Object.keys(SECTOR).length}종목 (섹터캡 ${SECTOR_CAP.enabled ? `max ${SECTOR_CAP.max}` : 'off — AI 판단용'}) · 보정 ${ov.length}종목 적용`);
    log(`  반도체복합: ${Object.entries(SECTOR).filter(([, s]) => s === '반도체복합').map(([c]) => c).join(' ')}`);
  } catch (e) { log(`섹터맵 로드 실패: ${String(e.message).slice(0, 60)}`); }
}

// ── PLAN: 미리보기 ────────────────────────────────────────────
if (argv.includes('--plan')) {
  const cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
  const { regime, cands, rsiCount, hiCount } = await pickCandidate(cash);
  console.log(`\n=== 주식 실계좌 매수 플랜 (미리보기) ===`);
  console.log(`현금 ${cash.toLocaleString()}원 | 레짐 ${regime} | rsi2후보 ${rsiCount} / hi120후보 ${hiCount} | 슬롯 ${LIVE_SLOTS} | 몰빵임계 ${CONVICTION_SIZING.strongThreshold}(현금×${CONVICTION_SIZING.strongFraction})`);
  const diversified = Math.floor(cash / LIVE_SLOTS);
  // 확신도순으로 훑어 예산에 맞는(살 수 있는) 후보만 최대 슬롯수만큼 표시 = 라이브 진입순서
  let shownN = 0; const secSeen = {};
  for (const p of (cands ?? [])) {
    if (shownN >= LIVE_SLOTS) break;
    // 섹터 캡 미리보기 반영: 같은 섹터 max개 넘으면 표시 스킵 (라이브 진입과 일치)
    if (SECTOR_CAP.enabled && p.sector && (secSeen[p.sector] ?? 0) >= SECTOR_CAP.max) continue;
    const strong = CONVICTION_SIZING.enabled && p.conviction >= CONVICTION_SIZING.strongThreshold;
    const minRemainForSlots = MIN_PRICE * 2 * (LIVE_SLOTS - 1);
    const strongBudgetCap = Math.max(MIN_PRICE, cash - minRemainForSlots);
    const budget = strong ? Math.min(Math.floor(cash * CONVICTION_SIZING.strongFraction), strongBudgetCap) : diversified;
    if (p.px >= budget) continue;
    const qty = Math.floor(budget * 0.999 / limitBuyPx(p.px));
    if (qty < 1) continue;
    if (SECTOR_CAP.enabled && p.sector) secSeen[p.sector] = (secSeen[p.sector] ?? 0) + 1;
    console.log(`→ ${strong ? '[집중몰빵]' : '[분산]'} ${p.name}(${p.code}) ${p.px.toLocaleString()}원 × ${qty}주 (예산 ${budget.toLocaleString()}) [${p.sub}, ${p.sector ?? '섹터?'}, 확신도 ${p.conviction.toFixed(1)}${p.rsi2 != null ? ', RSI2 ' + p.rsi2.toFixed(1) : ', 돌파 ' + p.breakout?.toFixed(1) + '%'}]`);
    shownN++;
  }
  if (!shownN) console.log(`→ 매수 대상 없음 (예산 내 신호 종목 없음 — 현금 대기)`);
  console.log(`※ 미리보기는 각 후보에 전액현금 기준 사이징 표시(실제론 매 사이클 잔여현금 재계산)`);
  console.log(`청산 규칙: 고점대비 -${TRAIL_PCT}% 트레일 / 진입대비 -${HARD_STOP_PCT}% 하드손절 / DOWN레짐 이탈`);
  process.exit(0);
}
if (!argv.includes('--go')) { console.log('사용법: --plan 또는 --go'); process.exit(1); }

// ── 상태 ─────────────────────────────────────────────────────
let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { meta: {}, ipAlerted: false };
const loadJournal = () => { try { return JSON.parse(readFileSync(JOURNAL, 'utf8')); } catch { return { trades: [] }; } };
function recordTrade(t) { const j = loadJournal(); j.trades.push(t); writeFileSync(JOURNAL, JSON.stringify(j, null, 1)); }
// AI게이트 컨텍스트용: 최근 실현 매도 n건 (연패 흐름을 판단 근거로 제공)
function recentSells(n = 5) {
  try { return loadJournal().trades.filter(t => t.side === 'SELL').slice(-n).map(t => ({ name: t.name, ret: t.ret, reason: t.reason, ts: t.ts })); } catch { return []; }
}

// 체결 확인: 주문상태 필드명 불확실 → 보유수량 변화로 검증(견고). 미체결이면 주문 취소해 스테일 방지.
/**
 * 체결 확인 + **실제 체결가 산출** (2026-07-29 결함 수정).
 *
 * 기존 결함: 저널이 `px: lpx`로 **지정가를 거래가로 기록**했다. 크로싱 지정가는 상한선일 뿐이고
 *   실제 체결은 최우선 호가에서 일어난다. 실측(보유 5종목): 실제 진입가가 지정가보다 **0.47~0.56% 낮다.**
 *   그 결과 매수는 손실 과대, 매도는 이익 과소로 기록돼 **봇의 자체 손익 보고 전체가 편향**됐다
 *   (오늘 보고한 "청산 15건 -32.6%p"도 실제보다 나쁜 값).
 *
 * 산출법: BUY는 보유 평균단가 변화에서 정확히 역산한다.
 *   fillPx = (avgAfter×qtyAfter − avgBefore×qtyBefore) / (qtyAfter − qtyBefore)
 *   SELL은 평균단가가 안 바뀌어 역산이 불가 → getOrder로 시도하고, 필드명이 불확실하므로
 *   처음 1회 응답 키를 로그에 남겨 실측으로 확정한다(추측한 필드명으로 조용히 틀리는 것 방지).
 *
 * 반환: { ok, fillPx } — fillPx가 null이면 호출자가 지정가로 폴백(기존 동작 유지).
 */
let orderKeysLogged = false;
async function settleOrder(orderId, symbol, side, qtyBefore, tag, avgBefore = 0) {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const h = await getHoldings(seq);
      const it = (h?.items ?? []).find(x => x.symbol === symbol);
      const cur = Number(it?.quantity ?? 0);
      if (side === 'BUY' && cur > qtyBefore) {
        const avgAfter = Number(it?.averagePurchasePrice ?? 0);
        let fillPx = null;
        if (avgAfter > 0 && cur > qtyBefore) {
          const v = (avgAfter * cur - avgBefore * qtyBefore) / (cur - qtyBefore);
          if (v > 0) fillPx = Math.round(v);
        }
        return { ok: true, fillPx };
      }
      if (side === 'SELL' && cur < qtyBefore) {
        let fillPx = null;
        try {
          const od = await getOrder(seq, orderId);
          if (!orderKeysLogged && od) { orderKeysLogged = true; log(`  [getOrder 필드 확인] ${JSON.stringify(od).slice(0, 300)}`); }
          for (const k of ['executedPrice', 'avgExecutedPrice', 'filledPrice', 'averagePrice', 'execPrice']) {
            const v = Number(od?.[k]);
            if (v > 0) { fillPx = Math.round(v); break; }
          }
        } catch {}
        return { ok: true, fillPx };
      }
    } catch {}
  }
  try { await cancelOrder(seq, orderId); log(`  ${tag} 미체결 → 주문취소(스테일 방지)`); } catch {}
  return { ok: false, fillPx: null };
}

// 수급붕괴 판정 (FLOW_EXIT). stock_investor_flows에서 종목별 최근 N거래일 누적 순매수 조회 → ≤ threshold면 청산대상.
//   하루 1회만 조회(수급은 장마감 후 확정). 조회 실패 시 빈 Set = 청산 안 함(안전 기본).
//   ★데이터가 N일 미확보인 종목은 제외(HAVING COUNT) — 백테의 "데이터 부족 시 룰 미적용"과 동일.
let flowCache = { day: null, breaking: new Set() };
async function flowBreaking(codes, today) {
  if (!codes.length) return new Set();
  if (flowCache.day === today) return flowCache.breaking;
  try {
    const rows = await dbQuery(`SELECT stock_code, SUM(net) AS total FROM (
        SELECT stock_code, (COALESCE(orgn_amt_mil,0) + COALESCE(frgn_amt_mil,0)) AS net,
               ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
        FROM stock_investor_flows WHERE stock_code IN (${codes.map(c => `'${c}'`).join(',')})
      ) t WHERE rn <= ${FLOW_EXIT.days}
      GROUP BY stock_code HAVING COUNT(*) >= ${FLOW_EXIT.days}`);
    const brk = new Set();
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (Number(r.total) / 100 <= FLOW_EXIT.threshold) brk.add(r.stock_code); // 백만원→억
    }
    flowCache = { day: today, breaking: brk };
    if (brk.size) log(`수급붕괴 감지 ${brk.size}종목: ${[...brk].join(',')}`);
    return brk;
  } catch (e) {
    log(`수급조회 실패(청산 보류): ${String(e.message).slice(0, 70)}`);
    return new Set();
  }
}

// 최신 KOSPI 프록시 시장 예측 (forecast_ledger). 실패/부재 시 null = 경보 없음(안전 기본).
// 스윙 보유(수일)엔 일간 예측(session=KRX_REGULAR, hm NULL)이 맞는 지평 → 일간 우선, 없으면 최신 아무거나.
async function marketForecast() {
  try {
    // ★ 2026-08-01: drivers(예측 근거 서술, jsonb) 추가 — AI게이트 프롬프트에 "오늘 아침 시장 이슈"
    //   컨텍스트로 전달된다(사용자 요청: 매일 아침 이슈 확인 후 전략 수립). 08:35 예측 런이 원천.
    const rows = await dbQuery(`SELECT call_direction, probability_up, probability_down, confidence, forecast_median, forecast_created_at, session, drivers
      FROM forecast_ledger WHERE target_kind='market' AND sector='KOSPI_PROXY'
      ORDER BY (session='KRX_REGULAR') DESC, forecast_created_at DESC LIMIT 1`);
    if (!Array.isArray(rows) || !rows.length) return null;
    const r = rows[0];
    return { dir: r.call_direction, up: Number(r.probability_up), down: Number(r.probability_down),
             conf: Number(r.confidence), median: Number(r.forecast_median), at: r.forecast_created_at, session: r.session,
             drivers: r.drivers ?? null };
  } catch { return null; }
}

/**
 * ★ 2026-08-01: 아침 시장 브리핑 (사용자 요청 — "매일 아침 전날 미국장의 이슈와 사회적인 이슈들을
 *   확인하여 전략을 수립한다"). 07:00 forecast-run pre 페이즈가 웹검색으로 합성한 보고서 본문이다.
 *   forecast_ledger.drivers 는 순수 통계(EWMA 변동성·평균)라 이 용도로 쓸 수 없다 — 실측 확인함.
 *   하루 1회만 조회하고 프롬프트 크기를 위해 앞부분만 쓴다. 없으면 null(브리핑 없이 판단).
 */
let briefCache = { day: null, text: null };
async function morningBrief(today) {
  if (briefCache.day === today) return briefCache.text;
  let text = null;
  try {
    const rows = await dbQuery(`SELECT data->>'text' AS t, data->>'hm' AS hm FROM paper_state
      WHERE k IN ('fc_report:pre:${today}', 'fc_report:close:${today}') ORDER BY k = 'fc_report:pre:${today}' DESC LIMIT 1`);
    const t = Array.isArray(rows) && rows[0]?.t ? String(rows[0].t) : null;
    if (t) { text = t.slice(0, 3000); log(`아침 브리핑 로드 (${rows[0].hm ?? '?'}, ${t.length}자 → ${text.length}자 사용)`); }
    else logGate('아침 브리핑 없음 — 예측 보고서 미저장(07:00 크론 확인)', 'brief|none');
  } catch (e) { log(`아침 브리핑 조회 실패: ${String(e.message).slice(0, 60)}`); }
  briefCache = { day: today, text };
  return text;
}
// 하락경보: call_direction=='down' 이거나 (하락확률−상승확률 ≥ probDiff AND confidence ≥ minConf)
function isBearish(f) {
  if (!f) return false;
  return f.dir === 'down' || (f.down - f.up >= FORECAST_GUARD.probDiff && f.conf >= FORECAST_GUARD.minConf);
}
// 텔레그램 경보 (CA서킷·매도사인·주문큐 결과 등). 실패해도 매매 무영향 — 단, 실패는 로그로 남긴다.
// ★ 2026-08-01: fetch → curl 전환. 이 VM에서 Node fetch는 api.telegram.org에 도달하지 못한다
//   (149.154.166.110:443 ETIMEDOUT 3/3 · curl은 같은 IP에 0.27s 성공 — watchdog·telegram-agent와 동일 실측).
//   즉 이 파일의 기존 알림(CA경보·매도사인·주문큐 결과)은 배포 이후 전부 조용히 유실되고 있었다.
//   기존 tgNotify/tgSend 두 함수가 동일 동작 중복이라 하나로 합친다. `catch {}` 침묵 금지(watchdog 96분 무경보의 원인).
const execFileP = promisify(execFile);
let tgFailStreak = 0;
async function tgNotify(text) {
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) return;
  try {
    const t = String(text ?? '');
    for (let i = 0; i < t.length; i += 3800) {
      const { stdout } = await execFileP('curl', [
        '-4', '-s', '-m', '20', '-X', 'POST', '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ chat_id: C, text: t.slice(i, i + 3800) }),
        `https://api.telegram.org/bot${T}/sendMessage`,
      ], { timeout: 25_000 });
      const j = JSON.parse(stdout);
      if (!j.ok) throw new Error(String(stdout).slice(0, 120));
    }
    if (tgFailStreak >= 3) log(`텔레그램 발신 복구(연속실패 ${tgFailStreak}건 후)`);
    tgFailStreak = 0;
  } catch (e) {
    tgFailStreak++;
    if (tgFailStreak <= 3 || tgFailStreak % 20 === 0) log(`텔레그램 발신 실패(${tgFailStreak}연속): ${String(e.message).slice(0, 100)}`);
  }
}

log(`=== 주식 연속 트레이더 시작 (계좌 ${accounts[0].accountSeq}, 08:00~20:00, LIVE_SLOTS=${LIVE_SLOTS}, 트레일-${TRAIL_PCT}%/하드-${HARD_STOP_PCT}%, 예측가드 ${FORECAST_GUARD.enabled ? (FORECAST_GUARD.shadow ? 'SHADOW' : 'LIVE') : 'off'}) ===`);
let lastSignal = 0, signalCache = null;
let scanCash = 0, scanHeld = new Set();
// 상태 로그 스로틀: key가 바뀌거나 10분 경과 시에만 1줄 (매 사이클 도배 방지)
let gateKey = '', gateAt = 0;
function logGate(msg, key) {
  if (key === gateKey && Date.now() - gateAt < 600_000) return;
  gateKey = key; gateAt = Date.now(); log(msg);
}
// 신호스캔 독립 루프 (2026-07-24: uni420 확장 후 Toss 레이트리밋(10TPS, rateSlot)상 스캔 자체가 45초~2분 걸려
//   메인루프(30초 매도/손절 체크) 안에서 실행하면 그 체크까지 같이 지연됨 → 완전 분리, 메인루프는 항상 30초 유지.
//   scanCash/scanHeld는 메인루프가 매 사이클 최신값으로 갱신(아래), 매수 실행은 여전히 메인루프 for-loop에서
//   현재(fresh) heldSet으로 재검증하므로 이 캐시가 한 스캔주기만큼 낡아도 중복매수 위험 없음.
/**
 * 일봉 timestamp → KST YYYYMMDD.
 * Toss가 어떤 포맷을 주는지 미확인(확인엔 봇 정지 필요)이라 알려진 4가지를 모두 안전하게 처리한다.
 * 특히 **타임존 없는 ISO**("2026-07-29T15:30:00")를 그냥 new Date()에 넣으면 VM이 UTC라 날짜가 밀린다 → KST로 간주.
 */
function barDay(ts) {
  if (typeof ts === 'string') {
    const ymd = ts.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    if (ymd && !/[TZ+]/.test(ts.slice(10))) return ymd[1] + ymd[2] + ymd[3];   // 날짜만 → 그대로
    const s = /[Z+]|-\d{2}:\d{2}$/.test(ts.slice(10)) ? ts : ts + '+09:00';     // 타임존 없으면 KST로 간주
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date((n < 1e12 ? n * 1000 : n) + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * ★ rsi2 종가 판정 (2026-07-29 신규) — 하루 1회, 15:35 이후.
 *   검증된 combo-v2 rsi2 청산을 라이브에 이식한다: 트레일 없음 · 종가 > MA5 익절 · 진입-7% 손절 · 5거래일 만기.
 *   판정만 하고 집행은 익일(예약). 같은 날 집행되지 않도록 exitDay를 같이 박는다.
 *
 * 설계 요점
 *  - **당일 종가**: Toss 일봉의 최신 봉 날짜가 오늘이면 그 종가(권위 있음), 아니면 현재가로 대체한다.
 *    15:35엔 KRX가 이미 마감(15:30)이라 현재가 ≈ 당일 종가다. 어느 쪽을 썼는지 로그에 남겨
 *    "Toss가 15:35에 당일봉을 주는가"라는 미검증 가정을 하루만 돌려 실측으로 바꾼다.
 *  - **holdDays를 카운터로 세지 않는다**: 진입일 이후의 일봉 개수로 계산한다. 휴장일 오판이 없고,
 *    구 규칙으로 산 기존 보유분도 마이그레이션 없이 정확한 값이 나온다(무상태·자기정정).
 */
async function judgeExitsAtClose(items, state, today) {
  for (const it of items) {
    const m = state.meta[it.symbol];
    if (!m || m.exitAt) continue;
    if (m.sub !== 'rsi2' && m.sub !== 'hi120') continue;
    if (m.judgedDay === today) continue;                       // 하루 1회
    let cd;
    try { cd = (await getDailyCandles(it.symbol, 12)).reverse(); } catch (e) { log(`종가판정 일봉조회 실패 ${it.symbol}: ${String(e.message).slice(0, 60)}`); continue; }
    if (!Array.isArray(cd) || cd.length < 5) continue;

    const newest = cd[cd.length - 1];
    const newestDay = barDay(newest.timestamp);
    const hasToday = newestDay === today.replace(/-/g, '');
    // 첫 판정 1회만 원본 timestamp를 남긴다 — barDay 파싱이 맞는지 실측으로 확인하기 위한 것
    if (!state.tsFmtLogged) { state.tsFmtLogged = true; log(`[일봉 timestamp 포맷 확인] raw=${JSON.stringify(newest.timestamp)} → barDay=${newestDay} (오늘=${today.replace(/-/g, '')})`); }
    const livePx = Number(it.lastPrice);
    const closeToday = hasToday ? Number(newest.close) : livePx;
    if (!(closeToday > 0)) continue;
    // MA(RSI_MA_N) = 당일 종가 + 직전 (N-1)일 종가. hasToday면 최신봉이 당일이므로 그 앞을 쓴다.
    const prior = (hasToday ? cd.slice(0, -1) : cd).map(b => Number(b.close)).filter(v => v > 0);
    if (prior.length < RSI_MA_N - 1) continue;
    const ma = (closeToday + prior.slice(-(RSI_MA_N - 1)).reduce((a, b) => a + b, 0)) / RSI_MA_N;

    const entry = Number(m.entry ?? it.averagePurchasePrice);
    const bDay = String(m.boughtAt ?? '').slice(0, 10).replace(/-/g, '');
    const holdDays = bDay ? cd.filter(b => barDay(b.timestamp) > bDay).length : 0;
    m.judgedDay = today; m.holdDays = holdDays;

    const ret = (closeToday / entry - 1) * 100;
    let why = null, frac = 1, extra = '';
    if (m.sub === 'rsi2') {
      // 검증된 rsi2 청산: 하드손절 / MA(rsiMa=3) 회귀 익절 / maxHoldR 만기
      //
      // ★ 2026-08-01 손절 1세션 유예 (사용자 요청 "폭락 과매도 구간이면 손절하지 않는다").
      //   ⚠️ 손절 15%는 60시드 MC 55승5패로 채택된 값이고 "손절 없음"은 폭락구간에서 더 나빴다
      //   (MDD 33.0% vs 29.3%). 그래서 무기한이 아니다 — 1세션 + 포지션당 상한 + 절대하한.
      //
      // ★ 리뷰 확정 결함 2건을 여기서 고쳤다:
      //   ① **하한을 소비 시점에 재확인한다.** 심을 때는 장중가(-13%)였는데 종가가 -27%까지
      //      빠질 수 있다. 재확인 없으면 "deferFloorPct 아래는 유예 불가"라는 불변식이 실제로 깨진다.
      //   ② **유예가 만기 청산까지 삼키지 않게** 분기를 분리했다. 기존 else-if 체인에서는 손절 분기에
      //      들어가 유예로 빠지면 그 아래 `holdDays >= MAX_HOLD_R` 판정에 도달하지 못해
      //      5거래일 만기가 무기한 연장됐다. 유예는 **손절만** 미루는 것이다.
      const stopHit = closeToday <= entry * (1 - HARD_STOP_PCT / 100);
      let deferred = false;
      if (stopHit && m.stopDefer === today && m.stopDeferDay !== today) {
        if (ret <= -AI_TRADER.deferFloorPct) {
          // 하한 미달 → 유예 거부. 원장·경보에서 "요청됐으나 하한으로 집행"을 구분할 수 있게 남긴다.
          delete m.stopDefer;
          log(`손절유예 거부 ${it.name}(${it.symbol}) 종가 ${ret.toFixed(1)}% ≤ 하한 -${AI_TRADER.deferFloorPct}% → 손절 집행`);
          tgNotify(`🛑 손절유예 거부: ${it.name} ${ret.toFixed(1)}%\n하한 -${AI_TRADER.deferFloorPct}% 아래라 유예 불가 — 손절을 집행합니다.`);
        } else {
          deferred = true;
          m.stopDeferDay = today; m.deferCount = Number(m.deferCount ?? 0) + 1; delete m.stopDefer;
          log(`손절유예 ${it.name}(${it.symbol}) ${ret.toFixed(1)}% — AI 판단(1세션, 포지션 ${m.deferCount}/${AI_TRADER.deferMaxPerPosition}회). 다음 판정일 재검토`);
          tgNotify(`⏸️ 손절 1세션 유예: ${it.name} ${ret.toFixed(1)}%\n사유: ${m.stopDeferWhy ?? 'AI 판단'}\n※ 다음 거래일 종가판정에서 재검토. 포지션 유예 ${m.deferCount}/${AI_TRADER.deferMaxPerPosition}회 사용.`);
        }
      }
      if (stopHit && !deferred) why = `손절 -${HARD_STOP_PCT}%${m.deferCount ? ` (유예 ${m.deferCount}회 후 집행)` : ''}`;
      else if (!why && closeToday > ma) why = `MA${RSI_MA_N}회귀 익절`;
      // ★ 만기는 유예 대상이 아니다 — deferred 여도 판정한다.
      if (!why && holdDays >= MAX_HOLD_R) why = `만기 ${MAX_HOLD_R}거래일${deferred ? '(손절유예 중이나 만기는 집행)' : ''}`;
      extra = ` / MA${RSI_MA_N} ${Math.round(ma).toLocaleString()}${deferred ? ' / 손절유예중' : ''}`;
    } else {
      // ★ 2026-07-29 hi120도 종가판정으로 이관. 백테 combo-v2는 intradayExit 키가 없어
      //   **hi120 트레일·부분익절도 종가판정 → 익일 시가 집행**이다(771행 exitAtOpen).
      //   라이브만 30초 실시간이었다 = rsi2에서 제거한 것과 동일한 미검증 괴리.
      //   우선순위는 백테와 같게: 부분익절 → 트레일 → 만기. (수급붕괴는 별도 경로에서 이미 하루 1회)
      //   hi120엔 백테상 하드손절이 없다(트레일이 진입 -TRAIL%에서 시작해 먼저 걸린다) → 넣지 않는다.
      const hiD = Math.max(Number(m.hi ?? closeToday), closeToday);
      m.hi = hiD;
      // ★ 갭정책: 진입 시점에 고정 저장된 값을 쓴다. 없으면 전역값 폴백(현행 동작).
      const tp1P = m.tp1Pct ?? PARTIAL_TP.tp1Pct, tp2P = m.tp2Pct ?? PARTIAL_TP.tp2Pct, trP = m.trailPct ?? TRAIL_PCT;
      if (PARTIAL_TP.enabled && !m.tp1 && ret >= tp1P) { why = `부분익절 tp1 +${tp1P}%`; frac = 0.5; }
      else if (PARTIAL_TP.enabled && m.tp1 && !m.tp2 && ret >= tp2P) { why = `부분익절 tp2 +${tp2P}%`; frac = 0.5; }
      else if (closeToday <= hiD * (1 - trP / 100)) why = `트레일 -${trP}%(고점 ${Math.round(hiD).toLocaleString()})`;
      else if (holdDays >= MAX_HOLD_H) why = `만기 ${MAX_HOLD_H}거래일`;
      extra = ` / 고점 ${Math.round(hiD).toLocaleString()}`;
    }
    if (why) { m.exitAt = why; m.exitDay = today; m.exitFrac = frac; }
    log(`종가판정[${m.sub}] ${it.name}(${it.symbol}) 종가 ${closeToday.toLocaleString()}${hasToday ? '(일봉)' : '(현재가대체)'}${extra} / ${ret.toFixed(1)}% / ${holdDays}일차 → ${why ? '★예약 ' + why + (frac < 1 ? ` ${Math.round(frac * 100)}%` : '') : '보유 유지'}`);
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
}

async function signalScanLoop() {
  while (true) {
    try {
      if (marketOpen() && scanCash >= MIN_PRICE) {
        signalCache = await pickCandidate(scanCash, scanHeld);
        lastSignal = Date.now();
      }
    } catch (e) { log(`신호스캔 오류: ${String(e.message).slice(0, 80)}`); }
    await new Promise(r => setTimeout(r, 5_000)); // 완료 즉시 잠깐 쉬고 재스캔(실제 페이싱은 rateSlot 전역 10TPS가 담당)
  }
}
signalScanLoop();

// 매도 사인 (수동픽 보유분이 AI 목표/손절 도달 시 텔레그램 알림, 자동매도 X). 30초 루프의 holdings 재사용 = Toss 추가호출 0.
// ★ 2026-08-01: 기존 fetch 구현(이 VM에서 불통)을 위 curl 기반 tgNotify로 통합.
const tgSend = tgNotify;
async function emitSellSignals(holdings, manualCodes, today) {
  const held = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && manualCodes.has(i.symbol));
  if (!held.length) return;
  const sig = (state.sellSig ??= {});
  let strat = [];
  try { strat = await dbQuery(`SELECT DISTINCT ON (stock_code) stock_code,name,strategy FROM ai_shadow_decisions WHERE stock_code IN (${held.map(i => `'${i.symbol}'`).join(',')}) AND decision='buy' ORDER BY stock_code, run_at DESC`); } catch {}
  const sMap = new Map(strat.map(r => [r.stock_code, { name: r.name, s: typeof r.strategy === 'string' ? (() => { try { return JSON.parse(r.strategy); } catch { return null; } })() : r.strategy }]));
  for (const it of held) {
    const entry = Number(it.averagePurchasePrice), cur = Number(it.lastPrice);
    if (!entry || !cur) continue;
    const ret = (cur / entry - 1) * 100;
    const info = sMap.get(it.symbol); const st = info?.s; const nm = info?.name || it.name || it.symbol;
    const tgt = Number(st?.target_pct ?? 7), stp = Number(st?.stop_pct ?? 5);
    let type = null, label = null;
    if (ret >= tgt) { type = 'target'; label = `🎯 목표 +${tgt}% 도달`; }
    else if (ret <= -stp) { type = 'stop'; label = `🛑 손절선 -${stp}% 도달`; }
    if (!type) continue;
    const key = `${it.symbol}:${type}`;
    if (sig[key] === today) continue; // 종목·유형당 하루 1회
    sig[key] = today;
    await tgSend(`🔔 매도 사인: ${nm}(${it.symbol}) ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% (${label})\n진입 ${entry.toLocaleString()} → 현재 ${cur.toLocaleString()}\n팔려면 텔레그램: 매도 ${nm}`);
    writeFileSync(STATE, JSON.stringify(state, null, 1));
  }
}

// 텔레그램 주문 큐 집행 — telegram-agent가 적재한 매수/매도를 stock-live의 단일 Toss 세션으로 집행(경합 0). 결과는 텔레그램 전송.
async function processOrderQueue(seq) {
  const e2 = (s) => String(s ?? '').replace(/'/g, "''");
  // H2: 오래된 pending 만료(장경계·지연 → 다음날 엉뚱가격 집행 방지)
  try {
    const exp = await dbQuery(`UPDATE tg_order_queue SET status='expired', done_at=NOW() WHERE status='pending' AND requested_at <= NOW() - INTERVAL '10 minutes' RETURNING name, side`);
    for (const e of (Array.isArray(exp) ? exp : [])) await tgSend(`⏰ 주문 만료(10분 미집행): ${e.side === 'buy' ? '매수' : '매도'} ${e.name} — 필요하면 다시 명령해줘.`);
  } catch {}
  let pend = [];
  try { pend = await dbQuery(`SELECT id, side, name, amount_krw, target_price FROM tg_order_queue WHERE status='pending' AND requested_at > NOW() - INTERVAL '10 minutes' ORDER BY id LIMIT 5`); } catch { return 0; }
  let executed = 0;
  for (const o of pend) {
    // C1: 실행 전 원자적 선점 — 중복 집행 방지(크래시 시 processing서 멈춤 = 재집행 안 됨 ≫ 중복매수)
    let claim;
    try { claim = await dbQuery(`UPDATE tg_order_queue SET status='processing', claimed_at=NOW() WHERE id=${o.id} AND status='pending' RETURNING id`); } catch { continue; }
    if (!Array.isArray(claim) || !claim.length) continue; // 이미 다른 사이클이 가져감
    let r, threw = false;
    try {
      if (o.side === 'ca-clear') {
        const res = await resolveStock(o.name, { dbQuery });
        if (res.status === 'ok') {
          if (state.meta[res.code]) {
            delete state.meta[res.code].caHold;
            delete state.meta[res.code].caAlertDay;
            writeFileSync(STATE, JSON.stringify(state, null, 1));
          }
          r = { ok: true, msg: `✅ [CA서킷 해제] ${res.name}(${res.code}) 봇 자동 매도/손절 정상 재개` };
        } else {
          r = { ok: false, msg: `[CA서킷 해제 실패] '${o.name}' 종목을 찾지 못함` };
        }
      } else {
        r = o.side === 'buy'
          ? await executeBuy({ name: o.name, amountKrw: Number(o.amount_krw) }, { dbQuery, seq, dryRun: false })
          : await executeSell({ name: o.name, targetPrice: o.target_price != null ? Number(o.target_price) : undefined }, { dbQuery, seq, dryRun: false });
      }
    } catch (e) { threw = true; r = { ok: false, msg: String(e.message).slice(0, 150) }; }
    executed++;
    // H1: 응답 실패(throw)면 주문이 Toss에 접수됐을 수 있음 → 'error_check'로 두고 경보(failed 단정 금지)
    const st = threw ? 'error_check' : (r.ok ? 'done' : 'failed');
    try {
      await dbQuery(`UPDATE tg_order_queue SET status='${st}', result='${e2(r.msg)}', order_id='${e2(r.orderId)}', done_at=NOW() WHERE id=${o.id}`);
    } catch {
      await tgSend(`🚨 주문 상태갱신 실패 (id ${o.id} ${o.name}) — ${r.ok ? '체결됐으나 원장 미갱신' : ''}. 큐/계좌 수동확인 필요. (processing 상태라 재집행은 안 됨)`);
      continue;
    }
    if (threw) await tgSend(`⚠️ 주문 응답 불확실: ${o.name} — Toss에 접수됐을 수 있음. 계좌·체결 직접 확인해줘. (${r.msg})`);
    else await tgSend((r.ok ? '' : '⚠️ ') + r.msg);
  }
  return executed;
}

while (true) {
  if (!marketOpen()) { await new Promise(r => setTimeout(r, 300_000)); continue; } // 장외: 5분 슬립
  let holdings, cash;
  try {
    holdings = await getHoldings(seq);
    cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
    state.ipAlerted = false;
  } catch (e) {
    if (String(e.message).includes('no_authorization_ip') && !state.ipAlerted) { state.ipAlerted = true; log('⚠️ [IP인증실패] 토스 API IP 미등록 — 매매 불가. IP 갱신 필요! (1회 경보)'); }
    else if (!String(e.message).includes('no_authorization_ip')) log(`조회 실패(재시도): ${e.message.slice(0, 60)}`);
    await new Promise(r => setTimeout(r, POLL_MS)); continue;
  }
  // LIVE_EXCLUDE(정적) + 동적 봇제외(텔레그램 수동매수, .bot-exclude.json)는 봇이 전혀 안 건드림 — items에서 제외(청산·슬롯계산 모두 스킵)
  const EXCLUDED = new Set([...LIVE_EXCLUDE, ...readBotExclude()]);
  const items = (holdings?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && !EXCLUDED.has(i.symbol));
  const today = now().slice(0, 10);
  // ★ meta 고아 정리 (2026-07-28 버그 수정): 사용자가 토스 앱에서 직접 팔면 봇은 매도를 못 봐서 meta가 남는다.
  //   그 종목을 나중에 다시 사면 372행이 **낡은 meta를 그대로 재사용**해 옛 고점으로 트레일을 계산하고
  //   (즉시 매도 위험) 옛 진입가로 하드손절을 잡고 tp1:true가 남아 부분익절을 건너뛴다.
  //   조회 실패·부분응답으로 트레일 고점을 잃지 않게 **3사이클 연속 미보유**일 때만 삭제한다.
  if (holdings?.items) {
    const heldNow = new Set((holdings.items ?? []).filter(i => Number(i.quantity) > 0).map(i => i.symbol));
    const miss = (state.metaMiss ??= {});
    let purged = 0;
    for (const code of Object.keys(state.meta)) {
      if (heldNow.has(code)) { delete miss[code]; continue; }
      miss[code] = (miss[code] ?? 0) + 1;
      if (miss[code] >= 3) { delete state.meta[code]; delete miss[code]; purged++; }
    }
    if (purged) log(`meta 고아 정리 ${purged}건 (미보유 3사이클 연속) → 남은 ${Object.keys(state.meta).length}건`);
  }
  // 당일 재진입 금지 목록은 날이 바뀌면 정리 (파일 무한 증가 방지)
  if (state.soldToday) {
    for (const [c, d] of Object.entries(state.soldToday)) if (d !== today) delete state.soldToday[c];
  }
  // ★ 주문거부 백오프 목록도 날이 바뀌면 정리 (2026-07-29)
  //   근거: 07-28 08:14~08:32 NXT 프리마켓에서 322000 매수를 35초 간격 31회 던져 31회 전부 422 거부.
  //   현금 609만·슬롯 0/5로 실탄이 충분했는데 18분을 같은 거부에 소모하고 프리마켓 매수 0건으로 끝났다.
  //   거래소가 거부하는 주문은 재시도로 뚫리지 않는다 → 동일 종목 N회 연속 거부면 당일 후보에서 제외.
  if (state.orderErr) {
    for (const [c, v] of Object.entries(state.orderErr)) if (v?.day !== today) delete state.orderErr[c];
  }
  try { await emitSellSignals(holdings, readBotExclude(), today); } catch (e) { log(`매도사인 오류: ${String(e.message).slice(0, 80)}`); } // 수동픽 목표/손절 도달 시 텔레그램 매도사인(자동매도 X)
  try { const ne = await processOrderQueue(seq); if (ne > 0) cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? cash); } catch (e) { log(`주문큐 오류: ${String(e.message).slice(0, 80)}`); } // 큐 집행 후 현금 재조회(M3)

  // 시장 예측 조회 (하락경보 판정) — forecast_ledger 최신 KOSPI 프록시
  const fc = FORECAST_GUARD.enabled ? await marketForecast() : null;
  const bear = isBearish(fc);

  // 수급붕괴 청산용 조회(하루 1회 — 수급은 장마감 후 확정이라 장중 재조회 불필요)
  const flowBrk = FLOW_EXIT.enabled ? await flowBreaking(items.filter(i => state.meta[i.symbol]?.sub === 'hi120').map(i => i.symbol), today) : new Set();

  // ① 청산 판정 (트레일링 최대익절 + 하드손절) + 예측하락 이익보호(신규) + 수급붕괴(신규)
  for (const it of items) {
    const px = Number(it.lastPrice), entry = Number(it.averagePurchasePrice), qty = Number(it.quantity);
    const m = state.meta[it.symbol] ?? (state.meta[it.symbol] = { hi: px, entry });
    const ret = (px / entry - 1) * 100;

    // ⓪-CA: 무상증자·분할 서킷브레이커 — 직전 관측 대비 급락 시 자동매도 보류(헐값 매도 방지) + 경보.
    if (CA_GUARD.enabled) {
      if (m.lastPx && px < m.lastPx * (1 - CA_GUARD.dropPct / 100)) m.caHold = true; // 급락 감지
      if (m.caHold) {
        if (ret >= CA_GUARD.clearRet) { m.caHold = false; delete m.caAlertDay; } // 조정 반영/회복 → 정상 재개
        else {
          if (m.caAlertDay !== today) {
            const msg = `⚠️ [CA서킷] ${it.name}(${it.symbol}) 급락 감지(${ret.toFixed(1)}%, 직전 ${m.lastPx?.toLocaleString()}→${px.toLocaleString()}) — 무상증자·분할 의심, 자동매도 보류. 수동 확인 필요!`;
            log(msg); tgNotify(msg); m.caAlertDay = today;
          }
          m.lastPx = px;
          writeFileSync(STATE, JSON.stringify(state, null, 1));
          continue; // 이 종목 자동매도(부분익절·손절·트레일) 전면 스킵
        }
      }
      m.lastPx = px;
    }
    m.hi = Math.max(m.hi ?? px, px);

    // ⓪-FLOW 수급붕괴 청산 (2026-07-25 배포, 사용자 결정): hi120 보유분의 최근 10거래일 누적(기관+외국인) ≤ 0 → 전량 청산.
    //   ★백테스트 우선순위와 동일하게 부분익절·트레일보다 먼저 판정(검증된 동작을 그대로 재현).
    //   MC 10시드: CAGR +0.5%p(중립) / MDD -1.8%p 개선(6/10), 최악시드 낙폭 대폭 축소(27.5→18.3 등), Calmar 1.65→1.82.
    if (flowBrk.has(it.symbol) && !m.flowSold) {
      try {
        const lpx = limitSellPx(px);
        const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `수급청산 ${it.symbol}`, entry);
        if (filled.ok) {
          const fpx = filled.fillPx ?? lpx;                       // 실제 체결가 우선, 없으면 지정가 폴백
          const fret = (fpx / entry - 1) * 100;
          const rsn = `수급붕괴(기관+외국인 ${FLOW_EXIT.days}일 순매도)`;
          log(`매도 ${it.name}(${it.symbol}) ${qty}주 @${fpx.toLocaleString()}${filled.fillPx ? '' : '(지정가)'} (${rsn}, ${fret.toFixed(1)}%)`);
          recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: fpx, limitPx: lpx, fillSrc: filled.fillPx ? 'actual' : 'limit', entry, ret: Number(fret.toFixed(1)), reason: rsn });
          delete state.meta[it.symbol];
          (state.soldToday ??= {})[it.symbol] = today;   // 당일 재진입 금지
          writeFileSync(STATE, JSON.stringify(state, null, 1));
          continue;
        }
        m.flowSold = today; // 미체결 → 당일 재시도 안 함(다음날 재판정)
      } catch (e) { log(`수급청산 오류 ${it.symbol}: ${String(e.message).slice(0, 80)}`); }
    }

    // ⓪ 부분익절 (백테스트 검증): +tp1Pct 절반 / +tp2Pct 잔량절반. 나머지는 아래 트레일 유지.
    // ★ 2026-07-29: hi120 전용으로 제한. 백테는 부분익절을 hi120에만 적용하는데(tp1R/tp2R 블록이
    //   `if (p.sub === 'hi120')` 안에 있다) 라이브는 07-21 이식 때 sub 분기를 안 가져와 rsi2에도 걸었다.
    //   10시드 MC: rsi2 부분익절만 추가해도 Calmar 1.71 → 1.59 (단일경로), 트레일과 합치면 1승 9패.
    if (false) {   // ★ 2026-07-29: 부분익절도 종가판정으로 이관(judgeExitsAtClose). 장중 실시간 판정 폐지.
      let tpTag = null;
      if (ret >= PARTIAL_TP.tp2Pct && m.tp1 && !m.tp2) tpTag = 'tp2';
      else if (ret >= PARTIAL_TP.tp1Pct && !m.tp1) tpTag = 'tp1';
      if (tpTag) {
        const tpQty = Math.floor(qty / 2);
        if (tpQty >= 1) {
          try {
            const lpx = limitSellPx(px);
            const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(tpQty) });
            const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `부분익절 ${it.symbol}`, entry);
            if (filled.ok) {
              m[tpTag] = true;
              const pct = tpTag === 'tp2' ? PARTIAL_TP.tp2Pct : PARTIAL_TP.tp1Pct;
              const fpx = filled.fillPx ?? lpx;
              const fret = (fpx / entry - 1) * 100;
              log(`부분익절 ${it.name}(${it.symbol}) ${tpQty}주 @${fpx.toLocaleString()}${filled.fillPx ? '' : '(지정가)'} (+${pct}% 도달, 실현 ${fret.toFixed(1)}%)`);
              recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: fpx, limitPx: lpx, fillSrc: filled.fillPx ? 'actual' : 'limit', qty: tpQty, entry, ret: Number(fret.toFixed(1)), reason: `부분익절(${tpTag}) +${pct}%` });
              writeFileSync(STATE, JSON.stringify(state, null, 1));
            }
          } catch (e) { log(`부분익절 오류 ${it.symbol}: ${e.message.slice(0, 80)}`); }
          continue; // 이번 사이클은 부분익절만 — 남은 수량은 다음 폴에서 추가익절/트레일 평가
        }
      }
    }

    let reason = null, harvest = false;
    // 기존(검증된 combo-v2) 청산 — 항상 실집행
    // ★ 2026-07-29 rsi2 청산 전면 개편 (검증 3종 통과 — 오늘 유일)
    //   ① 예약청산 집행: 전일 15:35 종가판정으로 예약된 건을 익일 개장 후 집행.
    //      "익일 시가"는 08시(NXT)다 — candles-daily 시가가 08시 첫봉과 88.9% 일치(KRX+NXT 통합 데이터).
    //      08시/09시 집행은 수익 차이 없음(782쌍 중 455건 동일, 갈리는 327건 160:167) → 시각 고정 안 하고
    //      미체결 시 settleOrder가 취소·재시도하게 둔다(프리마켓 유동성 부족이면 자연히 09시로 밀림).
    //   ② rsi2는 장중 트레일·하드손절 판정을 하지 않는다. 분봉 782쌍에서 장중 개입은 전부 악화:
    //      트레일 +0.38%→-0.31% · 실시간 -7% 손절 +0.38%→-0.11%. "작게 이기고 크게 진다"가 반복 확인됨.
    // exitDay !== today 가드: 판정한 당일에는 집행하지 않는다("종가 판정 → 익일 집행"을 순서와 무관하게 보장)
    if (m.exitAt && m.exitDay !== today) {
      reason = `예약청산(${m.exitAt}, ${m.holdDays ?? '?'}일차, ${m.exitDay} 종가판정)`;
      // ★ 2026-07-31 계측 추가: 예약청산이 **조용히 집행되지 않는 사례**가 실제로 발생했다.
      //   07-30 15:35 삼성전기(009150) exitAt='손절 -15%' 예약 → 07-31 08:00~08:45 4사이클 동안
      //   매도 시도 로그가 **한 줄도 없었다.** settleOrder 는 미체결 시 로그를 남기고 catch 도 로그하므로
      //   "주문 자체가 시도되지 않았다"는 뜻인데, 원인을 원격 정적분석으로 특정할 수 없었다
      //   (CA서킷 0건 · marketCountry 전부 KR · EXCLUDED 무관 · settleOrder 로그 없음 — 전부 배제됨).
      //   그래서 분기 진입 자체를 무조건 기록한다. 다음 사이클에 이 줄이 있으면 분기는 탄 것이고,
      //   없으면 items 에 없거나 그 앞에서 continue 된 것이다 — 둘 중 어디인지가 갈린다.
      log(`예약청산 시도 ${it.name}(${it.symbol}) ${m.exitAt} / exitDay ${m.exitDay} / 현재가 ${px.toLocaleString()} / ${qty}주 / ${ret.toFixed(1)}%`);
    }
    // ★ 장중 무개입: rsi2·hi120 모두 15:35 종가판정만(judgeExitsAtClose). 검증된 백테가 종가판정이다.
    else if (m.sub === 'rsi2' || m.sub === 'hi120') { /* 장중 판정 없음 */ }
    // ⚠️ sub 미상 포지션만 아래 장중 경로를 탄다(수동픽·state 유실분). 봇 매수분이 여기 오면
    //   meta가 유실돼 검증된 종가판정을 우회하는 것이므로 **경보**를 남긴다(조용한 회귀 방지).
    else if (!m.sub) {
      if (m.noSubAlertDay !== today) { m.noSubAlertDay = today; log(`⚠️ sub 미상 포지션 ${it.name}(${it.symbol}) — meta 유실 의심, 장중 경로로 판정됨. 수동 확인 필요`); }
      if (px <= entry * (1 - HARD_STOP_PCT / 100)) reason = `하드손절 -${HARD_STOP_PCT}%`;
      else if (px <= m.hi * (1 - TRAIL_PCT / 100)) reason = `트레일손절(고점대비 -${TRAIL_PCT}%, ${ret.toFixed(1)}%)`;
    }
    else if (px <= entry * (1 - HARD_STOP_PCT / 100)) reason = `하드손절 -${HARD_STOP_PCT}%`;
    else if (px <= m.hi * (1 - TRAIL_PCT / 100) && ret > 0) reason = `트레일링(고점대비 -${TRAIL_PCT}%, ${ret.toFixed(1)}%)`;
    else if (px <= m.hi * (1 - TRAIL_PCT / 100)) reason = `트레일손절(고점대비 -${TRAIL_PCT}%, ${ret.toFixed(1)}%)`;
    // 신규: 예측 하락경보 이익보호 — 기존 규칙 미발동 & 수익종목이 조인 트레일(bearTrailPct) 이탈 시
    else if (bear && ret >= FORECAST_GUARD.harvestRetPct && px <= m.hi * (1 - FORECAST_GUARD.bearTrailPct / 100)) {
      harvest = true;
      reason = `예측하락 이익보호(트레일-${FORECAST_GUARD.bearTrailPct}%, ${ret.toFixed(1)}%, 하락${fc.down}/상승${fc.up} conf${fc.conf})`;
    }
    if (reason) {
      // shadow 모드: 예측하락 이익보호는 실집행 없이 하루 1회 기록만 (검증 데이터 축적). 기존 청산은 그대로 실집행.
      if (harvest && FORECAST_GUARD.shadow) {
        if (m.shadowDay !== today) {
          log(`[SHADOW] 이익보호 예정: ${it.name}(${it.symbol}) ${ret.toFixed(1)}% — ${reason}`);
          recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SHADOW_HARVEST', px, entry, ret: Number(ret.toFixed(1)), reason, forecast: fc });
          m.shadowDay = today;
        }
        continue; // 실제 매도 안 함
      }
      try {
        const lpx = limitSellPx(px);
        // ★ 2026-07-29: 예약청산이 부분익절이면 절반만 팔고 포지션을 유지한다(백테 tp_half/tp_quarter 재현).
        //   m.exitFrac: 1=전량 / 0.5=절반. 전량이 아니면 meta를 지우지 않고 tp1/tp2 플래그만 세운다.
        const frac = Number(m.exitFrac ?? 1);
        const sellQty = frac >= 1 ? qty : Math.max(1, Math.floor(qty * frac));
        const partial = sellQty < qty;
        const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(sellQty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `매도 ${it.symbol}`, entry);
        if (filled.ok) {
          const fpx = filled.fillPx ?? lpx;                       // 실제 체결가 우선, 없으면 지정가 폴백
          const fret = (fpx / entry - 1) * 100;
          log(`매도 ${it.name}(${it.symbol}) ${sellQty}주${partial ? `/${qty} 부분` : ''} @${fpx.toLocaleString()}${filled.fillPx ? '' : '(지정가)'} (${reason}, 실현 ${fret.toFixed(1)}%)`);
          recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: fpx, limitPx: lpx, fillSrc: filled.fillPx ? 'actual' : 'limit', qty: sellQty, entry, ret: Number(fret.toFixed(1)), reason, forecast: harvest ? fc : undefined });
          if (partial) {
            // 부분익절: 포지션 유지. tp 플래그를 세워 다음 판정에서 같은 단계가 재발동하지 않게 한다.
            if (/tp1/.test(reason)) m.tp1 = true; else if (/tp2/.test(reason)) m.tp2 = true;
            delete m.exitAt; delete m.exitFrac; delete m.exitDay;
          } else {
            delete state.meta[it.symbol];
            (state.soldToday ??= {})[it.symbol] = today;   // 당일 재진입 금지(아래 진입 루프에서 스킵)
          }
        }
        // ★ 매도는 백오프를 걸지 않는다 (2026-07-29). 청산을 막으면 손실이 무한정 열린다 —
        //   매수와 달리 재시도 낭비보다 미청산 리스크가 크다. 오류 전문만 300자로 늘린다.
      } catch (e) { log(`매도 오류 ${it.name}(${it.symbol}): ${String(e.message).slice(0, 300)}`); }
    }
  }
  // ★ 2026-07-31 계측 추가: 청산 루프가 실제로 어떤 종목을 봤는지 사이클당 1줄로 남긴다.
  //   위 '예약청산 시도' 로그와 짝을 이룬다 — 여기 종목이 있는데 시도 로그가 없으면
  //   루프 앞 구간(CA가드 등)에서 continue 된 것이고, 여기에도 없으면 items 구성 문제다.
  //   내용이 바뀔 때만 찍히므로(logGate 10분 게이트) 평시 로그량은 거의 늘지 않는다.
  logGate(`보유판정 ${items.length}종목: ${items.map((i) => {
    const mm = state.meta[i.symbol];
    return `${i.symbol}@${Number(i.lastPrice).toLocaleString()}${mm?.exitAt ? `[예약 ${mm.exitAt}/${mm.exitDay}]` : ''}${mm?.caHold ? '[CA보류]' : ''}${mm?.sub ? '' : '[sub없음]'}`;
  }).join(' ')}`, `hold|${items.map(i => `${i.symbol}:${state.meta[i.symbol]?.exitAt ? 'R' : '-'}`).join(',')}`);

  writeFileSync(STATE, JSON.stringify(state, null, 1));

  // ★ rsi2 종가 판정 (2026-07-29) — 15:35 이후 하루 1회. 판정만, 집행은 익일.
  {
    const k = kst();
    const hhmm = k.getUTCHours() * 100 + k.getUTCMinutes();
    if (hhmm >= RSI2_JUDGE_HHMM && items.some(i => ['rsi2','hi120'].includes(state.meta[i.symbol]?.sub) && state.meta[i.symbol]?.judgedDay !== today)) {
      try { await judgeExitsAtClose(items, state, today); } catch (e) { log(`종가판정 오류: ${String(e.message).slice(0, 120)}`); }
    }
  }

  // 하락경보 시 신규진입 보류 (shadow면 기록만, live면 실제 스킵)
  if (bear && items.length < LIVE_SLOTS && cash >= MIN_PRICE) {
    if (FORECAST_GUARD.shadow) {
      if (state.shadowBearDay !== today) { log(`[SHADOW] 하락경보(하락${fc.down}/상승${fc.up} conf${fc.conf}) — 신규진입 보류 대상(실제로는 진행)`); state.shadowBearDay = today; }
    }
  }

  // ② 진입 — 자본기반 게이트(CAPITAL_DEPLOY). perSlot=equity/slots, 유휴현금이 반슬롯↑이면 편입.
  //   레거시 dust(시가평가<perSlot*dustFraction)는 슬롯 카운트 제외 → 큰 현금이 dust에 막히지 않음.
  const posVal = items.reduce((s, it) => s + Number(it.quantity) * Number(it.lastPrice), 0);
  const equity = cash + posVal;
  const perSlot = Math.max(MIN_PRICE, Math.floor(equity / LIVE_SLOTS));
  const bigCount = CAPITAL_DEPLOY.enabled
    ? items.filter(it => Number(it.quantity) * Number(it.lastPrice) >= perSlot * CAPITAL_DEPLOY.dustFraction).length
    : items.length;
  const canDeployRaw = CAPITAL_DEPLOY.enabled
    ? (bigCount < LIVE_SLOTS && cash >= perSlot * CAPITAL_DEPLOY.minFillFraction && cash >= MIN_PRICE)
    : (items.length < LIVE_SLOTS && cash >= MIN_PRICE);
  // ★ 2026-08-01: AI 판단·즉시교체는 **만석일 때도 실행돼야 한다.**
  //   즉시교체(rotate)는 정의상 "슬롯이 만석인데 지금 꼭 사야 할 후보가 있을 때" 쓰는 기능인데,
  //   만석이면 canDeploy 가 false 라 이 블록 전체가 스킵돼 **rotate 가 존재 이유인 상황에서 죽는다.**
  //   백테 `--rotate` 가 만석 break 뒤에 배선돼 죽어 있던 것과 같은 유형의 결함이다(2026-07-30 기록).
  //   → 진입 블록 진입 조건을 "매수 가능 OR 교체 가능"으로 넓히고, 실제 매수는 아래에서 canDeploy 로 다시 가른다.
  if (state.rotDay !== today) { state.rotDay = today; state.rotCount = 0; state.aiSellCount = 0; }
  const rotLeft = AI_TRADER.rotate.enabled ? Math.max(0, AI_TRADER.rotate.maxPerDay - (state.rotCount ?? 0)) : 0;
  const sellLeft = Math.max(0, AI_TRADER.sellMaxPerDay - (state.aiSellCount ?? 0));
  const bearBlock = bear && !FORECAST_GUARD.shadow;

  // ══════════════════════════════════════════════════════════════════════════
  // ★ 2026-08-01 AI 종합판단 (사용자 요청 — "조건에 맞을 때마다 사고 팔 수 있게, 자유로운 판단")
  //
  // ★★ 이 블록은 **진입 블록 밖**에 있어야 한다. 리뷰에서 critical 로 잡힌 결함이다:
  //   매도·손절유예 권한은 "매수 후보가 있는지"와 아무 관계가 없는데, 진입 블록 안에 두면
  //   canDeploy(현금·슬롯)·rotLeft·eligible 게이트에 같이 묶여 **가장 필요한 날에 정확히 죽는다.**
  //     · NEUTRAL 레짐 → skipNeutral 로 rsi2 후보 전멸 + hi120 0건 → eligible=[] → AI 미호출
  //       → 보유가 전부 -13% 여도 손절유예 판단이 존재하지 않고 15:35 에 전원 하드손절
  //     · 만석+현금소진 → pickCandidate 가 `current_price < cashCeil` 로 자르므로 후보 0건
  //       → 즉시교체가 자기 존재 이유인 상황에서 또 죽는다
  //   → 호출 조건을 "보유가 있거나 후보가 있으면"으로 바꾸고, 매수 관련 게이트는 매수 루프에만 적용한다.
  //
  // consultTrader 는 항상 즉시 반환(claude 호출은 백그라운드) — 30초 청산루프를 절대 막지 않는다.
  // 권한 비대칭 근거는 ai-trader.mjs 헤더 참조.
  const heldSet = new Set(items.map(i => i.symbol));
  const { regime, cands } = signalCache ?? { regime: null, cands: [] }; // 재시작 직후 첫 스캔 완료 전 = 빈 후보로 안전 대기
  // ★ eligible: **기계 필터를 실제로 통과한 것만** 판단에 넘긴다.
  //   pickCandidate 는 보유·정적제외만 걸러서 soldToday(당일 재진입금지)·orderErr(확정거부 3회)가 남아 있다.
  //   그걸 그대로 넘기면 폭락일에 top8 이 전부 "판단은 되지만 살 수 없는 종목"으로 채워지고
  //   (휩소 손절분은 깊은 과매도라 conviction 최상위로 재등장 — 07-28~29 두산퓨얼셀 4회 전례)
  //   9위 이하가 승인목록에 없어서 종일 매수 0이 된다. 판단 대상 = 실제로 살 수 있는 상위 N.
  const soldT0 = state.soldToday ?? {}, errT0 = state.orderErr ?? {};
  const eligible = (cands ?? []).filter(p =>
    !heldSet.has(p.code) && soldT0[p.code] !== today && (errT0[p.code]?.n ?? 0) < ORDER_ERR_MAX);
  // 종가판정이 이미 끝난 종목은 오늘 유예가 무효다(판정 뒤에 심으면 영구 미소비 플래그가 된다).
  const aiHoldings = items.map(i => {
    const mm = state.meta[i.symbol];
    const e = Number(i.averagePurchasePrice) || 0, p = Number(i.lastPrice) || 0;
    const r = e > 0 && p > 0 ? (p / e - 1) * 100 : null;
    const bd = String(mm?.boughtAt ?? '').slice(0, 10);
    return { code: i.symbol, name: i.name, sub: mm?.sub ?? null, sector: SECTOR[i.symbol] ?? null,
             ret_pct: r == null ? null : Number(r.toFixed(1)),
             // 손절선 임박 = 손절유예 판단 대상. hi120 은 하드손절이 없으므로 대상 아님(ai-trader 가 거른다).
             near_stop: mm?.sub === 'rsi2' && r != null && r <= -(HARD_STOP_PCT - AI_TRADER.nearStopPct),
             exit_reserved: mm?.exitAt ?? null, stop_deferred: mm?.stopDeferDay ?? null,
             defer_used: Number(mm?.deferCount ?? 0), judged_today: mm?.judgedDay === today,
             ca_hold: !!mm?.caHold,
             // 즉시교체 최소보유일 판정용(달력일 근사 — 정확한 거래일수는 종가판정이 계산한다)
             hold_days: bd ? Math.max(0, Math.round((new Date(today) - new Date(bd)) / 86_400_000)) : null };
  });
  let ai = { mode: 'off' };
  if (eligible.length > 0 || items.length > 0) {
    ai = consultTrader({
      today, nowKst: now(), regime, cands: eligible, forecast: fc, cash, perSlot, bigCount,
      slots: LIVE_SLOTS, hardStopPct: HARD_STOP_PCT, trigger: null,
      rotate: AI_TRADER.rotate, rotateLeft: rotLeft, sellLeft, brief: await morningBrief(today),
      holdings: aiHoldings, recentSells: recentSells(),
    }, { log, notify: tgNotify });
    if (ai.mode === 'hold') logGate(`AI판단 보류: ${ai.reason}`, 'ai|hold');
    else if (ai.mode === 'closed') logGate(`AI판단 매수중단(오늘): ${ai.reason}`, 'ai|closed');
    else if (ai.mode === 'open') logGate(`AI판단 폴백(기계 로직): ${ai.reason}`, 'ai|open');
    else if (ai.mode === 'live' && ai.skipAll) logGate(`AI판단 전면보류 — ${ai.strategy}`, 'ai|skipall');
  }
  // ★ AI 청산권고를 **종가판정 예약**으로 등록한다(즉시 매도 아님 — 익일 개장 집행).
  //   장중 즉시 매도로 만들지 않는 이유: 분봉 782쌍 실측에서 장중 개입은 트레일·손절 모두 악화였고,
  //   "종가판정 → 익일집행"이 백테와 라이브를 일치시킨 구조다. 이걸 깨면 검증 전체가 무효가 된다.
  //   일일 상한(sellMaxPerDay)이 없으면 한 판단으로 보유 전량 회전이 매일 가능하다 → 카운터로 막는다.
  if (ai.mode === 'live' && ai.sell?.size) {
    let n = 0;
    for (const [code, why] of ai.sell) {
      if ((state.aiSellCount ?? 0) >= AI_TRADER.sellMaxPerDay) { logGate(`AI청산예약 상한 도달(${AI_TRADER.sellMaxPerDay}/일) — ${code} 스킵`, 'aisell|cap'); break; }
      const m = state.meta[code];
      if (!m || m.exitAt) continue;                      // 미보유·기존예약은 스킵
      m.exitAt = `AI판단(${String(why).slice(0, 60)})`; m.exitDay = today; m.exitFrac = 1; m.aiExit = true;
      state.aiSellCount = (state.aiSellCount ?? 0) + 1; n++;
      log(`AI청산예약 ${code} (${state.aiSellCount}/${AI_TRADER.sellMaxPerDay}) — ${why}`);
    }
    if (n) { writeFileSync(STATE, JSON.stringify(state, null, 1)); tgNotify(`📌 AI 청산예약 ${n}건 — 익일 개장 집행 예정`); }
  }
  // ★ AI 손절유예 플래그를 포지션에 심는다. 실제 유예는 15:35 종가판정에서 1회만 소비된다.
  //   장중엔 rsi2 청산 판정이 없으므로(장중 무개입) 여기서 심어두면 된다. 단 **오늘 판정이 이미
  //   끝났으면 심지 않는다** — 소비 시점이 지나 영구 미소비 플래그가 되고 "유예했다"는 오보가 된다.
  if (ai.mode === 'live' && ai.defer?.size) {
    let n = 0;
    for (const [code, why] of ai.defer) {
      const m = state.meta[code];
      if (!m || m.stopDeferDay === today || m.stopDefer === today) continue;   // 미보유·당일 소비·이미 심음
      if (m.judgedDay === today) { log(`AI 손절유예 무효 ${code}: 오늘 종가판정 이미 완료(${m.exitAt ?? '보유유지'}) — 다음 거래일에 재판단`); continue; }
      if (Number(m.deferCount ?? 0) >= AI_TRADER.deferMaxPerPosition) { log(`AI 손절유예 거부 ${code}: 포지션 유예 상한 ${AI_TRADER.deferMaxPerPosition}회 소진`); continue; }
      m.stopDefer = today; m.stopDeferWhy = String(why).slice(0, 120); n++;
      log(`AI 손절유예 예정 ${code} — ${why}`);
    }
    if (n) writeFileSync(STATE, JSON.stringify(state, null, 1));
  }

  // ② 진입 — 자본기반 게이트. 매수·즉시교체만 이 블록 안에서 한다.
  if ((canDeployRaw || rotLeft > 0) && !bearBlock) {
    let canDeploy = canDeployRaw;
    let remainingSlots = Math.max(1, LIVE_SLOTS - bigCount);
    let diversified = Math.min(cash, perSlot);   // 한 슬롯 예산(초과 현금은 다음 폴에서 추가 편입)
    // ★ scanCash: 만석이라 현금이 없어도 **교체 여지가 있으면 슬롯예산 기준으로 스캔**한다.
    //   pickCandidate 가 `current_price < cashCeil` 로 유니버스를 자르므로, 현금 0 을 넘기면
    //   후보가 0건이 되고 즉시교체가 자기 존재 이유인 상황에서 발동조차 못 한다(리뷰 확정 critical).
    scanCash = rotLeft > 0 ? Math.max(cash, perSlot) : cash;
    scanHeld = heldSet;
    // 진입대기 가시성(2026-07-27): 후보 0건이면 아무 로그도 안 남아 "왜 안 사는지"를 매번 수동확인해야 했음.
    const blockedToday = Object.values(state.soldToday ?? {}).filter(d => d === today).length;
    logGate(`${canDeploy ? '진입대기' : '교체검토(만석)'}: 레짐 ${regime ?? '스캔중'} · 후보 ${cands?.length ?? 0}건 · 현금 ${Math.round(cash / 10000).toLocaleString()}만 · 슬롯 ${bigCount}/${LIVE_SLOTS}${rotLeft ? ` · 교체가능 ${rotLeft}회` : ''}${blockedToday ? ` · 당일재진입금지 ${blockedToday}종목` : ''}`,
      `${canDeploy ? 'buy' : 'rot'}|${regime ?? '스캔중'}|${(cands?.length ?? 0) > 0 ? 'cand' : 'none'}`);
    // ★ 즉시 교체(rotate) 집행 — **이 코드가 유일하게 장중에 매도한다.** 사용자 요청의 핵심 경로다.
    //   ("살 종목 생겼다 → 보유 모멘텀 없어졌다 → 판다 → 새로 산다". 일반 sell 은 익일 집행이라
    //    만석이면 기회가 사라진다.) 기각된 로테이션 축을 되살리는 것이므로 가드를 두껍게 둔다:
    //   ai-trader 가 이미 짝·상한·손실·보유일을 검증했고, 여기서 **집행 직전 상태를 다시 확인**한다
    //   (판단 시점과 집행 시점 사이에 예약청산·CA서킷·수급청산이 끼어들 수 있다).
    let rotBuyFirst = null;   // 교체 매도 성공 시 그 짝의 매수측을 최우선으로 사기 위한 표시
    if (ai.mode === 'live' && ai.rotate?.length && rotLeft > 0) {
      for (const rot of ai.rotate) {
        if ((state.rotCount ?? 0) >= AI_TRADER.rotate.maxPerDay) break;
        const it = items.find(i => i.symbol === rot.sell_code);
        const m = state.meta[rot.sell_code];
        // 스킵 사유는 logGate 로 — 판단 TTL 동안 매 사이클(30초) 반복 평가되므로 log 면 도배된다.
        const skip = (why) => logGate(`즉시교체 스킵 ${rot.sell_code}: ${why}`, `rotskip|${rot.sell_code}|${why.slice(0, 12)}`);
        if (!it || !m) { skip('미보유'); continue; }
        if (m.exitAt) { skip(`이미 청산예약(${m.exitAt})`); continue; }
        if (m.caHold) { skip('CA서킷 보류중'); continue; }
        if (flowBrk.has(rot.sell_code)) { skip('수급청산 대상(그 경로로 처리)'); continue; }
        const px = Number(it.lastPrice), entry = Number(it.averagePurchasePrice), qty = Number(it.quantity);
        const ret = entry > 0 ? (px / entry - 1) * 100 : 0;
        if (ret < -AI_TRADER.rotate.maxSellLossPct) { skip(`손실 ${ret.toFixed(1)}% > 상한 ${AI_TRADER.rotate.maxSellLossPct}% (손절 규칙에 맡김)`); continue; }
        // 매수측이 지금도 유효한지 재확인 — 승인·후보·미보유·당일미매도.
        // ★ 예산도 본다: 교체 후 확보될 현금(현재현금 + 매도대금)으로 buy_code 를 실제로 살 수 있어야
        //   한다. 안 보면 "비싼 종목으로 갈아타려고 싼 종목을 팔았는데 못 사는" 최악이 나온다.
        const buyPick = eligible.find(p => p.code === rot.buy_code);
        if (!ai.buy.has(rot.buy_code) || !buyPick) { skip(`매수측 ${rot.buy_code} 무효(승인·후보 이탈)`); continue; }
        const cashAfter = cash + px * qty * 0.9967;                 // 매도 수수료·세금 약 0.33% 차감
        const budgetAfter = Math.min(cashAfter, perSlot);
        if (limitBuyPx(buyPick.px) > budgetAfter) { skip(`교체 후 예산 부족(${Math.round(budgetAfter / 10000)}만 < ${rot.buy_code} ${Math.round(limitBuyPx(buyPick.px) / 10000)}만)`); continue; }
        try {
          const lpx = limitSellPx(px);
          const o = await createOrder(seq, { symbol: it.symbol, side: 'SELL', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
          const filled = await settleOrder(o?.orderId ?? o?.id, it.symbol, 'SELL', qty, `즉시교체 ${it.symbol}`, entry);
          if (filled.ok) {
            const fpx = filled.fillPx ?? lpx, fret = (fpx / entry - 1) * 100;
            const rsn = `AI 즉시교체(→${rot.buy_code}: ${String(rot.reason).slice(0, 60)})`;
            state.rotCount = (state.rotCount ?? 0) + 1; state.rotDay = today;
            log(`매도 ${it.name}(${it.symbol}) ${qty}주 @${fpx.toLocaleString()}${filled.fillPx ? '' : '(지정가)'} (${rsn}, 실현 ${fret.toFixed(1)}%) · 교체 ${state.rotCount}/${AI_TRADER.rotate.maxPerDay}회`);
            recordTrade({ ts: now(), code: it.symbol, name: it.name, side: 'SELL', px: fpx, limitPx: lpx,
              fillSrc: filled.fillPx ? 'actual' : 'limit', qty, entry, ret: Number(fret.toFixed(1)),
              reason: rsn, aiRotate: { to: rot.buy_code, why: rot.reason } });
            delete state.meta[it.symbol];
            (state.soldToday ??= {})[it.symbol] = today;   // 되사기 금지(플립플롭 방어)
            writeFileSync(STATE, JSON.stringify(state, null, 1));
            tgNotify(`🔄 AI 즉시교체: ${it.name} 매도 ${fret >= 0 ? '+' : ''}${fret.toFixed(1)}% → ${buyPick.name}(${rot.buy_code}) 매수 예정\n사유: ${rot.reason}\n※ 왕복비용 약 0.33%p 발생 · 오늘 ${state.rotCount}/${AI_TRADER.rotate.maxPerDay}회`);
            // ★ 남은 교체 지시를 비워 재판단을 강제한다(낡은 2번째 교체 자동집행·스킵로그 도배 방지).
            clearRotate();
            // ★ 매수측을 이번 사이클 최우선으로 지정 — 교체는 "이 종목을 사려고 팔았다"는 뜻이므로
            //   확신도순 루프가 다른 승인 종목을 먼저 사면 교체의 의미가 사라진다.
            rotBuyFirst = rot.buy_code;
            break;   // 사이클당 교체 1건 — 매수는 아래 루프가 같은 사이클에 집행한다
          }
        } catch (e) { log(`즉시교체 매도 오류 ${it.symbol}: ${String(e.message).slice(0, 200)}`); }
      }
      // ★ 교체 매도로 현금·슬롯이 바뀌었다. 매수 루프가 낡은 값을 쓰면 (a) 예산이 0에 가까워 아무것도
      //   못 사고 (b) canDeploy 가 false 로 남아 **팔기만 하고 안 사는** 최악 결과가 된다.
      //   그래서 현금·보유를 재조회하고 canDeploy·예산을 다시 계산한다.
      try {
        cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? cash);
        const h2 = await getHoldings(seq);
        const it2 = (h2?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && !EXCLUDED.has(i.symbol));
        heldSet.clear(); for (const i of it2) heldSet.add(i.symbol);
        const pv2 = it2.reduce((s, i) => s + Number(i.quantity) * Number(i.lastPrice), 0);
        const eq2 = cash + pv2;
        const ps2 = Math.max(MIN_PRICE, Math.floor(eq2 / LIVE_SLOTS));
        const bc2 = CAPITAL_DEPLOY.enabled
          ? it2.filter(i => Number(i.quantity) * Number(i.lastPrice) >= ps2 * CAPITAL_DEPLOY.dustFraction).length
          : it2.length;
        remainingSlots = Math.max(1, LIVE_SLOTS - bc2);
        diversified = Math.min(cash, ps2);
        scanCash = cash; scanHeld = heldSet;
        log(`교체 후 재계산: 현금 ${Math.round(cash / 10000).toLocaleString()}만 · 슬롯 ${bc2}/${LIVE_SLOTS} · 슬롯예산 ${Math.round(ps2 / 10000).toLocaleString()}만`);
      } catch (e) {
        // 재조회 실패 시에도 매수는 계속한다 — 슬롯을 비우고 현금을 받은 것은 **확정 사실**이고,
        // 예산·가격은 아래 매수 루프가 후보별로 다시 검증한다(pick.px >= budget → 스킵).
        log(`교체 후 재조회 실패(예산은 매도 전 값 사용, 후보별 재검증에 의존): ${String(e.message).slice(0, 80)}`);
        diversified = Math.max(diversified, Math.min(cash, perSlot));
      }
    }
    const aiBlocksAll = ai.mode === 'hold' || ai.mode === 'closed' || (ai.mode === 'live' && ai.skipAll);

    // 확신도순으로 훑어 각 후보의 예산(집중 or 분산)에 맞는 첫 종목 1건 매수
    // ★ 당일 재진입 금지 (2026-07-29 사용자 승인). 폭락장 휩소 대응.
    //   실측 근거: 07-28~29 청산 16건 중 승 3건(19%)·합계 -40.5%p인데 그 **53%가 두산퓨얼셀 단일 종목 4회 휩소**
    //   (26,200 → 24,300 → 22,950 → 20,550 계단식 하락에 매번 재진입해 매번 -3~6% 손절).
    //   일봉 백테는 하루 1회만 판정해 이 동작이 아예 없다 = "DOWN에서 rsi2 유지"(10시드 1승9패) 검증 범위 밖.
    //   비용도 실재: 청산 16회 × 왕복 0.33%p ≈ 계좌 -1.1%가 순수 마찰.
    //   진입만 막는다(청산 로직 불변). 다음 거래일부터 재진입 허용.
    // ★ 순서 역전 방지 (2026-08-01): 판단 후 새로 올라온 **미판정 1위**가 있으면 이번 사이클은 매수하지 않는다.
    //   그냥 진행하면 미판정 1위를 건너뛰고 기존 승인분(더 약한 신호)을 사게 되는데, 그게
    //   conviction ≥ 7 이면 CONVICTION_SIZING 이 현금 50%를 그 약한 신호에 몰아넣는다(집중몰빵).
    //   기계 기준선은 1위를 먼저·집중으로 샀을 상황이라 하루 배분이 뒤집힌다.
    //   지연 상한은 minCallGapMin(10분)+판단시간으로 유한하고, 방향은 "거래를 늦추는" 쪽이다.
    //   ★ 단, 교체 매도를 막 집행했으면(rotBuyFirst) 이 가드를 우회한다 — 이미 왕복비용을 내고
    //   슬롯을 비운 상태에서 매수를 미루면 "팔고 안 사는" 최악이 된다. 그건 어떤 순서 문제보다 나쁘다.
    const top1Unjudged = !rotBuyFirst && ai.mode === 'live' && !ai.skipAll
      && eligible[0] && !ai.judged?.has(eligible[0].code);
    if (top1Unjudged) logGate(`AI 재판단 대기: 신규 1위 ${eligible[0].name}(확신도 ${eligible[0].conviction?.toFixed(1)}) 미판정`, 'ai|top1new');
    const soldT = state.soldToday ?? {};
    const errT = state.orderErr ?? {};
    // 만석 상태로 이 블록에 들어온 경우(교체 검토 목적)엔 매수 루프를 돌지 않는다.
    // ★ 교체가 성사됐으면 슬롯이 비고 현금이 들어온 것이 확정이므로 canDeploy 를 강제로 연다.
    //   (재조회가 실패해 canDeploy 가 낡은 false 로 남는 경우까지 덮는다. 예산 검증은 후보별로 남아 있다.)
    if (rotBuyFirst) canDeploy = true;
    let bought = null;   // 이번 사이클 실제 매수 종목 — 교체 후 "팔고 안 샀다" 경보 판정용
    if (!canDeploy) logGate(`매수보류(만석): 슬롯 ${bigCount}/${LIVE_SLOTS} · 교체 ${state.rotCount ?? 0}/${AI_TRADER.rotate.maxPerDay}회 사용`, `full|${bigCount}`);
    // 교체 매도가 성사됐으면 그 짝의 매수측을 맨 앞으로 — "이 종목을 사려고 팔았다"를 지킨다.
    const buyOrder = rotBuyFirst
      ? [...eligible.filter(p => p.code === rotBuyFirst), ...eligible.filter(p => p.code !== rotBuyFirst)]
      : eligible;
    if (canDeploy && !aiBlocksAll && !top1Unjudged) for (const pick of buyOrder) {
      if (ai.mode === 'live' && !ai.buy.has(pick.code)) continue;   // ★ AI 미승인 후보 스킵
      if (heldSet.has(pick.code)) continue;
      if (soldT[pick.code] === today) continue;
      if ((errT[pick.code]?.n ?? 0) >= ORDER_ERR_MAX) continue;   // 당일 주문거부 누적 → 다음 후보로
      // 섹터 캡: 후보와 같은 섹터를 이미 SECTOR_CAP.max개 보유 중이면 스킵(금융 편중 차단). sector 미상(null)은 캡 미적용.
      if (SECTOR_CAP.enabled) { const psec = SECTOR[pick.code]; if (psec && items.filter(it => SECTOR[it.symbol] === psec).length >= SECTOR_CAP.max) continue; }
      const strong = CONVICTION_SIZING.enabled && pick.conviction >= CONVICTION_SIZING.strongThreshold;
      const minRemainForSlots = MIN_PRICE * 2 * (LIVE_SLOTS - 1);
      const strongBudgetCap = Math.max(MIN_PRICE, cash - minRemainForSlots);
      const budget = strong ? Math.min(Math.floor(cash * CONVICTION_SIZING.strongFraction), strongBudgetCap) : diversified;
      if (pick.px >= budget) continue;   // 이 예산으론 못 삼 → 다음 후보
      // ★ 주문 직전 현재가 재조회 (2026-07-29 진단으로 발견한 결함 수정)
      //   pick.px는 신호스캔이 그 종목을 훑던 시점의 가격이다. uni420 스캔이 최소 44초(420×105ms rateSlot),
      //   메인루프 30초 폴링까지 겹치면 **1~2분 낡는다**. 여기에 limitBuyPx가 +0.5%를 더 얹으므로
      //   폭락장에선 지정가가 실시간 시장가보다 1%+ 위로 나가고, 크로싱 지정가라 그대로 체결된다.
      //   실측(07-29 매수 11건): 진입가가 직전 30분 구간의 **63% 지점**(무작위 시점 28%),
      //   카카오·한국항공우주는 구간 고점을 넘긴 150%·136%. 진입 후 +10분 -0.88% vs 무작위 -0.45%.
      let livePx = pick.px;
      try {
        const pm = await getPricesMap([pick.code]);          // Map(symbol → {price, timestamp})
        const fresh = Number(pm?.get?.(pick.code)?.price ?? 0);
        if (fresh > 0) {
          if (Math.abs(fresh / pick.px - 1) > 0.003) log(`가격 갱신 ${pick.name}(${pick.code}) 스캔 ${pick.px.toLocaleString()} → 현재 ${fresh.toLocaleString()} (${((fresh / pick.px - 1) * 100).toFixed(2)}%)`);
          livePx = fresh;
        }
      } catch (e) { log(`현재가 재조회 실패(스캔가 사용) ${pick.code}: ${String(e.message).slice(0, 50)}`); }
      if (livePx >= budget) continue;     // 갱신가로 예산 재확인
      const lpx = limitBuyPx(livePx);
      const qty = Math.floor(budget * 0.999 / lpx);
      if (qty < 1) continue;
      try {
        const o = await createOrder(seq, { symbol: pick.code, side: 'BUY', orderType: 'LIMIT', price: String(lpx), quantity: String(qty) });
        const filled = await settleOrder(o?.orderId ?? o?.id, pick.code, 'BUY', 0, `매수 ${pick.code}`, 0);
        if (filled.ok) {
          // ★ 2026-07-29: 진입가·트레일 고점을 **실제 체결가**로 잡는다.
          //   지정가(lpx)는 크로싱 상한선일 뿐이고 실측으로 체결가가 0.47~0.56% 낮았다.
          //   lpx를 쓰면 (a) 손익이 과대 손실로 기록되고 (b) 트레일선·손절선이 실제보다 높게 걸린다.
          const fpx = filled.fillPx ?? lpx;
          // ★ 갭정책: 진입 시점 갭으로 청산폭을 결정해 **포지션에 고정 저장**한다(장중 스위칭 아님).
          //   hi120에만 의미가 있지만(rsi2는 트레일 없음) 감사 목적으로 둘 다 기록한다.
          const gp = await gapPolicyToday(today);
          state.meta[pick.code] = {
            hi: fpx, entry: fpx, sub: pick.sub, boughtAt: now(),
            trailPct: gp.trailPct, tp1Pct: gp.tp1Pct, tp2Pct: gp.tp2Pct, gapBin: gp.bin ?? null,
          };
          if (state.orderErr) delete state.orderErr[pick.code];   // 체결됐으면 거부 카운트 초기화
          const size = strong ? `집중 ${Math.round(CONVICTION_SIZING.strongFraction * 100)}%몰빵` : `분산 1/${remainingSlots}`;
          // ★ 2026-07-30 로그 표시 수정: 갭정책 오버라이드(trail/tp)는 **hi120 청산에만 작동한다.**
          //   rsi2 청산은 하드손절 -7% / MA회귀 / 만기뿐이라 trail·tp를 쓰지 않는다.
          //   그런데 기존 로그는 sub 구분 없이 'G1 trail10'을 찍어 rsi2에도 적용되는 것처럼 보였다
          //   (07-30 5건 전부 rsi2인데 'rsi2/G1 trail10'으로 표기됨). meta에는 감사 목적으로 계속 저장한다.
          const gapTag = gp.bin
            ? (pick.sub === 'hi120' ? `/${gp.bin} trail${gp.trailPct}%` : `/${gp.bin}(미적용:rsi2)`)
            : '';
          log(`매수 ${pick.name}(${pick.code}) ${qty}주 @${fpx.toLocaleString()}${filled.fillPx ? '' : '(지정가)'} [${pick.sub}${gapTag}, 레짐 ${regime}, 확신도 ${pick.conviction.toFixed(1)}, ${size}${pick.rsi2 != null ? ', RSI2 ' + pick.rsi2.toFixed(1) : ', 돌파 ' + pick.breakout?.toFixed(1) + '%'}]`);
          recordTrade({ ts: now(), code: pick.code, name: pick.name, side: 'BUY', px: fpx, limitPx: lpx, fillSrc: filled.fillPx ? 'actual' : 'limit', qty, sub: pick.sub, regime, conviction: Number(pick.conviction.toFixed(1)), sizing: strong ? 'concentrate' : 'diversify' });
          // signalCache는 더 이상 여기서 비우지 않음(2026-07-24) — signalScanLoop가 독립적으로 계속 갱신하므로
          // 비우면 다음 백그라운드 스캔 완료까지 후보가 빈 채로 대기하게 돼 불필요하게 매수 기회를 놓침.
          writeFileSync(STATE, JSON.stringify(state, null, 1));
        }
      } catch (e) {
        // ★ 오류 전문 300자 (2026-07-29). 기존 80자는 토스 422 본문의 code 필드가 잘려
        //   07-28 프리마켓 거부 31회의 사유를 사후에 특정할 수 없었다(`"code":"mark` 까지만 남음).
        const msg = String(e.message).slice(0, 300);
        // 4xx = 거래소/서버가 이 주문을 확정 거부한 것 → 재시도로 뚫리지 않으므로 카운트.
        // 5xx·타임아웃은 일시장애라 카운트하지 않는다(멀쩡한 종목을 당일 제외하면 손해).
        const definitive = /:\s*4\d\d\s/.test(msg);
        let n = 0;
        if (definitive) {
          const rec = (state.orderErr ??= {})[pick.code] ??= { n: 0, day: today };
          rec.day = today; rec.n++; rec.msg = msg.slice(0, 120); n = rec.n;
          writeFileSync(STATE, JSON.stringify(state, null, 1));
        }
        log(`매수 오류 ${pick.name}(${pick.code})${definitive ? ` 확정거부 ${n}/${ORDER_ERR_MAX}회` : ' 일시장애(카운트 제외)'}: ${msg}`);
        if (definitive && n >= ORDER_ERR_MAX) log(`  → ${pick.name}(${pick.code}) 당일 진입 제외 — 연속 확정거부 ${n}회`);
      }
      bought = pick.code;
      break;  // 사이클당 진입 1건 (나머지 슬롯은 다음 폴에서 잔여현금 재계산 후 평가)
    }
    // ★ "팔고 안 사는" 사건은 조용히 지나가서는 안 된다 — 왕복비용을 확정 지출했는데 포지션이 없다.
    //   다음 사이클(30초)에 재시도되지만, 사용자가 모르면 안 되는 상태라 즉시 경보한다.
    if (rotBuyFirst && !bought) {
      log(`🚨 교체 매도했으나 이번 사이클 매수 0건 (목표 ${rotBuyFirst}) — 현금 유휴, 다음 사이클 재시도`);
      tgNotify(`🚨 즉시교체 미완: 매도는 됐는데 ${rotBuyFirst} 매수가 이번 사이클에 안 됐습니다.\n현금이 유휴 상태이고 다음 사이클(30초)에 재시도합니다. 반복되면 확인이 필요합니다.`);
    }
  } else if (marketOpen()) {
    logGate(`진입보류: 슬롯 ${bigCount}/${LIVE_SLOTS} · 현금 ${Math.round(cash / 10000).toLocaleString()}만(슬롯예산 ${Math.round(perSlot / 10000).toLocaleString()}만)${bear && !FORECAST_GUARD.shadow ? ' · 하락경보' : ''}`,
      `blocked|${bigCount}|${cash >= perSlot * CAPITAL_DEPLOY.minFillFraction ? 'cash' : 'nocash'}`);
  }
  await new Promise(r => setTimeout(r, POLL_MS));
}
