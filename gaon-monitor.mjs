#!/usr/bin/env node
/**
 * gaon-monitor.mjs — 가온전선(000500) 수급 모니터 (KRX+NXT 통합)
 *   GitHub Actions 5분 크론. KST 08:00~20:00에만 동작. 수급 "이슈" 감지 시에만 텔레그램 보고.
 *   사용자가 "팔았다"고 하면 paper_state.gaon_monitor_off=true 설정 → 자동 중단.
 *
 *   감지 이슈(쿨다운 30분, 동일 유형 중복 억제):
 *     - 급락: 5분 -2.5% 이하 / 당일(전일종가 대비) -5% 이하
 *     - 급등: 5분 +3% 이상 (이탈/과열 경고)
 *     - 거래량 급증: 최근 5분 거래량 > 직전 30분 평균 5분의 3배
 *     - 매도벽: 매도호가 잔량 합 > 매수호가 잔량 합 ×2.5 (공급 우위)
 *     - 매도 체결 우위: 최근 체결 매도방향 비중 > 70%
 *     - 무상증자 일정: 6/29 권리부 마감 D-1, 6/30 권리락 당일 (1일 1회)
 *
 * env: TOSS_*, SUPABASE_MANAGEMENT_KEY, SUPABASE_PROJECT_REF, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { isTossConfigured, getPricesMap, getCandles1m, getDailyCandles } from './toss-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const SYMBOL = '000500', NAME = '가온전선';
const AVG = 368790;          // 사용자 평단
const TRAIL_PCT = 15;        // 변동성 큰 종목(60일 MDD 53%) — 익절 트레일링 폭
const HARD_STOP_PCT = 10;    // 평단 대비 손절선
const kst = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstHM = () => kst().toISOString().slice(11, 16);
const kstDate = () => kst().toISOString().slice(0, 10);
const log = (...a) => console.log(`[gaon ${kstHM()}]`, ...a);

// 무상증자 핵심 일정 (DART 6/16 공시)
const RIGHTS_LAST_BUY = '2026-06-29'; // 권리부 매수 마감
const EX_RIGHTS = '2026-06-30';       // 권리락일
const NEW_LISTING = '2026-07-23';     // 신주 상장

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30_000),
  });
  const d = await res.json();
  if (!Array.isArray(d)) throw new Error(d?.message ?? 'DB 오류');
  return d;
}
async function loadState() {
  const r = await dbQuery(`SELECT data FROM paper_state WHERE k='gaon_monitor'`).catch(() => []);
  return r.length && r[0].data ? (typeof r[0].data === 'string' ? JSON.parse(r[0].data) : r[0].data) : {};
}
async function saveState(s) {
  await dbQuery(`INSERT INTO paper_state (k,data,updated_at) VALUES ('gaon_monitor', $j$${JSON.stringify(s).replace(/\$/g, '')}$j$::jsonb, NOW()) ON CONFLICT (k) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`);
}
async function isOff() {
  const r = await dbQuery(`SELECT data FROM paper_state WHERE k='gaon_monitor_off'`).catch(() => []);
  return r.length && r[0].data ? r[0].data : null;
}
async function notify(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { log('텔레그램 미설정 — 콘솔만'); console.log(text); return; }
  await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000) }), signal: AbortSignal.timeout(10_000),
  }).catch(e => log('텔레그램 실패: ' + e.message));
}

const COOLDOWN_MIN = 30;
function onCooldown(state, type, now) {
  const last = state[type];
  return last && (now - last) < COOLDOWN_MIN * 60 * 1000;
}

async function main() {
  if (!isTossConfigured()) { log('TOSS 미설정 — 종료'); return; }
  const hm = kstHM();
  if (hm < '08:00' || hm >= '20:00') { log(`시간 외(${hm}) — 종료`); return; }
  const off = await isOff();
  if (off) { log(`중단 플래그 — 종료 (${JSON.stringify(off)})`); return; }

  const state = await loadState();
  const now = Date.now();
  const today = kstDate();

  // ── 데이터 수집 ──
  const daily = (await getDailyCandles(SYMBOL, 15).catch(() => [])).reverse(); // 오름차순
  const di = daily.length - 1;
  const prevClose = di >= 1 ? daily[di - 1].close : null;
  const recentHigh = daily.length ? Math.max(...daily.slice(-10).map(b => b.high)) : 0;
  const bars = await getCandles1m(SYMBOL, 10).catch(() => []);
  const asc = [...bars].reverse();
  const cur = asc.at(-1)?.close ?? Number((await getPricesMap([SYMBOL])).get(SYMBOL)?.price ?? 0);
  const chg5 = asc.length >= 6 ? (cur / asc.at(-6).close - 1) * 100 : 0;
  const chgDay = prevClose ? (cur / prevClose - 1) * 100 : 0;
  const fromAvg = (cur / AVG - 1) * 100;

  // ── 매도 기준선 ──
  const trailStop = Math.round(recentHigh * (1 - TRAIL_PCT / 100)); // 고점 -15% (변동성 반영)
  const hardStop = Math.round(AVG * (1 - HARD_STOP_PCT / 100));     // 평단 -10%
  const levels = `평단 ${AVG.toLocaleString()} (${fromAvg >= 0 ? '+' : ''}${fromAvg.toFixed(1)}%) | 익절선 ${trailStop.toLocaleString()}(고점${recentHigh.toLocaleString()}-15%) | 손절선 ${hardStop.toLocaleString()}(평단-10%)`;

  // ── 의사결정 (우선순위 순, 최상위 1건만 알림) ──
  let action = null; // { tag, msg, key }
  const set = (tag, key, msg) => { if (!action && !onCooldown(state, key, now)) { action = { tag, key, msg }; } };

  // 1) 손절: 평단 -10% 이탈
  if (cur <= hardStop) set('🔴 손절 권고', 'hardstop', `평단 -10%(${hardStop.toLocaleString()}) 이탈 — 추세 실패. 정리 권고.`);
  // 2) 급락: 당일 -7% 이하
  if (chgDay <= -7) set('🔴 급락', 'crash', `당일 ${chgDay.toFixed(1)}% 급락 (전일 ${prevClose?.toLocaleString()}→${cur.toLocaleString()}). 매도세면 정리.`);
  // 3) 익절: 고점 -15% 트레일링 이탈 (단 평단 위일 때만 '익절', 아래면 위 손절이 우선)
  if (cur <= trailStop && cur > hardStop) set('🟡 익절 권고', 'trail', `고점 ${recentHigh.toLocaleString()} 대비 -15%(${trailStop.toLocaleString()}) 이탈 — 모멘텀 꺾임. 차익실현 고려.`);
  // 4) 5분 급락(장중 변동)
  if (chg5 <= -3) set('🟠 단기 급락', 'drop5', `5분 ${chg5.toFixed(1)}% 급락. 손절선 ${hardStop.toLocaleString()} 근접 시 정리.`);

  // 5) 무상증자 일정 (1일 1회, 위 가격신호와 별개로 항상 통지)
  const calMsgs = [];
  if (state.calDate !== today) {
    if (today === RIGHTS_LAST_BUY) calMsgs.push(`📅 오늘 권리부 매수 마감 — 차익실현하려면 오늘까지가 권리부 가격. 내일 권리락 시 -약44% 기계조정(가치 불변).\n→ 익절 계획이면 오늘 일부 매도 권장.`);
    else if (today === EX_RIGHTS) calMsgs.push(`📅 오늘 권리락 — 시초가 약 -44% 표시(놀라지 마세요, 주식수 1.8배·가치 동일·평단도 비례조정). 갭 메우기 실패 시 약세 신호.`);
    else if (today >= '2026-07-20' && today < NEW_LISTING) calMsgs.push(`📅 신주 상장(${NEW_LISTING}) 임박 — 80% 물량 출회 전 구간. 보유 지속 시 공급 부담 감안, 정리 의향이면 상장 전 권장.`);
    else if (today === NEW_LISTING) calMsgs.push(`📅 오늘 신주 상장 — 80% 물량 출회, 공급 부담 최대 구간.`);
    if (calMsgs.length) state.calDate = today;
  }

  // ── 알림 (이슈 = 매도 신호 or 일정). 정상 보유는 1일 1회 아침 브리핑만 ──
  const out = [];
  if (action) { out.push(`${action.tag}: ${action.msg}`); state[action.key] = now; }
  out.push(...calMsgs);
  // 아침 첫 실행(08~09시) 1회: 오늘 기준선 브리핑 (이슈 없어도)
  if (!action && !calMsgs.length && hm >= '08:00' && hm < '09:00' && state.briefDate !== today) {
    out.push(`☀️ 오늘 보유 가이드 — 현재 ${cur.toLocaleString()}원\n매도 트리거: 손절 ${hardStop.toLocaleString()} 이탈 / 익절 ${trailStop.toLocaleString()} 이탈\n무상증자: 권리부마감 ${RIGHTS_LAST_BUY}·권리락 ${EX_RIGHTS}·상장 ${NEW_LISTING}`);
    state.briefDate = today;
  }

  if (out.length) {
    await notify(`[${NAME} ${hm}] ${cur.toLocaleString()}원\n${out.join('\n')}\n\n${levels}`);
    log(`보고 ${out.length}건`);
  } else {
    log(`보유 유지 — ${cur.toLocaleString()}원 | ${levels}`);
  }
  await saveState(state);
}

main().catch(e => { console.error('[gaon-monitor 오류]', e); process.exit(0); }); // 비치명 종료(크론 실패 방지)
