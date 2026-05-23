import { createRequire }  from "module";
import { fileURLToPath }  from "url";
import path from "path";

const require   = createRequire(import.meta.url);
const Database  = require("better-sqlite3");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH = path.join(__dirname, "dart-data.db");

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stocks (
      stock_code TEXT PRIMARY KEY,
      stock_name TEXT,
      market     TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS prices (
      stock_code TEXT,
      date       TEXT,
      close      REAL,
      open       REAL,
      high       REAL,
      low        REAL,
      volume     INTEGER,
      market_cap REAL,
      fetched_at TEXT,
      PRIMARY KEY (stock_code, date)
    );

    CREATE TABLE IF NOT EXISTS disclosures (
      rcept_no   TEXT PRIMARY KEY,
      stock_code TEXT,
      corp_code  TEXT,
      date       TEXT,
      type       TEXT,
      title      TEXT,
      filer      TEXT,
      url        TEXT,
      body       TEXT,
      fetched_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_prices_code_date       ON prices (stock_code, date DESC);
    CREATE INDEX IF NOT EXISTS idx_disclosures_code_date  ON disclosures (stock_code, date DESC);
  `);
  return db;
}
