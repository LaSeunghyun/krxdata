/**
 * research-intraday-stop.mjs — 2026-07-30
 *
 * 질문: 15:35 종가판정 → 익일 08:00 집행 사이에 손실이 계속 커지는 걸 **장중 손절**로 막을 수 있나?
 *   삼성전기 실측(07-30): -15%선을 13:48 에 터치 → 장중 최저 -17.8%(14:36) → KRX종가 -16.4%
 *   → NXT -18.4%(16:45) → 집행은 익일 08:00. 판정과 집행 사이에 -3%p 이상이 더 열렸다.
 *
 * ⚠️ 기존 기각 이력과의 관계 (같은 실수 반복 금지)
 *   2026-07-29 에 "rsi2 장중 실시간 -7% 손절"은 분봉 782쌍에서 기각됐다(+0.38% → -0.11%).
 *   또 "장중에 손을 대면 같은 방식으로 망가진다 — 작게 이기고 크게 진다"는 일반법칙이 세워졌다.
 *   **그건 -7%(좁은 손절) 실험이다.** 정상 변동폭 안에서 발동하니 노이즈에 잘린다.
 *   반면 commit 1965233 의 결론은 "최적점은 없음이 아니라 넓음"(7%→15% 채택)이었다.
 *   → 검정 대상은 **꼬리에서만 발동하는 광폭 장중선**이고 이건 측정된 적이 없다.
 *
 * 방법: rsi2 청산 규칙을 분봉 위에서 그대로 재현하고 장중선만 추가해 **같은 진입에 쌍대비교**한다.
 *   진입가 = 진입일 KRX 종가(근사 — 라이브는 장중 진입)
 *   A(현행) 매일 15:30 판정: 종가 ≤ 진입×(1-15%) 손절 / 종가 > MA3 익절 / 5거래일 만기 → **익일 08:00 집행**
 *   B(후보) A 와 동일 + 장중 언제든 가격 ≤ 진입×(1-X%) 이면 **즉시 그 가격에 청산**
 *   비용은 양쪽 동일하므로 차이에서 상쇄된다(그래서 미차감).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = 'data-1m';
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const STOP = Number(argOf('--stop', 15));          // 종가판정 하드손절 %(현행 라이브)
const MAXHOLD = Number(argOf('--hold', 5));        // maxHoldR
const MA_N = Number(argOf('--ma', 3));             // rsiMa=3
const LIMIT = Number(argOf('--max', 0));
const XS = (argOf('--xs', '15,18,20,25')).split(',').map(Number);   // 장중선 후보

const hhmmOf = (s) => { const d = new Date(s * 1000 + 9 * 3600_000); return d.getUTCHours() * 100 + d.getUTCMinutes(); };
const dayOf = (s) => { const d = new Date(s * 1000 + 9 * 3600_000); return d.toISOString().slice(0, 10); };
const priceAt = (bars, t) => { let v = null; for (const b of bars) { if (b.hm <= t) v = b.c; else break; } return v; };
const priceAtOrAfter = (bars, t) => { for (const b of bars) if (b.hm >= t) return b.c; return null; };

const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
const use = LIMIT > 0 ? files.slice(0, LIMIT) : files;

const res = new Map();   // key -> [ret%...]
const push = (k, v) => { if (!res.has(k)) res.set(k, []); res.get(k).push(v); };
let trades = 0, stocks = 0, fireCnt = new Map();

for (const f of use) {
  let o; try { o = JSON.parse(readFileSync(join(DIR, f), 'utf8').trim().split('\n')[0]); } catch { continue; }
  const { t, c, l } = o; if (!t || !c || t.length < 500) continue;
  stocks++;
  const byDay = new Map();
  for (let k = 0; k < t.length; k++) {
    const d = dayOf(t[k]);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ hm: hhmmOf(t[k]), c: c[k], l: (l ? l[k] : c[k]) });
  }
  const days = [...byDay.keys()].sort();
  for (const d of days) byDay.get(d).sort((a, b) => a.hm - b.hm);
  const kc = new Map();                                    // KRX 종가(15:30)
  for (const d of days) { const p = priceAt(byDay.get(d), 1530); if (p > 0) kc.set(d, p); }
  const dl = days.filter(d => kc.has(d));                  // 종가 있는 날만

  // 장중 저가(정규장 09:00~15:30 구간) — 장중선 접촉 판정용
  const intraLow = new Map();
  for (const d of dl) {
    let lo = Infinity, loHm = null;
    for (const b of byDay.get(d)) { if (b.hm < 900 || b.hm > 1530) continue; const v = Math.min(b.l ?? b.c, b.c); if (v < lo) { lo = v; loHm = b.hm; } }
    if (Number.isFinite(lo)) intraLow.set(d, { lo, loHm });
  }

  for (let ei = MA_N; ei < dl.length - MAXHOLD - 1; ei++) {
    const entry = kc.get(dl[ei]); if (!(entry > 0)) continue;
    trades++;

    // ── A(현행): 종가판정 → 익일 08:00 집행 ──
    let aRet = null, aWhy = null;
    for (let k = 1; k <= MAXHOLD && ei + k < dl.length - 1; k++) {
      const d = dl[ei + k], cl = kc.get(d);
      const prior = dl.slice(Math.max(0, ei + k - (MA_N - 1)), ei + k).map(x => kc.get(x)).filter(v => v > 0);
      const ma = (cl + prior.slice(-(MA_N - 1)).reduce((s, v) => s + v, 0)) / MA_N;
      let why = null;
      if (cl <= entry * (1 - STOP / 100)) why = 'stop';
      else if (cl > ma) why = 'ma';
      else if (k >= MAXHOLD) why = 'hold';
      if (why) {
        const px = priceAtOrAfter(byDay.get(dl[ei + k + 1]), 800);
        if (px > 0) { aRet = (px / entry - 1) * 100; aWhy = why; }
        break;
      }
    }
    if (aRet == null) continue;
    push('A_현행', aRet);
    if (aWhy === 'stop') push('A_손절건만', aRet);

    // ── B(후보): A + 장중 광폭선 ──
    for (const X of XS) {
      const line = entry * (1 - X / 100);
      let bRet = null, hitIntra = false;
      for (let k = 1; k <= MAXHOLD && ei + k < dl.length - 1; k++) {
        const d = dl[ei + k];
        const il = intraLow.get(d);
        if (il && il.lo <= line) { bRet = (line / entry - 1) * 100; hitIntra = true; break; }  // 장중선 체결(선 가격 가정)
        const cl = kc.get(d);
        const prior = dl.slice(Math.max(0, ei + k - (MA_N - 1)), ei + k).map(x => kc.get(x)).filter(v => v > 0);
        const ma = (cl + prior.slice(-(MA_N - 1)).reduce((s, v) => s + v, 0)) / MA_N;
        let why = null;
        if (cl <= entry * (1 - STOP / 100)) why = 'stop';
        else if (cl > ma) why = 'ma';
        else if (k >= MAXHOLD) why = 'hold';
        if (why) { const px = priceAtOrAfter(byDay.get(dl[ei + k + 1]), 800); if (px > 0) bRet = (px / entry - 1) * 100; break; }
      }
      if (bRet == null) continue;
      push(`B_장중${X}%`, bRet);
      push(`D_장중${X}%`, bRet - aRet);
      if (hitIntra) fireCnt.set(X, (fireCnt.get(X) ?? 0) + 1);
    }
  }
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * q)] : 0; };

console.log(`=== 장중 광폭손절 검정 (종가판정 손절 -${STOP}% · MA${MA_N} · 만기${MAXHOLD}일) ===`);
console.log(`종목 ${stocks} · 진입 후보 ${trades.toLocaleString()} · 완결거래 ${(res.get('A_현행') ?? []).length.toLocaleString()}\n`);
console.log('구성            n       평균     중앙    최악5%   승률   장중발동');
console.log('─'.repeat(72));
for (const k of ['A_현행', ...XS.map(X => `B_장중${X}%`)]) {
  const a = res.get(k) ?? []; if (!a.length) continue;
  const X = k.startsWith('B_') ? Number(k.match(/(\d+)%/)[1]) : null;
  const fc = X ? `${fireCnt.get(X) ?? 0}건(${((fireCnt.get(X) ?? 0) / a.length * 100).toFixed(1)}%)` : '-';
  console.log(`${k.padEnd(13)} ${String(a.length).padStart(6)} ${avg(a).toFixed(3).padStart(8)}% ${med(a).toFixed(2).padStart(7)}% ${pct(a, 0.05).toFixed(2).padStart(7)}% ${(a.filter(v => v > 0).length / a.length * 100).toFixed(1).padStart(5)}% ${fc.padStart(13)}`);
}
console.log('\n=== 쌍대차이 (후보 - 현행, 같은 진입) ===');
console.log('장중선        쌍n     평균차이   중앙차이   후보승   무승부');
console.log('─'.repeat(66));
for (const X of XS) {
  const a = res.get(`D_장중${X}%`) ?? []; if (!a.length) continue;
  const w = a.filter(v => v > 1e-9).length, tie = a.filter(v => Math.abs(v) <= 1e-9).length;
  console.log(`-${String(X).padEnd(11)} ${String(a.length).padStart(6)} ${avg(a).toFixed(3).padStart(10)}% ${med(a).toFixed(2).padStart(9)}% ${(w / a.length * 100).toFixed(1).padStart(7)}% ${(tie / a.length * 100).toFixed(1).padStart(7)}%`);
}
{
  // 사용자 질문의 핵심 수치: "-15% 선인데 실제로는 몇 %에 팔리나"
  const a = res.get('A_손절건만') ?? [];
  console.log(`\n=== 손절 발동 거래만 (현행 규칙) n=${a.length.toLocaleString()} ===`);
  console.log(`평균 ${avg(a).toFixed(2)}% · 중앙 ${med(a).toFixed(2)}%  (선은 -${STOP}%)`);
  for (const q of [0.25, 0.10, 0.05, 0.02, 0.01]) console.log(`  하위 ${String(Math.round(q * 100)).padStart(2)}% 분위: ${pct(a, q).toFixed(2)}%`);
  console.log(`  -20% 이하 체결: ${(a.filter(v => v <= -20).length / a.length * 100).toFixed(1)}%  ·  -25% 이하: ${(a.filter(v => v <= -25).length / a.length * 100).toFixed(1)}%`);
}
console.log('\n※ 거래당 기준이다. 슬롯 유한 시스템에서는 회전율 효과가 따로 있다(2026-07-28 일반법칙).');
console.log('※ 장중 체결가를 "선 가격 그대로"로 가정했다 = 후보에 유리한 낙관 가정(갭·슬리피지 미반영).');
