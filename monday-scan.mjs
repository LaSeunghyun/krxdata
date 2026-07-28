/**
 * monday-scan.mjs — 금요일(7/24) 종가 기준 시장 상황 + 월요일 진입후보 실사 (일회성 조사).
 *   캐시(candles-daily.jsonl, 7/24까지)만 사용 = 라이브봇이 월요일에 볼 신호와 동일 근거. Toss 안 침.
 */
import 'dotenv/config';
import { createReadStream } from 'fs';
import readline from 'readline';

const MIN_PRICE = 2000, MIN_TURNOVER = 3e9, RSI_MAX = 10, VOL_MIN = 1.25;

const P = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('./candles-daily.jsonl') });
  rl.on('line', (l) => { if (!l.trim()) return; const o = JSON.parse(l); P.set(o.code, o); });
  rl.on('close', res);
});

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const j = await r.json(); return Array.isArray(j) ? j : [];
};
const meta = new Map((await dbQuery(`SELECT stock_code, corp_name, sector, market_cap_tril FROM stock_analysis`)).map(r => [r.stock_code, r]));

const rsi2 = (c) => { const i = c.length - 1; if (i < 2) return 50; let up = 0, dn = 0; for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; } return up + dn === 0 ? 50 : (up / (up + dn)) * 100; };
const D = '20260724';

// ── 레짐 (삼성전자 SMA20/60, 라이브와 동일)
{
  const s = P.get('005930'); const i = s.d.indexOf(D);
  const avg = (n) => s.c.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
  const ma20 = avg(20), ma60 = avg(60), ret5 = (s.c[i] / s.c[i - 5] - 1) * 100;
  let rg = 'NEUTRAL';
  if (s.c[i] > ma20 && ma20 > ma60) rg = 'UP'; else if (s.c[i] < ma20 && ret5 < -3) rg = 'DOWN';
  console.log(`레짐(005930 기준): ${rg} | 종가 ${s.c[i].toLocaleString()} ma20 ${ma20.toFixed(0)} ma60 ${ma60.toFixed(0)} ret5 ${ret5.toFixed(1)}%`);
  console.log(`삼성전자 금요일: ${((s.c[i]/s.c[i-1]-1)*100).toFixed(2)}%`);
}

// ── 금요일 시장 폭 (PIT 유동성 필터)
const uni = [];
for (const [code, o] of P) {
  const i = o.d.indexOf(D);
  if (i < 130) continue;
  if (o.c[i] < MIN_PRICE) continue;
  let to = 0; for (let j = i - 19; j <= i; j++) to += o.c[j] * o.v[j]; to /= 20;
  if (to < MIN_TURNOVER) continue;
  uni.push({ code, o, i, friRet: (o.c[i] / o.c[i - 1] - 1) * 100 });
}
const rets = uni.map(u => u.friRet).sort((a, b) => a - b);
const med = rets[Math.floor(rets.length / 2)];
console.log(`\n금요일 시장폭(유동종목 ${uni.length}개): 중앙값 ${med.toFixed(2)}% | 하락 ${rets.filter(r=>r<0).length}개 / 상승 ${rets.filter(r=>r>0).length}개`);
console.log(`  -5%↓ ${rets.filter(r=>r<=-5).length}개 · -3%↓ ${rets.filter(r=>r<=-3).length}개 · +3%↑ ${rets.filter(r=>r>=3).length}개`);

// ── 월요일 rsi2 후보 (라이브 조건: RSI2<10 + 거래량비≥1.25)
console.log('\n=== rsi2 후보 (RSI2<10 & 거래량비≥1.25) ===');
const cands = [];
for (const u of uni) {
  const { o, i } = u;
  const cl = o.c.slice(0, i + 1);
  const rv = rsi2(cl);
  if (rv >= RSI_MAX) continue;
  let av = 0, n = 0; for (let j = i - 20; j < i; j++) { av += o.v[j]; n++; }
  const volRatio = av > 0 ? o.v[i] / (av / n) : 1;
  if (volRatio < VOL_MIN) continue;
  const m = meta.get(u.code) || {};
  cands.push({ code: u.code, name: m.corp_name || u.code, sector: m.sector, mcap: Number(m.market_cap_tril) || 0,
    px: o.c[i], rsi: rv, volRatio, friRet: u.friRet,
    ret20: (o.c[i] / o.c[i - 20] - 1) * 100, ret60: (o.c[i] / o.c[i - 60] - 1) * 100,
    conviction: (RSI_MAX - rv) });
}
cands.sort((a, b) => b.conviction - a.conviction || b.mcap - a.mcap);
console.log(`총 ${cands.length}개. 시총순 상위 12개:`);
for (const c of [...cands].sort((a,b)=>b.mcap-a.mcap).slice(0, 12)) {
  console.log(`  ${c.name.padEnd(12)} ${String(c.px).padStart(8)}원 | 금 ${c.friRet.toFixed(1).padStart(6)}% | RSI2 ${c.rsi.toFixed(1).padStart(4)} | 거래량 ${c.volRatio.toFixed(1)}x | 20일 ${c.ret20.toFixed(0).padStart(4)}% | 60일 ${c.ret60.toFixed(0).padStart(4)}% | 시총 ${c.mcap.toFixed(1)}조 | ${c.sector ?? ''}`);
}

// ── 대조군: 모멘텀 관점 (60일 강세 + 금요일 눌림) = "둘다 틀렸다면?" 검토용
console.log('\n=== 대조: 60일 모멘텀 상위인데 금요일 눌린 종목 (모멘텀+얕은눌림) ===');
const mom = uni.filter(u => {
  const { o, i } = u;
  const r60 = (o.c[i] / o.c[i - 60] - 1) * 100;
  return r60 > 20 && u.friRet < 0 && u.friRet > -8;
}).map(u => {
  const { o, i } = u; const m = meta.get(u.code) || {};
  const hh = Math.max(...o.h.slice(i - 120, i));
  return { name: m.corp_name || u.code, mcap: Number(m.market_cap_tril) || 0, px: o.c[i],
    friRet: u.friRet, r60: (o.c[i] / o.c[i - 60] - 1) * 100, fromHigh: (o.c[i] / hh - 1) * 100, sector: m.sector };
}).sort((a, b) => b.mcap - a.mcap).slice(0, 12);
for (const c of mom) console.log(`  ${c.name.padEnd(12)} ${String(c.px).padStart(8)}원 | 금 ${c.friRet.toFixed(1).padStart(6)}% | 60일 +${c.r60.toFixed(0)}% | 120일고점대비 ${c.fromHigh.toFixed(1)}% | 시총 ${c.mcap.toFixed(1)}조 | ${c.sector ?? ''}`);
