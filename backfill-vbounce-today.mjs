/**
 * backfill-vbounce-today.mjs — 오늘 V_bounce 최초성립 진입을 보충 적재 (2026-07-27 일회성)
 * 배경: 15:57 재실행 스냅샷이 V_bounce 배포 **전에** 시작돼 V 행이 빠졌다. KIS 분봉은 당일만 조회 가능하므로
 *       오늘 PIT 성립시각은 오늘 안 받으면 영구 소실 → 전체 재실행(7,332콜) 대신 해당 종목만(약 65콜) 보충.
 * 실행: node backfill-vbounce-today.mjs [--codes 484810,059120,...]
 */
import 'dotenv/config';
import { loadDaily, firstTriggers } from './scan-1m-core.mjs';
import { getMinuteBars } from './kis-api.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const CODES = String(argOf('--codes', '484810,059120,108860,319400,064260')).split(',');
const BASE = String(argOf('--base', '1520'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : 'NULL');
const kstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const log = (m) => console.log(`[${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);
const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 150)}`);
  return r.json();
};
const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EXITS = {
  base: () => ({ trail: 6, hard: 7, tp1: 6, tp2: 12, maxHold: 10 }),
  atr: (a) => ({ trail: cl(1.5 * a, 3, 12), hard: cl(2.0 * a, 4, 14), tp1: cl(1.5 * a, 3, 12), tp2: cl(3.0 * a, 6, 24), maxHold: 10 }),
  tight: () => ({ trail: 3, hard: 4, tp1: 3, tp2: 6, maxHold: 5 }),
};

const { daily } = await loadDaily();
const MKT_RET20 = daily.get('005930').ret20;
const baseMin = Number(BASE.slice(0, 2)) * 60 + Number(BASE.slice(2, 4));
const hm = (t) => String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
const calls = Math.ceil((baseMin - 540) / 30);
const d = kstDate();
let ins = 0;

for (const code of CODES) {
  const dc = daily.get(code);
  if (!dc) { log(`${code}: 유동성 통과 목록에 없음 — 스킵`); continue; }
  const seen = new Set(), bars = [];
  let prevClose = null;
  for (let k = 0; k < calls; k++) {
    const a = await getMinuteBars(code, hm(baseMin - 30 * k) + '00');
    await sleep(150);
    if (k === 0) prevClose = a.prevClose;
    for (const b of a.bars) if (!seen.has(b.hhmm)) { seen.add(b.hhmm); bars.push(b); }
    if (!a.bars.length) break;
  }
  bars.sort((x, y) => x.hhmm.localeCompare(y.hhmm));
  const trigs = firstTriggers({ code, prevClose: prevClose ?? dc.prevClose, bars }, dc, { MKT_RET20 }, { step: 1 })
    .filter(t => t.variant === 'V_bounce');
  if (!trigs.length) { log(`${code}: V_bounce 최초성립 없음(장중 조건 미충족 구간만 존재)`); continue; }
  for (const g of trigs) {
    const s = g.s;
    const snap = JSON.stringify({ at: g.at, trigger: true, backfill: true, vBounce: s.vBounce, vSince: s.vSince, dayRet: s.dayRet, volPace: s.volPace, hiProx: s.hiProx, atr1: s.atr1Pct, rs20: s.rs20 }).replace(/'/g, "''");
    for (const [rule, f] of Object.entries(EXITS)) {
      const e = f(s.atrPct ?? 4);
      await dbQuery(`INSERT INTO shadow_1m_positions (variant,stock_code,entry_d,entry_px,snapshot,at_hhmm,run_hi,exit_rule,trail_pct,hard_pct,tp1_pct,tp2_pct,max_hold)
        VALUES ('V_bounce','${code}','${d}',${num(s.now)},'${snap}'::jsonb,'${g.at}',${num(s.now)},'${rule}',${num(e.trail)},${num(e.hard)},${num(e.tp1)},${num(e.tp2)},${e.maxHold}) ON CONFLICT DO NOTHING`);
      ins++;
    }
    log(`${code}: V_bounce 성립 ${g.at} @${s.now.toLocaleString()} (반등 +${s.vBounce.toFixed(1)}%, 경과 ${s.vSince}일) → 3청산 적재`);
  }
}
log(`보충 완료: ${ins}행 시도`);
