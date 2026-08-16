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
import { spawnSync, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });
const { isTradingDayKST } = await import('./market-day.mjs'); // dotenv 이후 로드 (toss-api가 env를 읽는다)
const execFileP = promisify(execFile);

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
// ★ 2026-08-16: fetch → curl 전환. 이 VM에서 Node fetch 는 api.telegram.org 에 도달하지 못한다
//   (ETIMEDOUT — stock-live·watchdog·forecast-run 이 이미 같은 이유로 curl 로 옮겼는데 이 파일만
//   남아서 아침 후보 푸시가 통째로 유실되고 있었다. push-candidates.log 'fetch failed' 연속 실측).
const tgSend = async (text) => {
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) { console.log('[텔레그램 미설정 — 콘솔 출력]\n' + text); return; }
  for (let i = 0; i < text.length; i += 3800) {
    const chunk = text.slice(i, i + 3800);
    try {
      const { stdout } = await execFileP('curl', [
        '-4', '-s', '-m', '20', '-X', 'POST', '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ chat_id: C, text: chunk }),
        `https://api.telegram.org/bot${T}/sendMessage`,
      ], { timeout: 25_000 });
      const j = JSON.parse(stdout);
      if (!j.ok) console.error(`[텔레그램 전송 실패] ${String(stdout).slice(0, 200)}`);
    } catch (e) { console.error(`[텔레그램 전송 예외] ${e.message}`); }
  }
};
const arr = (x) => Array.isArray(x) ? x : (typeof x === 'string' ? (() => { try { return JSON.parse(x); } catch { return []; } })() : []);
const man = (n) => (n / 10000).toFixed(0);

async function main() {
  // 휴장일(주말·공휴일)은 스캔·발송 모두 안 함 (2026-08-16 사용자 요청 — claude 크레딧도 아낀다)
  if (!(await isTradingDayKST())) { console.log('휴장일 — 종료'); return; }
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
  // ★ 2026-08-16 (사용자 "간추려 달라"): 상위 5개만, 종목당 3줄(촉매·추천·명령).
  //   근거·리스크 전문은 ai_shadow_decisions 원장에 있다 — 텔레그램 봇에 종목명으로 물으면 읽어준다.
  const top = buys.slice(0, 5);
  let msg = `📈 오늘 촉매 후보 ${buys.length}개${buys.length > top.length ? ` 중 상위 ${top.length}` : ''} (AI · 미검증 · 판단은 본인)\n`;
  for (const b of top) {
    const px = Number(b.price) || 0;
    const rec = recFor(b.conviction);
    const shares = px > 0 ? Math.floor(rec / px) : 0;
    const s = typeof b.strategy === 'string' ? (() => { try { return JSON.parse(b.strategy); } catch { return null; } })() : b.strategy;
    msg += `\n📌 ${b.name} (확신 ${b.conviction}${s ? ` · 목표+${s.target_pct}/손절-${s.stop_pct}` : ''})\n`;
    msg += `  ${String(b.catalyst || arr(b.thesis)[0] || '').slice(0, 70)}\n`;
    msg += `  → 매수 ${b.name} ${man(rec)}만원${shares ? ` (≈${shares}주)` : ''}\n`;
  }
  if (DRY) console.log(msg); else await tgSend(msg);
}
main().catch(e => { console.error('push 오류:', e.message); process.exit(1); });
