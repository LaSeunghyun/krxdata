#!/usr/bin/env node
/**
 * collect-1m-etf.mjs — ETF 1분봉 수집 → candles-1m-etf.jsonl (2026-08-04)
 *
 * 왜: 개별주식 인트라데이 스캘핑은 **증권거래세 0.15% 때문에** 어떤 비용조합으로도 음수로 판정됐다
 *   (measured 최선 엣지 0.1662% vs 비용 하한 0.15%+). ETF 는 **증권거래세가 없고 호가단위가 5원 고정**이라
 *   왕복 마찰이 0.05~0.08% 로 떨어진다 = 엣지 아래. 유일하게 산수가 맞는 경로라 실제로 재본다.
 *
 * ⚠️ 낙관 금지: 지수 ETF 는 개별주보다 변동성이 낮아 VWAP 이격 신호의 **발생빈도·진폭이 함께 줄 수** 있다.
 *   비용이 내려간 만큼 엣지도 내려가면 상쇄된다. 그래서 레버리지 ETF(변동성 2배)를 함께 넣는다.
 *
 * rateSlot 은 toss-api 가 관리한다(라이브 봇과 계정 공유 → 장마감 후 실행).
 * 실행: node collect-1m-etf.mjs
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, appendFileSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { getCandles1m } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const OUT = join(__dirname, 'candles-1m-etf.jsonl');
const BARS = 40000;

/** 유동성 상위 ETF. 레버리지·인버스2X 를 반드시 포함(변동성이 신호 진폭을 좌우한다). */
const ETFS = [
  ['122630', 'KODEX 레버리지'],
  ['252670', 'KODEX 200선물인버스2X'],
  ['233740', 'KODEX 코스닥150레버리지'],
  ['251340', 'KODEX 코스닥150선물인버스'],
  ['069500', 'KODEX 200'],
  ['102110', 'TIGER 200'],
  ['114800', 'KODEX 인버스'],
  ['229200', 'KODEX 코스닥150'],
  ['133690', 'TIGER 미국나스닥100'],
  ['360750', 'TIGER 미국S&P500'],
  ['379800', 'KODEX 미국S&P500TR'],
  ['305720', 'KODEX 2차전지산업'],
  ['278530', 'KODEX 200TR'],
  ['069660', 'KOSEF 200'],
  ['261220', 'KODEX WTI원유선물'],
];

const now = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 19);
const log = (m) => console.log(`[${now()}] ${m}`);

async function collected() {
  const set = new Set();
  if (!existsSync(OUT)) return set;
  const rl = createInterface({ input: createReadStream(OUT), crlfDelay: Infinity });
  for await (const line of rl) { if (!line.trim()) continue; try { set.add(JSON.parse(line).code); } catch { /* */ } }
  return set;
}

const done = await collected();
const todo = ETFS.filter(([c]) => !done.has(c));
log(`ETF ${ETFS.length}종목 | 이미수집 ${done.size} | 남음 ${todo.length}`);

let ok = 0, fail = 0;
for (let i = 0; i < todo.length; i++) {
  const [code, name] = todo[i];
  try {
    const raw = await getCandles1m(code, BARS);
    if (!raw?.length) { log(`  빈 응답 ${code} ${name} — 스킵`); fail++; continue; }
    const bars = raw.map(b => ({ t: b.timestamp, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
    appendFileSync(OUT, JSON.stringify({ code, name, n: bars.length, bars }) + '\n');
    ok++;
    const days = new Set(bars.map(b => b.t.slice(0, 10))).size;
    log(`${i + 1}/${todo.length} ${code} ${name} — ${bars.length}봉 · ${days}일 · ${bars[bars.length - 1].t.slice(0, 10)}~${bars[0].t.slice(0, 10)}`);
  } catch (e) {
    fail++;
    log(`${i + 1}/${todo.length} ${code} ${name} 실패: ${String(e.message).slice(0, 120)}`);
  }
}
log(`완료 — 성공 ${ok} · 실패 ${fail} → ${OUT}`);
