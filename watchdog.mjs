/**
 * watchdog.mjs — 세션과 무관한 상주 감시자 (2026-07-29, 사용자 요청 "니가 상주할 방법")
 *
 * 역할: 이상 조건을 감지하면 **claude -p를 읽기전용 도구로 띄워 원인을 진단**하고 기록한다.
 *   주문은 절대 하지 않는다. 판단·제안·기록까지가 경계다(오늘 위양성 7건이 그 근거).
 *
 * 감지 조건은 전부 **오늘 실제로 발생한 사고**에서 뽑았다:
 *   ① 당일 손절 3건+        (07-29: 13건 → 휩소)
 *   ② 주문 오류 5회+        (07-29 08:14~08:32: 322000 422 오류 31회, 백오프 없음)
 *   ③ 스캔지연 1%+          (07-29 발견: 낡은 가격에 프리미엄 → 시장가보다 1% 위 매수)
 *   ④ 자산 전일 대비 -5%    (07-28~29: -10.7%)
 *   ⑤ IP인증실패
 *   ⑥ 봇 무응답 30분+       (로그 정지 = 프로세스 이상)
 * 조건별로 **하루 1회만** 진단을 띄운다(토큰·중복 방지).
 *
 * 데이터 출처는 전부 로컬 파일이다 — Toss/KIS 호출 0, 라이브봇과 경합 없음.
 * 실행: node watchdog.mjs [--interval 300] [--tg] [--dry]
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const INTERVAL = Number(argOf('--interval', 300)) * 1000;
const TG = argv.includes('--tg');
const DRY = argv.includes('--dry');            // 진단 스킵(조건 감지만 확인)
const LOG = join(__dirname, 'watchdog.log');
const STATE = join(__dirname, '.watchdog-state.json');
const LIVE_LOG = join(__dirname, 'stock-live-log.txt');
const JOURNAL = join(__dirname, 'stock-live-journal.json');

const kst = () => new Date(Date.now() + 9 * 3600_000);
const today = () => kst().toISOString().slice(0, 10);
const stamp = () => kst().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => { const l = `[${stamp()}] ${m}`; console.log(l); try { appendFileSync(LOG, l + '\n'); } catch {} };
const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { try { writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch {} };

async function tgSend(t) {
  if (!TG) return;
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) return;
  // ★ 2026-07-30: 기존은 `catch {}` 로 실패를 **완전히 삼켰다**. 경보가 안 가도 아무 흔적이 없었다.
  //
  //   그리고 이 VM에서 **Node의 fetch 로는 텔레그램에 보낼 수 없다**(실측):
  //     node fetch  → 149.154.166.110:443 ETIMEDOUT, 3회 재시도 전부 실패
  //                   IPv6(2001:67c:4e8:f004::9) 는 ENETUNREACH (VM에 글로벌 v6 경로 없음)
  //     curl        → **같은 IP** 에 HTTP 302 · connect 0.27s 로 성공
  //     `--dns-result-order=ipv4first` 로도 fetch 는 실패 → DNS 순서 문제가 아니다.
  //     A 레코드는 149.154.166.110 단 하나이므로 "나쁜 IP를 잡았다"도 아니다.
  //   원인을 undici 내부까지 파지 않고, **동작이 검증된 경로(curl)** 로 보낸다.
  //   fetch 는 폴백으로 남긴다(curl 없는 환경 대비).
  const body = JSON.stringify({ chat_id: C, text: t });
  const url = `https://api.telegram.org/bot${T}/sendMessage`;
  try {
    const { execFile } = await import('child_process');
    const out = await new Promise((res, rej) => {
      execFile('curl', ['-4', '-s', '-m', '10', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', body, url],
        { timeout: 12_000 }, (e, so) => (e ? rej(e) : res(so)));
    });
    if (/"ok":true/.test(out)) return;
    log(`텔레그램 전송 실패(curl): ${String(out).slice(0, 120)}`);
  } catch (e) {
    log(`텔레그램 curl 오류: ${String(e.message).slice(0, 80)} — fetch 폴백 시도`);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8_000) });
      if (r.ok) return;
      log(`텔레그램 전송 실패(fetch) HTTP ${r.status}`);
    } catch (e2) { log(`텔레그램 fetch 오류: ${String(e2.cause?.code ?? e2.message).slice(0, 60)}`); }
  }
  log(`⚠️ 텔레그램 경보 전달 실패 — 경보가 가지 않았다. 원문: ${t.slice(0, 80)}`);
}

/** claude -p 를 읽기전용 도구로 띄워 진단 (주문·수정 불가) */
function diagnose(prompt) {
  return new Promise((resolve) => {
    if (DRY) return resolve('(--dry: 진단 생략)');
    const SYS = [
      '너는 개인 퀀트 봇의 상주 감시자다. 지금 이상 조건이 감지돼 호출됐다.',
      '해야 할 것: 로컬 로그·저널·상태 파일을 읽고 **원인을 구체적으로 특정**해 3~6줄로 보고.',
      '반드시 지킬 것: 주문·코드수정·파라미터 변경을 하지 마라. 제안까지만 한다.',
      '표본이 작으면 "판단 불가"라고 명시하라. 추측을 결론처럼 쓰지 마라.',
      '수치는 파일에서 읽은 실측만 쓰고, 못 읽었으면 못 읽었다고 말하라.',
    ].join(' ');
    const ALLOWED = ['Read', 'Glob', 'Grep', 'Bash(node status.mjs:*)', 'Bash(node shadow-1m.mjs --report:*)'].join(',');
    const args = ['-p', prompt, '--append-system-prompt', SYS, '--allowedTools', ALLOWED,
      '--disallowedTools', 'Write,Edit,WebFetch,WebSearch'];
    /**
     * ★ 2026-08-01: claude 실행을 **공용 flock 에 참여**시킨다.
     *   claude 를 띄우는 경로가 3개(stock-live 의 ai-trader · telegram-agent · 여기)인데
     *   여기만 락 밖에 있었다. 하필 이 프로세스는 **장애가 터진 순간**에 뜨므로 —
     *   그때 ai-trader 도 판단을 시도한다 — VM RAM 956MB(가용 ~380MB)에서 claude 두 개가
     *   겹쳐 OOM 이 나고, 진단하려던 장애를 진단 시도가 키운다.
     *   진단은 급하지 않으므로 대기를 길게 주고(-w 120), 못 잡으면 그 사실을 보고에 남긴다.
     */
    const HAS_FLOCK = existsSync('/usr/bin/flock') || existsSync('/bin/flock');
    const LOCK = join(__dirname, '.claude-spawn.lock');
    const [bin, spawnArgs] = HAS_FLOCK
      ? ['flock', ['-w', '120', '-E', '99', LOCK, 'claude', ...args]]
      : ['claude', args];
    // DISABLE_HARNESS=1: 자동 프롬프트가 하네스 훅(개인·플러그인 인젝터)에 트리거 오탐돼 워크플로 ~14KB가
    // 주입되고 텔레메트리를 오염시킨다 (2026-09-02 실측: 30일 주입 101건 중 69건). 두 훅 모두 이 변수를 존중한다.
    const cp = spawn(bin, spawnArgs, { cwd: __dirname, env: { ...process.env, DISABLE_HARNESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { cp.kill(); resolve('(진단 시간초과 240s)'); }, 240_000);
    cp.on('close', (c) => {
      clearTimeout(timer);
      if (c === 99) return resolve('(진단 생략: claude 동시실행 락 대기 초과 — 다른 프로세스가 사용 중. 메모리 보호를 위해 양보)');
      resolve(out.trim() || `(claude 종료 ${c}) ${err.slice(0, 200)}`);
    });
    cp.on('error', (e) => { clearTimeout(timer); resolve('claude 실행 실패: ' + e.message); });
  });
}

/** 조건 평가 — 전부 로컬 파일 기반 */
function evaluate() {
  const hits = [];
  const d = today();
  const liveLog = existsSync(LIVE_LOG) ? readFileSync(LIVE_LOG, 'utf8').split('\n').filter(l => l.includes(d)) : [];
  const jr = (() => { try { return JSON.parse(readFileSync(JOURNAL, 'utf8')).trades ?? []; } catch { return []; } })();
  const todayTrades = jr.filter(x => String(x.ts).slice(0, 10) === d);

  // ① 손절 3건+
  const stops = todayTrades.filter(x => x.side === 'SELL' && /손절/.test(x.reason || ''));
  if (stops.length >= 3) hits.push({ key: 'stops', msg: `당일 손절 ${stops.length}건 (평균 ${(stops.reduce((s, x) => s + Number(x.ret || 0), 0) / stops.length).toFixed(2)}%)`, detail: stops.map(x => `${x.name} ${x.ret}%`).join(', ') });

  // ② 주문 오류 5회+
  const errs = liveLog.filter(l => /매수 오류|매도 오류/.test(l));
  if (errs.length >= 5) hits.push({ key: 'ordererr', msg: `주문 오류 ${errs.length}회`, detail: errs.slice(-2).join(' | ').slice(0, 200) });

  // ③ 스캔지연 1%+ (가격 갱신 로그)
  const drift = liveLog.map(l => l.match(/가격 갱신 .*\(([-\d.]+)%\)/)).filter(Boolean).map(m => Math.abs(Number(m[1])));
  const bigDrift = drift.filter(v => v >= 1);
  if (bigDrift.length) hits.push({ key: 'drift', msg: `스캔지연 1%+ ${bigDrift.length}건 (최대 ${Math.max(...bigDrift).toFixed(2)}%)`, detail: `평균 ${(drift.reduce((a, b) => a + b, 0) / drift.length).toFixed(2)}%` });

  // ④ 자산 -5% (슬롯예산×5로 추정, 당일 최초 대비 현재)
  const budgets = liveLog.map(l => l.match(/슬롯예산 ([\d,]+)만/)).filter(Boolean).map(m => Number(m[1].replace(/,/g, '')));
  if (budgets.length >= 2) {
    const dropPct = (budgets.at(-1) / budgets[0] - 1) * 100;
    if (dropPct <= -5) hits.push({ key: 'equity', msg: `자산 당일 ${dropPct.toFixed(1)}% (슬롯예산 ${budgets[0]}만 → ${budgets.at(-1)}만)`, detail: '' });
  }

  // ⑤ IP 인증 실패
  if (liveLog.some(l => /IP인증실패|no_authorization_ip/.test(l))) hits.push({ key: 'ip', msg: 'IP 인증 실패 — 매매 불가 상태', detail: '' });

  // ⑥ 봇 무응답 30분+ (장중에만)
  const h = kst().getUTCHours();
  if (h >= 9 && h < 16 && liveLog.length) {
    const lastTs = liveLog.at(-1).match(/\[([\d-]+ [\d:]+)\]/)?.[1];
    if (lastTs) {
      const gapMin = (Date.now() + 9 * 3600_000 - new Date(lastTs + 'Z').getTime()) / 60000;
      if (gapMin > 30) hits.push({ key: 'silent', msg: `봇 로그 ${gapMin.toFixed(0)}분간 정지 (마지막 ${lastTs})`, detail: '' });
    }
  }

  // ⑦ ★ 2026-07-30 신규: 조회 실패 반복 = **살아있지만 아무것도 못 하는 상태**
  //   07-30 실측: 08:50~10:26(96분) 동안 `조회 실패(재시도): aborted due to timeout` 이 1~2분마다 반복되며
  //   봇이 매수·매도·종가판정을 전부 못 했다. 그런데 기존 규칙 어디에도 안 걸렸다:
  //     · ⑥ silent 은 **로그가 계속 찍히고 있었으므로** 발동 안 함 (타임아웃 메시지 자체가 로그다)
  //     · ⑤ ip 는 no_authorization_ip 가 아니라서 미해당
  //   결과: 개장~10:26 장중 96분을 아무 경보 없이 흘려보냈다. 사용자가 직접 시세를 보고 알아챘다.
  //   이 침묵이 이번 사건의 실질 피해다(장애 자체보다). 그래서 별도 규칙으로 승격한다.
  if (h >= 8 && h < 16) {
    const fails = liveLog.filter(l => /조회 실패|aborted due to timeout|ETIMEDOUT|ECONNRESET/.test(l));
    // 장중 10건 이상이면 일시적 네트워크 흔들림이 아니라 지속 장애로 본다(정상일엔 0~2건).
    if (fails.length >= 10) {
      hits.push({
        key: 'apifail',
        msg: `조회 실패 ${fails.length}회 반복 — 봇이 살아있으나 매매 불가 상태일 수 있음`,
        detail: fails.slice(-3).map(l => l.slice(0, 90)).join(' | '),
      });
    }
  }
  return hits;
}

log(`감시 시작 — 폴링 ${INTERVAL / 1000}초 · 진단 ${DRY ? 'DRY' : 'claude -p(읽기전용)'} · 텔레그램 ${TG ? 'ON' : 'OFF'}`);
while (true) {
  try {
    const st = readState();
    const d = today();
    if (st.day !== d) { st.day = d; st.fired = {}; }
    for (const hit of evaluate()) {
      if (st.fired?.[hit.key]) continue;                     // 조건별 하루 1회
      (st.fired ??= {})[hit.key] = stamp();
      log(`⚠️ [${hit.key}] ${hit.msg}${hit.detail ? ' — ' + hit.detail : ''}`);
      const prompt = [
        `퀀트 봇 이상 감지: [${hit.key}] ${hit.msg}`,
        hit.detail ? `상세: ${hit.detail}` : '',
        '',
        'stock-live-log.txt · stock-live-journal.json · stock-live-state.json 을 읽고',
        '이 상황의 **원인**을 특정해 보고해라. 손실이면 선정/진입/청산 중 어디 문제인지 분류하고,',
        '집행 결함(낡은 가격·재시도 루프·중복 진입) 가능성을 먼저 점검해라.',
        '개선 후보가 있으면 1~2개만, "검증 필요" 여부를 명시해서 제안해라.',
      ].filter(Boolean).join('\n');
      const res = await diagnose(prompt);
      log(`── 진단 [${hit.key}] ──\n${res}\n── 끝 ──`);
      await tgSend(`⚠️ 봇 이상 감지: ${hit.msg}\n\n${res.slice(0, 1500)}`);
    }
    saveState(st);
  } catch (e) { log(`감시 오류: ${String(e.message).slice(0, 120)}`); }
  await new Promise(r => setTimeout(r, INTERVAL));
}
