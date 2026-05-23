/**
 * patch-marketcap.js
 * scored-stocks.json에서 시총=0 기업을 Naver API로 보완 후 재점수화
 */
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { ANALYSIS_YEAR, ANALYSIS_YEAR_FALLBACK, PATCH_MARKETCAP_DELAY_MS } from "./config.js";

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY  = process.env.DART_API_KEY;
const DART_BASE = "https://opendart.fss.or.kr/api";
const YEAR      = ANALYSIS_YEAR;
const YEAR_FB   = ANALYSIS_YEAR_FALLBACK;
const DELAY_MS  = PATCH_MARKETCAP_DELAY_MS;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com" },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Naver polling API — 주가/EPS/BPS/발행주식수 ─────────────
async function getNaverQuote(stockCode) {
  const url = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${stockCode}`;
  const d = await fetchJson(url);
  const item = d?.result?.areas?.[0]?.datas?.[0];
  if (!item) return null;
  return {
    price:          Number(item.nv  ?? 0),     // 현재가
    eps:            Number(item.eps ?? 0),     // EPS (네이버 기준)
    bps:            Number(item.bps ?? 0),     // BPS
    shares:         Number(item.countOfListedStock ?? 0), // 발행주식수
    marketCap:      Number(item.nv ?? 0) * Number(item.countOfListedStock ?? 0),
  };
}

// ── DART 재무 (순이익 재조회) ─────────────────────────────────
async function getDartNetIncome(corpCode) {
  for (const [year, fsdiv] of [[YEAR,"CFS"],[YEAR,"OFS"],[YEAR_FB,"CFS"],[YEAR_FB,"OFS"]]) {
    const url = new URL(`${DART_BASE}/fnlttMultiAcnt.json`);
    url.searchParams.set("crtfc_key", DART_KEY);
    url.searchParams.set("corp_code", corpCode);
    url.searchParams.set("bsns_year", year);
    url.searchParams.set("reprt_code", "11011");
    url.searchParams.set("fs_div", fsdiv);
    const d = await fetchJson(url.toString());
    if (d.status !== "000" || !d.list?.length) continue;

    const rows = d.list;
    const NI_NAMES = ["당기순이익", "당기순이익(손실)"];
    // 포괄손익계산서(IS)의 당기순이익 사용
    const row = rows.find(r => NI_NAMES.includes(r.account_nm?.trim()) && r.sj_div === "IS");
    if (row) {
      const v = Number(String(row.thstrm_amount ?? "0").replace(/,/g, ""));
      if (v !== 0) return v;
    }
  }
  return null;
}

// ── 밸류에이션 재채점 (score-top100.js와 동일 로직) ────────────
function reScoreValuation(marketCap, netIncome, totalEquity) {
  if (!marketCap || marketCap <= 0) return { score: 5, note: "시총없음" };
  let score = 0;
  const notes = [];

  // PER (18pt)
  if (netIncome && netIncome > 0) {
    const per = marketCap / netIncome;
    let perScore = 0;
    if (per < 5)       { perScore = 12; notes.push(`PER${per.toFixed(1)}(극저평가)`); }
    else if (per < 10) { perScore = 18; notes.push(`PER${per.toFixed(1)}(저평가)`); }
    else if (per < 15) { perScore = 15; notes.push(`PER${per.toFixed(1)}(적정)`); }
    else if (per < 20) { perScore = 10; notes.push(`PER${per.toFixed(1)}(다소고)`); }
    else if (per < 30) { perScore = 5;  notes.push(`PER${per.toFixed(1)}(고평가)`); }
    else               { perScore = 2;  notes.push(`PER${per.toFixed(1)}(과매수)`); }
    score += perScore;
  } else {
    notes.push("순손실(PER불가)");
  }

  // PBR (6pt)
  if (totalEquity > 0) {
    const pbr = marketCap / totalEquity;
    if (pbr < 0.5)    { score += 6; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 1) { score += 5; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 2) { score += 3; notes.push(`PBR${pbr.toFixed(2)}`); }
    else if (pbr < 4) { score += 1; notes.push(`PBR${pbr.toFixed(2)}`); }
    else              { notes.push(`PBR${pbr.toFixed(2)}(고)`); }
  }

  score += 3; // 업종 대비 기본점수
  return { score: Math.min(30, score), note: notes.join(", ") };
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  const filePath = path.join(__dirname, "scored-stocks.json");
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const results = data.results;

  // 시총 0인 기업 찾기
  const missing = results.filter(r => r.marketCapTril === 0);
  console.log(`\n시총 미수집 기업: ${missing.length}개 → Naver API로 보완\n`);

  // profitable-stocks.json에서 corp_code 매핑
  const profitable = JSON.parse(fs.readFileSync(path.join(__dirname, "profitable-stocks.json"), "utf8"));
  const corpMap = Object.fromEntries(profitable.profitable.map(s => [s.stockCode, s.corp_code]));

  let patched = 0;
  for (const r of missing) {
    process.stdout.write(`  ${r.stockCode} ${r.corp_name} ... `);

    try {
      // 1. Naver 주가/시총
      const quote = await getNaverQuote(r.stockCode);
      if (!quote || quote.marketCap === 0) {
        console.log("주가 없음, 스킵");
        continue;
      }

      // 2. DART 순이익
      const corpCode = corpMap[r.stockCode];
      let netIncome = null;
      if (corpCode) {
        netIncome = await getDartNetIncome(corpCode);
        await sleep(100);
      }

      // totalEquity 파싱 (기존 note에서 PBR 계산용 — 없으면 BPS×shares로 추정)
      const totalEquity = quote.bps > 0 ? quote.bps * quote.shares : 0;

      // 3. 밸류에이션 재채점
      const newVal = reScoreValuation(quote.marketCap, netIncome, totalEquity);
      const oldValScore = r.detail["중장기_밸류에이션"].score;
      const diff = newVal.score - oldValScore;

      // 4. 점수 갱신
      r.currentPrice    = quote.price;
      r.marketCapTril   = +(quote.marketCap / 1e12).toFixed(2);
      r.detail["중장기_밸류에이션"].score = newVal.score;
      r.detail["중장기_밸류에이션"].note  = newVal.note;
      r.longScore       += diff;
      r.totalScore      += diff;

      console.log(`시총 ${r.marketCapTril}조, ${newVal.note} (점수 ${oldValScore}→${newVal.score}, 총점 ${r.totalScore})`);
      patched++;
    } catch (e) {
      console.log(`오류: ${e.message}`);
    }

    await sleep(DELAY_MS);
  }

  // 재랭킹
  results.sort((a, b) => b.totalScore - a.totalScore);
  results.forEach((r, i) => r.rank = i + 1);

  // 저장
  data.patchedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  // TOP 10 출력
  console.log(`\n보완 완료: ${patched}개\n`);
  console.log("═".repeat(90));
  console.log("  최종 TOP 10 (시총 보완 후 재랭킹)");
  console.log("═".repeat(90));
  console.log(`${"순위".padEnd(4)} ${"코드".padEnd(8)} ${"기업명".padEnd(18)} ${"총점".padEnd(6)} ${"단기".padEnd(6)} ${"중장기".padEnd(6)} ${"시총(조)".padEnd(8)} 밸류에이션`);
  console.log("─".repeat(90));
  for (const r of results.slice(0, 10)) {
    console.log([
      String(r.rank).padEnd(4),
      r.stockCode.padEnd(8),
      r.corp_name.slice(0, 16).padEnd(18),
      String(r.totalScore).padEnd(6),
      String(r.shortScore).padEnd(6),
      String(r.longScore).padEnd(6),
      String(r.marketCapTril).padEnd(8),
      r.detail["중장기_밸류에이션"].note.slice(0, 35),
    ].join(" "));
  }
}

main().catch(e => { console.error("오류:", e); process.exit(1); });
