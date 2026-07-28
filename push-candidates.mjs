#!/usr/bin/env node
/**
 * push-candidates.mjs — 아침 촉매 후보를 텔레그램으로 푸시 (VM cron용, PC 꺼도 폰으로 받기).
 *   1) ai-shadow 스캔 실행(촉매 판단 → ai_shadow_decisions 원장, claude 사용 = 크레딧)
 *   2) 오늘 BUY 조회 → 추천금액/주수/리스크 + 텔레그램 매수명령 포함 포맷 → 전송.
 *   실행: node push-candidates.mjs         (스캔+전송)
 *         node push-candidates.mjs --dry   (스캔·전송 없이 오늘 원장만 읽어 콘솔 출력 = 검증)
 *         node push-candidates.mjs --max N (스캔 판단수 상한, 기본 12 = 일 크레딧 통제)
 *   env: TELEGRAM_BOT_TOKEN/CHAT_ID, SUPABASE_PROJECT_REF/MANAGEMENT_KEY, (스캔=claude CLI).
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const DRY = process.argv.includes('--dry');
const MAX = (() => { const i = process.argv.indexOf('--max'); return i >= 0 ? process.argv[i + 1] : '12'; })();
// 추천 매수금액 = AI 확신도 차등(확신 높을수록 크게). REC_AMOUNT env 설정 시 고정 우선.
//   ※ 정직: 검증된 최적 사이징 아님(TT100 연구서 Kelly도 확실한 개선 없었음). 확신 가중 휴리스틱.
const amtFor = (conv) => { const c = Number(conv) || 3; return c >= 5 ? 3_000_000 : c >= 4 ? 2_500_000 : c >= 3 ? 2_000_000 : 1_500_000; };
const recFor = (conv) => (process.env.REC_AMOUNT ? Number(process.env.REC_AMOUNT) : amtFor(conv));
const kstDate = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const j = await r.json(); return Array.isArray(j) ? j : [];
};
const tgSend = async (text) => {
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) { console.log('[텔레그램 미설정 — 콘솔 출력]\n' + text); return; }
  for (let i = 0; i < text.length; i += 3800) {
    const chunk = text.slice(i, i + 3800);
    try {
      const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: C, text: chunk }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) console.error(`[텔레그램 전송 실패] status=${r.status} ${JSON.stringify(j)?.slice(0, 200)}`); // 2026-07-24: 응답 미확인이 원인이던 무음 실패 방지
    } catch (e) { console.error(`[텔레그램 전송 예외] ${e.message}`); }
  }
};
const arr = (x) => Array.isArray(x) ? x : (typeof x === 'string' ? (() => { try { return JSON.parse(x); } catch { return []; } })() : []);
const man = (n) => (n / 10000).toFixed(0);

async function main() {
  if (!DRY) {
    const r = spawnSync('node', [join(__dirname, 'ai-shadow.mjs'), '--days', '2', '--max', String(MAX)], { cwd: __dirname, encoding: 'utf8', timeout: 30 * 60 * 1000 });
    if (r.status !== 0) console.error('스캔 경고:', (r.stderr || '').slice(0, 200));
  }
  const buys = await q(`SELECT stock_code,name,price,catalyst,thesis,strategy,opposing,conviction FROM ai_shadow_decisions
    WHERE decided_date='${kstDate()}' AND decision='buy' ORDER BY conviction DESC`);
  if (!buys.length) {
    const m = `📊 오늘(${kstDate()}) 촉매 매수 후보 없음 — 대기.`;
    if (DRY) console.log(m); else await tgSend(m);
    return;
  }
  let msg = `📈 오늘(${kstDate()}) 촉매 매수 후보 ${buys.length}개\n(AI shadow · 미검증 · 최종 판단은 본인)\n`;
  for (const b of buys) {
    const px = Number(b.price) || 0;
    const rec = recFor(b.conviction);
    const shares = px > 0 ? Math.floor(rec / px) : 0;
    const s = typeof b.strategy === 'string' ? (() => { try { return JSON.parse(b.strategy); } catch { return null; } })() : b.strategy;
    msg += `\n📌 ${b.name} (확신 ${b.conviction})\n`;
    msg += `  촉매: ${String(b.catalyst || '').slice(0, 90)}\n`;
    msg += `  근거: ${(arr(b.thesis)[0] || '').slice(0, 90)}\n`;
    msg += `  리스크: ${(arr(b.opposing)[0] || '').slice(0, 90)}\n`;
    if (s) msg += `  추천: ${man(rec)}만원(≈${shares}주) · 목표+${s.target_pct}%/손절-${s.stop_pct}%\n`;
    msg += `  → 매수 ${b.name} ${man(rec)}만원\n`;
  }
  msg += `\n※ 현금 확인 후 2~3개 선택. DRY로 먼저 확인 → 주문ON → 실매수.`;
  if (DRY) console.log(msg); else await tgSend(msg);
}
main().catch(e => { console.error('push 오류:', e.message); process.exit(1); });
