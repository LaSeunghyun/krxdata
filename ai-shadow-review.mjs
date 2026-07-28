#!/usr/bin/env node
/**
 * ai-shadow-review.mjs — SHADOW 원장 요약 (읽기전용, DB만).
 *   오늘(또는 --date) 판단·현재 가상 포지션(mark-to-market)·청산 성과·집계.
 *   실행: node ai-shadow-review.mjs [--date YYYY-MM-DD]
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DATE = argOf('--date', new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
const esc = (s) => String(s).replace(/'/g, "''");
const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const j = await r.json(); if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 150)); return j;
};
const arr = (x) => Array.isArray(x) ? x : (typeof x === 'string' ? (() => { try { return JSON.parse(x); } catch { return []; } })() : []);
const pct = (x) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(1)}%`;

async function main() {
  const dec = await q(`SELECT * FROM ai_shadow_decisions WHERE decided_date='${esc(DATE)}' ORDER BY conviction DESC, decision`);
  const buys = dec.filter(d => d.decision === 'buy'), skips = dec.filter(d => d.decision === 'skip');
  console.log(`\n=== SHADOW 리뷰 ${DATE} — 판단 ${dec.length}건 (BUY ${buys.length} / SKIP ${skips.length}) ===`);
  for (const b of buys) {
    const s = typeof b.strategy === 'string' ? JSON.parse(b.strategy) : b.strategy;
    console.log(`\n✅ BUY ${b.name}(${b.stock_code}) 확신${b.conviction} @${Number(b.price).toLocaleString()}`);
    console.log(`   촉매: ${b.catalyst}`);
    console.log(`   사유: ${arr(b.thesis).join(' / ')}`);
    if (s) console.log(`   전략: 목표+${s.target_pct}% 손절-${s.stop_pct}% ${s.horizon_days}일 | 깨짐:${arr(s.thesis_break).join(';')}`);
  }
  if (skips.length) {
    console.log(`\n--- 주요 SKIP (확신 높은 순 5) ---`);
    for (const s of skips.slice(0, 5)) console.log(`  ✕ ${s.name}(${s.stock_code}) 확신${s.conviction} — ${(arr(s.opposing)[0] || s.catalyst || '').slice(0, 70)}`);
  }

  // 현재 가상 포지션 (mark-to-market)
  const open = await q(`SELECT * FROM ai_shadow_positions WHERE status='open' ORDER BY opened_date`);
  console.log(`\n=== 가상 보유 포지션 ${open.length}개 ===`);
  let totCost = 0, totMv = 0;
  for (const p of open) {
    const pr = await q(`SELECT close FROM stock_prices WHERE stock_code='${esc(p.stock_code)}' ORDER BY date DESC LIMIT 1`);
    const cur = pr[0] ? Number(pr[0].close) : Number(p.entry_price);
    const ur = (cur / Number(p.entry_price) - 1) * 100;
    const held = Math.floor((Date.parse(DATE) - Date.parse(p.opened_date)) / 86400000);
    totCost += Number(p.budget); totMv += cur * Number(p.qty);
    console.log(`  ${p.name}(${p.stock_code}) ${p.qty}주 @${Number(p.entry_price).toLocaleString()}→${cur.toLocaleString()} ${pct(ur)} | ${held}일 | 목표+${p.target_pct}/손절-${p.stop_pct} | ${p.catalyst?.slice(0, 40) || ''}`);
  }
  if (open.length) console.log(`  평가손익(미실현): ${pct((totMv / totCost - 1) * 100)} (원가 ${Math.round(totCost).toLocaleString()} → 평가 ${Math.round(totMv).toLocaleString()})`);

  // 청산 성과
  const closed = await q(`SELECT * FROM ai_shadow_positions WHERE status='closed'`);
  if (closed.length) {
    const wins = closed.filter(c => Number(c.pnl_pct) > 0);
    const avg = closed.reduce((s, c) => s + Number(c.pnl_pct), 0) / closed.length;
    const byReason = {}; closed.forEach(c => { byReason[c.close_reason] = (byReason[c.close_reason] || 0) + 1; });
    console.log(`\n=== 청산 ${closed.length}건 | 승률 ${(wins.length / closed.length * 100).toFixed(0)}% | 평균 ${pct(avg)} | ${JSON.stringify(byReason)} ===`);
    closed.slice(-8).forEach(c => console.log(`  ${c.name}(${c.stock_code}) ${pct(c.pnl_pct)} [${c.close_reason}]`));
  } else {
    console.log(`\n청산 이력 없음 (아직 정산 전)`);
  }
}
main().catch(e => { console.error('리뷰 오류:', e.message); process.exit(1); });
