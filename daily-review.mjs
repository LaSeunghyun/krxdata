#!/usr/bin/env node
/**
 * daily-review.mjs — 데일리 매매 복기 + 추천 추적 텔레그램 보고 (2026-08-16, 사용자 목표 3·5)
 *
 * 목표 3: "나의 데일리 거래 내역·패턴을 분석해 승/패의 원인을 공유" — 저널(전 체결·청산사유)이
 *         원천. 요인은 저널의 실제 reason 에서만 뽑는다(추측 서사 금지).
 * 목표 5: "추천 종목이 추천 이후 어떻게 움직였는지" — ai_shadow_positions 가 추천마다
 *         가상 포지션으로 이미 추적 중. 여기서 사용자에게 표면화한다.
 * 목표 2(부분): 아침 브리핑의 보유종목 갭 콜(morning_calls)을 당일 시가로 기계 채점.
 *         사전 폐기 기준: 표본 60건 이상에서 방향적중(보합 제외) 55% 이하면 갭 콜 기능 제거.
 *
 * 실행: node daily-review.mjs [--dry] [--force]   크론(UTC): 50 7 * * 1-5 (= KST 16:50 평일)
 * 데이터: stock-live-journal.json(VM 로컬) · account_snapshots · ai_shadow_* · morning_calls · Toss 시세
 * 메시지는 짧게 — 상세는 저널·DB 에 있다 (2026-08-16 "간추려" 원칙).
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const { getDailyCandles, getPricesMap } = await import('./toss-api.js');
const { isTradingDayKST } = await import('./market-day.mjs');
const execFileP = promisify(execFile);

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const kst = () => new Date(Date.now() + 9 * 3600000);
const today = () => kst().toISOString().slice(0, 10);
const log = (m) => console.log(`[review ${kst().toISOString().slice(11, 19)}] ${m}`);
const sgn = (x, d = 1) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`;
const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`db: ${JSON.stringify(j).slice(0, 150)}`);
  return j;
};
async function tgSend(text) { // curl — 이 VM 에서 Node fetch 는 텔레그램 불통 (기존 실측)
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C || DRY) { console.log('--- 메시지 ---\n' + text); return; }
  for (let i = 0; i < text.length; i += 3800) {
    const { stdout } = await execFileP('curl', [
      '-4', '-s', '-m', '20', '-X', 'POST', '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ chat_id: C, text: text.slice(i, i + 3800) }),
      `https://api.telegram.org/bot${T}/sendMessage`,
    ], { timeout: 25_000 });
    if (!/"ok":true/.test(stdout)) log(`텔레그램 전송 실패: ${String(stdout).slice(0, 120)}`);
  }
}
// 청산 사유를 짧은 라벨로 (저널 reason 원문에서 — 새 사유가 나오면 원문 앞 12자)
function reasonLabel(r) {
  const s = String(r ?? '');
  if (/하드손절|손절/.test(s) && !/유예/.test(s)) return '손절';
  if (/트레일/.test(s)) return '트레일';
  if (/부분익절|익절/.test(s)) return '익절';
  if (/MA3/.test(s)) return 'MA3익절';
  if (/만기/.test(s)) return '만기';
  if (/수급/.test(s)) return '수급청산';
  if (/교체/.test(s)) return 'AI교체';
  if (/AI/.test(s)) return 'AI청산';
  // ai_shadow_positions.close_reason 영문 라벨
  if (s === 'stop') return '손절';
  if (s === 'target') return '목표달성';
  if (/horizon/.test(s)) return '만기';
  if (/thesis/.test(s)) return '논지붕괴';
  return s.slice(0, 12) || '기타';
}

async function main() {
  if (!FORCE && !(await isTradingDayKST())) { log('휴장일 — 종료'); return; }
  const d = today();
  const L = [];

  // ── 1) 계좌: 오늘 변화 (스냅샷 기준) + 시장 대비 ──────────────────────
  let equityLine = null;
  try {
    const snaps = await q(`SELECT ts, equity FROM account_snapshots WHERE ts::date = '${d}' ORDER BY ts`);
    const prev = await q(`SELECT equity FROM account_snapshots WHERE ts::date < '${d}' ORDER BY ts DESC LIMIT 1`);
    if (snaps.length) {
      const nowEq = Number(snaps[snaps.length - 1].equity);
      const base = prev.length ? Number(prev[0].equity) : Number(snaps[0].equity);
      const chg = base > 0 ? (nowEq / base - 1) * 100 : 0;
      let mkt = '';
      try {
        const c = (await getDailyCandles('069500', 3)).reverse(); // ⚠️ newest-first → reverse (레짐 버그 교훈)
        const last = c[c.length - 1], prevC = c[c.length - 2];
        if (String(last.timestamp).slice(0, 10) === d && prevC) {
          const mret = (last.close / prevC.close - 1) * 100;
          mkt = ` · 코스피 ${sgn(mret)}% 대비 ${sgn(chg - mret)}%p`;
        }
      } catch { /* 시장 비교는 부가 정보 */ }
      equityLine = `계좌 ${Math.round(nowEq / 10000).toLocaleString()}만원 (오늘 ${sgn(chg)}%${mkt})`;
    }
  } catch (e) { log(`계좌 조회 실패(비치명): ${e.message}`); }

  // ── 2) 오늘 매매 + 승/패 요인 (저널 원문 reason 기반) ──────────────────
  const jr = (() => {
    try { return JSON.parse(readFileSync(join(__dirname, 'stock-live-journal.json'), 'utf8')).trades ?? []; }
    catch { return []; }
  })();
  const tToday = jr.filter(t => String(t.ts).slice(0, 10) === d);
  const sells = tToday.filter(t => t.side === 'SELL' && t.ret != null);
  const buys = tToday.filter(t => t.side === 'BUY');
  if (tToday.length) {
    L.push(`매매 ${tToday.length}건 (매수 ${buys.length} · 매도 ${sells.length})`);
    for (const s of sells) L.push(`  ${Number(s.ret) >= 0 ? '🟢' : '🔴'} ${s.name} ${sgn(Number(s.ret))}% — ${reasonLabel(s.reason)}`);
    for (const b of buys) L.push(`  🔵 매수 ${b.name} ${b.qty}주 (${b.sub ?? '수동'})`);
    const w = sells.filter(s => Number(s.ret) > 0), l = sells.filter(s => Number(s.ret) <= 0);
    if (sells.length >= 2) {
      const sum = (a) => a.reduce((x, y) => x + Number(y.ret), 0);
      L.push(`승 ${w.length}(${sgn(sum(w))}%p) / 패 ${l.length}(${sgn(sum(l))}%p) — 패 요인: ${[...new Set(l.map(s => reasonLabel(s.reason)))].join(',') || '없음'}`);
    }
  } else {
    L.push('오늘 매매 없음');
  }

  // ── 3) 금요일: 주간 패턴 (최근 5거래일 매도 기준 — 전략·사유별 집계) ──
  if (kst().getUTCDay() === 5) {
    const wk = jr.filter(t => t.side === 'SELL' && t.ret != null
      && (Date.now() - new Date(t.ts.replace(' ', 'T') + '+09:00').getTime()) < 7 * 86400e3);
    if (wk.length) {
      const by = (keyFn) => {
        const g = {};
        for (const t of wk) { const k = keyFn(t); (g[k] ??= []).push(Number(t.ret)); }
        return Object.entries(g).map(([k, v]) =>
          `${k} ${v.filter(x => x > 0).length}/${v.length}승 평균 ${sgn(v.reduce((a, b) => a + b, 0) / v.length)}%`).join(' · ');
      };
      L.push('');
      L.push(`📅 주간 패턴 (매도 ${wk.length}건)`);
      L.push(`  전략별: ${by(t => t.sub ?? jr.find(b => b.side === 'BUY' && b.code === t.code && b.ts < t.ts)?.sub ?? '미상')}`);
      L.push(`  사유별: ${by(t => reasonLabel(t.reason))}`);
    }
  }

  // ── 4) 추천 추적 (목표 5 — ai_shadow 가상 포지션) ─────────────────────
  try {
    const open = await q(`SELECT stock_code, name, entry_price, opened_date FROM ai_shadow_positions WHERE status = 'open' ORDER BY opened_date`);
    const closed = await q(`SELECT name, pnl_pct, close_reason FROM ai_shadow_positions
      WHERE status <> 'open' AND closed_at >= now() - interval '7 days' ORDER BY closed_at DESC LIMIT 5`);
    if (open.length || closed.length) {
      L.push('');
      L.push('📌 추천 추적 (AI 가상매매 · 실주문 아님)');
      if (open.length) {
        const px = await getPricesMap(open.map(o => o.stock_code));
        const rows = open.map(o => {
          const cur = px.get(o.stock_code)?.price;
          return { ...o, ret: cur ? (cur / Number(o.entry_price) - 1) * 100 : null };
        }).filter(r => r.ret != null).sort((a, b) => b.ret - a.ret);
        if (rows.length) {
          const avg = rows.reduce((a, b) => a + b.ret, 0) / rows.length;
          L.push(`  보유 ${rows.length}종목 평균 ${sgn(avg)}% · 최고 ${rows[0].name} ${sgn(rows[0].ret)}% · 최저 ${rows[rows.length - 1].name} ${sgn(rows[rows.length - 1].ret)}%`);
        }
      }
      for (const c of closed) L.push(`  종결 ${c.name} ${sgn(Number(c.pnl_pct))}% (${reasonLabel(c.close_reason)})`);
    }
  } catch (e) { log(`추천 추적 조회 실패(비치명): ${e.message}`); }

  // ── 5) 아침 갭 콜 채점 (목표 2 — morning_calls, 오늘 시가로 기계 채점) ──
  try {
    const calls = await q(`SELECT code, name, gap_bias FROM morning_calls WHERE d = '${d}' AND hit IS NULL`);
    if (calls.length) {
      const scored = [];
      for (const c of calls) {
        try {
          const cd = (await getDailyCandles(c.code, 3)).reverse();
          const last = cd[cd.length - 1], prev = cd[cd.length - 2];
          if (String(last.timestamp).slice(0, 10) !== d || !prev) continue; // 오늘 봉 없으면 채점 보류
          const gap = (last.open / prev.close - 1) * 100;
          const hit = Math.abs(gap) <= 0.3 ? c.gap_bias === 'flat'
            : (gap > 0 ? c.gap_bias === 'up' : c.gap_bias === 'down');
          if (!DRY) await q(`UPDATE morning_calls SET actual_gap_pct = ${gap.toFixed(2)}, hit = ${hit}, scored_at = now()
            WHERE d = '${d}' AND code = '${c.code}'`);
          scored.push(`${c.name} ${c.gap_bias === 'up' ? '↑' : c.gap_bias === 'down' ? '↓' : '→'}예상 → 실제 ${sgn(gap)}% ${hit ? '✅' : '❌'}`);
        } catch { /* 종목별 실패는 건너뜀 */ }
      }
      if (scored.length) {
        const cum = await q(`SELECT count(*) n, sum(CASE WHEN hit THEN 1 ELSE 0 END) h FROM morning_calls WHERE hit IS NOT NULL AND gap_bias <> 'flat'`);
        const n = Number(cum[0]?.n ?? 0), hh = Number(cum[0]?.h ?? 0);
        L.push('');
        L.push(`🌅 아침 갭 콜 채점: ${scored.join(' · ')}`);
        if (n >= 10) L.push(`  누적(보합 제외) ${hh}/${n} = ${(hh / n * 100).toFixed(0)}% (60건 도달 시 55% 이하면 폐기)`);
      }
    }
  } catch { /* morning_calls 미생성 단계에선 조용히 스킵 */ }

  const head = `📒 오늘 복기 ${d.slice(5)}` + (equityLine ? `\n${equityLine}` : '');
  const msg = [head, ...L].join('\n');
  console.log(msg);
  await tgSend(msg);
  log('완료');
}
main().catch((e) => { log(`오류: ${e.message}`); process.exit(1); });
