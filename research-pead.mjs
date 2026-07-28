/**
 * research-pead.mjs — 긍정 촉매 공시 이후 드리프트(PEAD류) 존재 검증 (2026-07-24, 내가 제안).
 *   가설: ai-events.mjs가 분류한 '긍정+촉매' 공시 발생 후, 다음날 시가 진입 시 N일 뒤 초과수익이 있는가?
 *   공시 데이터가 2026-04-23~ 3개월치뿐이라 표본기간 짧음 — 방향성 확인 1차 스크리닝.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import readline from 'readline';
import { createReadStream } from 'fs';
import { classifyDisclosure } from './ai-events.mjs';

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  return r.json();
};

// candles-daily.jsonl 로드 (code -> {d,o,c} 오름차순 배열, 날짜탐색은 이진탐색)
console.log('일봉 캐시 로드 중...');
const priceMap = new Map();
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: createReadStream('./candles-daily.jsonl') });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const o = JSON.parse(line);
    priceMap.set(o.code, { d: o.d, o: o.o, c: o.c });
  });
  rl.on('close', resolve);
});
console.log(`캐시 ${priceMap.size}종목 로드 완료`);

// 공시 전체 로드 (2026-04-23~)
console.log('공시 로드 중...');
const disc = await dbQuery(`SELECT stock_code, rcept_dt, report_nm FROM stock_disclosures ORDER BY rcept_dt`);
console.log(`공시 ${disc.length}건`);

const HORIZONS = [1, 3, 5, 10, 20];
const events = []; // { code, entryIdx, fwdRet: {1:.., 3:.., ...} }

for (const row of disc) {
  const c = classifyDisclosure(row.report_nm);
  if (!c.catalytic || c.polarity !== 'positive') continue;
  const p = priceMap.get(row.stock_code);
  if (!p) continue;
  const eventDate = row.rcept_dt.replace(/-/g, '');
  // 공시일 이후 첫 거래일의 시가로 진입(당일 이미 반영됐을 수 있는 종가 lookahead 회피). d는 오름차순 정렬 → 이진탐색.
  let i0;
  { let lo = 0, hi = p.d.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (p.d[mid] > eventDate) { ans = mid; hi = mid - 1; } else lo = mid + 1; } i0 = ans; }
  if (i0 < 0 || i0 >= p.d.length) continue;
  const entryPx = p.o[i0];
  if (!entryPx || entryPx <= 0) continue;
  const fwdRet = {};
  let ok = true;
  for (const h of HORIZONS) {
    const j = i0 + h - 1; // i0가 t+1(진입일)이므로 t+1+h-1
    if (j >= p.d.length) { ok = false; break; }
    fwdRet[h] = (p.c[j] / entryPx - 1) * 100;
  }
  if (ok) events.push({ code: row.stock_code, entryDate: p.d[i0], type: c.type, fwdRet });
}

console.log(`\n촉매+긍정 이벤트(진입 가능, 전체호라이즌 확보) ${events.length}건\n`);

// 베이스라인: 이벤트에 등장한 종목들의 "아무 날짜에서나" 같은 호라이즌 수익률 분포(무작위 표본)
const eventCodes = [...new Set(events.map(e => e.code))];
const baseline = { 1: [], 3: [], 5: [], 10: [], 20: [] };
const SAMPLE_PER_STOCK = 30;
for (const code of eventCodes) {
  const p = priceMap.get(code);
  if (!p || p.d.length < 40) continue;
  for (let s = 0; s < SAMPLE_PER_STOCK; s++) {
    const i0 = Math.floor(Math.random() * (p.d.length - 21));
    const entryPx = p.o[i0] || p.c[i0];
    if (!entryPx) continue;
    for (const h of HORIZONS) {
      const j = i0 + h - 1;
      if (j < p.d.length) baseline[h].push((p.c[j] / entryPx - 1) * 100);
    }
  }
}

const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log('호라이즌 | 이벤트N | 이벤트평균% | 이벤트중앙% | 베이스라인평균% | 초과수익%p | 승률(이벤트)');
for (const h of HORIZONS) {
  const evRets = events.map(e => e.fwdRet[h]);
  const evAvg = avg(evRets), evMed = median(evRets);
  const baseAvg = avg(baseline[h]);
  const winRate = evRets.filter(r => r > 0).length / evRets.length;
  console.log(`  +${h}일 | ${String(evRets.length).padStart(5)} | ${evAvg >= 0 ? '+' : ''}${evAvg.toFixed(2).padStart(6)} | ${evMed >= 0 ? '+' : ''}${evMed.toFixed(2).padStart(6)} | ${baseAvg >= 0 ? '+' : ''}${baseAvg.toFixed(2).padStart(6)} | ${(evAvg - baseAvg) >= 0 ? '+' : ''}${(evAvg - baseAvg).toFixed(2).padStart(6)} | ${(winRate*100).toFixed(1)}%`);
}

// 유형별 분해 — 무상증자 등 권리락 미조정 가격 함정 여부 확인
console.log('\n--- 유형별 분해 (+20일 기준) ---');
const byType = new Map();
for (const e of events) { if (!byType.has(e.type)) byType.set(e.type, []); byType.get(e.type).push(e.fwdRet[20]); }
const typeRows = [...byType.entries()].map(([type, rets]) => ({ type, n: rets.length, avg: avg(rets), med: median(rets) })).sort((a, b) => b.n - a.n);
for (const r of typeRows) console.log(`  ${r.type ?? '(미상)'}: n=${r.n}, 평균 ${r.avg >= 0 ? '+' : ''}${r.avg.toFixed(2)}%, 중앙 ${r.med >= 0 ? '+' : ''}${r.med.toFixed(2)}%`);
