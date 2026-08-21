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

// 연내 정기보고서 순서와 법정 제출기한(MMDD).
// 사업보고서(11011)는 dart-financials-backfill.js 담당이라 여기서 제외.
const SEQ = ["11013", "11012", "11014"];
const DEADLINE_MMDD = { "11013": 515, "11012": 814, "11014": 1114 };

/**
 * 실행일 기준 "제출기한이 지난" 최근 기간부터 역순으로 count개를 만든다.
 * 기존에는 기본값이 하드코딩돼 분기마다 손으로 고쳐야 했고, 실제로
 * 2026 반기(11012)가 누락된 채 방치됐다. 날짜에서 유도해 재발을 막는다.
 */
export function recentPeriods(count = 6, now = new Date()) {
  let year = now.getFullYear();
  const mmdd = (now.getMonth() + 1) * 100 + now.getDate();
  let idx = -1;
  for (let i = SEQ.length - 1; i >= 0; i--) {
    if (mmdd >= DEADLINE_MMDD[SEQ[i]]) { idx = i; break; }
  }
  if (idx === -1) { year -= 1; idx = SEQ.length - 1; } // 5/15 이전 → 전년 3분기부터
  const out = [];
  while (out.length < count) {
    out.push({ year: String(year), reprtCode: SEQ[idx] });
    if (--idx < 0) { idx = SEQ.length - 1; year -= 1; }
  }
  return out;
}

const args = process.argv.slice(2);
const periodsArg = args.find(a => a.startsWith("--periods"))?.split("=")[1] ?? args[args.indexOf("--periods") + 1];
const PERIODS = periodsArg
  ? periodsArg.split(",").map(p => { const [y, rc] = p.trim().split(":"); return { year: y, reprtCode: rc }; })
  : recentPeriods();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const numAmt = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) && n !== 0 ? n : null; };
const esc = v => v == null ? "NULL" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "NULL") : `'${String(v).replace(/'/g, "''")}'`;

function pickAccount(rows, names) {
  for (const nm of names) {
    const row = rows.find(r => r.sj_div !== "CF" && r.account_nm?.replace(/\s/g, "") === nm.replace(/\s/g, ""));
    if (row) {
      // 누적(_add_amount)은 양쪽 모두 있을 때만 사용 — 한쪽만 누적이면
      // 누적 vs 3개월 비교가 돼 YoY가 수배 왜곡되므로 둘 다 plain으로 강제.
      const useAdd = row.thstrm_add_amount != null && row.frmtrm_add_amount != null;
      const cur = numAmt(useAdd ? row.thstrm_add_amount : row.thstrm_amount);
      const prv = numAmt(useAdd ? row.frmtrm_add_amount : row.frmtrm_amount);
      return { cur, prv };
    }
  }
  return { cur: null, prv: null };
}

async function main() {
  const companies = await loadCompanies();
  const byCorp = new Map(companies.map(c => [c.corp_code, c]));
  const lowCoverage = [];
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
    // 커버리지 경고 — DART 재무 API는 제출 마감 직후 며칠간 색인이 덜 돼
    // 조용히 일부만 적재된다. 무음 실패로 넘어가지 않도록 비율을 명시한다.
    const coverage = companies.length ? records.length / companies.length : 0;
    const pct = (coverage * 100).toFixed(1);
    if (coverage < 0.8) {
      console.warn(`  ⚠️ ${records.length}건 upsert (커버리지 ${pct}% — 80% 미만)`);
      console.warn(`     DART 색인 지연 가능. 며칠 뒤 동일 명령 재실행 필요 (upsert라 재실행 안전)`);
      lowCoverage.push(`${year}:${reprtCode}(${pct}%)`);
    } else {
      console.log(`  ✅ ${records.length}건 upsert (커버리지 ${pct}%)`);
    }
  }
  if (lowCoverage.length) {
    console.warn(`\n⚠️ 재실행 필요 기간: ${lowCoverage.join(", ")}`);
  }
  const stat = await dbQuery(
    `SELECT analysis_year, report_code, COUNT(*) cnt, COUNT(op_income_yoy) yoy_cnt
     FROM stock_financials WHERE report_code != '11011' GROUP BY 1,2 ORDER BY 1,2`
  );
  console.log("\n분기 행 현황:", JSON.stringify(stat));
}
// 진입점 가드 — recentPeriods를 import하는 것만으로 백필이 통째로 돌던 문제 방지.
const isEntrypoint = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(e => { console.error(e); process.exit(1); });
}
