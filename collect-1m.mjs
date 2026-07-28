#!/usr/bin/env node
// 유동성 KOSPI(거래대금30억↑) 1분봉 ~56일 수집 → candles-1m.jsonl (증분·재개가능).
// rateSlot(105ms) 존중 = 라이브 봇 토스 API와 계정 공유하므로 과호출 금지. 장마감 후 실행 권장(실매매 무간섭).
// 실행: node collect-1m.mjs  (백그라운드). 재실행 시 이미 수집된 종목 스킵.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { existsSync, readFileSync, appendFileSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { getCandles1m } from './toss-api.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const OUT = join(__dirname, 'candles-1m.jsonl');
const BARS = 40000; // ~56거래일
const argv = process.argv.slice(2);
const MAX = Number((() => { const i = argv.indexOf('--max'); return i >= 0 ? argv[i + 1] : 0; })()); // 이번 실행 최대 수집 종목수(0=무제한). 포그라운드 청크용.
const now = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 19);
const log = (m) => console.log(`[${now()}] ${m}`);

const dbRest = async (path) => { const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } }); return r.json(); };

async function collectedCodes() {
  const set = new Set();
  if (!existsSync(OUT)) return set;
  const rl = createInterface({ input: createReadStream(OUT), crlfDelay: Infinity });
  for await (const line of rl) { if (!line.trim()) continue; try { set.add(JSON.parse(line).code); } catch { /* */ } }
  return set;
}

(async () => {
  const rows = await dbRest(`stock_analysis?mrkt_ctg=eq.KOSPI&avg_turnover_20d=gte.3000000000&select=stock_code,corp_name,market_cap_tril&order=market_cap_tril.desc`);
  let codes = rows.map(r => r.stock_code);
  if (!codes.includes('005930')) codes = ['005930', ...codes]; // 레짐 프록시 보장
  const done = await collectedCodes();
  const todo = codes.filter(c => !done.has(c));
  log(`유동성 KOSPI ${codes.length}종목 | 이미수집 ${done.size} | 남음 ${todo.length}`);
  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    try {
      const raw = await getCandles1m(c, BARS);
      const bars = raw.map(b => ({ t: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
      appendFileSync(OUT, JSON.stringify({ code: c, n: bars.length, bars }) + '\n');
      ok++;
      if ((i + 1) % 5 === 0 || i === todo.length - 1) log(`진행 ${i + 1}/${todo.length} (성공 ${ok}, 실패 ${fail}) 최근 ${c} ${bars.length}봉`);
      if (MAX > 0 && ok >= MAX) { log(`--max ${MAX} 도달, 청크 종료`); break; }
    } catch (e) { fail++; log(`실패 ${c}: ${String(e.message).slice(0, 60)}`); }
  }
  log(`=== 완료: 성공 ${ok}, 실패 ${fail}, 파일 ${OUT} ===`);
})();
