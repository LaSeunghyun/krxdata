import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
const KEY = process.env.DART_API_KEY, CORP = "01236532";
async function call(ep, year) {
  const u = new URL(`https://opendart.fss.or.kr/api/${ep}.json`);
  u.searchParams.set("crtfc_key", KEY); u.searchParams.set("corp_code", CORP);
  u.searchParams.set("bsns_year", String(year)); u.searchParams.set("reprt_code", "11011");
  const d = await (await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0" } })).json();
  return { status: d.status, message: d.message, list: d.list ?? [] };
}
for (const year of [2025, 2024]) {
  console.log(`\n===== ${year} =====`);
  for (const ep of ["hmvAuditIndivdlBySttus", "indvdlByPay"]) {
    const r = await call(ep, year);
    console.log(`[${ep}] status=${r.status} (${r.message}) rows=${r.list.length}`);
    for (const x of r.list) {
      console.log("   ", JSON.stringify({ 성명: x.nm, 직위: x.ofcps, 보수총액: x.mendng_totamt, 비고: x.mendng_totamt_ct_incls_mendng }));
    }
    await new Promise(r=>setTimeout(r,250));
  }
}
