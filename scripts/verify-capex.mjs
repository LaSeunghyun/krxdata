/**
 * verify-capex.mjs — CF/capex 수집 end-to-end 기계 검증
 * 실제 OpenDART(fnlttSinglAcntAll)를 호출해 알려진 종목의 cfOps/cfInv/capex/fcf가
 * 정상 파싱되는지 assert. 실패 시 exit 1.
 * 실행: node scripts/verify-capex.mjs
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchCashflowCapex, computeFcf, capexCycle } from "../scoring-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });
const DART_KEY = process.env.DART_API_KEY;
if (!DART_KEY) { console.error("DART_API_KEY 미설정"); process.exit(1); }

const corpMap = JSON.parse(fs.readFileSync(path.join(ROOT, ".corp_code_cache.json"), "utf8"));
const cc = code => corpMap[code]?.corp_code;

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// 대형주·중형주 혼합. capex 규모가 크고 흑자라 cfOps/capex가 반드시 잡혀야 하는 종목들.
const TARGETS = [
  { code: "083450", name: "GST" },
  { code: "005930", name: "삼성전자" },
  { code: "000660", name: "SK하이닉스" },
  { code: "009830", name: "한화솔루션" },
];

const fmt = n => n == null ? "null" : (n / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 }) + "억";
let fail = 0;

for (const t of TARGETS) {
  const corp = cc(t.code);
  if (!corp) { console.log(`SKIP ${t.name}(${t.code}) — corp_code 없음`); continue; }
  const cf = await fetchCashflowCapex(corp, { dartKey: DART_KEY, year: "2025", fallbackYear: "2024", fetchJson });
  const fin = { cfOps: cf.cfOps, capex: cf.capex, capexPrev: cf.capexPrev };
  fin.fcf = computeFcf(fin);
  const cyc = capexCycle(fin);
  const ok = cf.source === "ok" && cf.cfOps != null && cf.capex != null;
  if (!ok) fail++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${t.name.padEnd(8)} yr=${cf.year} 영업CF=${fmt(cf.cfOps)} 투자CF=${fmt(cf.cfInv)} ` +
    `capex=${fmt(cf.capex)} FCF=${fmt(fin.fcf)} capexYoY=${cyc.capexYoY ?? "-"}% capex/OCF=${cyc.capexToOcf ?? "-"} 증설=${cyc.cycle}`
  );
  await new Promise(r => setTimeout(r, 200));
}

console.log(fail ? `\n❌ ${fail}건 실패` : `\n✅ 전체 통과`);
process.exit(fail ? 1 : 0);
