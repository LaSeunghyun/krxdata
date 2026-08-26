#!/usr/bin/env node
/**
 * telegram-agent.mjs — krxdata 주식 시스템 텔레그램 어시스턴트 (조회·분석·운영, 2026-07-21).
 *   롱폴 getUpdates → 승인된 chat_id 메시지만 → claude -p(조회/분석/운영, 실주문·코드수정·웹 차단) → 자연어 응답.
 *   전제: .env의 TELEGRAM_BOT_TOKEN/CHAT_ID + CLAUDE_CODE_OAUTH_TOKEN, claude CLI 설치. systemd 상시.
 *   킬스위치: "STOP"→일시정지(.bot-paused), "START"→재개.
 *   안전: (1)chat_id 잠금=본인만 (2)allowedTools 화이트리스트로 Write/Edit/Web 차단 (3)시스템프롬프트로 주문·--go 금지.
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { getAccounts, getHoldings } from './toss-api.js';
import { parseCommand, executeBuy, executeSell, resolveStock } from './tg-order.mjs';
import { readBotExclude, removeBotExclude } from './bot-exclude.mjs';
import { appendRequest } from './tg-requests.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const PAUSE = join(__dirname, '.bot-paused');
if (!TOKEN || !CHAT) { console.error('TELEGRAM_BOT_TOKEN/CHAT_ID 미설정'); process.exit(1); }
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) { console.error('CLAUDE_CODE_OAUTH_TOKEN 미설정'); process.exit(1); }

/**
 * ★ 2026-07-31: fetch → curl 로 교체.
 *
 * 이 VM 에서 **Node fetch 는 api.telegram.org 에 도달하지 못한다**(실측):
 *   node fetch → 149.154.166.110:443 ETIMEDOUT (3/3 실패) · IPv6 는 ENETUNREACH(글로벌 v6 경로 없음)
 *   curl       → **같은 IP** 에 HTTP 302 · connect 0.27s 성공
 *   `--dns-result-order=ipv4first` 로도 fetch 는 실패 → DNS 순서 문제가 아니다.
 *   A 레코드가 149.154.166.110 하나뿐이라 "나쁜 IP 를 잡았다"도 아니다.
 * 결과: telegram-agent 가 systemd 상 active 인데도 **메시지를 받은 적도 보낸 적도 없었다**
 *   (2시간 journalctl 0줄 — getUpdates 가 매번 타임아웃하고 조용히 재시도했다).
 * watchdog(2026-07-31 commit b5c2454)과 동일한 수정이다.
 *
 * getUpdates 는 long-poll(timeout 30)이므로 curl -m 은 45, 프로세스 타임아웃은 50s 로 둔다.
 * ★ 실패를 삼키지 않는다 — watchdog 의 `catch {}` 가 96분 무경보의 원인이었다. 여기선 로그를 남긴다.
 */
const execFileP = promisify(execFile);
let apiFailStreak = 0;
const api = async (m, body) => {
  try {
    const { stdout } = await execFileP('curl', [
      '-4', '-s', '-m', '45', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify(body),
      `https://api.telegram.org/bot${TOKEN}/${m}`,
    ], { maxBuffer: 8 * 1024 * 1024, timeout: 50_000 });
    const j = JSON.parse(stdout);
    if (j.ok) { if (apiFailStreak >= 3) console.log(`[tg] 복구 — ${m} 정상 (연속실패 ${apiFailStreak}건 후)`); apiFailStreak = 0; }
    else { apiFailStreak++; if (apiFailStreak <= 3 || apiFailStreak % 20 === 0) console.error(`[tg] ${m} 실패(${apiFailStreak}연속): ${stdout.slice(0, 160)}`); }
    return j;
  } catch (e) {
    apiFailStreak++;
    if (apiFailStreak <= 3 || apiFailStreak % 20 === 0) console.error(`[tg] ${m} 오류(${apiFailStreak}연속): ${String(e.message).slice(0, 160)}`);
    return { ok: false, e: String(e.message).slice(0, 160) };
  }
};
async function send(text) {
  const t = String(text || '(빈 응답)');
  for (let i = 0; i < t.length; i += 3800) await api('sendMessage', { chat_id: CHAT, text: t.slice(i, i + 3800) });
}

// ── 결정론적 주문 경로 (LLM 안 거침) ─────────────────────────
const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const j = await r.json(); return Array.isArray(j) ? j : [];
};
let SEQ = null;
const getSeq = async () => { if (SEQ == null) SEQ = (await getAccounts())[0].accountSeq; return SEQ; };
const ORDERS_FLAG = join(__dirname, '.orders-enabled');  // 존재 시 실주문, 없으면 DRY(모의). 기본 없음=안전.
const ordersOn = () => existsSync(ORDERS_FLAG);
const marketOpen = () => { const h = new Date(Date.now() + 9 * 3600000).getUTCHours(); return h >= 8 && h < 20; };

// ── 매도 사인 모니터 (수동픽 보유분이 AI 목표/손절 도달 시 알림, 자동매도 X) ──
const MONITOR_MS = 20 * 60 * 1000;
let lastMonitor = 0;
const sentSignals = new Set(); // `${code}:${type}:${date}` 하루 1회 dedup
async function monitorSells() {
  try {
    const seq = await getSeq();
    const excl = readBotExclude(); // 수동픽만 감시(자동봇 픽은 봇이 관리)
    const h = await getHoldings(seq);
    const items = (h?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0 && excl.has(i.symbol));
    if (!items.length) return;
    const codes = items.map(i => `'${i.symbol}'`).join(',');
    const strat = await dbQuery(`SELECT DISTINCT ON (stock_code) stock_code, name, strategy FROM ai_shadow_decisions
      WHERE stock_code IN (${codes}) AND decision='buy' ORDER BY stock_code, run_at DESC`);
    const sMap = new Map(strat.map(r => [r.stock_code, { name: r.name, s: typeof r.strategy === 'string' ? (() => { try { return JSON.parse(r.strategy); } catch { return null; } })() : r.strategy }]));
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    for (const it of items) {
      const entry = Number(it.averagePurchasePrice), cur = Number(it.lastPrice);
      if (!entry || !cur) continue;
      const ret = (cur / entry - 1) * 100;
      const info = sMap.get(it.symbol); const st = info?.s;
      const nm = info?.name || it.name || it.symbol;
      const tgt = Number(st?.target_pct ?? 7), stp = Number(st?.stop_pct ?? 5);
      let type = null, label = null;
      if (ret >= tgt) { type = 'target'; label = `🎯 목표 +${tgt}% 도달`; }
      else if (ret <= -stp) { type = 'stop'; label = `🛑 손절선 -${stp}% 도달`; }
      if (!type) continue;
      const key = `${it.symbol}:${type}:${today}`;
      if (sentSignals.has(key)) continue;
      sentSignals.add(key);
      await send(`🔔 매도 사인: ${nm}(${it.symbol}) 현재 ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}% (${label})\n진입 ${entry.toLocaleString()} → 현재 ${cur.toLocaleString()}\n팔려면: 매도 ${nm}`);
    }
  } catch (e) { console.error('모니터 오류:', String(e.message).slice(0, 120)); } // 모니터 실패가 봇 멈추면 안 됨
}

const SYS = `너는 krxdata 주식 자동매매 시스템(~/krxdata, VM)의 텔레그램 어시스턴트다.
매매는 stock-live 시스템이 평일 08:00~20:00 자동 집행한다: combo-v2 신호(rsi2 과매도·hi120 돌파) → AI 종합판단(claude가 매수승인·청산권고·손절 1세션유예를 판단, 원장 ai-trader-decisions.jsonl) → 집행. 청산은 15:35 종가판정 → 익일 개장 집행(rsi2: 손절-15%/MA3익절/5일만기 · hi120: 부분익절+6/12%·트레일-6%·갭정책 오버라이드). 시장예측은 매일 07:00(NXT 08:00 개장 전) forecast-run pre 페이즈. 너는 그걸 조회·분석·운영하는 조수다.
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
/**
 * ★ 2026-08-01: claude 실행을 flock 으로 감쌌다 — stock-live 의 AI 판단(ai-trader.mjs)과
 *   **동시 실행을 막는다.** VM RAM 956MB(available ~374MB)에 claude 1프로세스가 ~300-400MB라
 *   둘이 겹치면 OOM 이다. 여기(사용자 질의)가 우선이므로 대기시간을 길게 준다(-w 300).
 *   ai-trader 는 -w 20 으로 짧게 기다리고 못 잡으면 양보한다(다음 주기 재시도).
 *   flock 이 없는 환경이면 그대로 직접 실행(로컬 개발).
 */
const CLAUDE_LOCK = join(__dirname, '.claude-spawn.lock');
const HAS_FLOCK = existsSync('/usr/bin/flock') || existsSync('/bin/flock');
function ask(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--append-system-prompt', SYS,
      '--allowedTools', ALLOWED, '--disallowedTools', 'Write,Edit,WebFetch,WebSearch'];
    const [bin, spawnArgs] = HAS_FLOCK
      ? ['flock', ['-w', '300', CLAUDE_LOCK, 'claude', ...args]]
      : ['claude', args];
    // stdin 무시: 안 닫으면 claude가 파이프 stdin 입력을 기다리며 멈춰 응답이 안 나감(프롬프트는 -p 인자로 전달)
    const cp = spawn(bin, spawnArgs, { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { cp.kill(); resolve('⏱️ 응답 시간초과(300s)'); }, 300000); // 2026-07-24: 180→300s (개별종목 분석이 종종 180s 넘김, 재현확인됨)
    cp.on('close', (code) => { clearTimeout(timer); resolve(out.trim() || `(claude 종료 ${code}) ${err.slice(0, 300)}`); });
    cp.on('error', e => { clearTimeout(timer); resolve('claude 실행 실패(설치/토큰 확인): ' + e.message); });
  });
}

let offset = 0;
console.log('[telegram-agent] 시작 — chat_id 잠금:', CHAT);
while (true) {
  try {
    const r = await api('getUpdates', { offset, timeout: 30 });
    // ★ 2026-07-31 계측 추가: 수신을 **무조건** 로그로 남긴다.
    //   기존에는 정상 수신 경로에 로그가 하나도 없어서(미승인 chat 만 로그) "메시지를 받았는지"를
    //   판정할 수 없었다. 오늘 진단이 막힌 원인이 이것이다 — 발신은 msg_id 로 확인되는데
    //   수신은 흔적이 없어 "도달 안 함"과 "받고 조용히 처리"를 구분할 수 없었다.
    if (r.result?.length) console.log(`[tg] 수신 ${r.result.length}건 offset=${offset} → ${r.result.map(u => `${u.update_id}:${u.message?.chat?.id}:${JSON.stringify(u.message?.text ?? '(텍스트없음)').slice(0, 40)}`).join(' ')}`);
    else if (r.ok === false) console.error(`[tg] getUpdates 실패: ${JSON.stringify(r).slice(0, 200)}`);
    for (const u of (r.result || [])) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text) { console.log(`[tg] 스킵(텍스트 아님) update_id=${u.update_id}`); continue; }
      if (String(msg.chat.id) !== CHAT) { console.log('무시(미승인 chat):', msg.chat.id); continue; }
      const text = msg.text.trim();
      // ★ 2026-07-31: 제어명령을 **대소문자 무관**으로 바꿨다.
      //   실측 사고: 사용자가 `Start` 를 보냈는데 `text === 'START'` 가 거짓이라 제어 경로를 타지 않고
      //   일반 질문으로 흘러가 claude 를 51초 돌렸다. 제어명령은 오타·대소문자에 관대해야 한다.
      const CMD = text.toUpperCase();
      if (CMD === 'STOP') { writeFileSync(PAUSE, '1'); await send('⏸️ 봇 일시정지. 재개: START'); continue; }
      if (CMD === 'START') { if (existsSync(PAUSE)) unlinkSync(PAUSE); await send('▶️ 봇 재개'); continue; }
      if (existsSync(PAUSE)) { console.log(`[tg] 폐기(.bot-paused 존재) text=${JSON.stringify(text).slice(0, 40)}`); continue; }
      // 실주문 킬스위치
      if (CMD === '주문ON' || CMD === 'ORDERON') { writeFileSync(ORDERS_FLAG, '1'); await send('🟢 실주문 ON — 매수/매도 명령이 실제 체결됩니다. (끄기: 주문OFF)'); continue; }
      if (CMD === '주문OFF' || CMD === 'ORDEROFF') { if (existsSync(ORDERS_FLAG)) unlinkSync(ORDERS_FLAG); await send('🔴 실주문 OFF — 명령은 DRY(모의)로만 표시됩니다.'); continue; }
      if (text.startsWith('격리해제')) {
        // ★ 2026-08-26: 판정은 stock-live 가 한다. 여기서는 **자기 소유 파일**(.bot-exclude.json)만
        //   지우고, 자동 격리분(.bot-exclude-auto.json)은 요청 채널로 넘긴다.
        //   파일마다 writer 를 하나로 유지하기 위한 것이고(락 불필요), 봇이 산 적 없는 종목은
        //   stock-live 가 저널을 대조해 거부 사유와 함께 답한다.
        const nm = text.replace(/^격리해제\s*/, '').trim();
        if (!nm) { await send('사용법: 격리해제 <종목명>'); continue; }
        try {
          const rr = await resolveStock(nm, { dbQuery });
          if (rr.status === 'ok') {
            removeBotExclude(rr.code);
            appendRequest({ type: 'unquarantine', code: rr.code, name: rr.name });
            await send(`📨 격리해제 요청 접수: ${rr.name}(${rr.code}) — 봇이 저널을 확인한 뒤 결과를 알려드립니다.`);
          } else await send(`'${nm}' 못 찾음/모호 — 격리해제 실패.`);
        } catch (e) { await send('격리해제 오류: ' + String(e.message).slice(0, 120)); }
        continue;
      }
      if (text.startsWith('청산승인')) {
        // AI 청산 권고 승인. 실주문에 준하는 행위라 결정론적 파서만 쓴다(LLM 미사용).
        //   제안 존재 여부·일일상한·중복예약 판정은 전부 stock-live 가 하고 결과를 회신한다.
        const nm = text.replace(/^청산승인\s*/, '').trim();
        if (!nm) { await send('사용법: 청산승인 <종목명>'); continue; }
        try {
          const rr = await resolveStock(nm, { dbQuery });
          if (rr.status === 'ok') {
            appendRequest({ type: 'ai_exit_approve', code: rr.code, name: rr.name });
            await send(`📨 청산 승인 접수: ${rr.name}(${rr.code}) — 봇이 예약을 등록하면 알려드립니다.`);
          } else await send(`'${nm}' 못 찾음/모호 — 청산승인 실패.`);
        } catch (e) { await send('청산승인 오류: ' + String(e.message).slice(0, 120)); }
        continue;
      }
      // 결정론적 주문 인터셉터 (매수/매도 명령은 claude 안 거치고 tg-order로 직접 처리)
      const cmd = parseCommand(text);
      if (cmd.action === 'buy' || cmd.action === 'sell' || cmd.action === 'sell_target') {
        const dry = !ordersOn();
        if (!dry && !marketOpen()) { await send('⏰ 장시간(08:00~20:00 KST) 외 — 주문 보류. 시간 내 재시도해줘.'); continue; }
        try {
          if (dry) {
            // DRY = DB 가격으로 계획만(Toss 안 침)
            const r = cmd.action === 'buy'
              ? await executeBuy({ name: cmd.name, amountKrw: cmd.amount }, { dbQuery, dryRun: true })
              : await executeSell({ name: cmd.name, targetPrice: cmd.targetPrice }, { dbQuery, dryRun: true });
            await send('🔵 [DRY · 실행하려면 "주문ON"] ' + r.msg);
          } else {
            // 실주문 = 큐 적재(Toss 안 침). stock-live 단일 세션이 30초 내 집행 → 결과는 stock-live가 텔레그램 전송.
            const e2 = (s) => String(s ?? '').replace(/'/g, "''");
            const side = cmd.action === 'buy' ? 'buy' : 'sell';
            const amt = cmd.action === 'buy' ? Number(cmd.amount) : 'NULL';
            const tp = cmd.targetPrice ? Number(cmd.targetPrice) : 'NULL';
            await dbQuery(`INSERT INTO tg_order_queue (side, name, amount_krw, target_price) VALUES ('${side}', '${e2(cmd.name)}', ${amt}, ${tp})`);
            await send(`📥 주문 큐 등록: ${side === 'buy' ? '매수' : '매도'} ${cmd.name}${cmd.action === 'buy' ? ' ' + Math.round(cmd.amount / 10000) + '만원' : ''} — 자동봇이 곧 집행(최대 30초).`);
          }
        } catch (e) { await send('주문 오류: ' + String(e.message).slice(0, 200)); }
        continue;
      }
      // ★ 2026-07-31: claude 경로도 로그를 남긴다 — 오늘 "받았는데 답장이 왔는지" 판정이
      //   불가능했던 원인이 이 구간의 침묵이었다. 소요시간까지 남겨 300s 타임아웃 여부를 구분한다.
      await api('sendChatAction', { chat_id: CHAT, action: 'typing' });
      const t0 = Date.now();
      const reply = await ask(text);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[tg] claude 응답 ${secs}s · ${reply.length}자 · text=${JSON.stringify(text).slice(0, 40)}`);
      await send(reply);
    }
    // 매도사인 모니터는 stock-live(30초 루프, Toss 재사용)로 이관 — telegram-agent는 명령 처리만.
  } catch (e) { console.error('poll 오류:', e.message); await new Promise(r => setTimeout(r, 5000)); }
}
