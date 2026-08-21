#!/usr/bin/env node
/**
 * validate-hypotheses.mjs — 상시 가설 검증기 (2026-07-22, 사용자 요청).
 *   오늘 세션의 모든 백테스트/판정을 매일 실데이터로 live-parity + MC 재검증하고,
 *   판정이 뒤집히면(FLIP) 텔레그램 경보. 결과는 validation_ledger(append-only)에 궤적으로 적재.
 *   ※ 실계좌 파라미터는 절대 자동 변경 안 함 — 경보 → 사람 + 백테스트/MC 재확인 → 사람이 결정.
 *
 *   실행: node validate-hypotheses.mjs [--seeds 6] [--hyp <id>] [--no-ledger] [--no-telegram]
 *   크론: 매일 장마감 후 1회 (VM).
 */
import dotenv from 'dotenv';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { LIVE_PARITY_BASE, HYPOTHESES, DATA_HYPOTHESES, BARBELL } from './validation-registry.mjs';
import { LIVE_EXCLUDE } from './strategy-contract.mjs'; // 봇 미보유(이관/수동)종목 — live_track 승률서 제외(예: 한화솔루션 009830)
// 판정 유틸은 2026-08-21 validation-lib.mjs 로 추출 — autoresearch 러너와 공유한다(이 파일은 IIFE 라 import 불가였다)
import { median, parseComboRow, mcMedian } from './validation-lib.mjs';
// summarizeCurve 는 바벨(full 모드)에서만 필요 → 동적 import (data-only VM 크론은 백테스트 deps 불필요)

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEEDS = Number(argOf('--seeds', '6'));
const ONLY = argOf('--hyp', null);
const NO_LEDGER = argv.includes('--no-ledger');
const NO_TG = argv.includes('--no-telegram');
const DATA_ONLY = argv.includes('--data-only'); // 백테스트/바벨 스킵, 데이터가설(forecast·live_track·flow)만 — VM 일일 크론용(가벼움)
const now = () => new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${now()}] ${m}`);

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
};
// ★ 2026-08-16: fetch → curl 전환. 이 VM에서 Node fetch 는 api.telegram.org 에 도달하지 못한다
//   (ETIMEDOUT — stock-live·watchdog·forecast-run 과 동일 실측). 이 파일은 fetch 인 채로 남아서
//   상시검증 요약이 그동안 조용히 유실되고 있었다.
async function tgNotify(text) {
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C || NO_TG) return;
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { stdout } = await promisify(execFile)('curl', [
      '-4', '-s', '-m', '20', '-X', 'POST', '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ chat_id: C, text }),
      `https://api.telegram.org/bot${T}/sendMessage`,
    ], { timeout: 25_000 });
    if (!/"ok":true/.test(stdout)) log(`텔레그램 전송 실패: ${String(stdout).slice(0, 120)}`);
  } catch (e) { log(`텔레그램 전송 오류: ${String(e.message).slice(0, 80)}`); }
}
function runBacktest(args) {
  const r = spawnSync('node', ['backtest-swing.mjs', ...args], { cwd: __dirname, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout) return null;
  return parseComboRow((r.stdout || '') + (r.stderr || ''));
}

async function evalBacktestHyp(h) {
  const results = {};
  for (const [vName, vArgs] of Object.entries(h.variants)) {
    results[vName] = mcMedian(vArgs, { base: LIVE_PARITY_BASE, seeds: SEEDS, runBacktest });
    log(`  ${h.id}/${vName}: 중앙최종 ${results[vName].medianFinal?.toLocaleString() ?? 'n/a'} (CAGR ${results[vName].medianCagr?.toFixed(1)}%, n=${results[vName].n})`);
  }
  // 모니터 가설(liveparity_gap): 승자 안 뽑고 이상화/live-parity 갭 비율만 INFO 기록(생존편향 크기 추적)
  if (h.monitor) {
    const gap = (results.idealized?.medianFinal && results.liveparity?.medianFinal) ? results.idealized.medianFinal / results.liveparity.medianFinal : null;
    return { winner: gap ? `갭 ${gap.toFixed(1)}x` : 'n/a', status: 'INFO', results };
  }
  // 승자 = 중앙 최종자본 최대
  let winner = null, best = -Infinity;
  for (const [v, r] of Object.entries(results)) if ((r.medianFinal ?? -Infinity) > best) { best = r.medianFinal ?? -Infinity; winner = v; }
  const status = winner === h.myVerdict ? 'HOLD' : 'FLIP';
  return { winner, status, results };
}

// 바벨: 안정 curve + 공격 curve 를 가중 결합(분기 리밸런싱, 현금 flat)
function combineWeighted(core, sat, w, cap) {
  const n = Math.min(core.length, sat.length); if (!n) return [];
  let c = cap * w.core, s = cap * w.sat, cash = cap * w.cash, prevQ = null; const curve = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) { if (core[i - 1].equity > 0) c *= core[i].equity / core[i - 1].equity; if (sat[i - 1].equity > 0) s *= sat[i].equity / sat[i - 1].equity; }
    const day = core[i].day; const q = day.slice(0, 4) + Math.ceil(Number(day.slice(4, 6)) / 3);
    if (prevQ && q !== prevQ) { const t = c + s + cash; c = t * w.core; s = t * w.sat; cash = t * w.cash; }
    prevQ = q; curve.push({ day, equity: c + s + cash });
  }
  return curve;
}
function runDump(args, dumpPath) {
  spawnSync('node', ['backtest-swing.mjs', ...args, '--dump', dumpPath], { cwd: __dirname, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  try { const d = JSON.parse(readFileSync(dumpPath, 'utf8')); try { unlinkSync(dumpPath); } catch { /* */ } return d; } catch { return null; }
}
const curveOf = (dump, strat) => dump?.books?.[strat]?.daily || [];
async function evalBarbell() {
  const { summarizeCurve } = await import('./research-metrics.mjs');
  const cap = 6000000, w = BARBELL.weights;
  const bFinals = [], sFinals = [], bMdds = [];
  for (let s = 1; s <= SEEDS; s++) {
    const sd = runDump([...LIVE_PARITY_BASE, '--seed', String(s), '--subsample', '0.8'], join(__dirname, `._bb_s_${s}.json`));
    const ad = runDump([...BARBELL.aggressiveArgs, '--seed', String(s), '--subsample', '0.8'], join(__dirname, `._bb_a_${s}.json`));
    const sc = curveOf(sd, 'combo-v2'), ac = curveOf(ad, 'hi120');
    if (!sc.length || !ac.length) continue;
    const bSum = summarizeCurve(combineWeighted(sc, ac, w, cap), cap), sSum = summarizeCurve(sc, cap);
    bFinals.push(bSum.finalCapital); bMdds.push(bSum.mdd); sFinals.push(sSum.finalCapital);
    log(`  barbell/seed${s}: 바벨 ${Math.round(bSum.finalCapital).toLocaleString()} vs 안정100 ${Math.round(sSum.finalCapital).toLocaleString()}`);
  }
  const bMed = median(bFinals), sMed = median(sFinals);
  const winner = (bMed ?? 0) > (sMed ?? 0) ? 'barbell' : 'stable100';
  return { winner, status: winner === BARBELL.myVerdict ? 'HOLD' : 'FLIP', detail: { desc: BARBELL.desc, myVerdictNote: BARBELL.myVerdictNote, barbellMedianFinal: bMed, stable100MedianFinal: sMed, barbellMedianMdd: median(bMdds), n: bFinals.length } };
}

async function evalForecastSkill() {
  const r = spawnSync('node', ['forecast-skill.mjs'], { cwd: __dirname, encoding: 'utf8', timeout: 90000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const hold = /HOLD/.test(out);
  const hit = out.match(/방향 적중률\s+([0-9.]+)%/);
  return { winner: hold ? 'HOLD' : 'ACTIVATE', status: 'INFO', detail: { hold, hitRate: hit ? Number(hit[1]) : null } };
}
function evalLiveTrack() {
  const jp = join(__dirname, 'stock-live-journal.json');
  if (!existsSync(jp)) return { winner: 'n/a', status: 'INFO', detail: { note: 'journal 없음' } };
  let j; try { j = JSON.parse(readFileSync(jp, 'utf8')); } catch { return { winner: 'n/a', status: 'INFO', detail: { note: 'journal 파싱 실패' } }; }
  const trades = (j.trades || (Array.isArray(j) ? j : []));
  const allSells = trades.filter(t => t.side === 'SELL' && typeof t.ret === 'number');
  // 봇이 산 게 아닌 이관/수동 종목(LIVE_EXCLUDE, 예: 한화솔루션)은 봇 승률서 제외 — 봇은 손절만 했을 뿐 originate 안 함
  const sells = allSells.filter(t => !LIVE_EXCLUDE.has(t.code));
  const excludedNonBot = allSells.filter(t => LIVE_EXCLUDE.has(t.code)).map(t => `${t.name}(${t.ret}%)`);
  const wins = sells.filter(t => t.ret > 0).length;
  const avgRet = sells.length ? sells.reduce((s, t) => s + t.ret, 0) / sells.length : null;
  return { winner: 'accumulating', status: 'INFO', detail: { totalTrades: trades.length, closedSells: sells.length, winRate: sells.length ? Math.round(wins / sells.length * 100) : null, avgRet: avgRet != null ? Number(avgRet.toFixed(2)) : null, excludedNonBot } };
}
// H4: 수급(외국인/기관 순매수) 예측력. 표본 축적 단계 — ≥60거래일 되면 익일방향 hit rate 계산 활성(그 전엔 축적 상태만).
async function evalFlow() {
  try {
    const r = await dbQuery(`SELECT count(*) n, count(distinct date) d, min(date) a, max(date) b FROM stock_investor_flows`);
    const days = Number(r[0].d), ready = days >= 60;
    return { winner: ready ? 'ready-to-test' : 'accumulating', status: 'INFO', detail: { rows: Number(r[0].n), tradingDays: days, range: `${r[0].a}~${r[0].b}`, note: ready ? '표본 충족 — 익일방향 예측력 계산 활성 예정' : `축적 중(${days}/60거래일)` } };
  } catch (e) { return { winner: 'n/a', status: 'INFO', detail: { note: `flow 조회 실패: ${String(e.message).slice(0, 50)}` } }; }
}

(async () => {
  // 휴장일(주말·공휴일)은 실행 안 함 (2026-08-16 사용자 요청) — 새 데이터가 없어 ledger 중복 적재만 된다
  const { isTradingDayKST } = await import('./market-day.mjs');
  if (!(await isTradingDayKST())) { log('휴장일 — 종료'); process.exit(0); }
  log(`=== 상시 가설 검증 시작 (seeds=${SEEDS}${ONLY ? `, only=${ONLY}` : ''}${DATA_ONLY ? ', DATA-ONLY(백테스트 스킵)' : ''}) ===`);
  if (!NO_LEDGER) {
    try {
      await dbQuery(`CREATE TABLE IF NOT EXISTS validation_ledger (id bigserial PRIMARY KEY, run_ts timestamptz DEFAULT now(), hyp_id text, winner text, my_verdict text, status text, detail jsonb)`);
    } catch (e) { log(`ledger 테이블 준비 실패(계속): ${e.message}`); }
  }
  const flips = [], rows = [];
  const btHyps = ONLY ? HYPOTHESES.filter(h => h.id === ONLY) : HYPOTHESES;
  if (!DATA_ONLY) for (const h of btHyps) {
    try {
      const { winner, status, results } = await evalBacktestHyp(h);
      rows.push({ hyp_id: h.id, winner, my_verdict: h.myVerdict, status, detail: { desc: h.desc, myVerdictNote: h.myVerdictNote, results } });
      log(`[${status}] ${h.id}: 현재승자=${winner} / 내판정=${h.myVerdict} — ${h.desc}`);
      if (status === 'FLIP') flips.push(`⚠️ ${h.id}: 승자 ${winner} ≠ 내판정 ${h.myVerdict} (${h.desc})`);
    } catch (e) { log(`${h.id} 검증 실패: ${e.message}`); }
  }
  // 바벨 가설 (안정75/공격15/현금10 vs 100% 안정)
  if (!DATA_ONLY && (!ONLY || ONLY === 'barbell')) {
    try {
      const bb = await evalBarbell();
      rows.push({ hyp_id: BARBELL.id, winner: bb.winner, my_verdict: BARBELL.myVerdict, status: bb.status, detail: bb.detail });
      log(`[${bb.status}] ${BARBELL.id}: 승자=${bb.winner} (바벨중앙 ${Math.round(bb.detail.barbellMedianFinal ?? 0).toLocaleString()} vs 안정100 ${Math.round(bb.detail.stable100MedianFinal ?? 0).toLocaleString()}, 바벨MDD ${bb.detail.barbellMedianMdd?.toFixed(1)}%)`);
      if (bb.status === 'FLIP') flips.push(`⚠️ ${BARBELL.id}: ${bb.winner} 우위 (${bb.detail.desc})`);
    } catch (e) { log(`barbell 검증 실패: ${e.message}`); }
  }
  // 데이터 가설
  if (!ONLY) {
    try { const f = await evalForecastSkill(); rows.push({ hyp_id: 'forecast_edge', winner: f.winner, my_verdict: 'HOLD', status: f.status, detail: f.detail }); log(`[INFO] forecast_edge: ${f.winner} (적중률 ${f.detail.hitRate ?? '?'}%)`); } catch (e) { log(`forecast_edge 실패: ${e.message}`); }
    try { const t = evalLiveTrack(); rows.push({ hyp_id: 'live_track', winner: t.winner, my_verdict: 'accumulating', status: t.status, detail: t.detail }); log(`[INFO] live_track: 청산 ${t.detail.closedSells ?? 0}건(봇 originate), 승률 ${t.detail.winRate ?? '?'}%, 평균 ${t.detail.avgRet ?? '?'}%${t.detail.excludedNonBot?.length ? ` | 제외(이관): ${t.detail.excludedNonBot.join(',')}` : ''}`); } catch (e) { log(`live_track 실패: ${e.message}`); }
    try { const fl = await evalFlow(); rows.push({ hyp_id: 'flow_edge', winner: fl.winner, my_verdict: 'accumulating', status: fl.status, detail: fl.detail }); log(`[INFO] flow_edge: ${fl.winner} (${fl.detail.tradingDays ?? '?'}거래일 — ${fl.detail.note ?? ''})`); } catch (e) { log(`flow_edge 실패: ${e.message}`); }
  }
  // 적재
  if (!NO_LEDGER && rows.length) {
    try {
      const values = rows.map(r => `('${r.hyp_id}', ${r.winner == null ? 'NULL' : `'${r.winner}'`}, '${r.my_verdict}', '${r.status}', '${JSON.stringify(r.detail).replace(/'/g, "''")}'::jsonb)`).join(',');
      await dbQuery(`INSERT INTO validation_ledger (hyp_id, winner, my_verdict, status, detail) VALUES ${values}`);
      log(`validation_ledger 적재 ${rows.length}행`);
    } catch (e) { log(`ledger 적재 실패: ${e.message}`); }
  }
  // 로컬 스냅샷
  try { writeFileSync(join(__dirname, 'validation-latest.json'), JSON.stringify({ ts: now(), seeds: SEEDS, rows }, null, 1)); } catch { /* */ }
  // 텔레그램은 FLIP(판정 뒤집힘)이 있을 때만 — "전부 유지" 일일 요약은 로그로 충분 (2026-08-16 사용자 "간추려 달라")
  if (flips.length) {
    const summary = `🧪 상시검증 ${now().slice(5, 16)}\n` +
      rows.filter(r => r.status !== 'INFO').map(r => `${r.status === 'FLIP' ? '⚠️' : '✅'} ${r.hyp_id}: ${r.winner}`).join('\n') +
      `\n\n🚨 판정 뒤집힘:\n${flips.join('\n')}\n→ 사람 확인 필요(자동변경 안 함)`;
    await tgNotify(summary);
  } else {
    log('FLIP 없음 — 텔레그램 생략');
  }
  log(`=== 완료: ${rows.length}가설, FLIP ${flips.length}건 ===`);
  process.exit(0);
})();
