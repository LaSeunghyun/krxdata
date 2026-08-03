#!/usr/bin/env node
/**
 * backtest-swing.mjs — 일봉 기반 스윙·단기 전략 비교 시뮬레이터 (토스 일봉, 멀티 레짐)
 *
 *   v2: 유니버스를 토스 일봉에서 직접 PIT 계산 (stock_prices 의존 제거) →
 *       2023 약세~2024 횡보~2025-26 멜트업·조정 전 레짐 커버.
 *       전 종목 일봉은 candles-daily.jsonl 디스크 캐시 (첫 실행 ~25분, 이후 수 초).
 *       평가지표: 승률·Profit Factor·월별 일관성·MDD 중심 (복리 안정성 관점).
 *
 *   PIT: 일자 D 시그널은 D까지의 봉만 사용. 단 종목 풀 = 현재 상장 종목(생존 편향 존재) 주의.
 *   체결: 종가 매수 +1틱 / 시가 매도 -1틱, 스톱·익절은 종가 판정 → 익일 시가 집행.
 *   비용: 수수료 0.015%×2 + 매도 거래세 0.15%.
 *
 * 실행:
 *   node backtest-swing.mjs --from 20230102 --to 20260611 --capital 10000000
 *   node backtest-swing.mjs --strategies rsi2,hi120 --from 20240102 --to 20241230
 */
import dotenv from 'dotenv';
import { createReadStream, existsSync, appendFileSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDailyCandles } from './toss-api.js';
import { calcBuyCashImpact, calcSellCashImpact, calcRoundTripPnl, getSellTaxBps } from './execution-model.mjs';
import { LIVE_COMBO_CAPS, LIVE_UNIVERSE_LIMIT, LIVE_EXCLUDE, CONVICTION_SIZING, CAPITAL_DEPLOY, applySectorOverride } from './strategy-contract.mjs';
import { buildLiveCandidates, liveCandidateBudget } from './live-parity.mjs';
import { volatilityThrottleMultiplier } from './volatility-throttle.mjs';
import { absoluteTrendOn, hi120RegimeAllows, marketSeriesIndex, selectMomentumLeaders } from './research-strategies.mjs';
import { recordDailyEquity, serializeResearchBook } from './research-backtest-output.mjs';
import { ensureCandlesFresh } from './ensure-candles-fresh.mjs';
import { classify as classifyScenario } from './scenario-def.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const argv = process.argv.slice(2);
const argOf = (k, dflt) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : dflt; };
const FROM = argOf('--from', '20230102');
const TO = argOf('--to', '20260611');
const CAPITAL = Number(argOf('--capital', '10000000'));
const BARS_DEPTH = Number(argOf('--bars', '1150')); // 2022-01~ (FROM 이전 룩백 130일 포함)
const ONLY = argOf('--strategies', '').split(',').filter(Boolean);
// ★ 2026-07-30: 종가 소스 교체 실험용. 기본은 Toss(candles-daily.jsonl = KRX정규장+NXT 통합),
//   `--candles candles-daily-krx.jsonl` 을 주면 KRX 정규장 전용 일봉으로 같은 백테를 돌린다.
//   근거: 상위집합 제약(Toss고가>=KIS고가 AND Toss저가<=KIS저가) 390/390 = 100% → Toss는 NXT 포함 확정.
//   라이브 15:35 판정은 사실상 KRX 종가를 읽어 MA3 조건 판정이 5.1% 뒤집힌다(10:10 대칭 = 노이즈).
const CACHE_FILE = join(__dirname, argOf('--candles', 'candles-daily.jsonl'));
const CANDLES_ALT = CACHE_FILE !== join(__dirname, 'candles-daily.jsonl');
// 2026-07-24: 6주 stale 캐시로 리서치가 조용히 좁은 표본 도는 사고 재발 방지 — 실행 전 자동 신선도 체크(+장중이면 스킵).
// ★ 2026-07-30: --candles로 대체 소스를 쓸 때는 건너뛴다. 이 체크는 candles-daily.jsonl(Toss)을
//   대상으로 하고 갱신 시 **Toss를 호출**하는데, 토스 토큰은 단일 인스턴스라 라이브봇 세션을 깬다.
if (!argv.includes('--no-freshness-check') && !CANDLES_ALT) await ensureCandlesFresh();

// C31 (--stress 1): 슬리피지 ±2틱 + 수수료 2배 비관 시나리오
const STRESS = Number(argOf('--stress', 0));
const FEE_BPS = STRESS ? 3 : 1.5;
const TAX_BPS = getSellTaxBps('KOSPI');
const SLIP_TICKS = STRESS ? 2 : 1;
const MIN_PRICE = 2_000;
const MIN_TURNOVER = 30 * 1e8; // 20일 평균 거래대금 30억 미만 제외 (유동성)
const VOL_SHADOW = Number(argOf('--volshadow', 0));
// 장기 비교에서 window=30 / ref=252가 가장 안정적인 개선을 보여 기본값으로 둔다.
const VOL_WINDOW = Number(argOf('--volwindow', 30));
const VOL_REF_LOOKBACK = Number(argOf('--volref', 252));

const STRATEGIES = {
  'swing-mom':  { slots: 10 },                                        // ret60 top10 주간 리밸 + 스톱-25%/+100% 절반
  'swing-rank': { slots: 10 },                                        // 실제 daily_rankings (데이터 있는 날만)
  'vb':         { slots: 5, k: 0.5 },                                 // 변동성 돌파, 익일 시가 청산
  'overnight':  { slots: 5 },                                         // 종가 매수 → 익일 시가
  'hi120':      { slots: 10, lookback: 120, trailPct: 10, maxHold: 60 }, // 120일 신고가 + 트레일링
  'trend-cash': { slots: 3, lookback: 120 },                            // MA120 절대추세 + 120일 모멘텀 top3, 약세 현금
  'rsi2':       { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },    // 과매도 반등 (현재 시총 상위 — lookahead 주의)
  'rsi2-pit':   { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },    // 과매도 반등 (PIT 20일 거래대금 상위 — 테마주 포함)
  'rsi2-mcap':  { slots: 5, rsiMax: 10, stopPct: 7, maxHold: 10 },    // 과매도 반등 (PIT 시총 상위 = 당시 가격×발행주식수)
  'pullback':   { slots: 10, stopPct: 7, tpPct: 8, maxHold: 15 },     // C32: UP 추세주 MA20 눌림목 — 강한 기각 (PF 0.75)
  'gapfollow':  { slots: 10, stopPct: 7, gapPct: 4, trailPct: 8, maxHold: 10 }, // C33: 갭업 유지 추종 (스탠드얼론 검증)
  // combo: 레짐 적응형 — 상승장 hi120 비중↑, 중립 rsi2 비중↑, 하락장 rsi2 소량+현금
  'combo':      { slots: 10, rsiMax: 10, stopPct: 7, maxHoldR: 10, lookback: 120, trailPct: 10, maxHoldH: 60 },
  // combo-v2: 사유 기록 분석 반영 — hi120 돌파폭 3%+만, rsi2 최대보유 5일, NEUTRAL hi120 슬롯 2
  // ★ 2026-07-30: 라이브 HARD_STOP_PCT 를 7→15 로 올렸다(근거는 stock-live.mjs 주석). 백테 기본도 맞춘다.
  //   과거 비교를 재현할 때는 `--stoppct 7` 을 명시할 것. 라이브와 기본값이 갈리면 오늘 하루 종일 잡은
  //   "검증된 백테와 라이브가 다르다" 부류의 결함이 다시 생긴다.
  'combo-v2':   { slots: 10, rsiMax: 10, stopPct: 15, maxHoldR: 5, lookback: 120, trailPct: 8, maxHoldH: 60, minBreakout: 3, rsiDays: 2, tp1R: 1, rsiMa: 3, tp2R: 2, v2: true },
  // bb-mr: BB 하단밴드 이탈→재진입 확인(단순 터치 아님) 매수, 중심선 도달 전량청산 (rsi2 청산구조 재사용)
  'bb-mr':      { slots: 10, period: 20, mult: 2.0, stopPct: 7, maxHold: 10 },
  // bb-brk: 밴드폭 스퀴즈(120일 분포 하위 20%) 후 상단 돌파 매수, 트레일링 청산 (단독 hi120 청산구조 재사용)
  'bb-brk':     { slots: 10, period: 20, mult: 2.0, sqzLookback: 120, sqzQuantile: 0.20, trailPct: 10, maxHold: 60, stopPct: 7 },
  // hma-turn: HMA 슬로프 상향 반전 + 종가>HMA 매수, 슬로프 하향 청산 (Hull 정석 용법 — 크로스오버는 Hull 본인 비추라 미구현)
  'hma-turn':   { slots: 10, period: 25, stopPct: 7, maxHold: 60 },
  // hma-dip: HMA 하향 이탈 매수 → HMA 상향 복귀 청산 (QuantifiedStrategies 평균회귀 발견 falsification용)
  'hma-dip':    { slots: 10, period: 25, stopPct: 7, maxHold: 10 },
};
// combo-v2 파라미터 오버라이드 (스윕용): --trail 8 --minbreak 5 --maxholdr 3 --stoppct 5
// 가설 플래그: --volx N (hi120 돌파일 거래량 > 20일평균 ×N), --rsidays N (rsi2 N일 연속 과매도),
//             --downsize 0.5 (DOWN 레짐 rsi2 사이즈 배수), --tp1r 1 (1R 도달 시 절반 익절)
for (const [flag, key] of [['--trail', 'trailPct'], ['--minbreak', 'minBreakout'], ['--maxholdr', 'maxHoldR'], ['--stoppct', 'stopPct'],
  ['--volx', 'volX'], ['--rsidays', 'rsiDays'], ['--downsize', 'downSize'], ['--tp1r', 'tp1R'], ['--intraday', 'intradayExit'], ['--maxholdh', 'maxHoldH'], ['--rsiuni', 'rsiUni'], ['--entryopen', 'entryOpen'], ['--downflat', 'downFlat'], ['--rsima', 'rsiMa'], ['--tp2r', 'tp2R'], ['--trailwide', 'trailWide'], ['--maxbreak', 'maxBreak'], ['--atrsize', 'atrSize'], ['--lookback', 'lookback'], ['--rsitp', 'rsiTp'], ['--closeloc', 'closeLoc'], ['--rsivol', 'rsiVol'], ['--breakfail', 'breakFail'], ['--rsicut', 'rsiCut'], ['--pyramid', 'pyramid'], ['--slots', 'slots'], ['--rsiafford', 'rsiAfford'], ['--gapmax', 'gapMax'],
  // 2026-07-29 라이브-백테 괴리 검증(--rsitrail N): 라이브 봇은 rsi2 보유분에도 트레일 -6%를 걸지만
  //   백테의 검증된 rsi2 청산은 하드손절 -7%·MA5회귀·maxHoldR 만기뿐 — 트레일이 아예 없다.
  //   07-29 청산 15건 중 12건이 rsi2 트레일손절(전부 진입 2시간 내)이라 이 괴리가 실손실을 내고 있는지 판정해야 한다.
  //   N=0(기본)이면 현행 검증 동작. N>0이면 rsi2에 트레일 N% 적용.
  ['--rsitrail', 'rsiTrail'], ['--rsitp1', 'rsiTp1'],
  // 2026-07-29: rsi2 진입 임계(2일 RSI 상한). 현행 10. 오늘까지 CLI 오버라이드가 없어 스윕된 적이 없다.
  ['--rsimax', 'rsiMax'],
  // 2026-07-29 사용자 제안: 고정 % 대신 추세선 기반 청산
  //   --matrail N     hi120 트레일을 "종가 < MA(N)" 으로 대체 (0=기존 고정%)
  //   --rsilowstop N  rsi2 하드손절 -7%를 "종가 < 직전 N일 최저가" 로 대체 (0=기존 고정%)
  //     ※ rsi2에 MA 손절은 못 쓴다 — 과매도 진입이라 정의상 이미 모든 MA 아래여서 즉시 발동한다.
  //       그래서 추세선 대안은 구조적 지지선(직전 저가)이다.
  ['--matrail', 'maTrail'], ['--rsilowstop', 'rsiLowStop']]) {
  const v = argOf(flag, null);
  if (v != null) STRATEGIES['combo-v2'][key] = Number(v);
}
// bb-mr / bb-brk 파라미터 오버라이드 (스윕용, sweep-bb.mjs): --bbperiod 20 --bbmult 2.0
for (const [flag, key] of [['--bbperiod', 'period'], ['--bbmult', 'mult']]) {
  const v = argOf(flag, null);
  if (v != null) { STRATEGIES['bb-mr'][key] = Number(v); STRATEGIES['bb-brk'][key] = Number(v); }
}
// hma-turn / hma-dip 파라미터 오버라이드 (스윕용, sweep-hma.mjs): --hmaperiod 25
{
  const v = argOf('--hmaperiod', null);
  if (v != null) { STRATEGIES['hma-turn'].period = Number(v); STRATEGIES['hma-dip'].period = Number(v); }
}
const DUMP = argOf('--dump', null);
// ★ 2026-07-29 (--scendump FILE): 진입일의 시장 시나리오(scenario-def.mjs 5×4)를 거래별로 태깅해
//   시나리오별 집계가 가능한 per-trade JSON을 출력. 구성 1회 실행으로 20 시나리오 결과가 한꺼번에 나온다.
const SCENDUMP = argOf('--scendump', null);
// ★ 2026-07-29 (--scenpolicy FILE): 시나리오 조건부 파라미터 오버라이드 (scenario-policy.mjs 검증용).
//   FILE = { "T3V1": { "trailPct": 10 }, "T2V4": { "rsiVolMin": 1.25 }, ... }
//   의미론(측정과 동일해야 함): rsiVolMin은 진입일 필터, trailPct는 **진입일 시나리오로 포지션에 고정**
//   (tp1/tp2 부분익절 레벨 = trailPct×tp1R/tp2R 도 함께 스케일 — trail 스윕 런과 동일).
const SCENPOLICY_FILE = argOf('--scenpolicy', null);
const SCENPOLICY = SCENPOLICY_FILE ? JSON.parse(readFileSync(SCENPOLICY_FILE, 'utf8')) : null;
const SCEN_BY_DAY = new Map(); // day(YYYYMMDD) → 시나리오 키(T?V?) 또는 null. krx 로드 후 채움.
const COOLDOWN = Number(argOf('--cooldown', 0));
const DYNSLOT = Number(argOf('--dynslot', 0)); // MC3 I11: 포지션당 목표 예산(원), 0=비활성
// 레짐 노출 스로틀(2026-07-22 사용자 가설): 레짐별 총 투자비율. 나머지는 현금 보유. "--regimeexp 1.0,0.7,0.5"(UP,NEUTRAL,DOWN). null=현행(풀투자). live-parity 진입에만 적용.
const REGIME_EXP = (() => { const v = argOf('--regimeexp', null); if (!v) return null; const [u, n, d] = v.split(',').map(Number); return { UP: u, NEUTRAL: n, DOWN: d }; })();
// 2026-07-22 리서치 ICE#1: NEUTRAL 레짐 rsi2 진입 스킵(우리 regime pnl서 NEUTRAL rsi2=순손실). live-parity 진입에만 적용.
const SKIP_NEUTRAL_RSI = argv.includes('--skipneutralrsi');
// ★ 2026-07-30 (--downrsi N): DOWN 레짐 rsi2 슬롯 상한 오버라이드. -1(기본)=오버라이드 없음.
const DOWN_RSI = Number(argOf('--downrsi', -1));
// ★ 2026-07-30 (--maexitmin N): MA 익절에 '종가 > 진입가×(1+N%)' AND 조건. 미지정=조건 없음(현행).
//   0 이면 본전 초과에서만 익절. 음수도 허용(예: -1 = -1%까지는 허용).
const _mem = argOf('--maexitmin', null);
// ★ 2026-07-30 (--rsimarank): 확신도 동률 내 MA거리 내림차순 재정렬(풀 불변, 순서만).
// 값으로 방향을 받는다: desc=MA거리 큰 것 우선(급락 우선) · asc=작은 것 우선(완만한 딥 우선).
//   플래그만 주면 desc(하위호환). 2026-07-30 단일경로: desc 는 CAGR -6.4%·MDD 70.6% 로 파괴적이었다.
const _rmr = argOf('--rsimarank', null);
const RSI_MA_RANK = argv.includes('--rsimarank') ? (_rmr === 'asc' ? 'asc' : 'desc') : null;
const MA_EXIT_MIN = _mem == null ? null : Number(_mem);
// 2026-07-27 사용자 제안: 레짐을 시장(삼전) 프록시가 아니라 종목 자체 추세로 판정 (--selfregime)
const SELF_REGIME = argv.includes('--selfregime');
// --selfand: 시장 레짐은 그대로 두고, hi120 진입에 "종목 자체도 UP"을 추가 요구(교집합=더 엄격)
const SELF_AND = argv.includes('--selfand');
// 2026-07-25 사용자 요청: DOWN 레짐 rsi2도 스킵(=rsi2를 UP에서만). 분해검증서 rsi2 단독 5/5 손실 확인 후 검토.
const SKIP_DOWN_RSI = argv.includes('--skipdownrsi');
// 2026-07-25: rsi2 추세필터 — 진단된 rsi2 실패원인("떨어지는 칼날": 60일 -85% 종목까지 과매도로 잡음) 직접 차단.
//   --rsitrend N : rsi2 진입을 ret60 >= N% 인 종목으로 제한(0=off). 즉 "상승추세 종목의 눌림만" 매수.
const RSI_TREND = Number(argOf('--rsitrend', 0));
// 2026-07-25: rsi2 최대낙폭 필터 — 최근 20일 수익률이 -N% 이하로 붕괴한 종목 제외(구조적 하락 배제). 0=off.
const RSI_MAXDD20 = Number(argOf('--rsimaxdd20', 0));
// ★ 2026-07-30 (--maxnew N): 하루 신규진입 건수 상한(0=off).
//   계기 = 07-30 라이브가 폭락 하루에 5슬롯 전액을 3분 만에 같은 신호(rsi2·RSI2 0.0)로 채워
//   5개 독립 베팅이 아니라 1개 베팅 5배가 됐다. 슬롯 수는 총노출만 제한하고 **동시성**은 제한하지 않는다.
const MAX_NEW = Number(argOf('--maxnew', 0));
/**
 * ★ 2026-07-29 사용자 제안(--rsimindist N): rsi2 진입 시 **익절목표까지의 거리**를 요구한다.
 *   rsi2의 익절은 "종가 > MA(rsiMa)" 이고 손절은 진입 -stopPct% 고정이다. 그런데 진입 시점에
 *   MA가 종가 바로 위에 있으면 7%를 걸고 1%를 벌려는 거래가 된다(손익비 0.14).
 *   실거래 07-29 실측: 5종목의 MA3 거리가 +1.0%(카카오) ~ +21.8%(하이브)로 벌어졌다.
 *   ※ 이 지표의 가치: 폭락장에서 RSI2(전원 0.0)·확신도(전원 5.0)가 **포화돼 서열이 안 되는데
 *     MA 거리는 20배 차이로 벌어진다** = 판별력이 살아있는 유일한 축. 로테이션 랭킹 신호 후보.
 *   룩어헤드 없음: 진입일 종가까지의 MA는 그 시점에 계산 가능하고 청산은 이후 날짜 종가다.
 *   N=0(기본)이면 필터 없음(현행 동작).
 */
const RSI_MIN_DIST = Number(argOf('--rsimindist', 0));
// --atrexit K: 청산폭(트레일·하드손절·부분익절)을 진입시점 ATR(14)%에 비례. 0=고정폭(현행). 상세는 atrExitBands 주석.
const ATR_EXIT = Number(argOf('--atrexit', 0));
/**
 * ★ 2026-07-29 IC 연구 결과 (--rsiatrmax N): **rsi2 진입 시 ATR% 상한**.
 *
 * 근거(research-ic.mjs, 횡단면 예측력 2,576종목 868일):
 *   atrPct 20일 IC **-0.1744 (t=-39.3)** · vol20 IC -0.1702 (t=-41.7) — 2위권을 두 배 앞선 1위.
 *   20일 십분위 스프레드 -3.58~-3.93% · **4년 부호 전부 일관**.
 *   저변동성 프리미엄은 전세계 주식에서 가장 견고한 인자 중 하나이고 여기서도 그렇게 나왔다.
 *
 * 왜 지금 전략에 없나: rsi2는 폭락 종목을 사고 그건 정의상 고변동성이다 → 가장 강한 인자를 거스른다.
 * 왜 이 축이 특별한가: 확신도(폭락장 전원 5.0)·RSI2(전원 0.0)는 **포화돼 서열이 안 되는데**
 *   atrPct는 후보마다 연속적으로 다르다 = 오늘 로테이션·사이징이 막혔던 "랭킹 신호 없음"의 해답 후보.
 * ★ 생존편향이 이번엔 유리한 방향: 폐지 종목은 대부분 고변동성 → 빠져 있으면 고변동성 십분위가
 *   실제보다 좋게 나온다 → **측정된 저변동성 프리미엄은 과소평가**다.
 *
 * N=0(기본)이면 필터 없음(현행). N>0이면 ATR(14)% <= N 인 후보만 매수.
 */
const RSI_ATR_MAX = Number(argOf('--rsiatrmax', 0));
/**
 * ★ 2026-07-29 (--rsiatrrank 1): ATR을 **하드 필터가 아니라 순위**로 쓴다.
 *   오늘 두 번 확인된 교훈: volRatio(IC +0.035)·atrPct(IC -0.174) 둘 다 **예측력은 있는데
 *   하드컷으로 쓰면 갈린다.** 원인은 공통 — 좁은 후보 풀을 더 깎아 분산을 파괴하기 때문이다.
 *   순위로 쓰면 **후보 수는 그대로고 어느 종목이 슬롯을 차지하는지만 바뀐다.**
 *   적용 지점: 확신도 동률(폭락장에서 rsi2 전원 5.0으로 포화 → 지금은 순서가 사실상 임의) 내
 *   ATR% 오름차순. 저변동성 프리미엄(IC t=-39.3, 4년 일관)을 분산 손실 없이 쓰는 형태.
 */
const RSI_ATR_RANK = argv.includes('--rsiatrrank');
/**
 * ★ 2026-07-29 (--rsiflow N --rsiflowdays D): **rsi2 진입에 수급 조건**을 요구한다.
 *   지금 --flowout/--flowsell은 hi120 전용이라 rsi2엔 수급 조건이 아예 없다.
 *   논리: rsi2는 폭락 종목을 사고 논리가 평균회귀인데, 기관·외국인이 아직 순매도 중이면
 *   반등이 아니라 falling knife일 수 있다. 최근 D거래일 누적(기관+외국인) >= N억 이어야 매수.
 *   N은 음수 허용(예: -50 = "50억 넘는 순매도만 회피").
 *   근거: 같은 신호가 다른 역할(--flowexit, hi120 보유분 청산)에서 오늘까지 **유일하게 MC를 통과**했다.
 *   데이터: krx-flows.json 610종목 · 868거래일(20230102~20260724) 중앙값 전체 커버.
 *   N=미지정이면 필터 없음(현행).
 */
const RSI_FLOW = argv.includes('--rsiflow') ? Number(argOf('--rsiflow', 0)) : null;
const RSI_FLOW_DAYS = Number(argOf('--rsiflowdays', 5));
// 2026-07-25 패배 forensic 가설A: 확신도 집중매수(현금50% 몰빵)를 rsi2엔 미적용(hi120만 허용).
//   근거: rsi2/stop_loss 54건 평균 -28만(전체 패배평균 -14만의 2배), 최악거래 4건 전부 UP·RSI0·stop_loss
//   = conviction(10-RSI)×1.0=10 ≥ threshold7 → 50% 몰빵 대상. rsi2 단독 CAGR -3.5%인데 몰빵 허용 구조.
const NO_CONC_RSI2 = argv.includes('--noconc-rsi2');
// 2026-07-25 판별자 가설C: 애널리스트 컨센서스 목표가 대비 여력 필터 (analyst-hist.json 필요).
//   근거(in-sample 버킷): hi120 진입가>컨센서스 n=153 거래당 -4만 / 여력0~20% n=233 -2만
//                        / 여력20~50% n=31 **+7만**(승률74%) / 여력50%+ n=23 **+10만**(승률70%) / 미커버 n=214 **+6만**(승률67%)
//   --anup N : 커버된 종목은 컨센서스 여력 ≥ N% 일 때만 진입(미커버는 통과). 0=off
//   --anup-nocov-skip : 미커버 종목도 제외(미커버 우위가 데이터 결함인지 확인용 대조군)
const AN_UP = Number(argOf('--anup', 0));
const AN_NOCOV_SKIP = argv.includes('--anup-nocov-skip');
const AN_HIST = (() => {
  if (!AN_UP && !AN_NOCOV_SKIP) return null;
  try { return JSON.parse(readFileSync(join(__dirname, 'analyst-hist.json'), 'utf8')); }
  catch { console.error('⚠️ analyst-hist.json 없음 — 애널리스트 필터 비활성'); return null; }
})();
const anRank = (o) => { const t = String(o ?? '').toLowerCase().replace(/\s/g, ''); if (!t || t.includes('notrated') || t === 'n/r') return null; if (/매도|sell|underperform|underweight/.test(t)) return 1; if (/중립|hold|neutral|marketperform/.test(t)) return 2; if (/매수|buy|outperform|overweight|적극/.test(t)) return 3; return null; };
/** 진입일(day, YYYYMMDD) 이전 90일 리포트만으로 컨센서스 목표가 산출. null=커버리지 없음 */
function anConsensus(code, day) {
  const rows = AN_HIST?.[code]; if (!rows?.length) return null;
  const d = String(day);
  const cut = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - 90 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const t = rows.filter(r => r.date < d && r.date >= cut && anRank(r.opinion) != null && r.targetPrice > 0).map(r => r.targetPrice).sort((a, b) => a - b);
  return t.length ? t[Math.floor(t.length / 2)] : null;
}
// 2026-07-25 판별자 가설D: 수급(기관+외국인) 이탈 종목의 돌파 배제. krx-flows.json(pykrx 백필) 필요.
//   근거(in-sample, 1064거래 전량): hi120 20일누적 -100억이하 n=73 거래당 **-6만·승률47%** / 100억+ n=307 **+4만·68%**
//                                 5일 둘다순매도 n=75 -1만(유일 음수) / 둘다순매수 n=169 +3만·66%
//   --flowout N : 20일 누적(기관+외국인) ≤ -N억 이면 hi120 진입 배제 (0=off)
//   --flowsell  : 5일 기관·외국인 둘다 순매도면 hi120 진입 배제
//   ※ 데이터 없는 종목은 통과(미수집=배제로 오분류 방지). 유니버스 전체 백필 후 쓸 것.
const FLOW_OUT = Number(argOf('--flowout', 0));
const FLOW_SELL = argv.includes('--flowsell');
// 가설E(사용자 제안): 보유 중 수급 붕괴 시 청산. --flowexit N(억, 0허용) + --flowexitdays D(기본 5)
const FLOW_EXIT = argv.includes('--flowexit') ? Number(argOf('--flowexit', 0)) : null;
const FLOWEXIT_DAYS = Number(argOf('--flowexitdays', 5));
// 2026-07-27: 수급붕괴 청산 적용 범위. hi120(배포본 기본) | rsi2 | both. --flowexitsub
const FLOWEXIT_SUB = String(argOf('--flowexitsub', 'hi120'));
/**
 * ★ 2026-08-01 `--flowexitnow` — 수급청산 집행 시점.
 *
 * 라이브(stock-live.mjs)는 수급붕괴를 감지하면 청산 루프에서 `createOrder` 로 **장중 즉시** 판다.
 * 백테는 `exitAtOpen` 이라 **익일 시가**에 팔았다. 정보집합은 같고(둘 다 전일까지 확정 수급)
 * 집행 시점만 정확히 **1거래일** 다르다 — 신호는 X일 마감 후 확정 → 라이브 X+1 시가 / 백테 X+2 시가.
 *
 * 30시드 MC 로 두 타이밍을 재봤다(노이즈 바닥 0.380, 전 arm 30/30 완주):
 *   A 익일시가(백테 기존)  CAGR 35.3% MDD 25.7% **Calmar 1.37**  최악시드 19.9%
 *   B 당일시가(라이브)     CAGR 45.5% MDD 23.2% **Calmar 1.96**  최악시드 24.9%  ← Δ+0.59, 시드 28승2패
 *   C 수급청산 off         CAGR 39.6% MDD 24.6% Calmar 1.61
 * **라이브가 맞고 백테가 틀렸다.** 바닥(0.380)을 넘는 실질 개선이고 꼬리(최악시드·최대MDD)도 B 가 낫다.
 * → `--live-parity` 면 자동으로 당일 시가 집행을 쓴다. 그래야 백테가 라이브를 재현한다.
 *
 * ※ 남은 미결: **규칙 자체의 존치**는 아직 미확정이다. 올바른 타이밍끼리 비교하면
 *   B(1.96) vs C(1.61) = Δ+0.35 로 바닥 0.380 **바로 아래**다 = 경계값이라 판정 불가.
 *   경계값에서는 기각·채택이 아니라 **시드를 늘리는 것**이 올바른 대응이다(손절 15% 가 30시드
 *   미통과 → 60시드 통과로 갈린 전례). 라이브에서 이 규칙은 hi120 전용이고 hi120 진입이
 *   아직 0건이라 발동한 적이 없으므로 급하지 않다 — UP 레짐 전환 전에 60시드로 매듭지을 것.
 */
/**
 * ★ 2026-08-02 `--exitsameday <mode>` — 청산 **집행 시점**을 당일 종가로 바꾼다.
 *
 * 현행: 15:35 종가로 판정하고 `exitAtOpen` 으로 **익일 시가**에 집행한다.
 *   판정 가격과 체결 가격 사이에 하룻밤이 들어가므로 갭만큼 실현손익이 벌어진다.
 *   손절이 특히 나쁘다 — 이미 -15% 인 포지션이 갭하락하면 실현이 -30% 가 될 수 있고 상한이 없다.
 *   봇이 금요일 종가에 팔 수 없다는 구조적 제약(판정=종가·집행=익일개장)에서 나온다.
 * 대안: KRX 마감(15:30) 후에도 NXT 애프터마켓(15:40~20:00)이 열려 있으므로 **당일 청산이 가능**하다.
 *
 * mode: stop = 하드손절만 당일 집행 / all = 종가판정 청산 전부 당일 집행 / off(기본) = 현행
 *
 * ⚠️ 이 시뮬레이션의 한계를 명시한다(백테로 못 잡는 것):
 *   ① Toss 일봉 종가는 **20:00 NXT 애프터 종가**다. KRX 15:30 종가가 아니다
 *      (완전일치율 2024년 91.4% → 2026년 51.5%. NXT 는 2025년 가동).
 *      즉 여기서 `cd.c[i]` 로 파는 것은 "15:40 에 즉시" 가 아니라 "애프터마켓 종료 시점"에 가깝다.
 *      실제 라이브는 15:35 판정 직후 체결을 시도하므로 그 사이 가격이 다르다.
 *   ② NXT 애프터마켓은 **유동성이 얇다.** 백테는 종가에 전량 체결을 가정하지만 실제로는
 *      부분체결·슬리피지가 난다(07-28 프리마켓 422 거부 31회 전례). 그 비용은 여기 반영되지 않는다.
 *   → 따라서 이 측정이 개선을 보여도 **그대로 배포 근거가 되지 않는다.** 개선 폭이 위 두 비용을
 *      덮을 만큼 큰지가 판단 기준이고, 그 비용은 라이브 관측으로만 확정된다.
 */
const EXIT_SAMEDAY = String(argOf('--exitsameday', 'off'));
const FLOWEXIT_NOW = argv.includes('--flowexitnow') || argv.includes('--live-parity');
const FLOWS = (() => {
  if (!FLOW_OUT && !FLOW_SELL && FLOW_EXIT == null && RSI_FLOW == null) return null;
  try { return JSON.parse(readFileSync(join(__dirname, 'krx-flows.json'), 'utf8')); }
  catch { console.error('⚠️ krx-flows.json 없음 — 수급 필터 비활성'); return null; }
})();
/** 진입일(YYYYMMDD) 이전 n거래일 수급 합(억). null=데이터 부족 */
function flowSum(code, day, n) {
  const rec = FLOWS?.[code]; if (!rec) return null;
  const ks = Object.keys(rec).filter(k => k < day).sort().slice(-n);
  if (ks.length < n) return null;
  let org = 0, frg = 0;
  for (const k of ks) { org += rec[k][0]; frg += rec[k][1]; }
  return { org: org / 1e8, frg: frg / 1e8, both: (org + frg) / 1e8 };
}
// 2026-07-25 패배 forensic 가설B: live-parity에서 돌파폭 상한(기존 --maxbreak는 이 경로에 안 물림).
//   근거: 거래당 평균수익이 돌파폭에 반비례(3-4%:7만 / 4-6%:5만 / 6-10%:2만 / 10%+:2만), 최악거래 14건 전부 돌파10%+
const MAXBREAK_LIVE = Number(argOf('--maxbreaklive', 0));
// 2026-07-22 사용자 가설: 상대손절 — 시장(005930 프록시) 대비 진입후 낙폭이 N배 이상이면 매도(상대약세 컷). "--relstop 2". 0=off.
const RELSTOP = Number(argOf('--relstop', 0));
// 2026-07-23: live-parity 유니버스 크기 오버라이드(위성 활동성 스윕용). 기본 LIVE_UNIVERSE_LIMIT(40). mcapUniverse=KOSPI+KOSDAQ 시총순.
const LIVE_UNI = Number(argOf('--liveuni', LIVE_UNIVERSE_LIMIT));
const TPFRAC = Number(argOf('--tpfrac', '0.5')); // 부분익절 매도비율 (0.5=절반, 0.333=1/3→러너↑ 꼬리포착↑)
const MAXPOS = Number(argOf('--maxpos', '0')); // 총 종목수 상한 (0=무제한=현금기반 재투입, N=현행 live의 종목수 게이트 모사)
const SECTORCAP = Number(argOf('--sectorcap', '0')); // 섹터당 최대 동시보유 종목수 (0=무제한). 금융 편중 완화 테스트용(2026-07-22).
const LIVE_PARITY = argv.includes('--live-parity'); // 라이브 진입계약: 시총 top40 공통 유니버스·conviction 정렬·자본기반 사이징
const NO_UP_RSI = argv.includes('--no-up-rsi');     // 실험 변수: UP 레짐 rsi2 후보만 제거
STRATEGIES.hi120.slots = Number(argOf('--hislots', STRATEGIES.hi120.slots));
const HI_REGIME = argOf('--hiregime', 'all');
// 최약슬롯 교체(ROTATE, 2026-07-22): 현금 부족 + 신규 신호 시, 최약 laggard(수익≤rotmaxret·보유≥rotminhold·부분익절 미진행)를 팔아 자금 확보 후 신규 매수. 승자·트레일은 절대 안 건드림.
const ROTATE = argv.includes('--rotate');
const ROTATE_MAXRET = Number(argOf('--rotmaxret', '0')) / 100; // 자금원 후보 최대수익률(%). 0=플랫/손실만(승자 보호)
const ROTATE_MINHOLD = Number(argOf('--rotminhold', '3'));     // 최소보유일(당일·조기 청산 방지)
const ACTIVE = Object.entries(STRATEGIES).filter(([k]) => !ONLY.length || ONLY.includes(k));

function tickSize(p) {
  if (p < 2_000) return 1;
  if (p < 5_000) return 5;
  if (p < 20_000) return 10;
  if (p < 50_000) return 50;
  if (p < 200_000) return 100;
  if (p < 500_000) return 500;
  return 1_000;
}
/**
 * ★ 2026-07-29 (--crosspct P): **라이브가 실제로 내는 크로싱 지정가 프리미엄**을 비용에 반영.
 *   확정된 괴리: 백테는 슬리피지를 1틱(10만원 종목이면 0.1%)으로 잡는데
 *   라이브는 `limitBuyPx = 현재가 × 1.005` / `limitSellPx = 현재가 × 0.995` = **편당 0.5%**를 낸다.
 *   NXT가 시장가를 거부해서 크로싱을 쓰는 것인데, 그 비용이 백테에 없어 성과가 과대평가돼 있었다.
 *   분봉 실측(785신호): 현재가 소극적 지정가로 바꾸면 **5분 내 97.5% 체결**, 미체결 기회비용 -0.04%,
 *   순효과 +0.45%p/건 → 즉 이 비용은 회수 가능한 것이다.
 *   P=0(기본)이면 기존 1틱 모델(과거 결과와 비교 가능하게 유지).
 */
const CROSS_PCT = Number(argOf('--crosspct', 0));
const tickUp = (p) => {
  const base = Math.round(p / tickSize(p)) * tickSize(p) + tickSize(p) * SLIP_TICKS;
  return CROSS_PCT > 0 ? base * (1 + CROSS_PCT / 100) : base;
};
const tickDn = (p) => {
  const base = Math.round(p / tickSize(p)) * tickSize(p) - tickSize(p) * SLIP_TICKS;
  return CROSS_PCT > 0 ? base * (1 - CROSS_PCT / 100) : base;
};
const fmtDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
function netPnl(entry, exit, qty) {
  return calcRoundTripPnl({ entry, exit, qty, feeBps: FEE_BPS, taxBps: getSellTaxBps('KOSPI') });
}

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? 'DB 쿼리 오류');
  return data;
}

// ── 일봉 풀: 디스크 캐시 우선, 누락분만 API ───────────────────
// 구조: code → { d:[yyyymmdd...오름차순], o,h,l,c,v:[...], byDate:Map }
const candles = new Map();
function indexOfDate(cd, day) { return cd.byDate.get(day); }
function lastIndexBefore(cd, day) {
  // 이진 탐색: d[i] < day 인 최대 i
  let lo = 0, hi = cd.d.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cd.d[m] < day) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function addToPool(code, rec) {
  rec.byDate = new Map(rec.d.map((dt, i) => [dt, i]));
  candles.set(code, rec);
}
async function loadPool(codes) {
  if (existsSync(CACHE_FILE)) {
    console.log('캐시 로드:', CACHE_FILE);
    const rl = createInterface({ input: createReadStream(CACHE_FILE), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { const rec = JSON.parse(line); addToPool(rec.code, rec); } catch {}
    }
    console.log(`캐시 ${candles.size}종목`);
  }
  const missing = codes.filter(c => !candles.has(c));
  // ★ 대체 종가 소스(--candles)를 쓸 때는 Toss 자동 보충을 금지한다. 보충하면 한 백테 안에
  //   KRX 전용 봉과 NXT 통합 봉이 섞여 비교의 의미가 사라진다(조용한 오염). 누락은 드러내야 한다.
  if (missing.length && CANDLES_ALT) {
    console.log(`⚠️ 대체 캔들소스(${CACHE_FILE}) 사용 중 — 누락 ${missing.length}종목을 Toss로 보충하지 않는다.`);
    console.log(`   누락분은 유니버스에서 자연히 빠진다. 앞 10개: ${missing.slice(0, 10).join(' ')}`);
  } else if (missing.length) {
    console.log(`일봉 신규 수집 ${missing.length}종목 (~${Math.round(missing.length * 6 * 0.105 / 60)}분)...`);
    let done = 0;
    for (const code of missing) {
      try {
        const list = (await getDailyCandles(code, BARS_DEPTH)).reverse();
        const rec = {
          code,
          d: list.map(b => String(b.timestamp).slice(0, 10).replace(/-/g, '')),
          o: list.map(b => b.open), h: list.map(b => b.high),
          l: list.map(b => b.low), c: list.map(b => b.close), v: list.map(b => b.volume),
        };
        addToPool(code, rec);
        const { byDate, ...persist } = rec;
        appendFileSync(CACHE_FILE, JSON.stringify(persist) + '\n');
      } catch { /* 미커버 스킵 */ }
      if (++done % 200 === 0) console.log(`  ${done}/${missing.length}`);
    }
  }
}

// ── PIT 모멘텀 유니버스 (주간, 일봉 로컬 계산) ─────────────────
const universeCache = new Map();
function weekKey(day) {
  const d = new Date(`${fmtDay(day)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function momUniverse(day) {
  const wk = weekKey(day);
  if (universeCache.has(wk)) return universeCache.get(wk);
  const scored = [];
  for (const [code, cd] of candles) {
    const i = lastIndexBefore(cd, day);
    if (i < 61) continue;
    const price = cd.c[i];
    if (price < MIN_PRICE) continue;
    let turnover = 0;
    for (let j = i - 19; j <= i; j++) turnover += cd.c[j] * cd.v[j];
    turnover /= 20;
    if (turnover < MIN_TURNOVER) continue;
    const ret60 = (price / cd.c[i - 61] - 1) * 100;
    if (ret60 <= 0) continue;
    scored.push({ code, ret60, turnover });
  }
  scored.sort((a, b) => b.ret60 - a.ret60);
  universeCache.set(wk, scored.slice(0, 30).map(s => s.code));
  return universeCache.get(wk);
}

const trendUniverseCache = new Map();
function trendUniverse(day, lookback = 120) {
  const key = `${weekKey(day)}:${lookback}`;
  if (trendUniverseCache.has(key)) return trendUniverseCache.get(key);
  const rows = [];
  for (const code of mcapUniverse(day, LIVE_UNIVERSE_LIMIT)) {
    const cd = candles.get(code);
    const i = cd ? lastIndexBefore(cd, day) : -1;
    if (i < lookback) continue;
    rows.push({ code, momentum: cd.c[i] / cd.c[i - lookback] - 1 });
  }
  const leaders = selectMomentumLeaders(rows, 6).map(row => row.code);
  trendUniverseCache.set(key, leaders);
  return leaders;
}

// PIT 유동성 상위 30 (20일 평균 거래대금) — rsi2-pit용, 시총 lookahead 제거
const liqCache = new Map();
function liqUniverse(day) {
  const wk = weekKey(day);
  if (liqCache.has(wk)) return liqCache.get(wk);
  const scored = [];
  for (const [code, cd] of candles) {
    const i = lastIndexBefore(cd, day);
    if (i < 20) continue;
    if (cd.c[i] < MIN_PRICE) continue;
    let turnover = 0;
    for (let j = i - 19; j <= i; j++) turnover += cd.c[j] * cd.v[j];
    scored.push({ code, turnover: turnover / 20 });
  }
  scored.sort((a, b) => b.turnover - a.turnover);
  liqCache.set(wk, scored.slice(0, 30).map(s => s.code));
  return liqCache.get(wk);
}

// PIT 시총 상위 30 — 발행주식수(현재값 근사) × 당시 종가. 주식수 변동은 가격 대비 미미
const sharesEst = new Map(); // code → 추정 발행주식수
const mcapCache = new Map();
function mcapUniverse(day, top = MCAP_TOP) {
  const wk = weekKey(day) + ':' + top;
  if (mcapCache.has(wk)) return mcapCache.get(wk);
  const scored = [];
  for (const [code, cd] of candles) {
    const sh = sharesEst.get(code);
    if (!sh) continue;
    const i = lastIndexBefore(cd, day);
    if (i < 20 || cd.c[i] < MIN_PRICE) continue;
    let turnover = 0;
    for (let j = i - 19; j <= i; j++) turnover += cd.c[j] * cd.v[j];
    if (turnover / 20 < MIN_TURNOVER) continue;
    scored.push({ code, mcap: sh * cd.c[i] });
  }
  scored.sort((a, b) => b.mcap - a.mcap);
  mcapCache.set(wk, scored.slice(0, top).map(s => s.code));
  return mcapCache.get(wk);
}

/**
 * ★ 2026-07-29 설계 재검토 (--uni turnover): **완전 PIT 유니버스**.
 *
 * 기존 mcapUniverse의 결함: 과거 시총을 `sharesEst(현재 발행주식수) × 과거 종가`로 계산한다.
 *   그 사이 분할·증자·감자를 한 종목은 과거 시총이 왜곡돼 top-N 편입 여부가 틀린다(아나크로니즘).
 *   더 심한 건 largeCaps(696행) — `stock_analysis ORDER BY market_cap_tril DESC`로 **현재 시총 정적 리스트**를
 *   2023년에도 그대로 쓴다. 날짜 인자가 아예 없다 = 완전 lookahead.
 *
 * 거래대금은 `과거 종가 × 과거 거래량`이라 **발행주식수가 필요 없고 전부 그 시점 값**이다.
 *   → 아나크로니즘이 구조적으로 사라진다. 유동성 기준이라 실제 체결 가능성과도 더 잘 맞는다.
 *
 * ※ 남는 편향: candles 자체가 현재 상장분(생존편향). 이건 폐지종목 가격이력이 없어 제거 불가.
 *   공시 테이블은 3개월치뿐이라 보정도 불가. **절대 수치는 여전히 낙관**임을 전제로 읽어야 한다.
 */
const turnoverCache = new Map();
function turnoverUniverse(day, top) {
  const wk = weekKey(day) + ':t' + top;
  if (turnoverCache.has(wk)) return turnoverCache.get(wk);
  const scored = [];
  for (const [code, cd] of candles) {
    const i = lastIndexBefore(cd, day);
    if (i < 20 || cd.c[i] < MIN_PRICE) continue;
    let t = 0;
    for (let j = i - 19; j <= i; j++) t += cd.c[j] * cd.v[j];
    const avg = t / 20;
    if (avg < MIN_TURNOVER) continue;
    scored.push({ code, t: avg });
  }
  scored.sort((a, b) => b.t - a.t);
  const out = scored.slice(0, top).map(s => s.code);
  turnoverCache.set(wk, out);
  return out;
}
// --uni mcap(기본, 기존 동작) | turnover(완전 PIT)
const UNI_MODE = String(argOf('--uni', 'mcap'));
const pickUniverse = (day, top) => (UNI_MODE === 'turnover' ? turnoverUniverse(day, top) : mcapUniverse(day, top));

// C23 (--regimemode breadth): 시장 breadth(MA 위 비율)로 레짐 판정
//   --breadthma N    : breadth MA 윈도우 (기본 20 = 단기, 200 = 고전적 장기 breadth)
//   --breadthuni X   : large=시총 top30(기본) | all=전체 상장 유니버스
//   --breadthup/down : UP/DOWN 임계 비율 (기본 0.6 / 0.35)
// I14 (codex 제안): --breadthma 200 --breadthuni all --breadthup 0.55 --breadthdown 0.35
//   → 005930 단일종목 프록시 대신 시장 전체 MA200 breadth로 caps D 강건성 교차검증
const REGIME_MODE = argOf('--regimemode', 'proxy');
const BREADTH_MA = Number(argOf('--breadthma', '20'));
const BREADTH_UNI = argOf('--breadthuni', 'large');
const BREADTH_UP = Number(argOf('--breadthup', '0.6'));
const BREADTH_DOWN = Number(argOf('--breadthdown', '0.35'));
const breadthCache = new Map();      // day → 'UP'|'NEUTRAL'|'DOWN'
const breadthFracCache = new Map();  // day → 0..1 (MA 위 비율)
function breadthFraction(day) {
  if (breadthFracCache.has(day)) return breadthFracCache.get(day);
  // breadth는 시장 전체 신호 — subsample과 무관하게 전체 종목으로 계산 (레짐 일관성)
  const codes = BREADTH_UNI === 'all' ? allCodes : largeCaps;
  let above = 0, total = 0;
  for (const code of codes) {
    const cd = candles.get(code);
    const i = cd ? indexOfDate(cd, day) ?? lastIndexBefore(cd, day) : null;
    if (i == null || i < BREADTH_MA) continue;
    let ma = 0;
    for (let j = i - BREADTH_MA + 1; j <= i; j++) ma += cd.c[j];
    ma /= BREADTH_MA;
    total++;
    if (cd.c[i] > ma) above++;
  }
  const pct = total > 0 ? above / total : 0.5;
  breadthFracCache.set(day, pct);
  return pct;
}
function breadthRegime(day) {
  if (breadthCache.has(day)) return breadthCache.get(day);
  const pct = breadthFraction(day);
  const r = pct >= BREADTH_UP ? 'UP' : pct <= BREADTH_DOWN ? 'DOWN' : 'NEUTRAL';
  breadthCache.set(day, r);
  return r;
}
// I15 (codex 라운드2 헤지): breadth를 veto가 아닌 OR 승격 + 리스크가드로만 사용
//   --regimehedge 1 : proxyUp OR breadthUp → UP 승격 (breadth는 차단 불가, 승격만)
//   --hedgeup F     : breadthUp 임계 (MA200 breadth 비율, 기본 0.55)
//   --hedgeweak F   : breadthWeak 임계 (기본 0.30) — proxyUp & breadthWeak이면 진입예산 축소
//   --hedgecut F    : 약세확인 시 진입예산 배수 (기본 0.7)
const REGIME_HEDGE = Number(argOf('--regimehedge', '0'));
const HEDGE_UP = Number(argOf('--hedgeup', '0.55'));
const HEDGE_WEAK = Number(argOf('--hedgeweak', '0.30'));
const HEDGE_CUT = Number(argOf('--hedgecut', '0.7'));
const HEDGE_MA = Number(argOf('--hedgema', '200'));
function hedgeBreadthFrac(day) {
  // 헤지용 breadth는 항상 전체 유니버스 MA(HEDGE_MA) — 메인 레짐모드와 독립
  return _breadthFracMA(day, HEDGE_MA);
}
const _hedgeFracCache = new Map();
function _breadthFracMA(day, ma) {
  const key = day + ':' + ma;
  if (_hedgeFracCache.has(key)) return _hedgeFracCache.get(key);
  let above = 0, total = 0;
  for (const code of allCodes) {
    const cd = candles.get(code);
    const i = cd ? indexOfDate(cd, day) ?? lastIndexBefore(cd, day) : null;
    if (i == null || i < ma) continue;
    let s = 0;
    for (let j = i - ma + 1; j <= i; j++) s += cd.c[j];
    if (cd.c[i] > s / ma) above++;
    total++;
  }
  const pct = total > 0 ? above / total : 0.5;
  _hedgeFracCache.set(key, pct);
  return pct;
}

// 시장 레짐 (005930 프록시, 당일 종가 기준): UP / NEUTRAL / DOWN
function proxyRegime(day) {
  const cd = candles.get('005930');
  const i = cd ? indexOfDate(cd, day) ?? lastIndexBefore(cd, day) : null;
  const [fast, slow] = REGIME_MAS;
  if (i == null || i < slow) return 'NEUTRAL';
  let maF = 0, maS = 0;
  for (let j = i - fast + 1; j <= i; j++) maF += cd.c[j];
  for (let j = i - slow + 1; j <= i; j++) maS += cd.c[j];
  maF /= fast; maS /= slow;
  const ret5 = (cd.c[i] / cd.c[i - 5] - 1) * 100;
  if (cd.c[i] > maF && maF > maS) return 'UP';
  if (cd.c[i] < maF && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}
// I15 헤지 진입예산 배수: proxyUp & breadthWeak이면 HEDGE_CUT 적용, 아니면 1
function hedgeBudgetMult(day) {
  if (!REGIME_HEDGE) return 1;
  if (proxyRegime(day) === 'UP' && hedgeBreadthFrac(day) <= HEDGE_WEAK) return HEDGE_CUT;
  return 1;
}
// HMA 레짐 (--regimemode hma --regimehma N): 005930 HMA 슬로프로 판정 — SMA20/60 지연 제거 검증용
const REGIME_HMA_N = Number(argOf('--regimehma', '30'));
const hmaRegimeCache = new Map();
function hmaRegime(day) {
  if (hmaRegimeCache.has(day)) return hmaRegimeCache.get(day);
  const cd = candles.get('005930');
  const i = cd ? indexOfDate(cd, day) ?? lastIndexBefore(cd, day) : null;
  let r = 'NEUTRAL';
  if (i != null && i >= 5) {
    const h0 = hmaAt(cd.c, i, REGIME_HMA_N), h1 = hmaAt(cd.c, i - 1, REGIME_HMA_N);
    if (h0 != null && h1 != null) {
      const ret5 = (cd.c[i] / cd.c[i - 5] - 1) * 100;
      if (h0 > h1 && cd.c[i] > h0) r = 'UP';
      else if (h0 < h1 && ret5 < -3) r = 'DOWN';
    }
  }
  hmaRegimeCache.set(day, r);
  return r;
}
function marketRegime(day) {
  if (REGIME_MODE === 'breadth') return breadthRegime(day);
  if (REGIME_MODE === 'hma') return hmaRegime(day);
  const base = proxyRegime(day);
  // I15 헤지: breadth가 명확히 UP이면 proxy 비-UP을 UP으로 승격 (차단은 절대 안 함)
  if (REGIME_HEDGE && base !== 'UP' && hedgeBreadthFrac(day) >= HEDGE_UP) return 'UP';
  return base;
}
const COMBO_CAPS = LIVE_COMBO_CAPS;
const COMBO_CAPS_V2 = LIVE_COMBO_CAPS;
// 슬롯 배분 프리셋 (--caps A|B|C): A=현행, B=추세 공격형, C=역추세 수비형
const CAPS_PRESETS = {
  A: COMBO_CAPS_V2,
  // ★ 2026-07-29 (--caps R): hi120 전면 차단 = rsi2 단독. 16기법 IS/OOS 비교에서 나온 가설.
  //   근거: 양쪽 구간 플러스인 6개 전략이 **전부 평균회귀를 핵심으로** 갖고, 순수 추세추종 8개는
  //   양쪽 플러스가 하나도 없다(hi120은 IS -12.1% → OOS +18.1%로 부호가 뒤집힘 = 국면 의존).
  //   기본 파라미터 rsi2 단독은 IS +25.1% / OOS +40.8%로 튜닝 없이 양쪽 강세인데,
  //   combo-v2는 IS +2.0%다 → hi120이 IS를 끌어내렸다는 가설.
  R: { UP: { hi120: 0, rsi2: 99 }, NEUTRAL: { hi120: 0, rsi2: 99 }, DOWN: { hi120: 0, rsi2: 99 } },
  B: { UP: { hi120: 8, rsi2: 2 }, NEUTRAL: { hi120: 3, rsi2: 7 }, DOWN: { hi120: 0, rsi2: 5 } },
  C: { UP: { hi120: 5, rsi2: 5 }, NEUTRAL: { hi120: 2, rsi2: 8 }, DOWN: { hi120: 0, rsi2: 6 } },
  // C19: NEUTRAL hi120 무수익(전기간 +18k/46건) → rsi2로 재배분 — 기각 (Train 악화)
  D: { UP: { hi120: 6, rsi2: 4 }, NEUTRAL: { hi120: 0, rsi2: 8 }, DOWN: { hi120: 0, rsi2: 4 } },
  // C20: UP에서 hi120 증강 (UP hi120이 전기간 최대 수익원 +26.3M)
  E: { UP: { hi120: 8, rsi2: 2 }, NEUTRAL: { hi120: 2, rsi2: 6 }, DOWN: { hi120: 0, rsi2: 4 } },
  // MC3 I9 (30k 전용): D + UP rsi2 차단 — 소액 계좌에서 UP rsi2가 순손실(-374k/120런)이며 hi120 슬롯 잠식
  F: { UP: { hi120: 6, rsi2: 0 }, NEUTRAL: { hi120: 0, rsi2: 8 }, DOWN: { hi120: 0, rsi2: 4 } },
};
const CAPS_SEL = argOf('--caps', 'A');
// 레짐 MA 페어 (--regimema "20,60"): 빠른 스위치 vs 느린 스위치
const REGIME_MAS = argOf('--regimema', '20,60').split(',').map(Number);
const MCAP_TOP = Number(argOf('--rsiuni', '30'));
// --volsurge "volMin,dayRetMin,closeLocMin,cap": 거래량급증 진입 sub 활성화(검증용, live-parity에서만). 미지정=off(라이브 동작 불변).
const VOLSURGE_ARG = argOf('--volsurge', '');
const VOLSURGE = VOLSURGE_ARG ? (() => { const [v, d, cl] = VOLSURGE_ARG.split(',').map(Number); return { volMin: v || 2, dayRetMin: Number.isFinite(d) ? d : 0, closeLocMin: Number.isFinite(cl) ? cl : 0 }; })() : null;
const VOLSURGE_CAP = VOLSURGE_ARG ? (Number(VOLSURGE_ARG.split(',')[3]) || 3) : 0;

// ── 포트폴리오 ───────────────────────────────────────────────
function makeBook() { return { cash: CAPITAL, positions: {}, trades: [], daily: [], peak: CAPITAL, maxDD: 0, monthly: new Map(), lastEq: CAPITAL }; }
function equity(book, day) {
  let eq = book.cash;
  for (const [code, p] of Object.entries(book.positions)) {
    const cd = candles.get(code);
    const i = cd ? indexOfDate(cd, day) ?? lastIndexBefore(cd, day) : null;
    eq += (i != null && i >= 0 ? cd.c[i] : p.entry) * p.qty;
  }
  return eq;
}
function buy(book, day, code, price, budget, meta = {}) {
  const fill = tickUp(price);
  const unitCost = fill * (1 + FEE_BPS / 10_000);
  const qty = Math.floor(Math.min(budget, book.cash) / unitCost);
  if (qty < 1) return false;
  book.cash -= calcBuyCashImpact({ fill, qty, feeBps: FEE_BPS });
  book.positions[code] = { qty, entry: fill, entryDay: day, hi: fill, holdDays: 0, scen: SCEN_BY_DAY.get(day) ?? null, ...meta };
  return true;
}
// C18 (--cooldown N): stop_loss 청산 종목 N영업일 재진입 금지
let CUR_DI = 0;
function sell(book, day, code, price, reason, qtyArg) {
  const p = book.positions[code];
  if (!p) return;
  const qty = qtyArg ?? p.qty;
  const fill = tickDn(price);
  const pnl = netPnl(p.entry, fill, qty);
  book.cash += calcSellCashImpact({ fill, qty, feeBps: FEE_BPS, taxBps: getSellTaxBps('KOSPI') });
  book.trades.push({ day: fmtDay(day), code, entry: p.entry, exit: fill, qty, pnl, hold: p.holdDays, reason, ctx: p.ctx, scen: p.scen ?? null, sub: p.sub ?? null, eday: p.entryDay });
  if (reason === 'stop_loss' && COOLDOWN > 0) (book.cool ??= {})[code] = CUR_DI + COOLDOWN;
  p.qty -= qty;
  if (p.qty < 1) delete book.positions[code];
}
// C17 (--atrsize refPct): ATR(14)% 역가중 사이징 — refPct/atr%, [0.5, 1.5] 클램프
function atrMult(cd, i, cfg) {
  if (!(cfg.atrSize > 0) || i < 15) return 1;
  let tr = 0;
  for (let j = i - 13; j <= i; j++) {
    tr += Math.max(cd.h[j] - cd.l[j], Math.abs(cd.h[j] - cd.c[j - 1]), Math.abs(cd.l[j] - cd.c[j - 1]));
  }
  const atrPct = (tr / 14) / cd.c[i] * 100;
  if (!(atrPct > 0)) return 1;
  return Math.min(1.5, Math.max(0.5, cfg.atrSize / atrPct));
}

/** ATR(14) 퍼센트 — 진입 시점 변동성. --atrexit 용 (사이징이 아니라 **청산폭** 스케일) */
function atrPctAt(cd, i) {
  if (i < 15) return null;
  let tr = 0;
  for (let j = i - 13; j <= i; j++) tr += Math.max(cd.h[j] - cd.l[j], Math.abs(cd.h[j] - cd.c[j - 1]), Math.abs(cd.l[j] - cd.c[j - 1]));
  const v = (tr / 14) / cd.c[i] * 100;
  return v > 0 ? v : null;
}
/**
 * ★ 2026-07-29 (--atrexit K): 청산폭을 **종목 변동성에 비례**하게 만든다.
 *   근거(분봉 1,403만봉 조사): ATR 스케일 청산이 고정 청산을 **독립 4게이트에서 일관되게** 이겼다.
 *     A_hi120 +0.28→+1.77% · C_self +0.04→+0.99% · D_nochase -0.19→+0.91% · B_rs -0.14→+0.89%
 *   ※ 오늘 기각한 두 축과 다른 질문이다:
 *      - ATR **사이징**(포지션 크기) = 기각(단조 악화)
 *      - MA **트레일**(가격수준 적응) = 기각(0승 10패)
 *      - 고정폭 스윕(4/6/8/10/12) = "어떤 **단일** 폭이 최선인가" → 6
 *      - 이것 = "폭이 **종목마다 달라야 하는가**" → 미검증
 *   배수는 분봉 조사의 EXITS.atr과 동일: trail 1.5x[3,12] · hard 2.0x[4,14] · tp 1.5x/3.0x.
 *   K는 전체 스케일(이웃값 검사용). K=0이면 고정폭(현행).
 */
function atrExitBands(cd, i, K) {
  const a = atrPctAt(cd, i);
  if (!(K > 0) || a == null) return null;
  const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    trail: cl(1.5 * a * K, 3, 12),
    stop: cl(2.0 * a * K, 4, 14),
    tp1: cl(1.5 * a * K, 3, 12),
    tp2: cl(3.0 * a * K, 6, 24),
  };
}

/** 단순이동평균 (종가 i 포함, n일) — --matrail / --rsilowstop 용 */
function maAt(c, i, n) { let s = 0, k = Math.min(n, i + 1); for (let j = i - k + 1; j <= i; j++) s += c[j]; return s / k; }
/** 직전 n일 최저가 (당일 제외) — rsi2 구조적 지지선 */
function lowN(cd, i, n) { let lo = Infinity; for (let j = Math.max(0, i - n); j < i; j++) if (cd.l[j] < lo) lo = cd.l[j]; return lo; }

function rsi2(cd, i) {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) {
    const ch = cd.c[j] - cd.c[j - 1];
    if (ch > 0) up += ch; else dn -= ch;
  }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}

// 훌 이동평균선: HMA(n) = WMA(2×WMA(n/2) − WMA(n), √n) — Alan Hull 2005
function wmaAt(closes, i, n) {
  if (i < n - 1) return null;
  let num = 0, den = 0;
  for (let j = 0; j < n; j++) {
    const w = j + 1; // 최신봉이 최대 가중
    num += closes[i - n + 1 + j] * w;
    den += w;
  }
  return num / den;
}
function hmaAt(closes, i, n) {
  const half = Math.max(1, Math.round(n / 2));
  const m = Math.max(1, Math.round(Math.sqrt(n)));
  if (i < n - 1 + m - 1) return null;
  let num = 0, den = 0;
  for (let j = 0; j < m; j++) {
    const idx = i - m + 1 + j;
    const wf = wmaAt(closes, idx, n), wh = wmaAt(closes, idx, half);
    if (wf == null || wh == null) return null;
    const w = j + 1;
    num += (2 * wh - wf) * w;
    den += w;
  }
  return num / den;
}

// 볼린저밴드: population stddev (분모=period, TA-Lib 기본과 동일)
function bbBands(cd, i, period, mult) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += cd.c[j];
  const sma = sum / period;
  let sq = 0;
  for (let j = i - period + 1; j <= i; j++) sq += (cd.c[j] - sma) ** 2;
  const sd = Math.sqrt(sq / period);
  return { sma, sd, upper: sma + mult * sd, lower: sma - mult * sd };
}

// ── 메인 ─────────────────────────────────────────────────────
console.log(`=== 스윙 전략 비교 v2 ${fmtDay(FROM)} ~ ${fmtDay(TO)} | 자본 ${CAPITAL.toLocaleString()}원 | ${ACTIVE.map(([k]) => k).join(', ')} ===`);

const allRows = await dbQuery(`SELECT stock_code, current_price, market_cap_tril, avg_turnover_20d FROM stock_analysis WHERE current_price > 0`);
const allCodes = allRows.map(r => r.stock_code);
for (const r of allRows) {
  const sh = (Number(r.market_cap_tril) * 1e12) / Number(r.current_price);
  if (Number.isFinite(sh) && sh > 0) sharesEst.set(r.stock_code, sh);
}
const RSI_UNI = Number(STRATEGIES['combo-v2'].rsiUni ?? argOf('--rsiuni', 30)); // rsi2 유니버스 크기(대형주 상위 N). 라이브 LIVE_RSI2_UNIVERSE_LIMIT=30 대응. 이전엔 하드코딩 30이라 --rsiuni가 죽어있었음(2026-07-22 배선).
const largeCaps = (await dbQuery(`SELECT stock_code FROM stock_analysis WHERE current_price >= ${MIN_PRICE} AND avg_turnover_20d >= ${MIN_TURNOVER} ORDER BY market_cap_tril DESC LIMIT ${RSI_UNI}`)).map(r => r.stock_code);
// 섹터 캡용 stock_code→sector 맵 (금융 편중 완화 테스트). sector NULL은 캡 미적용(카운트 0).
// ★ 2026-07-30: stock_analysis.sector 보정 적용 (라이브와 동일 함수). 보정 없이 --sectorcap 을 돌리면
//   SK스퀘어가 금융으로, LG전자가 반도체로 잡혀 검증 대상이 실제 라이브 동작과 달라진다.
const SECTOR = applySectorOverride(Object.fromEntries((await dbQuery(`SELECT stock_code, sector FROM stock_analysis`)).map(r => [r.stock_code, r.sector])));
const countSector = (code, book) => { const s = SECTOR[code]; if (!s) return 0; let n = 0; for (const pc of Object.keys(book.positions)) if (SECTOR[pc] === s) n++; return n; };
// ROTATE 자금원: 최약 laggard(ret≤ROTATE_MAXRET & holdDays≥ROTATE_MINHOLD & 부분익절 미진행) 중 최저 ret. 승자·트레일 보호(반환 안 함).
function weakestLaggard(book, day) {
  let worst = null, worstRet = Infinity;
  for (const [code, p] of Object.entries(book.positions)) {
    const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
    if (i == null) continue;
    const ret = cd.c[i] / p.entry - 1;
    if (ret > ROTATE_MAXRET || p.holdDays < ROTATE_MINHOLD || p.halfDone) continue;
    if (ret < worstRet) { worstRet = ret; worst = code; }
  }
  return worst;
}
await loadPool(allCodes);

// MC (--seed N --subsample 0.8): 시드 기반 유니버스 무작위 표본 — 몬테카를로 강건성 검증용
const MC_SEED = Number(argOf('--seed', 0));
const SUBSAMPLE = Number(argOf('--subsample', 1));
if (SUBSAMPLE < 1) {
  const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const rng = mulberry32(MC_SEED || 1);
  let dropped = 0;
  for (const code of [...candles.keys()]) {
    if (code === '005930') continue; // 레짐 프록시·거래일 기준 유지
    if (rng() > SUBSAMPLE) { candles.delete(code); dropped++; }
  }
  console.log(`[MC] seed=${MC_SEED} subsample=${SUBSAMPLE} — ${dropped}종목 제외`);
}
// MC3 I10 (--exclude 065170,038500,...): 승자 제거 스트레스 — 지정 종목 유니버스에서 제외
const EXCLUDE = argOf('--exclude', '');
if (EXCLUDE) {
  let exDropped = 0;
  for (const code of EXCLUDE.split(',')) if (candles.delete(code.trim())) exDropped++;
  console.log(`[EXCLUDE] ${exDropped}종목 제외 (승자 제거 스트레스)`);
}

const krx = candles.get('005930');
/**
 * ★ 2026-07-29 (--gapaxis): 시나리오 축을 **당일 시가 갭**으로 교체 (사용자 제안 "장 30분 보고 판단").
 *   근거: 005930 1분봉 83일에서 **갭 ↔ 30분수익률 상관 0.865** → 갭이 30분의 대용이고,
 *   일봉 시가를 쓰면 표본이 84일 → 868일로 10배가 된다.
 *   ★ 기존 5×4 시나리오 대비 결정적 이점: 3구간 전부 IS·OOS 양쪽에 100일+ 표본이 있다
 *     (5×4 격자는 양쪽 검증가능이 6/20뿐이었다 — 두 축이 상관돼 비대각이 비어서).
 *   갭은 **그날 시가에서 관측**되므로 진입 결정 전에 알 수 있다 = lookahead 없음.
 *   SCEN_BY_DAY를 G1/G2/G3로 채우면 --scenpolicy 배선이 그대로 작동한다.
 */
const GAP_AXIS = argv.includes('--gapaxis');
// 경계는 결과 보기 전 ±0.5%로 고정했다(순환논증 방지). --gapbound는 **민감도 검사 전용**이다 —
// 값을 바꿔가며 최적을 찾으려는 게 아니라 "0.5가 봉우리인지 아니면 어느 값이나 되는지"를 보려는 것.
const GAP_BOUND = Number(argOf('--gapbound', 0.5));
const gapBinOf = (i) => {
  if (i < 1) return null;
  const g = (krx.o[i] / krx.c[i - 1] - 1) * 100;
  if (!Number.isFinite(g)) return null;
  return g < -GAP_BOUND ? 'G1' : g < GAP_BOUND ? 'G2' : 'G3';
};
// 시나리오 태깅 사전계산 (진입일 기준·PIT — classify는 i까지의 데이터만 사용)
if (SCENDUMP || SCENPOLICY) for (let i = 0; i < krx.d.length; i++) {
  if (GAP_AXIS) { SCEN_BY_DAY.set(krx.d[i], gapBinOf(i)); continue; }
  const s = classifyScenario(krx, i);
  SCEN_BY_DAY.set(krx.d[i], s ? s.key : null);
}
const tradingDays = krx.d.filter(d => d >= FROM && d <= TO);
console.log(`영업일 ${tradingDays.length}일 | 풀 ${candles.size}종목 (※ 현재 상장 기준 — 생존 편향 존재)`);

const rankRows = ACTIVE.some(([key]) => key === 'swing-rank')
  ? await dbQuery(`SELECT rank_date, stock_code, rank FROM daily_rankings WHERE rank <= 20 ORDER BY rank_date, rank`)
  : [];
const rankByDay = new Map();
for (const r of rankRows) {
  const d = String(r.rank_date).replace(/-/g, '');
  if (!rankByDay.has(d)) rankByDay.set(d, []);
  rankByDay.get(d).push(r);
}

const books = Object.fromEntries(ACTIVE.map(([k]) => [k, makeBook()]));
const shadowStats = Object.fromEntries(ACTIVE.map(([k]) => [k, { count: 0, sum: 0, min: 1 }]));
let weekMark = '';
const marketCloses = candles.get('005930')?.c ?? [];

for (let di = 0; di < tradingDays.length; di++) {
  const day = tradingDays[di];
  CUR_DI = di;
  const wk = weekKey(day);
  const isNewWeek = wk !== weekMark; weekMark = wk;
  const mom = momUniverse(day);

  for (const [k, cfg] of ACTIVE) {
    const book = books[k];
    const volMult = VOL_SHADOW && (k === 'combo' || k === 'combo-v2')
      ? volatilityThrottleMultiplier(marketCloses, marketSeriesIndex(krx.d, day), { volWindow: VOL_WINDOW, refLookback: VOL_REF_LOOKBACK })
      : 1;
    // MC3 I11 (--dynslot N): 자본 성장 시 슬롯 자동 확대 — 포지션당 예산을 N원 목표로,
    // slots ~ clamp(floor(equity/N), cfg.slots, 6). 소액일 땐 기존과 동일, 계좌 성장 시 집중 위험 축소
    const budget = () => {
      const eq = equity(book, day);
      const sl = DYNSLOT > 0 ? Math.max(cfg.slots, Math.min(6, Math.floor(eq / DYNSLOT))) : cfg.slots;
      return Math.floor(eq / sl * volMult);
    };
    if (VOL_SHADOW && (k === 'combo' || k === 'combo-v2')) {
      shadowStats[k].count++;
      shadowStats[k].sum += volMult;
      shadowStats[k].min = Math.min(shadowStats[k].min, volMult);
    }

    // ① 시가 집행 큐 + 보유일
    for (const [code, p] of Object.entries(book.positions)) {
      p.holdDays++;
      const cd = candles.get(code);
      const i = cd ? indexOfDate(cd, day) : null;
      if (i == null) continue;
      if (p.exitAtOpen) { sell(book, day, code, cd.o[i], p.exitAtOpen, p.exitQty); delete p.exitAtOpen; delete p.exitQty; continue; }
      // ★ --exitsameday: 전일 종가판정에서 '당일 집행' 으로 표시된 건은 이미 그날 팔렸으므로 여기 오지 않는다.
      //   (아래 종가판정부에서 sell 을 직접 호출한다 — 이 큐는 익일 집행분 전용이다.)
      /**
       * ★ 2026-08-01 `--flowexitnow`: **라이브 수급청산의 실제 동작**을 재현한다.
       *
       * 라이브(stock-live.mjs)는 수급붕괴를 감지하면 청산 루프에서 `createOrder` 로 **장중 즉시** 판다.
       * 반면 백테는 `p.exitAtOpen = 'flow_break'` 로 두어 **익일 시가**에 판다.
       * 정보집합은 같다(둘 다 전일까지 확정 수급) — 다른 것은 집행 시점이고, 그 차이가 정확히
       * **1거래일**이다. 신호는 X일 마감 후 확정 → 라이브는 X+1 시가, 백테는 X+2 시가에 집행.
       * 즉 MC 로 검증된 값(MDD 22.3→20.5%·Calmar 1.65→1.82)은 X+2 타이밍의 것이고
       * 라이브가 실제로 하는 X+1 타이밍은 **한 번도 측정된 적이 없다.**
       *
       * 이 플래그는 그 미측정 구간을 재현한다: 같은 flowSum(전일까지) 으로 판정하되 **당일 시가**에 판다.
       * look-ahead 아님 — flowSum 은 `k < day` 라 당일 시가 이전에 이미 알 수 있는 정보만 쓴다.
       */
      if (FLOW_EXIT != null && FLOWEXIT_NOW && p.holdDays >= 1
          && (FLOWEXIT_SUB === 'both' || p.sub === FLOWEXIT_SUB)) {
        const f = flowSum(code, day, FLOWEXIT_DAYS);
        if (f && f.both <= -FLOW_EXIT) { sell(book, day, code, cd.o[i], 'flow_break'); continue; }
      }
      p.hiPrev = p.hi; // 전일까지의 고점 (장중 트레일링 레벨용 — 당일 고가 lookahead 방지)
      p.hi = Math.max(p.hi, cd.h[i]);
    }

    // ② 전략 로직 (종가 판정)
    if (k === 'swing-mom' || k === 'swing-rank') {
      const top = k === 'swing-mom' ? mom.slice(0, 10)
        : (rankByDay.get(day) ?? []).filter(r => r.rank <= 10).map(r => r.stock_code);
      const keep = k === 'swing-mom' ? new Set(mom.slice(0, 20))
        : new Set((rankByDay.get(day) ?? []).map(r => r.stock_code));
      if (k === 'swing-rank' && !rankByDay.has(day)) { /* 랭킹 없는 날 보유만 유지 */ }
      else {
        for (const [code, p] of Object.entries(book.positions)) {
          const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
          if (i == null) continue;
          if (cd.c[i] <= p.entry * 0.75) { p.exitAtOpen = 'stop_loss'; continue; }
          if (!p.halfDone && cd.c[i] >= p.entry * 2) { p.exitAtOpen = 'half_profit'; p.exitQty = Math.floor(p.qty / 2); p.halfDone = true; continue; }
          if (isNewWeek && !keep.has(code)) p.exitAtOpen = 'rebalance';
        }
        if (isNewWeek || k === 'swing-rank') {
          for (const code of top) {
            if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
            const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
            if (i == null) continue;
            buy(book, day, code, cd.c[i], budget());
          }
        }
      }
    } else if (k === 'vb') {
      for (const code of mom.slice(0, 10)) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 1) continue;
        const target = cd.o[i] + cfg.k * (cd.h[i - 1] - cd.l[i - 1]);
        if (cd.h[i] >= target && target > 0) {
          if (buy(book, day, code, Math.max(target, cd.o[i]), budget()))
            book.positions[code].exitAtOpen = 'vb_exit';
        }
      }
    } else if (k === 'overnight') {
      for (const code of mom.slice(0, 5)) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        if (buy(book, day, code, cd.c[i], budget()))
          book.positions[code].exitAtOpen = 'overnight_exit';
      }
    } else if (k === 'trend-cash') {
      const proxy = candles.get('005930');
      const proxyIndex = proxy ? indexOfDate(proxy, day) : null;
      const trendOn = proxyIndex != null && absoluteTrendOn(proxy.c, proxyIndex, cfg.lookback);
      const leaders = trendOn ? trendUniverse(day, cfg.lookback) : [];
      const targets = new Set(leaders.slice(0, cfg.slots));
      const keep = new Set(leaders);
      for (const [code, position] of Object.entries(book.positions)) {
        if (!trendOn || (isNewWeek && !keep.has(code))) position.exitAtOpen = trendOn ? 'rebalance' : 'trend_off';
      }
      if (trendOn && isNewWeek) {
        for (const code of targets) {
          if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
          const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
          if (i != null) buy(book, day, code, cd.c[i], budget(), { ctx: { sub: 'trend-cash', regime: 'UP' } });
        }
      }
    } else if (k === 'hi120') {
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        if (cd.c[i] <= p.hi * (1 - cfg.trailPct / 100)) p.exitAtOpen = 'trailing';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      if (hi120RegimeAllows(marketRegime(day), HI_REGIME)) for (const code of mom) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < cfg.lookback + 1) continue;
        let prevHigh = 0;
        for (let j = i - cfg.lookback; j < i; j++) prevHigh = Math.max(prevHigh, cd.h[j]);
        if (cd.c[i] > prevHigh) buy(book, day, code, cd.c[i], budget());
      }
    } else if (k === 'pullback') {
      // C32: UP 추세주(종가>MA60) 모멘텀 유니버스가 MA20을 하향 터치하는 눌림목 매수
      // 청산: 손절 -stopPct% / 목표 +tpPct% / 만기 maxHold일
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (cd.c[i] >= p.entry * (1 + cfg.tpPct / 100)) p.exitAtOpen = 'tp_fixed';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      if (marketRegime(day) === 'UP') {
        for (const code of mom) {
          if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
          const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
          if (i == null || i < 61) continue;
          let ma20 = 0, ma20p = 0, ma60 = 0;
          for (let j = i - 19; j <= i; j++) ma20 += cd.c[j];
          for (let j = i - 20; j <= i - 1; j++) ma20p += cd.c[j];
          for (let j = i - 59; j <= i; j++) ma60 += cd.c[j];
          ma20 /= 20; ma20p /= 20; ma60 /= 60;
          // 추세 유지(MA60 위) + 전일 MA20 위 → 당일 MA20 하향 (첫 눌림)
          if (cd.c[i] > ma60 && cd.c[i - 1] >= ma20p && cd.c[i] < ma20) {
            buy(book, day, code, cd.c[i], budget(), { ctx: { sub: 'pullback', regime: 'UP' } });
          }
        }
      }
    } else if (k === 'gapfollow') {
      // C33: 갭업 유지 추종 — 시가 갭업 +gapPct% & 종가가 시가 위(갭 소화) 시 종가 매수
      // 청산: hi120과 동일 트레일링 구조 (손절 -stopPct% 백업)
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (cd.c[i] <= p.hi * (1 - cfg.trailPct / 100)) p.exitAtOpen = 'trailing';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of mom) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 1) continue;
        const gap = (cd.o[i] / cd.c[i - 1] - 1) * 100;
        if (gap >= cfg.gapPct && cd.c[i] > cd.o[i]) {
          buy(book, day, code, cd.c[i], budget(), { ctx: { sub: 'gapfollow', gap: gap.toFixed(1) } });
        }
      }
    } else if (k === 'combo' || k === 'combo-v2') {
      const regime = marketRegime(day);
      // --scenpolicy: 오늘 시나리오의 파라미터 오버라이드 (없으면 null → 현행 기본값 그대로)
      const scenPol = SCENPOLICY ? (SCENPOLICY[SCEN_BY_DAY.get(day)] ?? null) : null;
      let caps = (cfg.v2 ? (CAPS_PRESETS[CAPS_SEL] ?? COMBO_CAPS_V2) : COMBO_CAPS)[regime];
      // ★ 2026-07-30 (--downrsi N): 하락장 rsi2 슬롯 상한. 현행 DOWN은 { hi120: 0, rsi2: 4 } 로
      //   5슬롯 중 4개까지 rsi2를 허용한다. hi120은 DOWN에서 이미 0인데 rsi2는 거의 무제한인 비대칭.
      //   근거: 2026-07-29 "DOWN에서 rsi2 유지"를 10시드로 봤을 때 1승9패였으나, 그 판정은
      //   노이즈 바닥(10시드 0.527)을 재기 전이라 무효에 가깝다. 30시드+바닥으로 다시 본다.
      if (DOWN_RSI >= 0 && regime === 'DOWN') caps = { ...caps, rsi2: DOWN_RSI };
      // H9 (--entryopen): 전일 돌파 시그널을 당일 시가에 진입
      if (cfg.entryOpen && book.pendingBuys?.length) {
        const pend = book.pendingBuys; book.pendingBuys = [];
        for (const pb of pend) {
          if (book.positions[pb.code]) continue;
          const cd2 = candles.get(pb.code); const i2 = cd2 ? indexOfDate(cd2, day) : null;
          if (i2 == null) continue;
          // I16 (--gapmax N): 시가가 시그널 종가 대비 N% 이상 갭상승하면 추격 안 함 (최악 체결 회피)
          if (cfg.gapMax > 0 && pb.sigClose > 0 && (cd2.o[i2] / pb.sigClose - 1) * 100 > cfg.gapMax) continue;
          buy(book, day, pb.code, cd2.o[i2], Math.floor(budget() * (pb.atrM ?? 1)), { sub: 'hi120', ctx: pb.ctx, breakLv: pb.breakLv });
        }
      }
      // 보유 관리: 서브 전략별 청산 규칙
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        // ★ --atrexit K: 청산폭을 진입시점 ATR에 비례하게. 포지션당 1회 계산해 캐시(진입일 기준 = lookahead 없음).
        if (ATR_EXIT > 0 && p.bands === undefined) {
          const eiB = indexOfDate(cd, p.entryDay);
          p.bands = eiB != null ? atrExitBands(cd, eiB, ATR_EXIT) : null;
        }
        const trailP = p.bands?.trail ?? p.scenTrail ?? cfg.trailPct;   // 트레일 폭 (scenTrail = 진입일 시나리오 고정 오버라이드)
        const stopP = p.bands?.stop ?? p.scenStop ?? cfg.stopPct;      // 하드손절 폭 (scenStop = 진입일 시나리오 고정)
        // 부분익절 임계: ATR 모드면 절대% 사용, 아니면 기존 trailPct×tp1R/tp2R (scenTrail 시 함께 스케일 — trail 스윕 런과 동일 의미론)
        const tp1Lv = p.bands ? p.bands.tp1 : (p.scenTrail ?? cfg.trailPct) * cfg.tp1R;
        const tp2Lv = p.bands ? p.bands.tp2 : (p.scenTrail ?? cfg.trailPct) * cfg.tp2R;
        // 상대손절(--relstop N): 진입후 시장(005930) 대비 낙폭이 N배 이상이면 매도(상대약세 컷). 시장 하락구간·진입당일 제외.
        if (RELSTOP > 0 && !p.exitAtOpen && p.holdDays >= 1 && krx) {
          const ei = indexOfDate(krx, p.entryDay), ci = indexOfDate(krx, day);
          if (ei != null && ci != null && ei >= 0 && ci >= 0) {
            const mktRet = krx.c[ci] / krx.c[ei] - 1, posRet = cd.c[i] / p.entry - 1;
            if (mktRet < 0 && posRet <= RELSTOP * mktRet) { p.exitAtOpen = 'rel_stop'; continue; }
          }
        }
        // H1/H4 (--intraday 1): 당일 장중 레벨 터치 시 즉시 청산 (level 또는 갭 시 시가, 전일 기준 레벨)
        if (cfg.intradayExit && !p.exitAtOpen && (cfg.intradayExit === 1 || p.sub === 'rsi2')) { // 2=rsi2 스톱만
          const level = p.sub === 'hi120'
            ? (p.hiPrev ?? p.hi) * (1 - trailP / 100) // 전일 고점 기준 (당일 고가 lookahead 방지)
            // rsi2: 하드손절선. --rsitrail N이면 트레일선과 비교해 **높은 쪽**이 먼저 걸린다(라이브 동작 반영).
            : Math.max(p.entry * (1 - stopP / 100),
              cfg.rsiTrail > 0 ? (p.hiPrev ?? p.hi) * (1 - cfg.rsiTrail / 100) : 0);
          if (cd.l[i] <= level && p.holdDays >= 1) {     // 진입 당일 제외
            sell(book, day, code, Math.min(level, cd.o[i]), p.sub === 'hi120' ? 'trailing_intraday' : 'stop_intraday');
            continue;
          }
        }
        if (p.sub === 'hi120') {
          if (cfg.downFlat && regime === 'DOWN' && !p.exitAtOpen) { p.exitAtOpen = 'regime_flat'; continue; }
          // 2026-07-25 사용자 제안(가설E, --flowexit N): 익절/손절 도달 전이라도 **수급 주체가 무너지면** 청산.
          //   근거: 최대 손실덩어리가 hi120/trailing(-1,933만·339건) → 트레일 피격 전 수급붕괴로 선제 이탈.
          //   진입 후에는 "진입 후 수급"이라는 새 정보가 생기므로, 진입시점엔 불가능한 승/패 구분이 가능할 수 있다.
          //   N=0이면 순매도 전환만으로 청산, N>0이면 최근 FLOWEXIT_DAYS 누적 ≤ -N억일 때 청산.
          if (FLOW_EXIT != null && FLOWEXIT_SUB !== 'rsi2' && !p.exitAtOpen && p.holdDays >= 1) {
            const f = flowSum(code, day, FLOWEXIT_DAYS);
            if (f && f.both <= -FLOW_EXIT) { p.exitAtOpen = 'flow_break'; continue; }
          }
          // C26 (--breakfail 1): 돌파 실패 청산 — 종가가 돌파 기준선(직전 120일 고가) 아래 회귀 시 즉시 청산
          if (cfg.breakFail > 0 && !p.halfDone && p.breakLv > 0 && cd.c[i] < p.breakLv) { p.exitAtOpen = 'break_fail'; continue; }
          // H6 (--tp1r N): 진입가 +trailPct×N 도달 시 절반 익절 (잔량은 트레일링 지속)
          if (cfg.tp1R > 0 && !p.halfDone && cd.c[i] >= p.entry * (1 + tp1Lv / 100) && Math.floor(p.qty * TPFRAC) >= 1) {
            p.exitAtOpen = 'tp_half'; p.exitQty = Math.floor(p.qty * TPFRAC); p.halfDone = true;
          }
          // C14 (--tp2r N): 1차 부분익절 후 진입가 +trailPct×N 도달 시 잔량 추가 부분익절 (--tpfrac 비율)
          else if (cfg.tp2R > 0 && p.halfDone && !p.qtrDone && cd.c[i] >= p.entry * (1 + tp2Lv / 100) && Math.floor(p.qty * TPFRAC) >= 1) {
            p.exitAtOpen = 'tp_quarter'; p.exitQty = Math.floor(p.qty * TPFRAC); p.qtrDone = true;
          }
          // C15 (--trailwide N): 절반익절 후 잔량 트레일링 폭 확대 (러너 추세 보존)
          // ★ 2026-07-29 사용자 제안(--matrail N): 고점대비 고정 %가 아니라 **추세선(이동평균)** 이탈로 청산.
          //   근거: hi120/trailing이 전략 최대 손실 버킷(n=303 승률41% -1,701만). 돌파주는 이미 MA 위에 있으므로
          //   "종가 < MA(N)"이 자연스러운 추세종료 신호이고, 폭이 시장 상태에 따라 스스로 조절된다.
          //   ATR 기반(변동성 적응)은 별개 축으로 이미 기각됨 — 이건 가격수준 적응이다.
          //   N=0(기본)이면 기존 고정% 트레일. 0보다 크면 그것을 **대체**한다(하드손절·부분익절은 유지).
          else if (cfg.maTrail > 0
            ? (i >= cfg.maTrail && cd.c[i] < maAt(cd.c, i, cfg.maTrail))
            : cd.c[i] <= p.hi * (1 - (p.halfDone && cfg.trailWide > 0 ? cfg.trailWide : trailP) / 100)) p.exitAtOpen = 'trailing';
          else if (p.holdDays >= cfg.maxHoldH) p.exitAtOpen = 'max_hold';
          // C28 (--pyramid 1): 1R 절반익절 확인 종목이 추가 신고가 갱신 시 1회 증액 (추세 검증된 종목에 집중)
          else if (cfg.pyramid > 0 && p.halfDone && !p.pyrDone && cd.c[i] > (p.hiPrev ?? p.entry)) {
            const fill = tickUp(cd.c[i]);
            const q = Math.floor(Math.min(Math.floor(budget() * 0.5), book.cash) / fill);
            if (q >= 1) {
              book.cash -= calcBuyCashImpact({ fill, qty: q, feeBps: FEE_BPS });
              p.entry = (p.entry * p.qty + fill * q) / (p.qty + q);
              p.qty += q; p.pyrDone = true;
            }
          }
        } else {
          // 2026-07-27: rsi2 보유분에도 동일 규칙 검증(--flowexitsub rsi2|both). hi120과 동일 우선순위(청산체인 최상단).
          //   주의: rsi2는 ma회귀·maxHoldR=5로 이미 짧게 끝나므로 "더 짧게 끊을 여지" 자체가 작다 — 효과 없음이 기본 가설.
          if (FLOW_EXIT != null && FLOWEXIT_SUB !== 'hi120' && !p.exitAtOpen && p.holdDays >= 1) {
            const f = flowSum(code, day, FLOWEXIT_DAYS);
            if (f && f.both <= -FLOW_EXIT) { p.exitAtOpen = 'flow_break'; continue; }
          }
          const maN = cfg.rsiMa || 5;
          let ma5 = 0; const n = Math.min(maN, i + 1);
          for (let j = i - n + 1; j <= i; j++) ma5 += cd.c[j];
          ma5 /= n;
          // ★ 2026-07-29 (--rsilowstop N): 진입가 대비 고정 -7% 대신 **직전 N일 최저가 이탈**로 손절.
          //   구조적 지지선이라 종목 변동성·가격대에 따라 폭이 스스로 조절된다.
          if (cfg.rsiLowStop > 0
            ? cd.c[i] < lowN(cd, i, cfg.rsiLowStop)
            : cd.c[i] <= p.entry * (1 - stopP / 100)) p.exitAtOpen = 'stop_loss';
          // ★ 2026-07-29 (--rsitp1 N): 라이브가 rsi2에도 걸고 있는 부분익절 +N% 절반 (백테엔 hi120만 있었다)
          else if (cfg.rsiTp1 > 0 && !p.halfDone && cd.c[i] >= p.entry * (1 + cfg.rsiTp1 / 100) && Math.floor(p.qty * TPFRAC) >= 1) {
            p.exitAtOpen = 'tp_half'; p.exitQty = Math.floor(p.qty * TPFRAC); p.halfDone = true;
          }
          // ★ 2026-07-29 (--rsitrail N): 라이브가 rsi2에도 걸고 있는 트레일 N%.
          //   전일까지의 고점(hiPrev) 기준 — 당일 고가를 쓰면 lookahead다. 라이브는 실시간 당일 고점을 쓰므로
          //   이 시뮬레이션은 라이브보다 **덜 공격적** = 피해를 과소평가한다(진입당일 청산은 아예 재현 못 함).
          else if (cfg.rsiTrail > 0 && cd.c[i] <= (p.hiPrev ?? p.hi) * (1 - cfg.rsiTrail / 100)) p.exitAtOpen = 'trailing';
          // C22 (--rsitp N): ma 회귀 대신 진입가 +N% 고정익절
          // ★ 2026-07-30 (--maexitmin N): MA 익절에 **종가 > 진입가×(1+N%)** 를 AND로 요구한다.
          //   왜: MA선은 직전 2일 종가만 보고 진입가를 안 본다 → **손실 상태에서도 "익절"로 청산된다.**
          //   실측 2건: 카카오(07-29 진입 35,650 / MA선 35,475 = 진입가보다 낮음)
          //             한국타이어(07-30 진입 68,000 / MA선 66,300, 현재 67,300 = 이미 익절선 위 → -1.03% 손실청산 예약)
          //   손실 청산은 하드손절 -7%와 만기가 담당하므로, MA 익절이 손실에서 발동하는 건 설계 의도로 보기 어렵다.
          //   차단되면 rsiCut/max_hold로 흘러간다(= 더 오래 보유) — 그 대가를 측정하는 것이 이 검증의 요점.
          else if (cfg.rsiTp > 0
            ? cd.c[i] >= p.entry * (1 + cfg.rsiTp / 100)
            : (cd.c[i] > ma5 && (MA_EXIT_MIN == null || cd.c[i] > p.entry * (1 + MA_EXIT_MIN / 100)))) p.exitAtOpen = cfg.rsiTp > 0 ? 'tp_fixed' : 'ma5_exit';
          // C27 (--rsicut N): N일째에도 진입가 미회복이면 조기 타임컷 (만기 전패 버킷 공략)
          else if (cfg.rsiCut > 0 && p.holdDays >= cfg.rsiCut && cd.c[i] < p.entry) p.exitAtOpen = 'time_cut';
          else if (p.holdDays >= (p.scenMaxHold ?? cfg.maxHoldR)) p.exitAtOpen = 'max_hold';
        }
      }
      /**
       * ★ 2026-08-02 `--exitsameday`: 방금 판정된 청산을 **익일 시가 대기 없이 당일 종가에** 집행한다.
       *   판정은 위에서 이미 `cd.c[i]`(당일 종가)로 끝났다 — 여기서는 집행 시점만 바꾼다.
       *   look-ahead 아님: 판정 근거와 체결 가격이 **같은 종가**다(익일 정보를 쓰지 않는다).
       *   부분익절(exitQty 지정분)은 제외한다 — 잔량 관리·tp 플래그가 익일 집행 전제로 짜여 있고,
       *   그걸 같이 바꾸면 측정 대상이 둘로 섞인다(집행시점 vs 부분청산 회계).
       */
      if (EXIT_SAMEDAY !== 'off') {
        for (const [code, p] of Object.entries(book.positions)) {
          if (!p.exitAtOpen || p.exitQty) continue;               // 부분익절은 익일 집행 유지
          if (EXIT_SAMEDAY === 'stop' && p.exitAtOpen !== 'stop_loss') continue;
          const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
          if (i == null) continue;
          sell(book, day, code, cd.c[i], p.exitAtOpen + '_sameday');
          delete p.exitAtOpen;
        }
      }
      const countSub = (sub) => Object.values(book.positions).filter(p => p.sub === sub).length;
      if (LIVE_PARITY) {
        const signalRows = [];
        for (const code of pickUniverse(day, LIVE_UNI)) {
          if (book.positions[code] || LIVE_EXCLUDE.has(code)) continue;
          const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
          if (i == null || i < cfg.lookback + 1) continue;
          let prevHigh = 0;
          for (let j = i - cfg.lookback; j < i; j++) prevHigh = Math.max(prevHigh, cd.h[j]);
          // 확인필터용: 거래량비(당일/20일평균), 종가위치((c-l)/(h-l))
          let avgVol = 0, nv = 0; for (let j = Math.max(0, i - 20); j < i; j++) { avgVol += cd.v[j]; nv++; }
          avgVol = nv > 0 ? avgVol / nv : 0;
          const volRatio = avgVol > 0 ? cd.v[i] / avgVol : 1;
          const closeLoc = cd.h[i] > cd.l[i] ? (cd.c[i] - cd.l[i]) / (cd.h[i] - cd.l[i]) : 1;
          signalRows.push({
            code,
            rsi: rsi2(cd, i),
            breakoutPct: (cd.c[i] / prevHigh - 1) * 100,
            breakLv: prevHigh,
            price: cd.c[i],
            sector: SECTOR[code],
            volRatio,
            closeLoc,
            dayRet: i > 0 ? (cd.c[i] / cd.c[i - 1] - 1) * 100 : 0,
            // 2026-07-27 사용자 제안(--selfregime): 레짐을 삼전 프록시가 아니라 **종목 자체** 추세로 판정.
            //   판정식은 라이브 marketRegime과 동일(종가>MA20 && MA20>MA60 = UP / 종가<MA20 && 5일<-3% = DOWN / else NEUTRAL)
            selfRegime: (() => {
              if ((!SELF_REGIME && !SELF_AND) || i < 60) return null;
              let ma20 = 0, ma60 = 0;
              for (let j = i - 19; j <= i; j++) ma20 += cd.c[j];
              for (let j = i - 59; j <= i; j++) ma60 += cd.c[j];
              ma20 /= 20; ma60 /= 60;
              const ret5 = i >= 5 ? (cd.c[i] / cd.c[i - 5] - 1) * 100 : 0;
              if (cd.c[i] > ma20 && ma20 > ma60) return 'UP';
              if (cd.c[i] < ma20 && ret5 < -3) return 'DOWN';
              return 'NEUTRAL';
            })(),
          });
        }
        const candidates = buildLiveCandidates(signalRows, {
          regime,
          rsiMax: cfg.rsiMax,
          minBreakout: cfg.minBreakout,
          allowUpRsi: !NO_UP_RSI,
          rsiVolMin: scenPol?.rsiVolMin ?? (cfg.rsiVol > 0 ? cfg.rsiVol : 0), // --rsivol N: rsi2 매수 시 거래량비 ≥ N 요구(투매 확인). scenpolicy가 시나리오 조건부 오버라이드.
          closeLocMin: cfg.closeLoc > 0 ? cfg.closeLoc : 0, // --closeloc N: rsi2 매수 시 종가위치 ≥ N 요구(강한 마감)
          volSurge: VOLSURGE,                               // --volsurge "volMin,dayRetMin,closeLocMin,cap": 거래량급증 진입 sub(검증용)
          regimeOf: SELF_REGIME ? (row) => row.selfRegime : null,  // --selfregime: 종목별 레짐
        });
        // ★ --rsiatrrank: 확신도 동률 내 ATR 오름차순 재정렬 (풀을 깎지 않고 순서만 바꾼다)
        if (RSI_ATR_RANK) {
          const atrOf = new Map();
          for (const c of candidates) {
            if (c.sub !== 'rsi2') continue;
            const cdR = candles.get(c.code); const iR = cdR ? indexOfDate(cdR, day) : null;
            atrOf.set(c.code, iR != null ? (atrPctAt(cdR, iR) ?? 99) : 99);
          }
          candidates.sort((a, b) => {
            const cv = b.conviction - a.conviction;
            if (cv) return cv;
            if (a.sub !== b.sub) return a.sub === 'hi120' ? -1 : 1;
            if (a.sub === 'rsi2') return (atrOf.get(a.code) ?? 99) - (atrOf.get(b.code) ?? 99);
            return 0;
          });
        }
        // ★ 2026-07-30 (--rsimarank): 확신도 동률 내 **MA거리 내림차순** 재정렬. 풀을 깎지 않고 순서만 바꾼다.
        //
        //   왜 이 축인가: 확신도는 rsi2에서 **사실상 상수다.** 라이브 journal 실측 BUY 28건 중
        //   **26건이 확신도 정확히 5.0**(나머지 2건만 2.3·0.8). 즉 후보가 슬롯보다 많을 때
        //   무엇을 사는지가 **임의 순서로 결정된다.** 07-30 라이브는 후보 98건에서 5건을 샀다 = 93건이 임의 탈락.
        //   실제 피해 사례: 07-29 카카오는 진입 시 MA거리 +1.0%(익절선 35,475 < 진입가 35,650)로
        //   **규칙상 최대 기대이익이 음수인 자리**였다. 같은 날 하이브는 +21.8% — 20배 차이인데
        //   확신도가 같아 구분되지 않았다.
        //
        //   같은 직관의 다른 두 형태는 이미 기각됐다(노이즈 바닥 0.268 초과):
        //     --rsimindist (거른다)   Calmar 3.30 → 1.71 (Δ-1.59)
        //     --maexitmin  (막는다)   Calmar 1.73 → 1.19 (Δ-0.54)
        //   ATR 정렬(--rsiatrrank)도 최하위였다(0.70). 그래서 **거르기·막기가 아니라 정렬**만 남았다.
        if (RSI_MA_RANK) {
          const mdOf = new Map();
          for (const c of candidates) {
            if (c.sub !== 'rsi2') continue;
            const cdR = candles.get(c.code); const iR = cdR ? indexOfDate(cdR, day) : null;
            const n = cfg.rsiMa || 5;
            // MA거리 % = 익절목표(MA)까지 남은 거리. 클수록 규칙상 기대이익이 크다.
            mdOf.set(c.code, (iR != null && iR >= n) ? ((maAt(cdR.c, iR, n) / cdR.c[iR] - 1) * 100) : -99);
          }
          candidates.sort((a, b) => {
            const cv = b.conviction - a.conviction;
            if (cv) return cv;
            if (a.sub !== b.sub) return a.sub === 'hi120' ? -1 : 1;
            if (a.sub === 'rsi2') {
              const av = mdOf.get(a.code) ?? -99, bv = mdOf.get(b.code) ?? -99;
              return RSI_MA_RANK === 'asc' ? av - bv : bv - av;
            }
            return 0;
          });
        }
        let newToday = 0;   // --maxnew: 당일 신규진입 카운터
        for (const candidate of candidates) {
          if (MAX_NEW > 0 && newToday >= MAX_NEW) break;   // 당일 신규진입 상한 도달
          if (book.positions[candidate.code]) continue;
          const cReg = SELF_REGIME ? (candidate.selfRegime ?? regime) : regime; // 스킵 필터도 같은 기준으로
          if (SKIP_NEUTRAL_RSI && cReg === 'NEUTRAL' && candidate.sub === 'rsi2') continue; // ICE#1: NEUTRAL rsi2 스킵 테스트
          if (SKIP_DOWN_RSI && cReg === 'DOWN' && candidate.sub === 'rsi2') continue;
          // ★ --rsiatrmax N: rsi2 진입 시 ATR(14)% 상한 (저변동성 프리미엄, IC t=-39.3)
          if (RSI_ATR_MAX > 0 && candidate.sub === 'rsi2') {
            const cdA = candles.get(candidate.code);
            const iA = cdA ? indexOfDate(cdA, day) : null;
            if (iA == null) continue;
            const a = atrPctAt(cdA, iA);
            if (a == null || a > RSI_ATR_MAX) continue;
          }
          // ★ 2026-07-29 (--cooldown N): 손절 후 N거래일 재진입 금지. **live-parity 경로엔 이 검사가 없었다**
          //   (sell()에서 book.cool은 설정되는데 비파리티 rsi2 경로에서만 검사됨) → 플래그가 무동작이었다.
          //   근거: 07-28~29 실거래 청산 16건 중 손실의 53%가 두산퓨얼셀 단일 종목 4회 휩소.
          //   그 증거로 라이브엔 "당일 재진입 금지"를 이미 배포했다. 백테판을 이제 검증한다.
          if (COOLDOWN > 0 && (book.cool?.[candidate.code] ?? -1) > di) continue;
          // ★ --rsiflow N: rsi2 진입에 수급 조건. 최근 D일 누적(기관+외국인) < N억이면 진입 안 함.
          //   데이터 부족 종목은 통과시킨다(백테의 "데이터 없으면 룰 미적용" 관례와 동일).
          if (RSI_FLOW != null && candidate.sub === 'rsi2' && FLOWS) {
            const fl = flowSum(candidate.code, day, RSI_FLOW_DAYS);
            if (fl && fl.both < RSI_FLOW) continue;
          }
          // ★ --rsimindist N: 익절목표(MA rsiMa)까지 N% 미만이면 손익비가 깨져 진입 안 함
          if (RSI_MIN_DIST > 0 && candidate.sub === 'rsi2') {
            const cdR = candles.get(candidate.code);
            const iR = cdR ? indexOfDate(cdR, day) : null;
            if (iR == null || iR < (cfg.rsiMa || 5)) continue;
            const maR = maAt(cdR.c, iR, cfg.rsiMa || 5);
            if ((maR / cdR.c[iR] - 1) * 100 < RSI_MIN_DIST) continue;
          }
          if (SELF_AND && candidate.sub === 'hi120' && candidate.selfRegime !== 'UP') continue; // 시장UP ∩ 종목UP
          // 가설B(--maxbreaklive N): 과열 돌파 진입 제외
          if (MAXBREAK_LIVE > 0 && candidate.sub === 'hi120' && Number(candidate.breakoutPct) > MAXBREAK_LIVE) continue;
          // 가설D(--flowout N / --flowsell): 기관+외국인 이탈 종목의 돌파 배제. 데이터 없으면 통과.
          if (FLOWS && candidate.sub === 'hi120') {
            if (FLOW_OUT > 0) { const f = flowSum(candidate.code, day, 20); if (f && f.both <= -FLOW_OUT) continue; }
            if (FLOW_SELL) { const f = flowSum(candidate.code, day, 5); if (f && f.org <= 0 && f.frg <= 0) continue; }
          }
          // 가설C(--anup N): 애널리스트 컨센서스 여력 필터. 커버된 종목만 심사(미커버는 통과, --anup-nocov-skip이면 제외)
          if (AN_HIST && candidate.sub === 'hi120') {
            const cons = anConsensus(candidate.code, day); // day = YYYYMMDD (analyst-hist의 date 형식과 동일)
            if (cons == null) { if (AN_NOCOV_SKIP) continue; }
            else if (AN_UP > 0 && (cons / candidate.price - 1) * 100 < AN_UP) continue;
          }
          // 2026-07-25: rsi2 추세/붕괴 필터 — 하락추세 종목의 과매도(떨어지는 칼날) 배제
          if (candidate.sub === 'rsi2' && (RSI_TREND !== 0 || RSI_MAXDD20 !== 0)) {
            const tcd = candles.get(candidate.code); const ti = tcd ? indexOfDate(tcd, day) : null;
            if (ti == null || ti < 61) continue;
            if (RSI_TREND !== 0 && (tcd.c[ti] / tcd.c[ti - 60] - 1) * 100 < RSI_TREND) continue;
            if (RSI_MAXDD20 !== 0 && (tcd.c[ti] / tcd.c[ti - 20] - 1) * 100 < -RSI_MAXDD20) continue;
          }
          const subCap = candidate.sub === 'volsurge' ? VOLSURGE_CAP : caps[candidate.sub];
          if (countSub(candidate.sub) >= subCap) continue;
          if (SECTORCAP > 0 && countSector(candidate.code, book) >= SECTORCAP) continue;
          const eq = equity(book, day);
          // 레짐 노출 스로틀: effEq = 투자대상 자본(나머지는 현금). 약세일수록 effEq↓ → 자동으로 현금 더 보유.
          const expFrac = REGIME_EXP ? (REGIME_EXP[regime] ?? 1) : 1;
          const effEq = eq * expFrac;
          const perSlot = Math.floor(effEq / cfg.slots);
          const countBig = () => Object.entries(book.positions).filter(([code, p]) => {
            const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
            const px = i == null ? p.entry : cd.c[i];
            return px * p.qty >= perSlot * CAPITAL_DEPLOY.dustFraction;
          }).length;
          let bigCount = countBig();
          const blocked = () => bigCount >= cfg.slots || book.cash < perSlot * CAPITAL_DEPLOY.minFillFraction;
          // ★ 2026-07-30 배선 수정: ROTATE가 **non-live-parity 분기(아래 else)에만** 걸려 있어
          //   --live-parity 실행에서는 죽은 코드였다. 실측: --rotate 유/무 + rotminhold 1/3 세 조합이
          //   1115체결·CAGR 26.2%·최종자본 21,942,606원으로 완전 동일, 로그에 'rotate' 0건.
          //   (오늘 세 번째 사례 — --cooldown no-op, --dynslot 미결합에 이어)
          //   ★ 배선 지점이 중요하다: 이 break가 "슬롯 만석 또는 현금 부족"에서 즉시 발동하는데
          //     그게 바로 로테이션이 필요한 상황이다. bgt 산출 뒤에 훅을 달면 도달하지 못한다
          //     (1차 시도가 그래서 또 무효였다 — 값이 다시 완전 동일했다).
          //   → break 자리에서 최약 laggard를 팔아 자리를 만들고, 그래도 막히면 break.
          if (blocked()) {
            let rotated = false;
            if (ROTATE) {
              const w = weakestLaggard(book, day);
              if (w && w !== candidate.code) {
                const cw = candles.get(w), iw = cw ? indexOfDate(cw, day) : null;
                if (iw != null) { sell(book, day, w, cw.c[iw], 'rotate'); rotated = true; }
              }
            }
            if (!rotated) break;
            bigCount = countBig();          // 매도로 슬롯·현금이 바뀌었으므로 재평가
            if (blocked()) break;
          }
          // 변동성 사이징(--atrsize N): 후보 종목 ATR%가 목표(N%)보다 크면 작게, 작으면 크게(0.5~1.5배). atrSize 미설정 시 1.
          const vcd = candles.get(candidate.code); const vci = vcd ? indexOfDate(vcd, day) : null;
          const atrM = vci != null ? atrMult(vcd, vci, cfg) : 1;
          const bgt = liveCandidateBudget({
            cash: book.cash,
            equity: effEq,
            slots: cfg.slots,
            // 가설A(--noconc-rsi2): rsi2는 확신도를 임계값 미달로 강제 → 집중(몰빵) 대신 균등분산
            conviction: (NO_CONC_RSI2 && candidate.sub === 'rsi2') ? 0 : candidate.conviction,
            strongThreshold: CONVICTION_SIZING.strongThreshold,
            strongFraction: CONVICTION_SIZING.strongFraction,
            exposureMultiplier: volMult * atrM,
          });
          if (candidate.price >= bgt) continue;
          const ctx = candidate.sub === 'hi120'
            ? { sub: 'hi120', regime, breakoutPct: candidate.breakoutPct.toFixed(1), conviction: candidate.conviction.toFixed(1) }
            : candidate.sub === 'volsurge'
            ? { sub: 'volsurge', regime, volRatio: Number(candidate.volRatio).toFixed(2), dayRet: Number(candidate.dayRet).toFixed(1), conviction: candidate.conviction.toFixed(1) }
            // ★ 2026-07-29: maDist = 진입 시점 익절목표(MA rsiMa)까지의 거리 %. 버킷 분석으로
            //   "이 값이 결과를 예측하는가"(= 랭킹 신호로 쓸 수 있는가)를 본다. 필터 통과 여부와 별개 질문.
            : { sub: 'rsi2', regime, rsi: candidate.rsi.toFixed(0), conviction: candidate.conviction.toFixed(1),
              maDist: (vci != null && vci >= (cfg.rsiMa || 5)) ? ((maAt(vcd.c, vci, cfg.rsiMa || 5) / vcd.c[vci] - 1) * 100).toFixed(1) : null };
          buy(book, day, candidate.code, candidate.price, bgt, { sub: candidate.sub, ctx, breakLv: candidate.breakLv, ...(scenPol?.trailPct > 0 ? { scenTrail: scenPol.trailPct } : {}), ...(scenPol?.stopPct > 0 ? { scenStop: scenPol.stopPct } : {}), ...(scenPol?.maxHoldR > 0 ? { scenMaxHold: scenPol.maxHoldR } : {}) });
          newToday++;
        }
      } else {
      // hi120 서브 진입 (모멘텀 유니버스 신고가 돌파)
      for (const code of mom) {
        if (MAXPOS > 0 && Object.keys(book.positions).length >= MAXPOS) break; // 총 종목수 상한(현행 live 모사)
        if (countSub('hi120') >= caps.hi120 || book.positions[code]) continue;
        if (SECTORCAP > 0 && countSector(code, book) >= SECTORCAP) continue; // 섹터 캡
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < cfg.lookback + 1) continue;
        let prevHigh = 0;
        for (let j = i - cfg.lookback; j < i; j++) prevHigh = Math.max(prevHigh, cd.h[j]);
        const breakoutPct = (cd.c[i] / prevHigh - 1) * 100;
        // H3: 돌파일 거래량 필터 (--volx N) — 거래량 미동반 돌파 제외
        let volOk = true;
        if (cfg.volX > 0 && i >= 21) {
          let av = 0;
          for (let j = i - 20; j < i; j++) av += cd.v[j];
          volOk = cd.v[i] > (av / 20) * cfg.volX;
        }
        // C16 (--maxbreak N): 돌파폭 과열 상한 — 파라볼릭 진입 제외
        const breakCapOk = !(cfg.maxBreak > 0) || breakoutPct <= cfg.maxBreak;
        // C24 (--closeloc N): 돌파일 종가 위치 필터 — (c-l)/(h-l) >= N, 장중 되돌림 없는 강한 마감만
        const clOk = !(cfg.closeLoc > 0) || (cd.h[i] > cd.l[i] && (cd.c[i] - cd.l[i]) / (cd.h[i] - cd.l[i]) >= cfg.closeLoc);
        if (cd.c[i] > prevHigh && breakoutPct >= (cfg.minBreakout ?? 0) && breakCapOk && clOk && volOk) {
          const ctxE = { sub: 'hi120', regime, breakoutPct: breakoutPct.toFixed(1) };
          const am = atrMult(cd, i, cfg) * hedgeBudgetMult(day);  // 시그널 시점 ATR 사이징 (라이브 liveAtrMult와 동일 시점)
          // I16: entryOpen 시 atrM·breakLv를 시그널 시점 값으로 보존 → 익일 시가 체결에 적용 (라이브 충실)
          if (cfg.entryOpen) (book.pendingBuys ??= []).push({ code, ctx: ctxE, breakLv: prevHigh, atrM: am, sigClose: cd.c[i] });
          else { const bgt = Math.floor(budget() * am);
            if (ROTATE && book.cash < bgt * 0.5) { const w = weakestLaggard(book, day); if (w && w !== code) { const cw = candles.get(w), iw = cw ? indexOfDate(cw, day) : null; if (iw != null) sell(book, day, w, cw.c[iw], 'rotate'); } }
            buy(book, day, code, cd.c[i], bgt, { sub: 'hi120', ctx: ctxE, breakLv: prevHigh }); }
        }
      }
      // rsi2 서브 진입 (PIT 시총 상위 + 20일 평균 거래대금 30억 이상)
      const rsiPool = mcapUniverse(day, MCAP_TOP);
      for (const code of rsiPool) {
        if (MAXPOS > 0 && Object.keys(book.positions).length >= MAXPOS) break; // 총 종목수 상한(현행 live 모사)
        if (countSub('rsi2') >= caps.rsi2 || book.positions[code]) continue;
        if (SECTORCAP > 0 && countSector(code, book) >= SECTORCAP) continue; // 섹터 캡
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 4) continue;
        const r = rsi2(cd, i);
        // H7: N일 연속 과매도 요구 (--rsidays 2)
        const daysOk = !(cfg.rsiDays > 1) || rsi2(cd, i - 1) < cfg.rsiMax;
        // C18: stop_loss 쿨다운 중이면 재진입 금지
        if ((book.cool?.[code] ?? -1) > di) continue;
        // C25 (--rsivol 1): 투매 거래량 확인 — 당일 거래량 > 20일 평균
        let rvOk = true;
        if (cfg.rsiVol > 0 && i >= 21) {
          let av = 0;
          for (let j = i - 20; j < i; j++) av += cd.v[j];
          rvOk = cd.v[i] > (av / 20) * cfg.rsiVol;
        }
        if (r < cfg.rsiMax && daysOk && rvOk) {
          // H2: DOWN 레짐 사이즈 축소 (--downsize 0.5)
          const sizeMult = (regime === 'DOWN' && cfg.downSize > 0) ? cfg.downSize : 1;
          { const bgt = Math.floor(budget() * sizeMult * atrMult(cd, i, cfg));
            if (ROTATE && book.cash < bgt * 0.5) { const w = weakestLaggard(book, day); if (w && w !== code) { const cw = candles.get(w), iw = cw ? indexOfDate(cw, day) : null; if (iw != null) sell(book, day, w, cw.c[iw], 'rotate'); } }
            buy(book, day, code, cd.c[i], bgt, { sub: 'rsi2', ctx: { sub: 'rsi2', regime, rsi: r.toFixed(0) } }); }
        }
      }
      }
    } else if (k === 'rsi2' || k === 'rsi2-pit' || k === 'rsi2-mcap') {
      const uni = k === 'rsi2' ? largeCaps : k === 'rsi2-pit' ? liqUniverse(day) : mcapUniverse(day);
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        let ma5 = 0; const n = Math.min(5, i + 1);
        for (let j = i - n + 1; j <= i; j++) ma5 += cd.c[j];
        ma5 /= n;
        if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (cd.c[i] > ma5) p.exitAtOpen = 'ma5_exit';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of uni) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 3) continue;
        if (rsi2(cd, i) < cfg.rsiMax) buy(book, day, code, cd.c[i], budget());
      }
    } else if (k === 'bb-mr') {
      // 하단밴드 이탈 → 재진입 확인 매수 (단순 터치 아님, 낙하나이프 방지) / 중심선 도달 전량청산
      const uni = mcapUniverse(day, MCAP_TOP);
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        const bb = bbBands(cd, i, cfg.period, cfg.mult);
        if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (bb && cd.c[i] > bb.sma) p.exitAtOpen = 'bb_mid_exit';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of uni) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < cfg.period) continue;
        const bbPrev = bbBands(cd, i - 1, cfg.period, cfg.mult);
        const bb = bbBands(cd, i, cfg.period, cfg.mult);
        if (!bbPrev || !bb) continue;
        if (cd.c[i - 1] < bbPrev.lower && cd.c[i] > bb.lower) buy(book, day, code, cd.c[i], budget());
      }
    } else if (k === 'bb-brk') {
      // 밴드폭 스퀴즈(전일까지 sqzLookback일 분포 하위 sqzQuantile) 후 상단 돌파 매수 / 트레일링 청산
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        if (cd.c[i] <= p.hi * (1 - cfg.trailPct / 100)) p.exitAtOpen = 'trailing';
        else if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of mom) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < cfg.period + cfg.sqzLookback) continue;
        // 전일까지의 밴드로 판정 (hi120의 prevHigh와 동일 사상 — 당일 돌파가 밴드를 넓혀 자기부정하는 것 방지)
        const bbY = bbBands(cd, i - 1, cfg.period, cfg.mult);
        if (!bbY || bbY.sma <= 0) continue;
        const bandwidths = [];
        for (let j = i - 1 - cfg.sqzLookback; j <= i - 1; j++) {
          const b = bbBands(cd, j, cfg.period, cfg.mult);
          if (b && b.sma > 0) bandwidths.push((b.upper - b.lower) / b.sma);
        }
        if (bandwidths.length < cfg.sqzLookback * 0.8) continue;
        bandwidths.sort((a, b2) => a - b2);
        const threshold = bandwidths[Math.floor(bandwidths.length * cfg.sqzQuantile)];
        const bwY = (bbY.upper - bbY.lower) / bbY.sma;
        if (bwY <= threshold && cd.c[i] > bbY.upper) {
          buy(book, day, code, cd.c[i], budget(), { ctx: { sub: 'bb-brk', bandwidth: bwY.toFixed(4) } });
        }
      }
    } else if (k === 'hma-turn') {
      // HMA 슬로프 상향 반전 매수 / 슬로프 하향 청산 (Hull 정석 — 지연 최소 추세 전환)
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        const h0 = hmaAt(cd.c, i, cfg.period), h1 = hmaAt(cd.c, i - 1, cfg.period);
        if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (h0 != null && h1 != null && h0 < h1) p.exitAtOpen = 'hma_exit';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of mom) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        const h0 = hmaAt(cd.c, i, cfg.period), h1 = hmaAt(cd.c, i - 1, cfg.period), h2 = hmaAt(cd.c, i - 2, cfg.period);
        if (h0 == null || h1 == null || h2 == null) continue;
        // 슬로프 상향 반전 (직전까지 하락/보합 → 당일 상승) + 종가가 HMA 위
        if (h0 > h1 && h1 <= h2 && cd.c[i] > h0) {
          buy(book, day, code, cd.c[i], budget(), { ctx: { sub: 'hma-turn' } });
        }
      }
    } else if (k === 'hma-dip') {
      // HMA 하향 이탈 매수 → HMA 상향 복귀 청산 (평균회귀 falsification — rsi2 중복률 확인 전제)
      const uni = mcapUniverse(day, MCAP_TOP);
      for (const [code, p] of Object.entries(book.positions)) {
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null) continue;
        const h0 = hmaAt(cd.c, i, cfg.period);
        if (cd.c[i] <= p.entry * (1 - cfg.stopPct / 100)) p.exitAtOpen = 'stop_loss';
        else if (h0 != null && cd.c[i] > h0) p.exitAtOpen = 'hma_revert';
        else if (p.holdDays >= cfg.maxHold) p.exitAtOpen = 'max_hold';
      }
      for (const code of uni) {
        if (book.positions[code] || Object.keys(book.positions).length >= cfg.slots) continue;
        const cd = candles.get(code); const i = cd ? indexOfDate(cd, day) : null;
        if (i == null || i < 1) continue;
        const h0 = hmaAt(cd.c, i, cfg.period), h1 = hmaAt(cd.c, i - 1, cfg.period);
        if (h0 == null || h1 == null) continue;
        // 전일 HMA 위 → 당일 HMA 아래 (하향 이탈 첫날만)
        if (cd.c[i - 1] >= h1 && cd.c[i] < h0) {
          buy(book, day, code, cd.c[i], budget(), { ctx: { sub: 'hma-dip' } });
        }
      }
    }

    // ③ 자산·MDD·월별 수익 추적
    const eq = equity(book, day);
    book.peak = Math.max(book.peak, eq);
    book.maxDD = Math.max(book.maxDD, (book.peak - eq) / book.peak * 100);
    const mon = day.slice(0, 6);
    if (!book.monthly.has(mon)) book.monthly.set(mon, { start: book.lastEq, end: eq });
    book.monthly.get(mon).end = eq;
    book.lastEq = eq;
    recordDailyEquity(book, day, eq);
  }
  if ((di + 1) % 60 === 0) console.log(`[${di + 1}/${tradingDays.length}] ${fmtDay(day)} | ` + ACTIVE.map(([k]) => `${k}:${((equity(books[k], day) / CAPITAL - 1) * 100).toFixed(0)}%`).join(' '));
}

const lastDay = tradingDays[tradingDays.length - 1];
for (const [k] of ACTIVE) {
  const book = books[k];
  for (const code of Object.keys(book.positions)) {
    const cd = candles.get(code);
    const i = cd ? indexOfDate(cd, lastDay) ?? lastIndexBefore(cd, lastDay) : null;
    sell(book, lastDay, code, i != null && i >= 0 ? cd.c[i] : book.positions[code].entry, 'eov');
  }
  if (book.daily.length) book.daily[book.daily.length - 1].equity = book.cash;
}

// ── 요약: 복리 안정성 관점 ────────────────────────────────────
const years = tradingDays.length / 248;
console.log(`\n=== 전략 비교 (${fmtDay(FROM)}~${fmtDay(TO)}, ${tradingDays.length}영업일 ≈ ${years.toFixed(1)}년) ===`);
console.log('전략         체결    승률   PF     CAGR     MDD    월승률   평균보유  최종자본');
console.log('─'.repeat(95));
for (const [k] of ACTIVE) {
  const b = books[k];
  const wins = b.trades.filter(t => t.pnl > 0);
  const losses = b.trades.filter(t => t.pnl <= 0);
  const grossW = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = -losses.reduce((s, t) => s + t.pnl, 0);
  const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '∞';
  const months = [...b.monthly.values()];
  const monWin = months.length ? Math.round(months.filter(m => m.end > m.start).length / months.length * 100) : 0;
  const cagr = (Math.pow(b.cash / CAPITAL, 1 / years) - 1) * 100;
  const avgHold = b.trades.length ? (b.trades.reduce((s, t) => s + t.hold, 0) / b.trades.length).toFixed(1) : '-';
  console.log(
    `${k.padEnd(12)} ${String(b.trades.length).padStart(4)}  ${String(b.trades.length ? Math.round(wins.length / b.trades.length * 100) : 0).padStart(4)}%  ${String(pf).padStart(5)}  ${cagr.toFixed(1).padStart(6)}%  ${b.maxDD.toFixed(1).padStart(5)}%  ${String(monWin).padStart(4)}%  ${String(avgHold).padStart(6)}일  ${b.cash.toLocaleString()}원`
  );
}

// 레짐 전환 통계 — hma 레짐 whipsaw 비교용 (sweep-hma.mjs가 이 줄을 파싱)
{
  let prev = null, trans = 0;
  const dist = { UP: 0, NEUTRAL: 0, DOWN: 0 };
  for (const day of tradingDays) {
    const r = marketRegime(day);
    dist[r]++;
    if (prev && r !== prev) trans++;
    prev = r;
  }
  console.log(`\n레짐 통계 (mode=${REGIME_MODE}${REGIME_MODE === 'hma' ? ` N=${REGIME_HMA_N}` : ''}): 전환 ${trans}회 | UP ${dist.UP}일 / NEUTRAL ${dist.NEUTRAL}일 / DOWN ${dist.DOWN}일`);
}

// 연도별 수익률 분해 (레짐별 일관성)
console.log('\n연도별 수익률:');
const yearsList = [...new Set(tradingDays.map(d => d.slice(0, 4)))];
for (const [k] of ACTIVE) {
  const b = books[k];
  const byYear = yearsList.map(y => {
    const months = [...b.monthly.entries()].filter(([m]) => m.startsWith(y)).map(([, v]) => v);
    if (!months.length) return `${y}: -`;
    const ret = (months[months.length - 1].end / months[0].start - 1) * 100;
    return `${y}: ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`;
  });
  console.log(`  ${k.padEnd(12)} ${byYear.join('  ')}`);
}

if (VOL_SHADOW) {
  console.log('\n볼라틸리티 스로틀 shadow:');
  for (const k of ['combo', 'combo-v2']) {
    if (!shadowStats[k]?.count) continue;
    console.log(
      `  ${k.padEnd(12)} avgMult=${(shadowStats[k].sum / shadowStats[k].count).toFixed(3)} ` +
      `minMult=${shadowStats[k].min.toFixed(3)} days=${shadowStats[k].count}`
    );
  }
}
// ── combo 조건별 분석: 해야할 것 / 하지말아야할 것 ─────────────
for (const comboKey of ['combo', 'combo-v2']) {
  if (!books[comboKey]) continue;
  const ct = books[comboKey].trades.filter(t => t.ctx);
  const groups = new Map();
  for (const t of ct) {
    for (const key of [
      `${t.ctx.sub} × 레짐 ${t.ctx.regime}`,
      `${t.ctx.sub} × 청산 ${t.reason}`,
      t.ctx.sub === 'rsi2' ? `rsi2 × RSI ${t.ctx.rsi <= 5 ? '0~5(극단)' : '5~10'}` : `hi120 × 돌파폭 ${Number(t.ctx.breakoutPct) >= 3 ? '3%+(갭성)' : '0~3%'}`,
      `${t.ctx.sub} × 보유 ${t.hold <= 3 ? '1~3일' : t.hold <= 10 ? '4~10일' : '11일+'}`,
      // ★ 2026-07-29: rsi2 진입 시 익절목표까지 거리 버킷. 이 축이 결과를 가르면 랭킹 신호로 쓸 수 있다.
      // ★ 1% 단위 — 손실 구간의 경계가 진짜 2%인지, 내가 2%로 끊어서 그렇게 보이는지 가른다.
      //   임계를 내가 고른 것이 아니라 데이터가 정하는지 확인하는 절차다.
      ...(t.ctx.sub === 'rsi2' && t.ctx.maDist != null
        ? [`rsi2 × 거리 ${(() => { const d = Number(t.ctx.maDist); return d < 0.5 ? 'a 0.0~0.5%' : d < 1 ? 'b 0.5~1%' : d < 1.5 ? 'c 1~1.5%' : d < 2 ? 'd 1.5~2%' : d < 3 ? 'e 2~3%' : d < 4 ? 'f 3~4%' : d < 5 ? 'g 4~5%' : d < 7 ? 'h 5~7%' : 'i 7%+'; })()}`]
        : []),
    ]) {
      if (!groups.has(key)) groups.set(key, { n: 0, w: 0, pnl: 0 });
      const g = groups.get(key);
      g.n++; if (t.pnl > 0) g.w++; g.pnl += t.pnl;
    }
  }
  console.log(`\n=== ${comboKey} 조건별 성적 (매매 사유 기록 기반) ===`);
  const rows = [...groups.entries()].filter(([, g]) => g.n >= 15).sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n);
  for (const [key, g] of rows) {
    console.log(`  ${key.padEnd(28)} n=${String(g.n).padStart(4)} 승률 ${String(Math.round(g.w / g.n * 100)).padStart(3)}% 누적 ${(g.pnl >= 0 ? '+' : '') + Math.round(g.pnl / 1000).toLocaleString()}k`);
  }
  const dos = rows.filter(([, g]) => g.w / g.n >= 0.55 && g.pnl > 0).map(([k]) => k);
  const donts = rows.filter(([, g]) => g.w / g.n < 0.40 || g.pnl < 0).map(([k]) => k);
  console.log('\n  ✅ 해야할 것: ' + (dos.join(' / ') || '(표본 부족)'));
  console.log('  ⛔ 하지말아야할 것: ' + (donts.join(' / ') || '(표본 부족)'));
}
console.log(`\n비용: 수수료 ${FEE_BPS}bp×2 + 거래세 ${TAX_BPS}bp + 슬리피지 ±1틱 | 풀: 현재 상장 ${candles.size}종목 (생존 편향) | swing-rank: 랭킹 ${rankByDay.size}일치`);

// 매매 내역 덤프 (--dump path) — 사이클 분석용
if (DUMP) {
  const { writeFileSync } = await import('fs');
  const out = {};
  for (const [k] of ACTIVE) out[k] = serializeResearchBook(books[k]);
  writeFileSync(DUMP, JSON.stringify({
    from: FROM,
    to: TO,
    capital: CAPITAL,
    seed: MC_SEED,
    subsample: SUBSAMPLE,
    stress: STRESS,
    universe: { kind: 'current-listed', size: candles.size, survivorshipBias: true },
    params: Object.fromEntries(ACTIVE.map(([key, cfg]) => [key, cfg])),
    books: out,
  }));
  console.log(`덤프 저장: ${DUMP}`);
}

// 시나리오 태깅 덤프 (--scendump path) — 진입일 시나리오별 거래 원장 (집계는 분석 스크립트에서)
if (SCENDUMP) {
  const { writeFileSync } = await import('fs');
  const trades = {};
  for (const [k] of ACTIVE) {
    trades[k] = books[k].trades.map(t => ({
      eday: t.eday ?? null, day: t.day, code: t.code, scen: t.scen, sub: t.sub,
      reason: t.reason, entry: t.entry, exit: t.exit, qty: t.qty, pnl: t.pnl, hold: t.hold,
    }));
  }
  writeFileSync(SCENDUMP, JSON.stringify({
    from: FROM, to: TO, seed: MC_SEED, subsample: SUBSAMPLE,
    argv: argv.join(' '),
    params: Object.fromEntries(ACTIVE.map(([key, cfg]) => [key, cfg])),
    finalCash: Object.fromEntries(ACTIVE.map(([key]) => [key, books[key].cash])),
    maxDD: Object.fromEntries(ACTIVE.map(([key]) => [key, books[key].maxDD])),
    trades,
  }));
  console.log(`시나리오 덤프 저장: ${SCENDUMP}`);
}
