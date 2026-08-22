#!/usr/bin/env node
/**
 * diag-holding-period.mjs — "사서 얼마나 보유할 때 가장 높은 수익인가" (2026-08-04)
 *
 * ── 왜 이 질문이 지금 나왔나 ──────────────────────────────────────────────────
 * 분봉 스캘핑 측정(§7)에서 **엣지가 보유시간에 비례해 자란다**는 게 나왔다
 * (vwap2.0c 5분 +0.0014%p → 380분 +0.1662%p). 그럼 어디까지 자라고 어디서 꺾이는가가 다음 질문이다.
 * 분봉은 세션(380분)에서 끝나므로 **일봉으로 이어서** 1~60거래일 구간을 잰다.
 *
 * ── 반드시 연율화해야 하는 이유 (이 측정의 핵심 함정) ─────────────────────────
 * 보유기간이 다르면 **총수익 비교는 무의미하다.** 5일 보유 +1% 와 60일 보유 +5% 는
 * 연 회전수가 50회 vs 4회라 5일 쪽이 압도적이다(+63% vs +22%).
 * 그리고 **왕복비용은 회전마다 든다** — 짧을수록 비용을 자주 낸다. 두 힘이 반대로 작용하므로
 * 최적점은 내부 어딘가에 있고, 그게 이 스크립트가 찾는 값이다.
 *
 * ── 방법 ──────────────────────────────────────────────────────────────────────
 *   데이터: candles-daily-toss-clean.jsonl (1,105종목 · 2021-09~2026-07 = 4.8년, 다국면)
 *   진입:   신호 발생일 **다음날 시가** (look-ahead 차단)
 *   청산:   진입 + N거래일 종가
 *   비용:   왕복 1회 (--cost, 기본 0.42% = 분봉 연구에서 실측한 현실 마찰)
 *   지표:   평균 순수익 · 승률 · **기하 연율화 수익** · 연율화 변동성 · 샤프
 *           (메모리 누적 합산 방식 — 배열 저장 안 함)
 *
 * 실행: node diag-holding-period.mjs [--cost 0.42] [--limit N]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'candles-daily-toss-clean.jsonl');
const ARGV = process.argv.slice(2);
const argOf = (f, d) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };

const COST = Number(argOf('--cost', 0.42));       // 왕복 %
const LIMIT = Number(argOf('--limit', 0));
const MIN_PRICE = 1000;
const HOLDS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 60];
const TRADING_DAYS = 252;

/** RSI(2) — 라이브 rsi2 신호와 동일 산식 */
function rsi2(c, i) {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}

const SIGNALS = {
  // 무조건부 — 아무 날이나 사서 N일 보유 (드리프트 기준선). 나머지는 이걸 넘어야 의미가 있다.
  'any':    () => true,
  // 라이브 검증 신호 2종
  'rsi2':   (c, h, l, i) => rsi2(c, i) < 10,
  'hi120':  (c, h, l, i) => {
    if (i < 121) return false;
    let hh = 0;
    for (let j = i - 120; j < i; j++) hh = Math.max(hh, h[j]);
    return hh > 0 && c[i] / hh - 1 >= 0.03;
  },
  // 20일 낙폭 깊은 것 (분봉의 VWAP 이격에 대응하는 일봉판 평균회귀)
  'dd20':   (c, h, l, i) => i >= 20 && c[i] / c[i - 20] - 1 <= -0.15,
};
const NAMES = Object.keys(SIGNALS);

// acc[sig][hold] = {n, sum, sumsq, wins}
const acc = {};
for (const s of NAMES) { acc[s] = {}; for (const H of HOLDS) acc[s][H] = { n: 0, sum: 0, sumsq: 0, wins: 0, byYear: {} }; }

let nStock = 0, nUsed = 0;
const rl = createInterface({ input: createReadStream(FILE) });
for await (const line of rl) {
  if (!line.trim()) continue;
  if (LIMIT && nStock >= LIMIT) break;
  let j; try { j = JSON.parse(line); } catch { continue; }
  nStock++;
  const { d, o, h, l, c } = j;
  if (!c || c.length < 200) continue;
  nUsed++;
  const maxH = Math.max(...HOLDS);
  for (let i = 121; i < c.length - maxH - 1; i++) {
    if (!(c[i] >= MIN_PRICE)) continue;
    const ePx = o[i + 1];                        // 다음날 시가 진입
    if (!(ePx > 0)) continue;
    let fired = null;
    for (const s of NAMES) {
      let ok = false;
      try { ok = SIGNALS[s](c, h, l, i); } catch { ok = false; }
      if (!ok) continue;
      (fired ??= []).push(s);
    }
    if (!fired) continue;
    for (const H of HOLDS) {
      const xIdx = i + 1 + H - 1;                // 진입일 포함 H거래일 → 청산 종가
      if (xIdx >= c.length) continue;
      const xPx = c[xIdx];
      if (!(xPx > 0)) continue;
      const gross = (xPx / ePx - 1) * 100;
      if (Math.abs(gross) > 200) continue;       // 데이터 이상치 방어
      const net = gross - COST;
      for (const s of fired) {
        const a = acc[s][H];
        a.n++; a.sum += net; a.sumsq += net * net; if (net > 0) a.wins++;
        const yr = String(d[i]).slice(0, 4);
        (a.byYear[yr] ??= { n: 0, sum: 0 }).n++; a.byYear[yr].sum += net;
      }
    }
  }
}

// ── 리포트 ────────────────────────────────────────────────────
console.log('=== 보유기간별 수익 — "얼마나 들고 있어야 하나" ===');
console.log(`데이터 ${nUsed}종목 · candles-daily-toss-clean (2021-09~2026-07, 4.8년) · 왕복비용 ${COST}%`);
console.log(`진입 = 신호 다음날 시가 / 청산 = +N거래일 종가 / 비용은 회전 1회당 1번\n`);

const best = {};
for (const s of NAMES) {
  console.log(`【${s}】`);
  console.log(`  ${'보유'.padStart(5)}${'n'.padStart(10)}${'평균순수익'.padStart(12)}${'승률'.padStart(8)}${'연율수익'.padStart(11)}${'연율변동'.padStart(11)}${'샤프'.padStart(8)}`);
  let bestAnn = -Infinity, bestH = null;
  for (const H of HOLDS) {
    const a = acc[s][H];
    if (a.n < 500) continue;
    const mean = a.sum / a.n;                                   // % (순)
    const varr = Math.max(0, a.sumsq / a.n - mean * mean);
    const sd = Math.sqrt(varr);
    const turns = TRADING_DAYS / H;                             // 연 회전수
    const ann = (Math.pow(1 + mean / 100, turns) - 1) * 100;    // 기하 연율화
    const annVol = sd * Math.sqrt(turns);
    const sharpe = annVol > 0 ? ann / annVol : NaN;
    if (Number.isFinite(ann) && ann > bestAnn) { bestAnn = ann; bestH = H; }
    console.log(
      `  ${String(H).padStart(5)}${String(a.n).padStart(10)}` +
      `${((mean >= 0 ? '+' : '') + mean.toFixed(3) + '%').padStart(12)}` +
      `${((a.wins / a.n * 100).toFixed(1) + '%').padStart(8)}` +
      `${((ann >= 0 ? '+' : '') + ann.toFixed(1) + '%').padStart(11)}` +
      `${(annVol.toFixed(1) + '%').padStart(11)}` +
      `${(Number.isFinite(sharpe) ? sharpe.toFixed(2) : '-').padStart(8)}`);
  }
  best[s] = { H: bestH, ann: bestAnn };
  console.log(`  → 연율 최고: ${bestH}거래일 (${bestAnn >= 0 ? '+' : ''}${bestAnn.toFixed(1)}%)\n`);
}

// ── 연도별 분해 (국면효과 확인) ───────────────────────────────
/**
 * ★ 전 구간 평균 하나로는 "한 해가 만든 값"과 "지속 엣지"를 구분할 수 없다.
 *   최적 보유기간에서 연도별 연율수익을 나눠 본다. 부호가 해마다 뒤집히면 국면효과다.
 */
console.log('── 연도별 분해 (각 신호의 최적 보유기간에서) ──');
const years = [...new Set(NAMES.flatMap(s => Object.keys(acc[s][best[s].H]?.byYear ?? {})))].sort();
console.log(`  ${'신호'.padEnd(8)}${'보유'.padStart(5)}${years.map(y => y.padStart(11)).join('')}`);
for (const s of NAMES) {
  const H = best[s].H; if (!H) continue;
  const by = acc[s][H].byYear;
  const turns = TRADING_DAYS / H;
  const cells = years.map(y => {
    const o = by[y];
    if (!o || o.n < 100) return '-';
    const m = o.sum / o.n;
    return ((m >= 0 ? '+' : '') + ((Math.pow(1 + m / 100, turns) - 1) * 100).toFixed(0) + '%');
  });
  const pos = cells.filter(c => c.startsWith('+')).length, tot = cells.filter(c => c !== '-').length;
  console.log(`  ${s.padEnd(8)}${String(H).padStart(5)}${cells.map(c => c.padStart(11)).join('')}   (양수 ${pos}/${tot})`);
}
console.log();

console.log('── 요약 ──');
for (const s of NAMES) console.log(`  ${s.padEnd(8)} 최적 보유 ${String(best[s].H).padStart(3)}거래일 · 연율 ${(best[s].ann >= 0 ? '+' : '') + best[s].ann.toFixed(1)}%`);
console.log(`\n※ 비용 손익분기 보유기간 = 표에서 연율수익이 0을 넘는 첫 지점. 그보다 짧으면 신호가 뭐든 마찰이 이긴다.`);
console.log(`\n※ 연율화는 "그 보유기간으로 쉬지 않고 굴렸을 때"의 기하수익이다. 슬롯 제약·동시보유·신호 부족은 반영 안 됨`);
console.log(`  → 실제 운용 수익이 아니라 **보유기간 축의 모양**을 보는 값이다. 최적 근처를 라이브 설정과 대조하는 용도.`);
console.log(`※ 생존편향 있음(현재 상장 종목만). 절대수치는 낙관, 보유기간 간 **상대비교**가 이 측정의 목적.`);
