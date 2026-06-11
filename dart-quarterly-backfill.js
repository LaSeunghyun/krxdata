/**
 * dart-quarterly-backfill.js — 분기/반기 재무 적재 (report_code 11013/11012/11014)
 *
 * 분기보고서의 thstrm_add_amount(당기 누적) vs frmtrm_add_amount(전년동기 누적) 비교로
 * 계절성 없는 YoY를 산출(quarterlyYoY 재사용)해 분기 행으로 upsert.
 * rcept_no 앞 8자리 = 접수일 → rcept_dt (PIT용).
 *
 * 실행: node dart-quarterly-backfill.js [--periods 2025:11013,2025:11012,2025:11014,2026:11013]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchYearFinancials, loadCompanies, dbQuery } from "./dart-financials-backfill.js";
import { quarterlyYoY } from "./factors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const QUARTER_OF = { "11013": 1, "11012": 2, "11014": 3 };
const args = process.argv.slice(2);
const periodsArg = args.find(a => a.startsWith("--periods"))?.split("=")[1] ?? args[args.indexOf("--periods") + 1];
const PERIODS = (periodsArg ?? "2025:11013,2025:11012,2025:11014,2026:11013")
  .split(",").map(p => { const [y, rc] = p.trim().split(":"); return { year: y, reprtCode: rc }; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const numAmt = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) && n !== 0 ? n : null; };
const esc = v => v == null ? "NULL" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "NULL") : `'${String(v).replace(/'/g, "''")}'`;

function pickAccount(rows, names) {
  for (const nm of names) {
    const row = rows.find(r => r.sj_div !== "CF" && r.account_nm?.replace(/\s/g, "") === nm.replace(/\s/g, ""));
    if (row) {
      // 누적(_add_amount) 우선 — 전년동기 누적과 비교해야 계절성이 제거됨
      const cur = numAmt(row.thstrm_add_amount ?? row.thstrm_amount);
      const prv = numAmt(row.frmtrm_add_amount ?? row.frmtrm_amount);
      return { cur, prv };
    }
  }
  return { cur: null, prv: null };
}

async function main() {
  const companies = await loadCompanies();
  const byCorp = new Map(companies.map(c => [c.corp_code, c]));
  console.log(`대상 ${companies.length}개 기업 / 기간 ${PERIODS.map(p => `${p.year}:${p.reprtCode}`).join(",")}`);

  for (const { year, reprtCode } of PERIODS) {
    const quarter = QUARTER_OF[reprtCode];
    if (!quarter) { console.warn(`지원하지 않는 reprt_code: ${reprtCode} — 건너뜀`); continue; }
    console.log(`\n[${year} ${reprtCode} (분기 ${quarter})] 수집...`);
    const records = [];
    for (let i = 0; i < companies.length; i += 100) {
      const batch = companies.slice(i, i + 100);
      const rows = await fetchYearFinancials(batch.map(c => c.corp_code), year, reprtCode);
      const grouped = {};
      for (const r of rows) (grouped[r.corp_code] ??= []).push(r);
      for (const [corpCode, list] of Object.entries(grouped)) {
        const c = byCorp.get(corpCode);
        if (!c) continue;
        const op  = pickAccount(list, ["영업이익", "영업이익(손실)"]);
        const rev = pickAccount(list, ["매출액", "영업수익", "수익(매출액)", "매출"]);
        const rceptRaw = list[0]?.rcept_no ? String(list[0].rcept_no).slice(0, 8) : null;
        const rceptDt = rceptRaw && /^\d{8}$/.test(rceptRaw) ? rceptRaw : null;
        const opYoY = op.cur != null && op.prv != null ? quarterlyYoY(op.cur, op.prv) : null;
        records.push({
          stock_code: c.stock_code, corp_name: c.corp_name, mrkt_ctg: c.mrkt_ctg,
          analysis_year: Number(year), report_code: reprtCode, quarter,
          rcept_dt: rceptDt,
          op_income: op.cur, revenue: rev.cur,
          op_income_yoy: opYoY != null ? +opYoY.toFixed(1) : null,
          revenue_yoy: rev.cur != null && rev.prv != null && rev.prv > 0
            ? +((rev.cur - rev.prv) / rev.prv * 100).toFixed(1) : null,
        });
      }
      process.stdout.write(`\r  배치 ${Math.min(i + 100, companies.length)}/${companies.length} (확보 ${records.length})`);
      await sleep(300);
    }
    console.log("");
    for (let i = 0; i < records.length; i += 500) {
      const vals = records.slice(i, i + 500)
        .filter(r => /^[A-Za-z0-9]{5,6}$/.test(r.stock_code))
        .map(r =>
          `(${esc(r.stock_code)},${esc(r.corp_name)},${esc(r.mrkt_ctg)},${r.analysis_year},${esc(r.report_code)},${r.quarter},` +
          `${esc(r.rcept_dt)},${esc(r.op_income)},${esc(r.revenue)},${esc(r.op_income_yoy)},${esc(r.revenue_yoy)},NOW())`
        ).join(",\n");
      if (!vals) continue;
      await dbQuery(`
        INSERT INTO stock_financials
          (stock_code,corp_name,mrkt_ctg,analysis_year,report_code,quarter,rcept_dt,op_income,revenue,op_income_yoy,revenue_yoy,updated_at)
        VALUES ${vals}
        ON CONFLICT (stock_code, analysis_year, report_code) DO UPDATE SET
          rcept_dt = EXCLUDED.rcept_dt, quarter = EXCLUDED.quarter,
          op_income = EXCLUDED.op_income, revenue = EXCLUDED.revenue,
          op_income_yoy = EXCLUDED.op_income_yoy, revenue_yoy = EXCLUDED.revenue_yoy,
          updated_at = NOW()
      `);
    }
    console.log(`  ✅ ${records.length}건 upsert`);
  }
  const stat = await dbQuery(
    `SELECT analysis_year, report_code, COUNT(*) cnt, COUNT(op_income_yoy) yoy_cnt
     FROM stock_financials WHERE report_code != '11011' GROUP BY 1,2 ORDER BY 1,2`
  );
  console.log("\n분기 행 현황:", JSON.stringify(stat));
}
main().catch(e => { console.error(e); process.exit(1); });
