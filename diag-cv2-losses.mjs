/**
 * diag-cv2-losses.mjs — combo-v2 패배 거래 forensic 분해 (2026-07-25, 사용자 요청).
 *   목적: "왜 졌는지 → 가설 → 재테스트" 루프의 1단계. 패배가 몰린 축을 찾는다.
 *   입력: backtest-swing.mjs --dump 산출 JSON
 */
import { readFileSync } from 'fs';

const path = process.argv[2] || './cv2-dump.json';
const d = JSON.parse(readFileSync(path, 'utf8'));
const T = d.books['combo-v2'].trades;
const won = T.filter(t => t.pnl > 0), lost = T.filter(t => t.pnl <= 0);
const sum = (a) => a.reduce((s, x) => s + x.pnl, 0);
const fmt = (n) => (n / 1e4).toFixed(0) + '만';

console.log(`총 ${T.length}거래 | 승 ${won.length}(${(won.length/T.length*100).toFixed(0)}%) ${fmt(sum(won))} | 패 ${lost.length} ${fmt(sum(lost))} | 순 ${fmt(sum(T))}`);
console.log(`평균: 승 ${fmt(sum(won)/won.length)} / 패 ${fmt(sum(lost)/lost.length)}\n`);

const group = (label, keyFn) => {
  const m = new Map();
  for (const t of T) {
    const k = keyFn(t); if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  console.log(`=== ${label} ===`);
  const rows = [...m.entries()].map(([k, v]) => ({
    k, n: v.length, net: sum(v), win: v.filter(x => x.pnl > 0).length / v.length * 100,
    avg: sum(v) / v.length,
  })).sort((a, b) => a.net - b.net);
  for (const r of rows) {
    const bar = r.net < 0 ? '🔴' : '🟢';
    console.log(`  ${bar} ${String(r.k).padEnd(22)} n=${String(r.n).padStart(4)} 순 ${fmt(r.net).padStart(8)} 평균 ${fmt(r.avg).padStart(7)} 승률 ${r.win.toFixed(0).padStart(3)}%`);
  }
  console.log();
};

group('서브전략 × 레짐', t => `${t.ctx?.sub ?? '?'} / ${t.ctx?.regime ?? '?'}`);
group('청산사유', t => t.reason);
group('서브전략 × 청산사유', t => `${t.ctx?.sub ?? '?'} / ${t.reason}`);
group('보유일 버킷', t => t.hold === 0 ? '0일(당일)' : t.hold <= 2 ? '1-2일' : t.hold <= 5 ? '3-5일' : t.hold <= 10 ? '6-10일' : '11일+');
group('확신도 버킷', t => { const c = Number(t.ctx?.conviction); return Number.isFinite(c) ? (c < 2 ? 'conv 0-2' : c < 4 ? 'conv 2-4' : c < 7 ? 'conv 4-7' : 'conv 7+') : null; });
group('hi120 돌파폭', t => { if (t.ctx?.sub !== 'hi120') return null; const b = Number(t.ctx.breakoutPct); return b < 4 ? '돌파 3-4%' : b < 6 ? '돌파 4-6%' : b < 10 ? '돌파 6-10%' : '돌파 10%+'; });
group('rsi2 RSI값', t => { if (t.ctx?.sub !== 'rsi2') return null; const r = Number(t.ctx.rsi); return r < 1 ? 'RSI 0' : r < 4 ? 'RSI 1-3' : 'RSI 4-9'; });

// 연도별 (국면 의존성 확인)
group('연도', t => String(t.day).slice(0, 4));

// 최악 20거래
console.log('=== 최악 20거래 ===');
for (const t of [...T].sort((a, b) => a.pnl - b.pnl).slice(0, 20)) {
  console.log(`  ${t.day} ${t.code} ${(t.ctx?.sub ?? '?').padEnd(6)} ${(t.ctx?.regime ?? '?').padEnd(8)} ${fmt(t.pnl).padStart(8)} ${String(t.hold).padStart(3)}일 ${t.reason} ${t.ctx?.rsi != null ? 'RSI'+t.ctx.rsi : ''}${t.ctx?.breakoutPct != null ? '돌파'+t.ctx.breakoutPct+'%' : ''}`);
}
