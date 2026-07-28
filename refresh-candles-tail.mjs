/**
 * refresh-candles-tail.mjs — candles-daily.jsonl 캐시가 stale(마지막 갱신 이후 미반영일)일 때
 *   각 종목의 "꼬리"(최근 누락분)만 토스에서 추가로 받아 병합·재작성 (2026-07-24, PEAD 재검증 준비).
 *   ⚠ 라이브봇(stock-live.service) 정지 상태에서만 실행 — 안 그러면 rateSlot 경합(429).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, createReadStream } from 'fs';
import readline from 'readline';
import { getDailyCandles } from './toss-api.js';

const CACHE_FILE = './candles-daily.jsonl';
const TAIL_DAYS = 45; // 6주 갭 + 여유

console.log('캐시 로드 중...');
const store = new Map();
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: createReadStream(CACHE_FILE) });
  rl.on('line', (line) => { if (!line.trim()) return; const o = JSON.parse(line); store.set(o.code, o); });
  rl.on('close', resolve);
});
console.log(`${store.size}종목 로드 완료`);

const kstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
const codes = [...store.keys()];
let updated = 0, skippedCurrent = 0, failed = 0;
const t0 = Date.now();

for (let idx = 0; idx < codes.length; idx++) {
  const code = codes[idx];
  const rec = store.get(code);
  const lastDate = rec.d[rec.d.length - 1];
  if (lastDate >= kstToday) { skippedCurrent++; continue; } // 이미 최신
  try {
    const bars = await getDailyCandles(code, TAIL_DAYS); // 최신순
    const existing = new Set(rec.d);
    const newBars = bars.filter(b => {
      const d = String(b.timestamp).slice(0, 10).replace(/-/g, '');
      return d > lastDate;
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (newBars.length) {
      for (const b of newBars) {
        const d = String(b.timestamp).slice(0, 10).replace(/-/g, '');
        if (existing.has(d)) continue;
        rec.d.push(d); rec.o.push(b.open); rec.h.push(b.high); rec.l.push(b.low); rec.c.push(b.close); rec.v.push(b.volume);
        existing.add(d);
      }
      updated++;
    }
  } catch (e) {
    failed++;
    if (failed <= 5) console.log(`  ${code} 실패: ${String(e.message).slice(0, 80)}`);
  }
  if ((idx + 1) % 200 === 0) {
    const elapsed = (Date.now() - t0) / 1000;
    console.log(`진행 ${idx + 1}/${codes.length} (갱신 ${updated}, 이미최신 ${skippedCurrent}, 실패 ${failed}) — ${elapsed.toFixed(0)}s 경과`);
  }
}

console.log(`\n완료 — 갱신 ${updated}종목, 이미최신 ${skippedCurrent}종목, 실패 ${failed}종목, 총 ${((Date.now()-t0)/1000).toFixed(0)}초`);

console.log('파일 재작성 중...');
const lines = codes.map(code => JSON.stringify(store.get(code)));
writeFileSync(CACHE_FILE, lines.join('\n') + '\n');
console.log('완료:', CACHE_FILE);
