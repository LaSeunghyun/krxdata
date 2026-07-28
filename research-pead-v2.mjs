/**
 * research-pead-v2.mjs — PEAD 1차 스크리닝의 방법론 결함(베이스라인이 전체기간 랜덤추출 = 기간매칭 안 됨) 수정판.
 *   각 이벤트의 entryDate와 동일 날짜 기준, 같은 유니버스의 "날짜매칭 시장평균"과 비교(시장 전체 하락기 여부 통제).
 */
import 'dotenv/config';
import readline from 'readline';
import { createReadStream } from 'fs';
import { classifyDisclosure } from './ai-events.mjs';

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  return r.json();
};

const priceMap = new Map();
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: createReadStream('./candles-daily.jsonl') });
  rl.on('line', (line) => { if (!line.trim()) return; const o = JSON.parse(line); priceMap.set(o.code, { d: o.d, o: o.o, c: o.c }); });
  rl.on('close', resolve);
});
const allCodes = [...priceMap.keys()];

const disc = await dbQuery(`SELECT stock_code, rcept_dt, report_nm FROM stock_disclosures ORDER BY rcept_dt`);

const HORIZONS = [1, 3, 5, 10, 20];
const events = [];
for (const row of disc) {
  const c = classifyDisclosure(row.report_nm);
  if (!c.catalytic || c.polarity !== 'positive') continue;
  const p = priceMap.get(row.stock_code);
  if (!p) continue;
  const eventDate = row.rcept_dt.replace(/-/g, '');
  let lo = 0, hi = p.d.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (p.d[mid] > eventDate) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  const i0 = ans;
  if (i0 < 0) continue;
  const entryPx = p.o[i0];
  if (!entryPx) continue;
  const fwdRet = {};
  let ok = true;
  for (const h of HORIZONS) { const j = i0 + h - 1; if (j >= p.d.length) { ok = false; break; } fwdRet[h] = (p.c[j] / entryPx - 1) * 100; }
  if (ok) events.push({ code: row.stock_code, type: c.type, entryDateStr: p.d[i0], entryIdx: i0, fwdRet });
}
console.log(`이벤트 ${events.length}건`);

// 날짜매칭 시장평균: 이벤트에 등장하는 고유 entryDate마다, 그 날짜 기준 전체유니버스(샘플 400종목) 동일호라이즌 평균수익률
const uniqDates = [...new Set(events.map(e => e.entryDateStr))];
console.log(`고유 진입일 ${uniqDates.length}개 — 날짜매칭 시장평균 계산 중...`);
const SAMPLE_UNIVERSE = allCodes.slice(0, 600); // 속도용 샘플(전체 2605종목 다 돌면 느림)
const marketAvgByDate = new Map(); // date -> {1:avg,3:avg,...}
for (const dateStr of uniqDates) {
  const sums = { 1: [], 3: [], 5: [], 10: [], 20: [] };
  for (const code of SAMPLE_UNIVERSE) {
    const p = priceMap.get(code);
    if (!p) continue;
    const idx = p.d.indexOf(dateStr);
    if (idx < 0) continue;
    const entryPx = p.o[idx];
    if (!entryPx) continue;
    for (const h of HORIZONS) {
      const j = idx + h - 1;
      if (j < p.d.length) sums[h].push((p.c[j] / entryPx - 1) * 100);
    }
  }
  const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  marketAvgByDate.set(dateStr, Object.fromEntries(HORIZONS.map(h => [h, avg(sums[h])])));
}

const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
console.log('\n호라이즌 | 이벤트N | 이벤트평균% | 날짜매칭시장평균% | 초과수익(알파)%p | 승률(이벤트 vs 시장당일)');
for (const h of HORIZONS) {
  const pairs = events.map(e => ({ ev: e.fwdRet[h], mkt: marketAvgByDate.get(e.entryDateStr)?.[h] })).filter(x => x.mkt != null);
  const evAvg = avg(pairs.map(x => x.ev));
  const mktAvg = avg(pairs.map(x => x.mkt));
  const alpha = avg(pairs.map(x => x.ev - x.mkt));
  const beatMarket = pairs.filter(x => x.ev > x.mkt).length / pairs.length;
  console.log(`  +${h}일 | ${String(pairs.length).padStart(5)} | ${evAvg>=0?'+':''}${evAvg.toFixed(2).padStart(6)} | ${mktAvg>=0?'+':''}${mktAvg.toFixed(2).padStart(6)} | ${alpha>=0?'+':''}${alpha.toFixed(2).padStart(6)} | ${(beatMarket*100).toFixed(1)}%`);
}

console.log('\n--- 유형별 알파(+20일) ---');
const byType = new Map();
for (const e of events) {
  const mkt = marketAvgByDate.get(e.entryDateStr)?.[20];
  if (mkt == null) continue;
  if (!byType.has(e.type)) byType.set(e.type, []);
  byType.get(e.type).push(e.fwdRet[20] - mkt);
}
for (const [type, alphas] of [...byType.entries()].sort((a,b)=>b[1].length-a[1].length)) {
  console.log(`  ${type ?? '(미상)'}: n=${alphas.length}, 알파평균 ${avg(alphas)>=0?'+':''}${avg(alphas).toFixed(2)}%p`);
}
