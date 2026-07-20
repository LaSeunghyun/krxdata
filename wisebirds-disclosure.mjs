/**
 * wisebirds-disclosure.mjs — 와이즈버즈(273060 / corp_code 01236532) 정기보고서 분석
 * OpenDART 정기보고서 주요정보 API 직접 호출 (.env DART_API_KEY)
 */
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const KEY = process.env.DART_API_KEY;
const CORP = "01236532";       // 와이즈버즈
const BASE = "https://opendart.fss.or.kr/api";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(endpoint, year, reprt = "11011") {
  const url = new URL(`${BASE}/${endpoint}.json`);
  url.searchParams.set("crtfc_key", KEY);
  url.searchParams.set("corp_code", CORP);
  url.searchParams.set("bsns_year", String(year));
  url.searchParams.set("reprt_code", reprt);
  const res = await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
  const d = await res.json();
  return { status: d.status, message: d.message, list: d.list ?? [] };
}

async function main() {
  if (!KEY) throw new Error("DART_API_KEY 미설정");
  const out = {};

  for (const year of [2025, 2024, 2023]) {
    out[year] = {};

    // 1) 직원 현황 (사업부문별 1인평균급여액)
    const emp = await call("empSttus", year);
    out[year].empStatus = { status: emp.status, rows: emp.list.map(r => ({
      부문: r.fo_bbm, 성별: r.sexdstn,
      정규직: r.rgllbr_co, 계약직: r.cnrct_co, 합계: r.sm,
      평균근속: r.avrg_cnwk_sdytrn,
      연간급여총액: r.fyer_salary_totamt, "1인평균급여액": r.jan_salary_am, 비고: r.rm,
    })) };
    await sleep(250);

    // 2) 임원 현황 (인원/구성)
    const exec = await call("exctvSttus", year);
    out[year].execStatus = { status: exec.status, count: exec.list.length,
      sample: exec.list.slice(0, 5).map(r => ({ 성명: r.nm, 직위: r.ofcps, 등기여부: r.rgist_exctv_at, 상근여부: r.fte_at })) };
    await sleep(250);

    // 3) 이사·감사 전체의 보수현황 (총액/1인평균) — 후보 엔드포인트 모두 시도
    for (const ep of ["hmvAuditAllSttus", "drctrAdtAllMendngSttusGmtsckConfmAmount", "drctrAdtAllMendngSttusMendngPymntamtTyCl"]) {
      const r = await call(ep, year);
      if (r.status === "000" && r.list.length) {
        out[year][ep] = r.list;
      } else {
        out[year][ep] = { status: r.status, msg: r.message };
      }
      await sleep(250);
    }

    // 4) 재무 (매출/영업이익/순이익) — 단일회사 전체 재무제표
    const fin = await call("fnlttSinglAcntAll", year).catch(() => null);
    // fnlttSinglAcntAll requires fs_div; retry with param
    const url = new URL(`${BASE}/fnlttSinglAcntAll.json`);
    url.searchParams.set("crtfc_key", KEY);
    url.searchParams.set("corp_code", CORP);
    url.searchParams.set("bsns_year", String(year));
    url.searchParams.set("reprt_code", "11011");
    url.searchParams.set("fs_div", "CFS");
    let fd = await (await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } })).json();
    if (fd.status !== "000") {
      url.searchParams.set("fs_div", "OFS");
      fd = await (await fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } })).json();
    }
    const pick = nm => {
      const row = (fd.list ?? []).find(x => x.sj_div !== "CF" && x.account_nm?.replace(/\s/g, "") === nm.replace(/\s/g, ""));
      return row ? { 당기: row.thstrm_amount, 전기: row.frmtrm_amount } : null;
    };
    out[year].financials = { fs_div: url.searchParams.get("fs_div"), status: fd.status,
      매출액: pick("매출액") || pick("영업수익") || pick("수익(매출액)"),
      영업이익: pick("영업이익") || pick("영업이익(손실)"),
      당기순이익: pick("당기순이익") || pick("당기순이익(손실)"),
      자산총계: pick("자산총계"), 자본총계: pick("자본총계"), 부채총계: pick("부채총계"),
    };
    await sleep(250);
  }

  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
