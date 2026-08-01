/**
 * 떨어지는 칼날 배제 가설 — 3.4년 소급 판별력 측정 (shadow-missed 절차 준용)
 * 질문: rsi2 후보(RSI2<10) 중 20일 낙폭이 깊은 것이 실제로 더 나쁜가?
 * 표본 = 종목-일. PIT 유동성필터(cache 자체로 계산 = look-ahead 없음).
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const MIN_TURNOVER = 3e9, MIN_PRICE = 2000, RSI_MAX = 10;
const FWD = [1, 3, 5];
const BUCKETS = [-1e9, -50, -40, -30, -20, -10, 0, 1e9];
const blabel = (v) => {
  for (let k = 0; k < BUCKETS.length - 1; k++) if (v >= BUCKETS[k] && v < BUCKETS[k + 1])
    return `${BUCKETS[k] === -1e9 ? '     ~-50' : BUCKETS[k + 1] === 1e9 ? '   0~    ' : String(BUCKETS[k]).padStart(4) + '~' + String(BUCKETS[k + 1]).padStart(4)}`;
  return '?';
};
function rsi2(c, i) { if (i < 2) return 50; let up = 0, dn = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; } return up + dn === 0 ? 50 : (up / (up + dn)) * 100; }

// ── 1패스: 삼전으로 시장 레짐 시계열 ──────────────────────────
const regimeByDay = new Map();
{
  const rl = createInterface({ input: createReadStream('candles-daily.jsonl') });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.code !== '005930') continue;
    const c = o.c, d = o.d;
    for (let i = 60; i < c.length; i++) {
      const avg = (n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; };
      const ma20 = avg(20), ma60 = avg(60), ret5 = (c[i] / c[i - 5] - 1) * 100;
      regimeByDay.set(String(d[i]), c[i] > ma20 && ma20 > ma60 ? 'UP' : (c[i] < ma20 && ret5 < -3) ? 'DOWN' : 'NEUTRAL');
    }
    break;
  }
  rl.close();
}
console.log(`레짐 시계열 ${regimeByDay.size}일`);

// ── 2패스: 전 종목 rsi2 후보 수집 ─────────────────────────────
const rows = [];  // {dd20, fwd:[..], regime, turn}
let stocks = 0;
{
  const rl = createInterface({ input: createReadStream('candles-daily.jsonl') });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const { d, c, v } = o; if (!c || c.length < 82) continue;
    stocks++;
    for (let i = 61; i < c.length - Math.max(...FWD); i++) {
      if (c[i] < MIN_PRICE) continue;
      let t = 0; for (let j = i - 19; j <= i; j++) t += c[j] * (v[j] ?? 0);
      const turn = t / 20; if (turn < MIN_TURNOVER) continue;
      const reg = regimeByDay.get(String(d[i])); if (!reg || reg === 'NEUTRAL') continue;  // 라이브: NEUTRAL rsi2 스킵
      if (rsi2(c, i) >= RSI_MAX) continue;
      rows.push({
        dd20: (c[i] / c[i - 20] - 1) * 100,
        fwd: FWD.map(f => (c[i + f] / c[i] - 1) * 100),
        reg, turn,
      });
    }
  }
  rl.close();
}
console.log(`종목 ${stocks} · rsi2 후보 종목-일 ${rows.length.toLocaleString()}\n`);

function report(title, set) {
  console.log(`── ${title} (n=${set.length.toLocaleString()}) ─────────────`);
  console.log(`20일수익률       n      +1일     +3일     +5일   승률(5일)  최악5%(5일)`);
  const by = new Map();
  for (const r of set) { const b = blabel(r.dd20); (by.get(b) ?? by.set(b, []).get(b)).push(r); }
  for (const b of [...by.keys()].sort()) {
    const g = by.get(b);
    const m = (k) => g.reduce((s, r) => s + r.fwd[k], 0) / g.length;
    const win = g.filter(r => r.fwd[2] > 0).length / g.length * 100;
    const s5 = g.map(r => r.fwd[2]).sort((a, b2) => a - b2);
    const p5 = s5[Math.floor(s5.length * 0.05)] ?? 0;
    console.log(`${b}  ${String(g.length).padStart(7)}  ${m(0).toFixed(2).padStart(7)}% ${m(1).toFixed(2).padStart(7)}% ${m(2).toFixed(2).padStart(7)}%  ${win.toFixed(1).padStart(6)}%  ${p5.toFixed(1).padStart(8)}%`);
  }
  console.log('');
}
report('전체', rows);
const cut = rows.map(r => r.turn).sort((a, b) => b - a)[Math.floor(rows.length * 0.2)];
report('대형주 근사(거래대금 상위 20%)', rows.filter(r => r.turn >= cut));
report('레짐 DOWN', rows.filter(r => r.reg === 'DOWN'));
