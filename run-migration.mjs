// 실행: node run-migration.mjs migration-v6.sql
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const MGMT_KEY = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!MGMT_KEY || !PROJECT_REF) { console.error("SUPABASE_MANAGEMENT_KEY / SUPABASE_PROJECT_REF 미설정"); process.exit(1); }

const file = process.argv[2];
if (!file) { console.error("사용법: node run-migration.mjs <file.sql>"); process.exit(1); }
const sql = fs.readFileSync(path.join(__dirname, file), "utf8");

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${MGMT_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const data = await res.json().catch(() => null);
if (!res.ok) { console.error("마이그레이션 실패:", JSON.stringify(data)); process.exit(1); }
console.log(`✅ ${file} 적용 완료`, Array.isArray(data) ? `(rows: ${data.length})` : "");
