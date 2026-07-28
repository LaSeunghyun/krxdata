#!/usr/bin/env node
// 오늘 하루 intraday 재현 (토스 1분봉). 승자(skipNrsi+rsivol1.25) vs 베이스라인(구 combo-v2) 대조.
// 레짐(005930, reverse 정상) → 유니버스 rsi2<10 [+승자: 거래량비≥1.25 & NEUTRAL스킵] → 자본기반 진입(slots3) → EOD 마킹.
// ※ 청산은 하드손절 -7%만(단순화). 볼륨비=장중누적/20일평균일봉(라이브 봇과 동일 방식 — 장초반엔 낮음).
import dotenv from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { getDailyCandles, getCandles1m } from './toss-api.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const dbQuery = async (sql) => { const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) }); if (!r.ok) throw new Error(await r.text()); return r.json(); };
function rsi2(c) { const i = c.length - 1; if (i < 2) return 50; let up = 0, dn = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; } return up + dn === 0 ? 50 : (up / (up + dn)) * 100; }
const TODAY = '2026-07-22', RSI_MAX = 10, VOL_MIN = 1.25, SLOTS = 3, CAP = 6000000;
const hhmm = (ts) => ts.slice(11, 16); const isToday = (ts) => ts.slice(0, 10) === TODAY;
const daily = {}, min1 = {}, name = {};

async function load() {
  const rows = await dbQuery(`SELECT stock_code,corp_name FROM stock_analysis WHERE current_price>=2000 AND avg_turnover_20d>=3e9 ORDER BY market_cap_tril DESC LIMIT 40`);
  const codes = ['005930', ...rows.map(r => r.stock_code).filter(c => c !== '005930')];
  rows.forEach(r => name[r.stock_code] = r.corp_name); name['005930'] = '삼성전자';
  process.stderr.write(`데이터 로딩 ${codes.length}종목...\n`);
  for (const c of codes) {
    try {
      const dc = (await getDailyCandles(c, 130)).reverse();
      daily[c] = { closes: dc.map(b => b.close), vols: dc.map(b => Number(b.volume) || 0) };
      min1[c] = (await getCandles1m(c, 700)).filter(b => isToday(b.timestamp)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch (e) { process.stderr.write(`skip ${c}\n`); }
  }
  return codes;
}
const prevCloses = (c) => (daily[c]?.closes || []).slice(0, -1);
const avg20Vol = (c) => { const v = daily[c]?.vols || []; const s = v.slice(-21, -1); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0; };
const priceAt = (c, t) => { let p = null; for (const b of (min1[c] || [])) { if (hhmm(b.timestamp) <= t) p = b.close; else break; } return p; };
const cumVolAt = (c, t) => { let v = 0; for (const b of (min1[c] || [])) { if (hhmm(b.timestamp) <= t) v += Number(b.volume) || 0; else break; } return v; };
const regimeAt = (t) => { const cl = prevCloses('005930'); const px = priceAt('005930', t); if (px == null || cl.length < 60) return null; const c = [...cl, px]; const i = c.length - 1; const ma = (n) => c.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n; const ma20 = ma(20), ma60 = ma(60), ret5 = (c[i] / c[i - 5] - 1) * 100; if (c[i] > ma20 && ma20 > ma60) return 'UP'; if (c[i] < ma20 && ret5 < -3) return 'DOWN'; return 'NEUTRAL'; };

function simulate(codes, winner) {
  const checkpoints = ['09:30', '10:00', '10:30', '11:00', '11:30', '13:00', '14:00', '15:00', '15:20'];
  let cash = CAP; const pos = {}; const log = [];
  for (const t of checkpoints) {
    const regime = regimeAt(t) || 'NEUTRAL';
    for (const c of Object.keys(pos)) { const px = priceAt(c, t); if (px && px <= pos[c].entry * 0.93) { cash += px * pos[c].qty; log.push(`  ${t} 매도 ${name[c]} @${px.toLocaleString()} (하드손절)`); delete pos[c]; } }
    const cands = [];
    for (const c of codes) {
      if (c === '005930' || pos[c]) continue;
      const px = priceAt(c, t); if (px == null) continue;
      const cl = [...prevCloses(c), px]; if (cl.length < 3) continue;
      const rv = rsi2(cl); if (rv >= RSI_MAX) continue;
      if (winner && regime === 'NEUTRAL') continue;
      const av = avg20Vol(c), vr = av > 0 ? cumVolAt(c, t) / av : 0;
      if (winner && vr < VOL_MIN) continue;
      cands.push({ c, px, rv, vr, conv: (RSI_MAX - rv) * (regime === 'UP' ? 1 : regime === 'DOWN' ? 0.5 : 0.85) });
    }
    cands.sort((a, b) => b.conv - a.conv);
    const bought = [];
    for (const cd of cands) {
      const eq = cash + Object.entries(pos).reduce((s, [c, p]) => s + (priceAt(c, t) || p.entry) * p.qty, 0);
      const perSlot = Math.floor(eq / SLOTS);
      const big = Object.entries(pos).filter(([c, p]) => (priceAt(c, t) || p.entry) * p.qty >= perSlot * 0.5).length;
      if (big >= SLOTS || cash < perSlot * 0.5) break;
      const qty = Math.floor(Math.min(cash, perSlot) * 0.999 / cd.px); if (qty < 1) continue;
      cash -= qty * cd.px; pos[cd.c] = { entry: cd.px, qty };
      bought.push(`${name[cd.c]} ${qty}주 @${cd.px.toLocaleString()}(RSI2 ${cd.rv.toFixed(0)},거래량${cd.vr.toFixed(2)}x)`);
    }
    log.push(`${t} | ${regime} | 후보 ${cands.length}${bought.length ? ' → 매수: ' + bought.join(', ') : ''}`);
  }
  let mv = 0; const held = [];
  for (const [c, p] of Object.entries(pos)) { const px = priceAt(c, '15:20') || p.entry; mv += px * p.qty; held.push(`${name[c]} ${((px / p.entry - 1) * 100).toFixed(1)}%`); }
  return { log, held, cash, mv, total: cash + mv };
}

(async () => {
  const codes = await load();
  for (const [label, winner] of [['베이스라인(구 combo-v2: rsi2 전레짐·필터없음)', false], ['승자(skipNrsi + 거래량1.25배)', true]]) {
    const r = simulate(codes, winner);
    console.log(`\n=== ${label} ===`);
    r.log.forEach(l => console.log(l));
    console.log(`→ EOD 보유: ${r.held.join(' / ') || '없음(현금)'} | 총 ${Math.round(r.total).toLocaleString()} (${((r.total / CAP - 1) * 100).toFixed(2)}%)`);
  }
})();
