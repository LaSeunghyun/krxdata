#!/usr/bin/env node
// 56일 intraday 백테스트 엔진 — 분봉(candles-1m.jsonl) + 일봉base(candles-daily.jsonl).
// 목적: 캠페인 가설을 장중(누적거래량) 기준으로 재검증 = 일봉 백테스트와 대조(FLIP 잡기).
// 매 거래일 × 30분 체크포인트: 레짐(005930 장중)·rsi2(전일까지 종가+장중가)·거래량비(장중누적/20일평균일봉).
//   진입: 자본기반(slots3), 가설별 필터. 청산: 하드손절-7%·트레일-8%(장중 고점)·부분익절·maxhold.
// ※ 30분 체크포인트·수정주가 미반영·생존편향(현상장분) — sanity check용. 정직 단서 리포트에.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
import { existsSync, createReadStream } from 'fs'; import { createInterface } from 'readline';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const CAP = 6000000, SLOTS = 3, RSI_MAX = 10, CKPTS = ['09:30','10:00','10:30','11:00','11:30','13:00','13:30','14:00','14:30','15:00','15:20'];
const rsi2 = (c) => { const i = c.length - 1; if (i < 2) return 50; let up = 0, dn = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; } return up + dn === 0 ? 50 : (up / (up + dn)) * 100; };
const REGF = { UP: 1, NEUTRAL: 0.85, DOWN: 0.5 };

async function loadJsonl(path, fn) { const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity }); for await (const line of rl) { if (line.trim()) { try { fn(JSON.parse(line)); } catch { /* partial last line */ } } } }

const daily = {}, min1 = {}; let SECTOR = {};
async function load() {
  // 일봉 base를 분봉에서 직접 도출(candles-daily.jsonl은 06-12서 끝나 stale → 미사용). 분봉은 07-22까지 완전.
  await loadJsonl(join(__dirname, 'candles-1m.jsonl'), o => {
    const byDay = {};
    for (const b of o.bars) { const day = b.t.slice(0, 10).replace(/-/g, ''); const t = b.t.slice(11, 16); (byDay[day] ??= []).push({ t, c: b.c, h: b.h, l: b.l, v: b.v }); }
    for (const day of Object.keys(byDay)) byDay[day].sort((a, b) => a.t.localeCompare(b.t));
    min1[o.code] = byDay;
    // 분봉→일봉: 일별 종가=마지막 분봉 close(정규장 15:30 우선), 일별 거래량=분봉 합
    const days = Object.keys(byDay).sort();
    const closes = [], vols = [];
    for (const d of days) {
      const bars = byDay[d];
      const reg = bars.filter(b => b.t <= '15:30'); const src = reg.length ? reg : bars;
      closes.push(src[src.length - 1].c); vols.push(bars.reduce((s, b) => s + b.v, 0));
    }
    daily[o.code] = { d: days, c: closes, v: vols };
  });
  // 섹터맵 (sectorcap 가설용)
  try { const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'SELECT stock_code, sector FROM stock_analysis' }) }); SECTOR = Object.fromEntries((await r.json()).map(x => [x.stock_code, x.sector])); } catch { /* */ }
}
// D일(YYYYMMDD) 이전 일봉 종가/거래량
function dailyBefore(code, D) { const dd = daily[code]; if (!dd) return null; let k = -1; for (let i = 0; i < dd.d.length; i++) { if (dd.d[i] < D) k = i; else break; } if (k < 2) return null; return { closes: dd.c.slice(0, k + 1), avg20v: dd.v.slice(Math.max(0, k - 19), k + 1).reduce((a, b) => a + b, 0) / Math.min(20, k + 1) }; }
function barsUpTo(code, D, T) { const bd = min1[code]?.[D]; if (!bd) return null; let px = null, cum = 0, hi = 0; for (const b of bd) { if (b.t <= T) { px = b.c; cum += b.v; hi = Math.max(hi, b.h); } else break; } return px == null ? null : { px, cum, hi }; }
function dayHL(code, D) { const bd = min1[code]?.[D]; if (!bd || !bd.length) return null; let hi = 0, last = bd[bd.length - 1].c; for (const b of bd) hi = Math.max(hi, b.h); return { hi, last }; }
function regimeAt(D, T) { const base = dailyBefore('005930', D); const b = barsUpTo('005930', D, T); if (!base || !b) return null; const c = [...base.closes, b.px]; const i = c.length - 1; const ma = (n) => c.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n; const ma20 = ma(20), ma60 = ma(60), ret5 = (c[i] / c[i - 5] - 1) * 100; if (c[i] > ma20 && ma20 > ma60) return 'UP'; if (c[i] < ma20 && ret5 < -3) return 'DOWN'; return 'NEUTRAL'; }

function simulate(codes, tradingDays, V) {
  let cash = CAP; const pos = {}; let peak = CAP, mdd = 0;
  for (const D of tradingDays) {
    for (const T of CKPTS) {
      const regime = regimeAt(D, T) || 'NEUTRAL';
      // 청산
      for (const code of Object.keys(pos)) {
        const b = barsUpTo(code, D, T); if (!b) continue; const p = pos[code]; const px = b.px;
        if (V.relstop && p.holdDays >= 1) { const kb = dailyBefore('005930', D); const mb = barsUpTo('005930', D, T); if (kb && mb) { const mk = mb.px / kb.closes[kb.closes.length - 1] - 1, pr = px / p.entry - 1; if (mk < 0 && pr <= V.relstop * mk) { cash += px * p.qty; delete pos[code]; continue; } } }
        if (px <= p.entry * 0.93) { cash += px * p.qty; delete pos[code]; continue; }
        if (p.hi && px <= p.hi * 0.92 && px > p.entry) { cash += px * p.qty; delete pos[code]; continue; }
        if (!p.tp1 && px >= p.entry * (1 + V.tp1 / 100)) { const q = Math.floor(p.qty / 2); if (q >= 1) { cash += px * q; p.qty -= q; p.tp1 = 1; } }
        else if (p.tp1 && !p.tp2 && px >= p.entry * (1 + V.tp2 / 100)) { const q = Math.floor(p.qty / 2); if (q >= 1) { cash += px * q; p.qty -= q; p.tp2 = 1; } }
      }
      // 진입 (자본기반)
      const cands = [];
      for (const code of codes) {
        if (code === '005930' || pos[code]) continue;
        const base = dailyBefore(code, D); const b = barsUpTo(code, D, T); if (!base || !b) continue;
        const rv = rsi2([...base.closes, b.px]); if (rv >= RSI_MAX) continue;
        if (V.skipNeutral && regime === 'NEUTRAL') continue;
        if (V.volMin) { const vr = base.avg20v > 0 ? b.cum / base.avg20v : 0; if (vr < V.volMin) continue; }
        cands.push({ code, px: b.px, conv: (RSI_MAX - rv) * (REGF[regime] ?? 0.85) });
      }
      cands.sort((a, b) => b.conv - a.conv);
      for (const cd of cands) {
        const eqv = cash + Object.entries(pos).reduce((s, [c, p]) => s + ((barsUpTo(c, D, T)?.px) || p.entry) * p.qty, 0);
        let perSlot = Math.floor(eqv / SLOTS); if (V.regimeexp) perSlot = Math.floor(perSlot * (V.regimeexp[regime] ?? 1));
        const big = Object.entries(pos).filter(([c, p]) => ((barsUpTo(c, D, T)?.px) || p.entry) * p.qty >= perSlot * 0.5).length;
        if (big >= SLOTS || cash < perSlot * 0.5) break;
        if (V.sectorcap && SECTOR[cd.code]) { const n = Object.keys(pos).filter(c => SECTOR[c] === SECTOR[cd.code]).length; if (n >= V.sectorcap) continue; }
        const qty = Math.floor(Math.min(cash, perSlot) * 0.999 / cd.px); if (qty < 1) continue;
        cash -= qty * cd.px; pos[cd.code] = { entry: cd.px, qty, hi: cd.px, holdDays: 0 };
      }
    }
    // EOD: 트레일 고점·보유일 갱신, equity 마킹, MDD
    let mv = 0;
    for (const code of Object.keys(pos)) { const hl = dayHL(code, D); const p = pos[code]; if (hl) { p.hi = Math.max(p.hi, hl.hi); mv += hl.last * p.qty; } else mv += p.entry * p.qty; p.holdDays++; if (p.holdDays > 5) { const hl2 = dayHL(code, D); cash += (hl2?.last || p.entry) * p.qty; delete pos[code]; } }
    const eq = cash + mv; peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak * 100);
  }
  let mv = 0; for (const code of Object.keys(pos)) { const hl = dayHL(code, tradingDays[tradingDays.length - 1]); mv += (hl?.last || pos[code].entry) * pos[code].qty; }
  const total = cash + mv; const years = tradingDays.length / 248;
  const cagr = (Math.pow(total / CAP, 1 / years) - 1) * 100;
  return { total, cagr, mdd, calmar: mdd > 0 ? cagr / mdd : 0 };
}

(async () => {
  process.stderr.write('로딩...\n'); await load();
  const codes = Object.keys(min1);
  const days = [...new Set(codes.flatMap(c => Object.keys(min1[c] || {})))].sort();
  process.stderr.write(`종목 ${codes.length}, 거래일 ${days.length} (${days[0]}~${days[days.length-1]})\n`);
  const VARIANTS = [
    { id: 'baseline', tp1: 4, tp2: 8 },
    { id: 'skipNrsi', skipNeutral: true, tp1: 4, tp2: 8 },
    { id: 'rsivol1.0', volMin: 1.0, tp1: 4, tp2: 8 },
    { id: 'rsivol1.25', volMin: 1.25, tp1: 4, tp2: 8 },
    { id: 'rsivol1.5', volMin: 1.5, tp1: 4, tp2: 8 },
    { id: '★winner(skipN+vol1.25)', skipNeutral: true, volMin: 1.25, tp1: 4, tp2: 8 },
    { id: 'winner+sectorcap1', skipNeutral: true, volMin: 1.25, sectorcap: 1, tp1: 4, tp2: 8 },
    { id: 'winner+tp8/16', skipNeutral: true, volMin: 1.25, tp1: 8, tp2: 16 },
    { id: 'winner+volsize(regimeexp)', skipNeutral: true, volMin: 1.25, regimeexp: { UP: 1, NEUTRAL: 0.7, DOWN: 0.5 }, tp1: 4, tp2: 8 },
    { id: 'winner+relstop2', skipNeutral: true, volMin: 1.25, relstop: 2, tp1: 4, tp2: 8 },
  ];
  console.log(`\n=== 56일 intraday 백테스트 (${days.length}거래일, ${codes.length}종목) ===`);
  console.log('가설 | CAGR | MDD | Calmar | 최종');
  const res = [];
  for (const V of VARIANTS) { const r = simulate(codes, days, V); res.push({ id: V.id, ...r }); console.log(`${V.id} | ${r.cagr.toFixed(1)}% | ${r.mdd.toFixed(1)}% | ${r.calmar.toFixed(2)} | ${Math.round(r.total).toLocaleString()}`); }
  res.sort((a, b) => b.calmar - a.calmar);
  console.log('\n=== Calmar 리더보드 ===');
  res.forEach((r, i) => console.log(`${i + 1}. ${r.id}: Calmar ${r.calmar.toFixed(2)} (CAGR ${r.cagr.toFixed(1)}%, MDD ${r.mdd.toFixed(1)}%)`));
})();
