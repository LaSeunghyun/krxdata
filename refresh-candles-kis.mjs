/**
 * refresh-candles-kis.mjs — candles-daily.jsonl 꼬리 갱신 (2026-07-27)
 * refresh-candles-tail.mjs(토스판)과 달리 **KIS**를 쓴다 → 라이브봇 Toss 세션과 경합 0,
 * 그래서 봇을 세우지 않고 VM에서 매일 돌릴 수 있다. KIS는 1콜에 ~30거래일이라 꼬리 병합엔 충분.
 *
 * 실행: node refresh-candles-kis.mjs [--pace 70] [--max 0]
 * 주의: FID_ORG_ADJ_PRC=1(수정주가) — 액면분할·유상증자 소급수정은 이 방식으로 전체 재작성되지 않는다.
 *       분기 1회 정도는 refresh-candles-tail.mjs(봇 정지 후)나 전체 재수집으로 정합성 확인 권장.
 */
import 'dotenv/config';
import { createReadStream, writeFileSync, renameSync } from 'fs';
import readline from 'readline';
import { getDailyPrices } from './kis-api.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const PACE = Number(argOf('--pace', 70));
const MAXN = Number(argOf('--max', 0));
const FILE = './candles-daily.jsonl';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);

const store = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream(FILE) });
  rl.on('line', (l) => { if (!l.trim()) return; try { const o = JSON.parse(l); store.set(o.code, o); } catch {} });
  rl.on('close', res);
});
let maxDate = '';
for (const o of store.values()) if (o.d.at(-1) > maxDate) maxDate = o.d.at(-1);
// ★ 당일 장중 부분봉 차단(2026-07-27 실측 결함): KIS는 장중에도 당일 미완성 봉을 준다.
//   그게 캐시에 들어가면 MA·고가·거래량이 오염되고, 기준일 자동판정까지 틀어진다. 15:40 KST 이후만 채택.
const kst = new Date(Date.now() + 9 * 3600_000);
const today = kst.toISOString().slice(0, 10).replace(/-/g, '');
const allowToday = kst.getUTCHours() * 60 + kst.getUTCMinutes() >= 940;
log(`캐시 ${store.size}종목 · 최신 거래일 ${maxDate} · 당일(${today})봉 ${allowToday ? '채택' : '제외(장중)'}`);

let codes = [...store.keys()];
if (MAXN > 0) codes = codes.slice(0, MAXN);
let added = 0, touched = 0, fail = 0, done = 0;
for (const code of codes) {
  const o = store.get(code);
  try {
    const bars = (await getDailyPrices(code)).slice().reverse(); // 최신순 → 과거순
    let n = 0;
    for (const b of bars) {
      if (!b.date || b.date <= o.d.at(-1)) continue;             // 이미 있는 날짜는 건너뜀(append-only)
      if (!allowToday && b.date >= today) continue;              // 장중 당일 부분봉 제외
      o.d.push(b.date); o.o.push(b.open); o.h.push(b.high); o.l.push(b.low); o.c.push(b.close); o.v.push(b.volume);
      n++;
    }
    if (n) { added += n; touched++; }
  } catch { fail++; }
  await sleep(PACE);
  if (++done % 200 === 0) log(`  ${done}/${codes.length} (갱신 ${touched}종목 ${added}행, 실패 ${fail})`);
}

const tmp = FILE + '.tmp';
writeFileSync(tmp, [...store.values()].map(o => JSON.stringify(o)).join('\n') + '\n');
renameSync(tmp, FILE);                                            // 원자적 교체(중간 크래시 시 원본 보존)
let newMax = '';
for (const o of store.values()) if (o.d.at(-1) > newMax) newMax = o.d.at(-1);
log(`완료: ${touched}종목 ${added}행 추가 · 실패 ${fail} · 최신 거래일 ${maxDate} → ${newMax}`);
