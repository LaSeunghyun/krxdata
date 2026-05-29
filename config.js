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
export const FACTOR_WEIGHTS = {
  // IC-calibrated (Loop B): 2025-05~2026-05, 25주 리밸런스, 20d·60d spearman IC 평균.
  // backtest-pit.mjs 합성점수 전용(연구용) — 라이브 v5 스코어러는 자체 로직 사용, 영향 없음.
  // ⚠ 1년 단일 국면(성장·모멘텀 우위) 기준 — value 역방향은 국면 의존적. 분기 갱신 권장.
  value: -0.15,         // IC -0.12/-0.19 (IC>0 0~8%) 일관 역방향 → 역가중
  quality: 0.02,        // IC +0.027/+0.020
  growth: 0.08,         // IC +0.050/+0.093 (IC>0 96~100%) 최강
  priceMomentum: 0.03,  // IC +0.006/+0.039
  trend: 0,             // IC ~0
  earningsMomentum: 0,  // 미측정(분기 데이터 필요) — probation
  governance: 0,        // 미측정 — probation
  event: 0,             // 공시: 미측정 — probation
};
