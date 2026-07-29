/**
 * diag-nxt-exit.mjs — NXT 애프터마켓 청산이 한 번도 발동하지 않은 이유 판정 (2026-07-29)
 *
 * 관측 사실: 로그 전 기간에서 청산은 08~14시에만 발생했고 15:30~20:00에는 0건이다.
 *   봇 코드는 marketOpen() = 08~20시로 30초마다 청산을 평가하므로 "안 돌았다"로는 설명이 안 된다.
 *
 * 두 가설을 데이터로 가른다:
 *   (a) NXT 애프터마켓에서 트레일선이 실제로 안 깨진다 → 봇은 대응할 게 없었다(정상)
 *   (b) 깨지는데도 청산이 안 됐다 → 청산 경로 결함(고점 추적/가격 피드/체결)
 *
 * 방법: data-1m 의 1분봉(NXT 포함)으로 **같은 트레일 규칙을 두 정책으로** 재생한다.
 *   정책 A(현행 실측 동작): 09:00~15:20 구간에서만 청산 판정
 *   정책 B(NXT 포함):      09:00~20:00 구간에서 청산 판정
 *   진입은 매 거래일 09:00 첫 봉(정책 무관, 동일 표본) — 진입 규칙의 승패가 아니라
 *   **애프터마켓 감시의 가치**만 분리 측정하는 게 목적이다.
 *
 * 핵심 산출: B가 청산했는데 A는 못 한 건수, 그리고 그 때 A가 실제로 나간 가격(익일 09:00 시가)과의 차이.
 *   차이가 유의하게 +면 애프터마켓 청산은 이득 → (b)면 실제 손실이 있었다는 뜻.
 *
 * 실행: node diag-nxt-exit.mjs [--dir data-1m] [--trail 6] [--hard 7] [--max 234]
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DIR = String(argOf('--dir', 'data-1m'));
const TRAIL = Number(argOf('--trail', 6));
const HARD = Number(argOf('--hard', 7));
const MAXF = Number(argOf('--max', 999));

const KST = (s) => new Date(s * 1000 + 9 * 3_600_000);
const dayOf = (s) => KST(s).toISOString().slice(0, 10);
const hmOf = (s) => { const d = KST(s); return d.getUTCHours() * 100 + d.getUTCMinutes(); };

const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl')).slice(0, MAXF);
console.log(`대상 ${files.length}종목 · 트레일 -${TRAIL}% · 하드 -${HARD}%`);
console.log(`정규장 = 0900~1520 · NXT애프터 = 1530~2000\n`);

let nStockDay = 0, nAfterBars = 0, nNoAfter = 0;
let crossAfterOnly = 0;          // B는 청산, A는 못 함
let crossBoth = 0;               // 둘 다 정규장에서 청산
let crossNeither = 0;
const gapPct = [];               // (B청산가 - A차선책가) / 진입가, %p
const detail = [];

for (const f of files) {
  let o;
  try { o = JSON.parse(readFileSync(join(DIR, f), 'utf8').split('\n')[0]); } catch { continue; }
  const { code, t, o: op, h, l, c } = o;
  if (!t?.length || !c?.length) continue;

  // 일자별 인덱스 구간으로 자른다
  const byDay = new Map();
  for (let i = 0; i < t.length; i++) {
    const d = dayOf(t[i]);
    let a = byDay.get(d);
    if (!a) byDay.set(d, a = []);
    a.push(i);
  }
  const days = [...byDay.keys()].sort();

  for (let di = 0; di < days.length - 1; di++) {
    const idx = byDay.get(days[di]);
    const reg = idx.filter(i => hmOf(t[i]) >= 900 && hmOf(t[i]) <= 1520);
    const aft = idx.filter(i => hmOf(t[i]) >= 1530 && hmOf(t[i]) <= 2000);
    if (reg.length < 60) continue;                 // 정규장 데이터 부족한 날 제외
    nStockDay++;
    if (!aft.length) { nNoAfter++; continue; }     // 이 종목은 NXT 미참여(소형주) → 애초에 대응 불가
    nAfterBars += aft.length;

    const entry = op?.[reg[0]] ?? c[reg[0]];
    if (!(entry > 0)) continue;
    const trailPx = (hi) => hi * (1 - TRAIL / 100);
    const hardPx = entry * (1 - HARD / 100);

    // ── 정책 A: 정규장만 판정 ──
    let hiA = entry, exitA = null;
    for (const i of reg) {
      if (h[i] > hiA) hiA = h[i];
      if (l[i] <= Math.max(trailPx(hiA), hardPx)) { exitA = Math.max(trailPx(hiA), hardPx); break; }
    }
    // ── 정책 B: 정규장 + 애프터 판정 (고점은 동일 규칙으로 계속 갱신) ──
    let hiB = entry, exitB = null, exitBAfter = false;
    for (const i of [...reg, ...aft]) {
      if (h[i] > hiB) hiB = h[i];
      const lvl = Math.max(trailPx(hiB), hardPx);
      if (l[i] <= lvl) { exitB = lvl; exitBAfter = hmOf(t[i]) >= 1530; break; }
    }

    if (exitA && exitB) { crossBoth++; continue; }        // 정규장에서 이미 갈림 = NXT 무관
    if (!exitB) { crossNeither++; continue; }
    if (exitB && !exitA && exitBAfter) {
      // B만 청산 — 애프터마켓에서 트레일선이 깨졌다. A는 익일 09:00 시가에야 나갈 수 있다.
      crossAfterOnly++;
      const nx = byDay.get(days[di + 1]).filter(i => hmOf(t[i]) >= 900);
      if (!nx.length) continue;
      const nextOpen = op?.[nx[0]] ?? c[nx[0]];
      if (!(nextOpen > 0)) continue;
      const g = (exitB - nextOpen) / entry * 100;         // +면 애프터 청산이 유리
      gapPct.push(g);
      if (detail.length < 12) detail.push({ code, day: days[di], entry, exitB, nextOpen, g });
    }
  }
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log('=== 표본 ===');
console.log(`종목·일 조합 ${nStockDay.toLocaleString()}건 (그 중 NXT 애프터 봉 없음 ${nNoAfter.toLocaleString()}건 = 소형주 미참여)`);
console.log(`애프터마켓 봉 합계 ${nAfterBars.toLocaleString()}개\n`);

console.log('=== 트레일선 교차 위치 ===');
const tot = crossBoth + crossAfterOnly + crossNeither;
const pc = (n) => tot ? (n / tot * 100).toFixed(1) + '%' : '-';
console.log(`정규장에서 교차(NXT 무관)      ${crossBoth.toLocaleString().padStart(7)}  ${pc(crossBoth)}`);
console.log(`애프터마켓에서만 교차 ★        ${crossAfterOnly.toLocaleString().padStart(7)}  ${pc(crossAfterOnly)}`);
console.log(`둘 다 미교차                   ${crossNeither.toLocaleString().padStart(7)}  ${pc(crossNeither)}\n`);

if (gapPct.length) {
  const win = gapPct.filter(v => v > 0).length;
  console.log('=== 애프터마켓 청산 vs 익일 09:00 시가 청산 ===');
  console.log(`표본 ${gapPct.length.toLocaleString()}건`);
  console.log(`평균 ${(avg(gapPct) >= 0 ? '+' : '') + avg(gapPct).toFixed(2)}%p · 중앙 ${(med(gapPct) >= 0 ? '+' : '') + med(gapPct).toFixed(2)}%p`);
  console.log(`애프터 청산이 유리한 비율 ${(win / gapPct.length * 100).toFixed(1)}% (${win}/${gapPct.length})`);
  console.log(`\n※ 평균이 유의하게 +면 → 애프터마켓 청산 미발동은 실제 손실이었다(가설 b가 문제).`);
  console.log(`※ 0 근처거나 -면 → 애프터에서 나가도 익일 시가와 비슷하다 = 놓쳐도 손해 아님(가설 a).`);
  console.log('\n--- 샘플 ---');
  console.log('종목    일자         진입      애프터청산   익일시가    차이');
  for (const d of detail) console.log(`${d.code}  ${d.day}  ${Math.round(d.entry).toLocaleString().padStart(8)}  ${Math.round(d.exitB).toLocaleString().padStart(9)}  ${Math.round(d.nextOpen).toLocaleString().padStart(9)}  ${((d.g >= 0 ? '+' : '') + d.g.toFixed(2) + '%p').padStart(8)}`);
} else {
  console.log('애프터마켓에서만 교차한 건이 0 → 가설 (a): NXT에서 트레일선이 깨지지 않는다.');
}
