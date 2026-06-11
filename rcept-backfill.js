/**
 * rcept-backfill.js — stock_financials.rcept_dt 백필 (연간 11011)
 *
 * DART fnlttMultiAcnt 응답의 rcept_no 앞 8자리 = 접수일(YYYYMMDD).
 * 정정공시가 있으면 정정 접수일이 들어옴 → PIT 관점에서 보수적(늦게 반영) = 안전.
 *
 * 실행: node rcept-backfill.js --years 2023,2024,2025
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchYearFinancials, loadCompanies, dbQuery } from "./dart-financials-backfill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const args = process.argv.slice(2);
const yearsArg = args.find(a => a.startsWith("--years"))?.split("=")[1] ?? args[args.indexOf("--years") + 1];
const YEARS = yearsArg ? yearsArg.split(",").map(y => y.trim()) : ["2023", "2024", "2025"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const companies = await loadCompanies(args.includes("--db")); // --db: DB+corpCode 전체 유니버스
  const byCorp = new Map(companies.map(c => [c.corp_code, c]));
  console.log(`대상 ${companies.length}개 기업 / 연도 ${YEARS.join(",")}`);

  for (const year of YEARS) {
    console.log(`\n[${year}] rcept_dt 수집...`);
    const updates = new Map(); // stock_code -> rcept_dt
    for (let i = 0; i < companies.length; i += 100) {
      const batch = companies.slice(i, i + 100);
      const rows = await fetchYearFinancials(batch.map(c => c.corp_code), year);
      for (const r of rows) {
        const c = byCorp.get(r.corp_code);
        if (!c || !r.rcept_no) continue;
        const dt = String(r.rcept_no).slice(0, 8);
        if (/^\d{8}$/.test(dt)) updates.set(c.stock_code, dt);
      }
      process.stdout.write(`\r  배치 ${Math.min(i + 100, companies.length)}/${companies.length} (확보 ${updates.size})`);
      await sleep(300);
    }
    console.log("");
    const entries = [...updates.entries()];
    for (let i = 0; i < entries.length; i += 500) {
      const vals = entries.slice(i, i + 500)
        .filter(([code]) => /^[A-Za-z0-9]{5,6}$/.test(code))
        .map(([code, dt]) => `('${code}','${dt}')`).join(",");
      if (!vals) continue;
      await dbQuery(`
        UPDATE stock_financials sf SET rcept_dt = v.dt
        FROM (VALUES ${vals}) AS v(stock_code, dt)
        WHERE sf.stock_code = v.stock_code
          AND sf.analysis_year = ${Number(year)}
          AND sf.report_code = '11011'
      `);
    }
    console.log(`  ✅ [${year}] ${entries.length}건 rcept_dt 업데이트`);
  }
  const left = await dbQuery(
    `SELECT analysis_year, COUNT(*) cnt FROM stock_financials WHERE report_code='11011' AND rcept_dt IS NULL GROUP BY 1 ORDER BY 1`
  );
  console.log("\n잔여 NULL(estimateRceptDt 폴백 대상):", JSON.stringify(left));
}
main().catch(e => { console.error(e); process.exit(1); });
