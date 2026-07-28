/**
 * fetch-analyst-hist.mjs — 애널리스트 의견 과거 백필 (2026-07-25).
 *   목적: "애널리스트가 판별자인가" 검증용. combo-v2 백테 거래 종목(330개)의 2023~2026 의견 이력 수집.
 *   실측: KIS FHKST663300C0는 DATE_1/DATE_2 범위 조회 가능하나 **호출당 최대 100건**(초과 시 최신 100건만)
 *         → 6개월 버킷으로 쪼개고, 100건 도달(=capped) 버킷은 3개월로 재분할.
 *   출력: analyst-hist.json  { code: [{date, firm, opinion, prevOpinion, targetPrice, closeAtReport}] }
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const BASE = 'https://openapi.koreainvestment.com:9443';
const tok = JSON.parse(readFileSync('./.kis-token.json', 'utf8')).value;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchRange(code, d1, d2) {
  const u = new URL(BASE + '/uapi/domestic-stock/v1/quotations/invest-opinion');
  for (const [k, v] of Object.entries({ FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '16633', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: d1, FID_INPUT_DATE_2: d2 })) u.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u, { headers: { authorization: `Bearer ${tok}`, appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET, tr_id: 'FHKST663300C0', custtype: 'P' }, signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.rt_cd !== '0') { await sleep(500 * (attempt + 1)); continue; }
      return (j.output ?? []).map(x => ({
        date: x.stck_bsop_date, firm: String(x.mbcr_name ?? '').trim(),
        opinion: String(x.invt_opnn ?? '').trim(), prevOpinion: String(x.rgbf_invt_opnn ?? '').trim(),
        targetPrice: Number(x.hts_goal_prc) || null, closeAtReport: Number(x.stck_prdy_clpr) || null,
      }));
    } catch { await sleep(500 * (attempt + 1)); }
  }
  return null; // 실패
}

// 6개월 버킷 (2023-01 ~ 2026-08)
const buckets = [];
for (let y = 2023; y <= 2026; y++) {
  buckets.push([`${y}0101`, `${y}0630`]);
  buckets.push([`${y}0701`, `${y}1231`]);
}
const splitHalf = ([d1, d2]) => { // 100건 capped 시 3개월로 재분할
  const y = d1.slice(0, 4), h1 = d1.slice(4, 6) === '01';
  return h1 ? [[`${y}0101`, `${y}0331`], [`${y}0401`, `${y}0630`]] : [[`${y}0701`, `${y}0930`], [`${y}1001`, `${y}1231`]];
};

// 유니버스 소스: --universe liquid 이면 Supabase 유동성 종목 전체, 기본은 cv2-dump 거래종목
let codes;
if (process.argv.includes('--universe')) {
  const q = async (sql) => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
      { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
    return r.json();
  };
  codes = (await q('SELECT stock_code FROM stock_analysis WHERE current_price>=2000 AND avg_turnover_20d>=3e9 ORDER BY market_cap_tril DESC')).map(r => r.stock_code);
} else {
  const T = JSON.parse(readFileSync('./cv2-dump.json', 'utf8')).books['combo-v2'].trades;
  codes = [...new Set(T.map(t => t.code))];
}
console.log(`대상 ${codes.length}종목 × ${buckets.length}버킷`);

const out = existsSync('./analyst-hist.json') ? JSON.parse(readFileSync('./analyst-hist.json', 'utf8')) : {};
let done = 0, calls = 0, fails = 0, splits = 0;
const t0 = Date.now();

for (const code of codes) {
  if (out[code]) { done++; continue; } // 재실행 시 이어받기
  const seen = new Map();
  for (const b of buckets) {
    let rows = await fetchRange(code, b[0], b[1]); calls++;
    await sleep(120);
    if (rows == null) { fails++; continue; }
    if (rows.length >= 100) { // capped → 재분할
      splits++;
      rows = [];
      for (const sb of splitHalf(b)) {
        const r2 = await fetchRange(code, sb[0], sb[1]); calls++;
        await sleep(120);
        if (r2) rows.push(...r2);
      }
    }
    for (const r of rows) seen.set(`${r.date}|${r.firm}`, r);
  }
  out[code] = [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));
  done++;
  if (done % 25 === 0) {
    writeFileSync('./analyst-hist.json', JSON.stringify(out));
    const el = (Date.now() - t0) / 1000;
    console.log(`  ${done}/${codes.length} (콜 ${calls}, 분할 ${splits}, 실패 ${fails}) ${el.toFixed(0)}s`);
  }
}
writeFileSync('./analyst-hist.json', JSON.stringify(out));
const total = Object.values(out).reduce((s, v) => s + v.length, 0);
const covered = Object.values(out).filter(v => v.length > 0).length;
console.log(`완료: ${done}종목, 의견 ${total}건, 커버리지 있는 종목 ${covered}/${done} (콜 ${calls}, 실패 ${fails})`);
