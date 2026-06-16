#!/usr/bin/env node
/**
 * telegram-gateway.mjs — KRX 라이브 트레이딩 조회·제어 게이트웨이 (경량, Claude API 불필요)
 *   폰 텔레그램 → long-polling 수신 → 명령 처리 → 응답
 *   명령: /status(보유·손익·큐·halt·레짐) /halt(긴급중단) /resume(재개) /help
 *   보안: 본인 TELEGRAM_CHAT_ID만 허용(화이트리스트). 매매는 PC에서만(여긴 조회+제어).
 *   배포: Oracle VM systemd 상시. 봇 토큰은 paper-swing과 공유(발송 vs 수신 분리).
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccounts, getHoldings, getBuyingPower, getDailyCandles } from './toss-api.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = String(process.env.TELEGRAM_CHAT_ID ?? '');
if (!TOKEN || !ALLOWED) { console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정'); process.exit(1); }

const api = (m, p) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
}).then(r => r.json());
const send = (chatId, text) => api('sendMessage', { chat_id: chatId, text });

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const stateKey = async (k) => { const rows = await dbQuery(`SELECT data FROM paper_state WHERE k='${k}'`); return rows.length ? rows[0].data : null; };

async function cmdStatus() {
  const accts = await getAccounts(); const seq = accts[0]?.accountSeq;
  const h = await getHoldings(seq); const bp = await getBuyingPower(seq, { currency: 'KRW' });
  const cash = Number(bp?.cashBuyingPower ?? 0);
  // 레짐 (005930)
  let regime = '?';
  try {
    const c = (await getDailyCandles('005930', 70)).reverse(); const cl = c.map(b => b.close); const i = cl.length - 1;
    const avg = (n) => cl.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
    regime = cl[i] > avg(20) && avg(20) > avg(60) ? 'UP' : (cl[i] < avg(20) && (cl[i] / cl[i - 5] - 1) * 100 < -3 ? 'DOWN' : 'NEUTRAL');
  } catch {}
  let s = `📊 현황 (레짐 ${regime})\n`;
  let totPnl = 0;
  for (const it of (h?.items ?? [])) {
    const avg = Number(it.averagePurchasePrice), last = Number(it.lastPrice), qty = Number(it.quantity);
    const pnl = (last - avg) * qty, pct = (last / avg - 1) * 100; totPnl += pnl;
    s += `· ${it.name} ${qty}주 평단 ${avg.toLocaleString()} → ${last.toLocaleString()} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)\n`;
  }
  if (!(h?.items?.length)) s += '· (보유 없음)\n';
  s += `평가손익 ${totPnl >= 0 ? '+' : ''}${Math.round(totPnl).toLocaleString()} / 현금 ${cash.toLocaleString()}\n`;
  const q = await stateKey('live_queue'); const halt = await stateKey('live_halt');
  const qn = Array.isArray(q) ? q.length : 0;
  s += `큐 ${qn}건`;
  if (qn) s += ` (${q.map(o => `${o.side === 'SELL' ? '매도' : '매수'} ${o.name}`).join(', ')})`;
  s += `\nhalt: ${halt ? '⛔ ' + (halt.reason ?? '걸림') : '✅ 정상'}`;
  return s;
}
async function cmdHalt() {
  await dbQuery(`INSERT INTO paper_state (k,data,updated_at) VALUES ('live_halt', $j$${JSON.stringify({ reason: '텔레그램 수동 중단', at: new Date().toISOString() })}$j$::jsonb, NOW()) ON CONFLICT (k) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`);
  return '⛔ 매매 중단(halt) 설정됨. 다음 집행부터 매수/매도 보류. 재개는 /resume';
}
async function cmdResume() {
  await dbQuery(`DELETE FROM paper_state WHERE k='live_halt'`);
  return '✅ halt 해제됨. 다음 집행부터 정상 매매.';
}

let offset = 0;
console.log(`[gateway] 시작 — 허용 chat_id ${ALLOWED}`);
// 시작 시 기존 미처리 업데이트 드레인 (재시작 전 쌓인 과거 메시지에 응답 폭탄 방지)
try { const init = await api('getUpdates', { offset: -1 }); if (init.result?.length) offset = init.result[init.result.length - 1].update_id + 1; } catch {}
while (true) {
  try {
    const r = await api('getUpdates', { offset, timeout: 30 });
    for (const u of (r.result ?? [])) {
      offset = u.update_id + 1;
      const msg = u.message; if (!msg?.text) continue;
      const chatId = String(msg.chat.id);
      if (chatId !== ALLOWED) { await send(chatId, '⛔ 권한 없음'); console.log(`[gateway] 미허용 chat_id ${chatId} 차단`); continue; }
      const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase();
      try {
        if (cmd === '/status') await send(chatId, await cmdStatus());
        else if (cmd === '/halt') await send(chatId, await cmdHalt());
        else if (cmd === '/resume') await send(chatId, await cmdResume());
        else if (cmd === '/help') await send(chatId, '명령: /status(현황) /halt(긴급중단) /resume(재개)\n※ 매매는 PC에서만');
        else await send(chatId, '명령: /status /halt /resume /help');
      } catch (e) { await send(chatId, `오류: ${e.message}`); }
    }
  } catch (e) { console.error('[gateway] 루프 오류:', e.message); await new Promise(r => setTimeout(r, 5000)); }
}
