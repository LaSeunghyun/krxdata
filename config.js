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

export const SCORE_BATCH_SIZE = toNumber("SCORE_BATCH_SIZE", 100);
export const SCORE_DELAY_MS = toNumber("SCORE_DELAY_MS", 300);
export const TOP_STOCK_LIMIT = toNumber("TOP_STOCK_LIMIT", 100);

export const FETCH_TIMEOUT_MS = toNumber("FETCH_TIMEOUT_MS", 10_000);
export const BATCH_TIMEOUT_MS = toNumber("BATCH_TIMEOUT_MS", 30_000);
export const PATCH_MARKETCAP_DELAY_MS = toNumber("PATCH_MARKETCAP_DELAY_MS", 200);
export const FILTER_DELAY_MS = toNumber("FILTER_DELAY_MS", 500);
