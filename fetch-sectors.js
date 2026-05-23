/**
 * fetch-sectors.js
 * DART company.json API → induty_code → 섹터명 매핑
 * 결과: .sector_cache.json { stockCode: sectorName }
 * 실행: node fetch-sectors.js
 */
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const DART_KEY   = process.env.DART_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CACHE_FILE = path.join(__dirname, ".sector_cache.json");

if (!DART_KEY) { console.error("DART_API_KEY 미설정"); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── KSIC 업종코드 → 섹터명 매핑 ───────────────────────────
function indutyToSector(induty_code) {
  if (!induty_code) return "기타";
  const code = String(induty_code).trim();
  const n = parseInt(code.slice(0, 2), 10);
  if (isNaN(n)) return "기타";

  if (n >= 1  && n <= 3)  return "농림어업";
  if (n >= 5  && n <= 8)  return "광업";

  // 제조업 세분류
  if (n >= 10 && n <= 12) return "식품·음료";
  if (n >= 13 && n <= 15) return "섬유·의류";
  if (n === 16 || n === 17 || n === 18) return "목재·종이";
  if (n === 19)           return "석유화학";
  if (n === 20)           return "화학·소재";
  if (n === 21)           return "바이오·의약";
  if (n === 22)           return "고무·플라스틱";
  if (n === 23)           return "비금속광물";
  if (n === 24)           return "철강·금속";
  if (n === 25)           return "금속가공";
  if (n === 26)           return "반도체·전자부품";
  if (n === 27)           return "전기장비";
  if (n === 28)           return "기계·장비";
  if (n === 29)           return "자동차·부품";
  if (n === 30)           return "조선·운송장비";
  if (n >= 31 && n <= 33) return "가구·기타제조";
  if (n === 34)           return "산업용기계수리";

  if (n === 35)           return "에너지·유틸리티";
  if (n >= 36 && n <= 39) return "환경·폐기물";
  if (n >= 41 && n <= 43) return "건설·부동산";
  if (n >= 45 && n <= 47) return "도소매·유통";
  if (n >= 49 && n <= 53) return "운수·물류";
  if (n >= 55 && n <= 56) return "숙박·음식";

  // 정보통신 세분류
  if (n >= 58 && n <= 60) return "미디어·엔터";
  if (n === 61)           return "통신";
  if (n >= 62 && n <= 63) return "IT서비스·소프트웨어";

  if (n >= 64 && n <= 66) return "금융·보험";
  if (n === 68)           return "부동산";
  if (n === 72)           return "R&D·연구개발";
  if (n >= 70 && n <= 75) return "전문서비스";
  if (n >= 76 && n <= 82) return "사업지원서비스";
  if (n === 84)           return "공공행정";
  if (n === 85)           return "교육서비스";
  if (n >= 86 && n <= 88) return "보건·의료";
  if (n >= 90 && n <= 96) return "예술·오락·레저";
  return "기타서비스";
}

// ── DART company.json 조회 ────────────────────────────────
async function getCompanyInfo(corp_code) {
  const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${DART_KEY}&corp_code=${corp_code}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "000") return null;
    return data;
  } catch { return null; }
}

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  // 기존 캐시 로드
  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    console.log(`기존 캐시: ${Object.keys(cache).length}개`);
  }

  // 전체 종목 로드
  const kospiAll  = JSON.parse(fs.readFileSync(path.join(__dirname, "kospi-all.json"))).all;
  const kosdaqAll = JSON.parse(fs.readFileSync(path.join(__dirname, "kosdaq-all.json"))).all;
  const allCompanies = [
    ...kospiAll.map(r => ({ ...r, mrkt_ctg: "KOSPI" })),
    ...kosdaqAll.map(r => ({ ...r, mrkt_ctg: "KOSDAQ" })),
  ];

  // 캐시 미스만 처리
  const todo = allCompanies.filter(r => !cache[r.stockCode]);
  console.log(`총 ${allCompanies.length}개 중 미조회 ${todo.length}개`);

  let done = 0, failed = 0;
  for (const company of todo) {
    const info = await getCompanyInfo(company.corp_code);
    if (info) {
      cache[company.stockCode] = {
        sector: indutyToSector(info.induty_code),
        induty_code: info.induty_code || "",
        corp_cls: info.corp_cls || "",   // Y=KOSPI K=KOSDAQ
      };
    } else {
      cache[company.stockCode] = { sector: "기타", induty_code: "", corp_cls: "" };
      failed++;
    }
    done++;
    if (done % 100 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      process.stdout.write(`\r  진행: ${done}/${todo.length} (실패: ${failed})`);
    }
    await sleep(150); // ~6req/s
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`\n완료: ${done}개 조회, 실패: ${failed}개`);

  // 섹터 분포 출력
  const dist = {};
  Object.values(cache).forEach(v => { dist[v.sector] = (dist[v.sector]||0)+1; });
  console.log("\n[섹터 분포]");
  Object.entries(dist).sort((a,b)=>b[1]-a[1]).forEach(([s,c]) => console.log(`  ${s}: ${c}개`));

  // Supabase stock_analysis에 sector upsert
  if (SUPABASE_URL && SUPABASE_KEY) {
    console.log("\nSupabase sector 업데이트 중...");
    const rows = allCompanies
      .filter(r => cache[r.stockCode])
      .map(r => ({
        stock_code: r.stockCode,
        sector: cache[r.stockCode].sector,
        mrkt_ctg: r.mrkt_ctg,
      }));

    const BATCH = 500;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_analysis`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`  upsert 실패 ${res.status}:`, body.slice(0, 200));
      } else {
        upserted += chunk.length;
        process.stdout.write(`\r  sector upsert: ${upserted}/${rows.length}`);
      }
    }
    console.log("\n✅ sector 업데이트 완료");
  }
}

main().catch(e => { console.error("오류:", e); process.exit(1); });
