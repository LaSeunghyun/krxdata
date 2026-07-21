#!/usr/bin/env node
/**
 * telegram-agent.mjs — krxdata 주식 시스템 텔레그램 어시스턴트 (조회·분석·운영, 2026-07-21).
 *   롱폴 getUpdates → 승인된 chat_id 메시지만 → claude -p(조회/분석/운영, 실주문·코드수정·웹 차단) → 자연어 응답.
 *   전제: .env의 TELEGRAM_BOT_TOKEN/CHAT_ID + CLAUDE_CODE_OAUTH_TOKEN, claude CLI 설치. systemd 상시.
 *   킬스위치: "STOP"→일시정지(.bot-paused), "START"→재개.
 *   안전: (1)chat_id 잠금=본인만 (2)allowedTools 화이트리스트로 Write/Edit/Web 차단 (3)시스템프롬프트로 주문·--go 금지.
 */
import { spawn } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const PAUSE = join(__dirname, '.bot-paused');
if (!TOKEN || !CHAT) { console.error('TELEGRAM_BOT_TOKEN/CHAT_ID 미설정'); process.exit(1); }
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) { console.error('CLAUDE_CODE_OAUTH_TOKEN 미설정'); process.exit(1); }

const api = (m, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ ok: false, e: e.message }));
async function send(text) {
  const t = String(text || '(빈 응답)');
  for (let i = 0; i < t.length; i += 3800) await api('sendMessage', { chat_id: CHAT, text: t.slice(i, i + 3800) });
}

const SYS = `너는 krxdata 주식 자동매매 시스템(~/krxdata, VM)의 텔레그램 어시스턴트다.
매매는 stock-live 시스템이 조건(combo-v2 신호·트레일 고점-8%·하드손절 진입-7%)에 따라 08:00~20:00 자동 집행한다. 너는 그걸 조회·분석·운영하는 조수다.
적극 답할 것(★분석·예측 포함★):
 - 계좌·포지션·손익(node status.mjs 또는 toss-api), 예측(forecast_ledger)·수급(stock_investor_flows) 조회
 - "내일 뭐 팔아?/살아?" 같은 질문은 반드시 '분석'으로 답한다: 각 보유 종목의 현재가·손절선·여유%를 근거로 어느 게 청산 임박인지, 조건상 무엇을 사고팔 가능성이 있는지 설명. 절대 거부하지 마라.
 - 종목/전략 분석, node stock-live.mjs --plan(미리보기), 운영(systemctl status/restart, journalctl)
거부는 오직 이 경우만: "지금 삼성 사줘/두산 팔아줘"처럼 실제 수동 주문을 즉시 집행하라는 지시. 이때만 "봇은 직접 주문 안 한다. 시스템이 조건 충족 시 자동 집행한다"고 설명(그리고 조건상 그 종목이 어떤지는 분석해줘도 됨). createOrder·--go 실행은 도구상으로도 불가하니 걱정 말고 분석엔 적극적으로.
한국어로 간결히, 숫자는 근거와 함께.`;

// 화이트리스트 명령만 허용 (임의 셸/주문 불가). bypassPermissions 미사용 → 비허용 도구는 헤드리스에서 자동 거부.
const ALLOWED = [
  'Read', 'Glob', 'Grep',
  'Bash(node status.mjs:*)',                 // 읽기전용 계좌·포지션·예측 요약
  'Bash(node stock-live.mjs --plan:*)',      // 매수 미리보기(주문 없음)
  'Bash(node forecast-skill.mjs:*)',         // 예측 skill 게이트
  'Bash(sudo systemctl status stock-live:*)',
  'Bash(sudo systemctl restart stock-live:*)',
  'Bash(sudo journalctl -u stock-live:*)',
].join(',');
function ask(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--append-system-prompt', SYS,
      '--allowedTools', ALLOWED, '--disallowedTools', 'Write,Edit,WebFetch,WebSearch'];
    // stdin 무시: 안 닫으면 claude가 파이프 stdin 입력을 기다리며 멈춰 응답이 안 나감(프롬프트는 -p 인자로 전달)
    const cp = spawn('claude', args, { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { cp.kill(); resolve('⏱️ 응답 시간초과(180s)'); }, 180000);
    cp.on('close', (code) => { clearTimeout(timer); resolve(out.trim() || `(claude 종료 ${code}) ${err.slice(0, 300)}`); });
    cp.on('error', e => { clearTimeout(timer); resolve('claude 실행 실패(설치/토큰 확인): ' + e.message); });
  });
}

let offset = 0;
console.log('[telegram-agent] 시작 — chat_id 잠금:', CHAT);
while (true) {
  try {
    const r = await api('getUpdates', { offset, timeout: 30 });
    for (const u of (r.result || [])) {
      offset = u.update_id + 1;
      const msg = u.message; if (!msg?.text) continue;
      if (String(msg.chat.id) !== CHAT) { console.log('무시(미승인 chat):', msg.chat.id); continue; }
      const text = msg.text.trim();
      if (text === 'STOP') { writeFileSync(PAUSE, '1'); await send('⏸️ 봇 일시정지. 재개: START'); continue; }
      if (text === 'START') { if (existsSync(PAUSE)) unlinkSync(PAUSE); await send('▶️ 봇 재개'); continue; }
      if (existsSync(PAUSE)) continue;
      await api('sendChatAction', { chat_id: CHAT, action: 'typing' });
      const reply = await ask(text);
      await send(reply);
    }
  } catch (e) { console.error('poll 오류:', e.message); await new Promise(r => setTimeout(r, 5000)); }
}
