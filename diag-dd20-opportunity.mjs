/**
 * diag-dd20-opportunity.mjs — `--rsimaxdd20 40` 이 왜 한 번도 발동하지 않는지 실측 (2026-07-31)
 *
 * ═══ 문제 ═══
 * 2026-07-25 에 "떨어지는 칼날 배제" 목적으로 추가된 20일 낙폭 필터가
 * `--rsimaxdd20 40` 에서 백테 결과를 **한 비트도 바꾸지 않는다**(체결·CAGR·MDD·최종자본 완전 동일).
 * 30 에서 처음 발동한다. 그런데 2026-07-30 라이브가 산 삼성전기의 진입시점 20일낙폭은 **-52.9%** 였다.
 * 즉 현실에는 -50%대가 존재하는데 백테에는 없다 → 표본 문제인지 배선 문제인지 갈라야 한다.
 *
 * ═══ 방법 ═══
 * 백테와 같은 데이터(candles-daily-toss-clean.jsonl)에서 **rsi2 신호가 성립한 종목-일**을 전수 세고,
 * 그 중 20일 낙폭이 임계를 넘는 건수를 연도별로 집계한다. 필터가 잡을 **기회 자체가 있었나**를 본다.
 *   rsi2 신호 = RSI2(2일) < 10        (백테 cfg.rsiMax = 10)
 *   20일 낙폭 = c[i]/c[i-20] - 1      (백테 RSI_MAXDD20 산식과 동일)
 * 유동성 필터(20일 평균 거래대금 >= 30억)를 적용한 것과 안 한 것을 나란히 낸다 —
 * 유니버스(시총 top-420) 필터가 원인인지 분리하기 위해서다.
 *
 * 판정:
 *   · 임계 초과 종목-일이 **0건** → 표본에 없다. 필터는 무해하지만 검정 불가(현재 라벨과 일치)
 *   · 0건이 아닌데 백테가 안 변함 → 그 종목-일이 후보 선정에서 이미 탈락했거나 배선 결함
 *
 * 실행: node --max-old-space-size=6144 diag-dd20-opportunity.mjs
 */
import { createReadStream } from 'fs';
import readline from 'readline';

const FILE = 'candles-daily-toss-clean.jsonl';
const FROM = '20230102';
const MIN_TURNOVER = 30 * 1e8;   // 백테 MIN_TURNOVER 와 동일
const THRESHOLDS = [15, 20, 30, 40, 50];

const rsi2 = (c, i) => {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
};

const stat = {};   // year → { sig, sigLiq, byThr:{t:{all,liq}} }
const worst = [];  // 최악 낙폭 사례
let nCode = 0;

const rl = readline.createInterface({ input: createReadStream(FILE), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (!j?.d || !j?.c) continue;
  nCode++;
  const { d, c, v } = j;
  for (let i = 21; i < d.length; i++) {
    const day = String(d[i]);
    if (day < FROM) continue;
    if (!(c[i] > 0) || !(c[i - 20] > 0)) continue;
    if (rsi2(c, i) >= 10) continue;                       // rsi2 신호 아님
    // 유동성: 직전 20일 평균 거래대금
    let to = 0; for (let k = i - 19; k <= i; k++) to += c[k] * (v?.[k] ?? 0);
    const liq = to / 20 >= MIN_TURNOVER;
    const y = day.slice(0, 4);
    const s = (stat[y] ??= { sig: 0, sigLiq: 0, byThr: Object.fromEntries(THRESHOLDS.map(t => [t, { all: 0, liq: 0 }])) });
    s.sig++; if (liq) s.sigLiq++;
    const dd = (c[i] / c[i - 20] - 1) * 100;
    for (const t of THRESHOLDS) if (dd < -t) { s.byThr[t].all++; if (liq) s.byThr[t].liq++; }
    if (dd < -40) worst.push({ code: j.code, day, dd, liq });
  }
}

console.log(`데이터 ${nCode}종목 · ${FILE} · ${FROM}~\n`);
console.log('=== rsi2 신호(RSI2<10) 종목-일 중 20일낙폭 임계 초과 건수 ===');
console.log('연도    rsi2신호   (유동성통과)  |  -15%      -20%      -30%      -40%      -50%   ※괄호=유동성통과');
for (const y of Object.keys(stat).sort()) {
  const s = stat[y];
  const cells = THRESHOLDS.map(t => `${s.byThr[t].all}(${s.byThr[t].liq})`.padStart(10)).join('');
  console.log(`${y}  ${String(s.sig).padStart(8)}  ${String(s.sigLiq).padStart(10)}   |${cells}`);
}
const tot = THRESHOLDS.map(t => Object.values(stat).reduce((a, s) => a + s.byThr[t].all, 0));
const totLiq = THRESHOLDS.map(t => Object.values(stat).reduce((a, s) => a + s.byThr[t].liq, 0));
const sigT = Object.values(stat).reduce((a, s) => a + s.sig, 0);
const sigL = Object.values(stat).reduce((a, s) => a + s.sigLiq, 0);
console.log('─'.repeat(96));
console.log(`합계  ${String(sigT).padStart(8)}  ${String(sigL).padStart(10)}   |${tot.map((n, k) => `${n}(${totLiq[k]})`.padStart(10)).join('')}`);

console.log('\n=== 판정 ===');
const i40 = THRESHOLDS.indexOf(40);
if (totLiq[i40] === 0) {
  console.log(`-40% 초과 & 유동성통과 = **0건**. 표본에 기회가 없다 → 필터는 무해하나 검정 불가.`);
  console.log(`  = strategy-contract 의 "포트폴리오 근거 0건" 라벨이 정확하다. 배선 결함이 아니다.`);
} else {
  console.log(`-40% 초과 & 유동성통과 = ${totLiq[i40]}건 존재한다.`);
  console.log(`  그런데 백테 결과가 안 변했다 → 그 종목-일이 **후보 선정(시총 top-420·슬롯 경쟁)에서 이미 탈락**했거나 배선 결함이다.`);
  console.log(`  다음 단계: 해당 종목-일이 실제 진입 후보 상위에 올랐는지 --scendump 로 확인.`);
}
if (worst.length) {
  console.log(`\n=== -40% 초과 사례 상위 12건 (낙폭순) ===`);
  for (const w of worst.sort((a, b) => a.dd - b.dd).slice(0, 12)) {
    console.log(`  ${w.day} ${w.code} 20일낙폭 ${w.dd.toFixed(1)}%  유동성 ${w.liq ? '통과' : '미달'}`);
  }
}
console.log(`\n※ 라이브는 스캔 시점의 **당일 진행 종가**로 dd20 을 계산한다(백테는 확정 종가). 경계에서 판정이 갈릴 수 있다.`);
