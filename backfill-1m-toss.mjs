/**
 * backfill-1m-toss.mjs — 토스 1분봉 과거 백필 (2026-07-27 발견: **84거래일 제공**)
 *
 * 배경: KIS 분봉은 당일만 준다 → 분봉 룰(V2_intra·C_self)은 소급 검증이 불가능하다고 판단했었다.
 *   그런데 토스 `getCandles1m(code, total, before)`는 페이징으로 **60,000봉 = 84거래일(4개월)**을 준다(실측).
 *   → 분봉 룰의 진짜 백테스트가 가능해진다.
 * ⚠️ 토스는 라이브봇과 **토큰이 하나**다. 실행 중 stock-live.service를 반드시 정지해둬야 한다(401 경합 실측).
 *
 * 저장: data-1m/{code}.jsonl 1줄 = {code, t:[epoch초...], o,h,l,c,v}. 종목당 약 2.4MB.
 *   이미 있는 파일은 건너뛴다(재개 가능).
 * 실행: node backfill-1m-toss.mjs [--every 5] [--bars 60000] [--dir data-1m] [--codes a,b,c]
 */
import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadDaily } from './scan-1m-core.mjs';
import { getCandles1m } from './toss-api.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const EVERY = Number(argOf('--every', 5));       // 계통표본 간격 (1=전체)
const BARS = Number(argOf('--bars', 60000));
const DIR = String(argOf('--dir', 'data-1m'));
const ONLY = argOf('--codes', null);
const log = (m) => console.log(`[${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const { daily } = await loadDaily();
// ★ 처리 순서: 1/EVERY 계통표본을 **먼저** 돌리고 나머지를 뒤에 붙인다.
//   토스 토큰이 라이브봇과 하나라서 중간에 끊길 수 있는데(봇 재기동), 어디서 끊겨도
//   **완료분이 그 자체로 무작위 표본**이 되게 하려는 것. 나머지는 다음 정지 창에서 재개(파일 존재 시 스킵).
const all = ONLY ? ONLY.split(',') : [...daily.keys()];
let codes = ONLY ? all : [...all.filter((_, i) => i % EVERY === 0), ...all.filter((_, i) => i % EVERY !== 0)];
const done0 = new Set(readdirSync(DIR).filter(f => f.endsWith('.jsonl')).map(f => f.replace('.jsonl', '')));
const todo = codes.filter(c => !done0.has(c));
log(`대상 ${codes.length}종목 (유동성 ${daily.size} 중 1/${EVERY} 계통표본) · 기완료 ${codes.length - todo.length} · 남은 ${todo.length}`);
log(`종목당 ${BARS}봉(약 84거래일) 요청 — 예상 소요 ${(todo.length * 90 / 3600).toFixed(1)}시간`);

let ok = 0, fail = 0, barsTotal = 0;
const t0 = Date.now();
for (const code of todo) {
  try {
    const r = await getCandles1m(code, BARS, null);
    if (!r?.length) { fail++; log(`  ${code}: 0봉 — 스킵`); continue; }
    // 오래된순으로 정렬 후 컬럼 배열로 압축 저장
    const s = r.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const rec = {
      code,
      t: s.map(x => Math.floor(new Date(x.timestamp).getTime() / 1000)),
      o: s.map(x => x.open), h: s.map(x => x.high), l: s.map(x => x.low), c: s.map(x => x.close), v: s.map(x => x.volume),
    };
    writeFileSync(join(DIR, `${code}.jsonl`), JSON.stringify(rec) + '\n');
    ok++; barsTotal += s.length;
    const el = (Date.now() - t0) / 1000;
    const eta = todo.length > ok ? (el / ok) * (todo.length - ok) / 60 : 0;
    if (ok % 5 === 0 || ok === 1) log(`  ${ok}/${todo.length} ${code} ${s.length}봉 · 누적 ${(barsTotal / 1e6).toFixed(1)}M봉 · 남은 예상 ${eta.toFixed(0)}분`);
  } catch (e) {
    fail++;
    const msg = String(e.message).slice(0, 70);
    log(`  ${code} 실패: ${msg}`);
    if (/401|invalid-token/.test(msg)) { log('⚠️ 토큰 경합(401) — stock-live가 켜져 있는지 확인 필요. 30초 후 재시도.'); await new Promise(r => setTimeout(r, 30_000)); }
  }
}
log(`완료: 성공 ${ok} · 실패 ${fail} · 총 ${(barsTotal / 1e6).toFixed(1)}M봉 · ${((Date.now() - t0) / 60000).toFixed(0)}분 소요`);
log(`※ stock-live.service 재기동 잊지 말 것`);
