import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
const KEY = process.env.DART_API_KEY, CORP = "01236532";
const num = s => Number(String(s ?? "0").replace(/[^0-9.-]/g, "")) || 0;
const won = n => (n/1e8).toFixed(1) + "억";

async function fin(year, fs_div) {
  const u = new URL("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json");
  u.searchParams.set("crtfc_key", KEY); u.searchParams.set("corp_code", CORP);
  u.searchParams.set("bsns_year", String(year)); u.searchParams.set("reprt_code", "11011");
  u.searchParams.set("fs_div", fs_div);
  const d = await (await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0" } })).json();
  if (d.status !== "000") return null;
  const pick = (...nms) => {
    for (const nm of nms) {
      const r = (d.list??[]).find(x => ["IS","CIS"].includes(x.sj_div) && x.account_nm?.replace(/\s/g,"")===nm.replace(/\s/g,""));
      if (r) return num(r.thstrm_amount);
    }
    return null;
  };
  return {
    매출: pick("매출액","영업수익","수익(매출액)","I.매출액"),
    영업이익: pick("영업이익","영업이익(손실)"),
    순이익: pick("당기순이익","당기순이익(손실)","분기순이익","당기순이익(손실)"),
  };
}
for (const fs_div of ["OFS","CFS"]) {
  console.log(`\n== ${fs_div} (${fs_div==="OFS"?"별도":"연결"}) ==`);
  for (const y of [2023,2024,2025]) {
    const f = await fin(y, fs_div);
    if (!f) { console.log(`  ${y}: (없음)`); continue; }
    console.log(`  ${y}: 매출 ${f.매출!=null?won(f.매출):"-"}, 영업이익 ${f.영업이익!=null?won(f.영업이익):"-"}, 순이익 ${f.순이익!=null?won(f.순이익):"-"}`);
    await new Promise(r=>setTimeout(r,250));
  }
}
