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

const disc = await dbQuery(`SELECT stock_code, rcept_dt, report_nm FROM stock_disclosures ORDER BY rcept_dt`);

const byType = new Map();
for (const row of disc) {
  const c = classifyDisclosure(row.report_nm);
  if (!c.catalytic || c.polarity !== 'positive') continue;
  const p = priceMap.get(row.stock_code);
  if (!p) continue;
  const eventDate = row.rcept_dt.replace(/-/g, '');
  let lo = 0, hi = p.d.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (p.d[mid] > eventDate) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  const i0 = ans;
  if (i0 < 20 || i0 >= p.d.length) continue;
  const preRet20 = (p.c[i0 - 1] / p.c[i0 - 21] - 1) * 100; // 공시일-20일 ~ 공시일 직전 수익률(사전 급등 여부)
  const dayOfRet = (p.o[i0] / p.c[i0 - 1] - 1) * 100; // 공시 인지 후 다음날 시가 갭
  if (!byType.has(c.type)) byType.set(c.type, []);
  byType.get(c.type).push({ preRet20, dayOfRet });
}

const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
console.log('유형 | N | 공시전 20일수익률(평균) | 공시 익일 시가갭(평균)');
for (const [type, rows] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${type ?? '(미상)'}: n=${rows.length}, 사전20일 ${avg(rows.map(r=>r.preRet20)) >= 0 ? '+' : ''}${avg(rows.map(r=>r.preRet20)).toFixed(2)}%, 익일갭 ${avg(rows.map(r=>r.dayOfRet)) >= 0 ? '+' : ''}${avg(rows.map(r=>r.dayOfRet)).toFixed(2)}%`);
}
