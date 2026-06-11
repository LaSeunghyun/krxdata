import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const toNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
};

export const ANALYSIS_YEAR = process.env.ANALYSIS_YEAR ?? "2025";
export const ANALYSIS_YEAR_FALLBACK = process.env.ANALYSIS_YEAR_FALLBACK ?? "2024";

// daily-ranking SQL에서 사용하는 숫자 연도 (YEAR, 직전, 전전)
export const ANALYSIS_YEAR_NUM = Number(ANALYSIS_YEAR);
export const ANALYSIS_YEAR_PREV = ANALYSIS_YEAR_NUM - 1;
export const ANALYSIS_YEAR_PREV2 = ANALYSIS_YEAR_NUM - 2;

export const SCORE_BATCH_SIZE = toNumber("SCORE_BATCH_SIZE", 100);
export const SCORE_DELAY_MS = toNumber("SCORE_DELAY_MS", 300);
export const TOP_STOCK_LIMIT = toNumber("TOP_STOCK_LIMIT", 100);

export const FETCH_TIMEOUT_MS = toNumber("FETCH_TIMEOUT_MS", 10_000);
export const BATCH_TIMEOUT_MS = toNumber("BATCH_TIMEOUT_MS", 30_000);
export const PATCH_MARKETCAP_DELAY_MS = toNumber("PATCH_MARKETCAP_DELAY_MS", 200);
export const FILTER_DELAY_MS = toNumber("FILTER_DELAY_MS", 500);

// ── 백테스트(스코어링 v2) 상수 ──
export const BACKTEST_HORIZONS = [20, 60]; // 영업일(≈1M, 3M) 포워드 수익 구간
export const BACKTEST_TOLERANCE = 5; // 스냅샷 정렬 허용일
export const WINSOR_BOUNDS = [0.01, 0.99]; // 섹터 z-score winsorize 분위
export const BACKTEST_ROUND_TRIP_COST = 0.005; // 왕복 거래비용 0.5% (수수료+거래세+슬리피지 보수 추정)
export const BACKTEST_MIN_PRICE = 1000; // 동전주 제외 (유동성·슬리피지 방어)

// ── 포트폴리오 운용 규칙 ──
export const STOP_LOSS_PCT = -25;   // 즉시청산
export const HALF_PROFIT_PCT = 100; // 절반익절
export const FACTOR_WEIGHTS = {
  // IC-calibrated (Loop B, PIT 수정판): 2025-05-07~2026-06-11, 25주 리밸런스, 2,572종목.
  // 각 시점 T에서 rcept_dt <= T 재무만 사용 (look-ahead 제거 후 재측정).
  // 규칙: w = clamp(round(mean(IC20, IC60), 2), ±0.2), |w|<0.01 → 0.
  // ※ 이전 가중치(growth 0.08, value -0.15)는 look-ahead 오염 측정치 기반이라 폐기 —
  //   PIT 수정 후 growth IC -0.003/+0.004, value IC -0.004/-0.003 (둘 다 노이즈 수준).
  value: 0,             // IC -0.004/-0.003 → 노이즈 컷
  quality: -0.01,       // IC -0.007/-0.020
  growth: 0,            // IC -0.003/+0.004 → 노이즈 컷 (누수 제거 후 신호 소멸)
  priceMomentum: 0.02,  // IC +0.002/+0.046 (60d IC>0 76%) — 최강 팩터
  trend: 0,             // IC -0.013/+0.018 → 노이즈 컷
  earningsMomentum: 0,  // IC -0.047/-0.079 (60d IC>0 0%) — 첫 측정·이상 분포(완전 역방향).
                        //   규칙상 -0.06이나 데이터 품질 의심(999 코딩·rcept 추정 폴백) → 1분기 probation 후 재검증
  governance: 0,        // 미측정 — probation
  event: 0,             // 공시: 미측정 — probation
};
