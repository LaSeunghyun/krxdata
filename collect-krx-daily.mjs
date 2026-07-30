/**
 * collect-krx-daily.mjs — KRX 정규장 확정 일봉 전체 히스토리 수집 (2026-07-30)
 *
 * 목적: candles-daily.jsonl(Toss = KRX+NXT 통합)의 **KRX 정규장 전용 대응물**을 만들어
 *       백테를 같은 조건에서 종가 소스만 바꿔 재검증한다. (정합화 방안 '가')
 *
 * 출력: candles-daily-krx.jsonl — candles-daily.jsonl과 **동일 스키마**
 *       {code, d:[YYYYMMDD...], o:[], h:[], l:[], c:[], v:[]}  (날짜 오름차순)
 *
 * 재개: 이미 기록된 code는 스킵한다(append-only). 중단돼도 다시 실행하면 이어서 받는다.
 * 병렬: KIS 실전계좌 초당 제한을 고려해 동시 3, 내부 페이징 간 260ms 페이싱.
 *       레이트리밋 응답은 kis-daily-history.mjs가 4회까지 재시도한다(결손 방지).
 *
 * 수정주가: FID_ORG_ADJ_PRC='0'(수정주가반영). Toss가 수정주가로 보이므로 장기 비교엔 이 설정이 맞다.
 *          원주가('1')와의 차이는 collect 후 diag로 별도 검증한다.
 *
 * 실행: node collect-krx-daily.mjs [--to 20260729] [--conc 3]
 */
import { existsSync, readFileSync, appendFileSync, createReadStream } from 'fs';
import readline from 'readline';
import { getDailyHistory } from './kis-daily-history.mjs';

const argOf = (k, d) => { const i = process.argv.lastIndexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FROM = argOf('--from', '20230102');
const TO = argOf('--to', '20260729');
const CONC = Number(argOf('--conc', '3'));
const OUT = 'candles-daily-krx.jsonl';
const UNI = 'krx-universe-union.json';

if (!existsSync(UNI)) { console.error(`${UNI} 없음 — 먼저 node krx-universe-union.mjs 실행`); process.exit(1); }
const codes = JSON.parse(readFileSync(UNI, 'utf8')).union;

// ── 재개: 이미 받은 code 수집 ─────────────────────────────────────────────────
const done = new Set();
if (existsSync(OUT)) {
  await new Promise((res) => {
    const rl = readline.createInterface({ input: createReadStream(OUT) });
    rl.on('line', (l) => { const m = l.match(/"code"\s*:\s*"(\d{6})"/); if (m) done.add(m[1]); });
    rl.on('close', res);
  });
}
const todo = codes.filter(c => !done.has(c));
console.log(`유니버스 ${codes.length}종목 · 기수집 ${done.size} · 남음 ${todo.length} · 동시 ${CONC}`);
console.log(`기간 ${FROM} ~ ${TO} · 출력 ${OUT}`);
if (!todo.length) { console.log('전부 수집됨 — 종료'); process.exit(0); }

// ── 수집 ──────────────────────────────────────────────────────────────────────
let ok = 0, fail = 0, ndone = 0;
const failed = [];
const t0 = Date.now();

async function worker(slice) {
  for (const code of slice) {
    try {
      // paceMs 0 — 페이싱은 kis-daily-history.mjs의 전역 레이트 게이트가 담당한다(워커 수 무관).
      const rows = await getDailyHistory(code, FROM, TO, { adj: '0', paceMs: 0 });
      if (!rows.length) { fail++; failed.push([code, '0행']); console.log(`  ! ${code} 0행`); }
      else {
        // 동일 스키마로 append. 한 줄 = 한 종목.
        appendFileSync(OUT, JSON.stringify({
          code,
          d: rows.map(r => r.date),
          o: rows.map(r => r.open), h: rows.map(r => r.high),
          l: rows.map(r => r.low), c: rows.map(r => r.close), v: rows.map(r => r.volume),
        }) + '\n');
        ok++;
      }
    } catch (e) {
      fail++; const m = String(e.message).slice(0, 60); failed.push([code, m]);
      console.log(`  ! ${code} ${m}`);          // 즉시 로깅 — 끝에만 찍으면 진행 중 원인 파악이 불가능하다
    }
    ndone++;
    if (ndone % 50 === 0) {
      const el = (Date.now() - t0) / 1000;
      const eta = (todo.length - ndone) * (el / ndone);
      console.log(`  ${ndone}/${todo.length} · 성공 ${ok} 실패 ${fail} · 경과 ${Math.round(el / 60)}분 · 남은시간 약 ${Math.round(eta / 60)}분`);
    }
  }
}

const slices = Array.from({ length: CONC }, (_, i) => todo.filter((_, j) => j % CONC === i));
await Promise.all(slices.map(worker));

console.log(`\n완료 — 성공 ${ok} · 실패 ${fail} · 소요 ${Math.round((Date.now() - t0) / 60000)}분`);
if (failed.length) {
  console.log(`실패 ${failed.length}건 (상위 20):`);
  for (const [c, m] of failed.slice(0, 20)) console.log(`  ${c}  ${m}`);
  console.log(`※ 재실행하면 실패분만 다시 시도한다(성공분은 스킵).`);
}
