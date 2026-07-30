/**
 * build-clean-candles.mjs — 종가소스 비교용 정제 캔들 2쌍 생성 (2026-07-30)
 *
 * ═══ 왜 필요한가 ═══
 * KRX 재수집분 vs Toss 캐시 대조에서 1,125종목을 3분류했다(diag-adj-structure 재판정):
 *   · 1,105종목(98.2%) 비율≈1 — NXT 세션 차이만. 정상.
 *   · 2종목 상수배율(025560 5.001× · 051360 1.643×) — 창밖 권리변동. 수익률엔 영향 없으나
 *     MIN_PRICE·거래대금 필터에 영향 → 제외가 안전.
 *   · **18종목 진짜 계단** — Toss 시계열 내부에 가짜 가격점프(최대 30배). 전환일이
 *     20260615에 7종목 몰려 있어 권리변동이 아니라 캐시 갱신 이벤트로 보인다.
 *     rsi2 유니버스(top30) 포함 0/18 · hi120 유니버스 포함 18/18 → **hi120만 오염.**
 *
 * ═══ 무엇을 만드나 ═══
 * 같은 20종목을 **양쪽에서** 빼고 같은 코드집합으로 맞춘 파일 2개.
 *   candles-daily-toss-clean.jsonl  (기준선)
 *   candles-daily-krx-clean.jsonl   (KRX 정규장 종가)
 * 코드집합을 동일하게 맞추는 이유: mcapUniverse가 로드된 풀 안에서 top-420을 고르므로
 * 풀이 다르면 유니버스가 달라지고 그러면 종가소스 효과와 유니버스 효과가 섞인다.
 *
 * ※ 부수효과: Toss 정제본은 **기존 백테의 가짜점프 오염도 제거된** 기준선이다.
 *   원본 대비 차이가 나면 그 자체가 기존 검증결과의 오염 규모를 알려준다.
 *
 * 실행: node --max-old-space-size=6144 build-clean-candles.mjs
 */
import { createReadStream, createWriteStream, readFileSync, existsSync } from 'fs';
import readline from 'readline';

// diag-adj-structure.mjs 재판정 결과 (비율 최대/최소 비 > 1.5)
const STEPPED = ['196490', '074610', '006740', '484870', '377460', '356860', '476830', '000500',
  '000300', '119650', '298000', '327260', '182400', '245620', '082270', '199800', '087010', '287840'];
const CONST_F = ['025560', '051360'];
const DROP = new Set([...STEPPED, ...CONST_F]);

const uni = JSON.parse(readFileSync('krx-universe-union.json', 'utf8')).union;
const KEEP = new Set(uni.filter(c => !DROP.has(c)));
console.log(`유니버스 ${uni.length} − 제외 ${DROP.size} = 유지 ${KEEP.size}종목`);

async function filterFile(src, dst) {
  if (!existsSync(src)) { console.error(`${src} 없음`); process.exit(1); }
  const ws = createWriteStream(dst);
  const seen = new Set();
  let kept = 0, skipped = 0;
  const rl = readline.createInterface({ input: createReadStream(src), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l.trim()) continue;
    // 코드만 싸게 뽑아 필터 — 전체 파싱은 유지 대상만
    const m = l.match(/"code"\s*:\s*"(\d{6})"/);
    if (!m || !KEEP.has(m[1])) { skipped++; continue; }
    if (seen.has(m[1])) { skipped++; continue; }        // 중복라인 방지(원본에 있으면 첫 줄만)
    seen.add(m[1]);
    ws.write(l + '\n');
    kept++;
  }
  await new Promise(r => ws.end(r));
  console.log(`${src} → ${dst}: 유지 ${kept} · 스킵 ${skipped}`);
  return seen;
}

const tossCodes = await filterFile('candles-daily.jsonl', 'candles-daily-toss-clean.jsonl');
const krxCodes = await filterFile('candles-daily-krx.jsonl', 'candles-daily-krx-clean.jsonl');

// 코드집합 일치 확인 — 다르면 비교가 성립하지 않는다
const onlyToss = [...tossCodes].filter(c => !krxCodes.has(c));
const onlyKrx = [...krxCodes].filter(c => !tossCodes.has(c));
console.log(`\n=== 코드집합 일치 검증 ===`);
console.log(`Toss ${tossCodes.size} · KRX ${krxCodes.size}`);
console.log(`Toss에만 ${onlyToss.length}${onlyToss.length ? ' → ' + onlyToss.slice(0, 10).join(' ') : ''}`);
console.log(`KRX에만 ${onlyKrx.length}${onlyKrx.length ? ' → ' + onlyKrx.slice(0, 10).join(' ') : ''}`);
if (onlyToss.length || onlyKrx.length) {
  console.log(`★ 코드집합이 다르다 — 비교 전에 해결해야 한다.`);
} else {
  console.log(`통과 — 두 파일의 코드집합이 동일하다. 종가소스만 다른 통제된 비교가 가능하다.`);
}
