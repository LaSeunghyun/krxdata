/**
 * entry-monitor.mjs — 지엔씨에너지(119850)·SNT에너지(100840) 진입 타이밍 감시
 *   2026-08-21 사용자 요청: 세션 무관하게 VM cron 에서 상시 감시, 조건 충족 시 텔레그램 알림.
 *   지엔씨 = "좋은 주식이 싸지길" 대기(가격 구간) / SNT = "떨어지는 칼날이 멈추길" 대기(반등+수급 신호).
 *
 * cron(UTC, VM): 15 1 * * 1-5 (10:15 KST) · 25 5 * * 1-5 (14:25 KST)
 *   node entry-monitor.mjs            # 감시 1회 실행
 *   node entry-monitor.mjs --test-tg  # 텔레그램 경로 점검용 1회 발송
 *   node entry-monitor.mjs --no-tg    # 알림 억제(로컬 드라이런)
 *
 * ★ VM 에서 Node fetch 는 api.telegram.org 에 도달하지 못한다(ETIMEDOUT 실측) → 텔레그램만 curl.
 * ★ 같은 조건은 하루 1회만 알림(.entry-monitor-state.json). DART 공시는 rcept_no 기준 신규만.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPricesMap, getDailyCandles } from "./toss-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, ".entry-monitor-state.json");
const NO_TG = process.argv.includes("--no-tg");
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstToday = () => kstNow().toISOString().slice(0, 10);
const log = (m) => console.log(`[${kstNow().toISOString().slice(0, 19)}K] ${m}`);

const DART_KEY = (() => {
  try { return readFileSync(path.join(__dirname, ".env"), "utf8").match(/^DART_API_KEY=(.+)$/m)[1].trim(); }
  catch { return process.env.DART_API_KEY; }
})();

async function tgNotify(text) {
  const env = readFileSync(path.join(__dirname, ".env"), "utf8");
  const T = process.env.TELEGRAM_BOT_TOKEN ?? env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
  const C = process.env.TELEGRAM_CHAT_ID ?? env.match(/^TELEGRAM_CHAT_ID=(.+)$/m)?.[1]?.trim();
  if (!T || !C || NO_TG) { log(`(알림 억제) ${text}`); return; }
  try {
    const { stdout } = await promisify(execFile)("curl", [
      "-4", "-s", "-m", "20", "-X", "POST", "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ chat_id: C, text }),
      `https://api.telegram.org/bot${T}/sendMessage`,
    ], { timeout: 25_000 });
    if (!/"ok":true/.test(stdout)) log(`텔레그램 전송 실패: ${String(stdout).slice(0, 120)}`);
    else log(`알림 전송: ${text.split("\n")[0]}`);
  } catch (e) { log(`텔레그램 오류: ${String(e.message).slice(0, 80)}`); }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { alerted: {}, lastDartRcept: {} }; }
}
function saveState(s) { writeFileSync(STATE_PATH, JSON.stringify(s, null, 1)); }

// 같은 조건 키는 하루 1회만
function onceToday(state, key) {
  if (state.alerted[key] === kstToday()) return false;
  state.alerted[key] = kstToday();
  return true;
}

async function dartList(corpCode, days = 3) {
  const end = kstToday().replace(/-/g, "");
  const d = kstNow(); d.setDate(d.getDate() - days);
  const bgn = d.toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_KEY}&corp_code=${corpCode}&bgn_de=${bgn}&end_de=${end}&page_count=30`;
  const j = await (await fetch(url)).json();
  return j.list ?? [];
}

async function snapshot(code) {
  const prices = await getPricesMap([code]);
  const now = prices.get(code)?.price;
  const candles = (await getDailyCandles(code, 25))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const last = candles[candles.length - 1];
  const lastIsToday = String(last.timestamp).startsWith(kstToday());
  const prevClose = lastIsToday ? candles[candles.length - 2]?.close : last.close;
  const done = lastIsToday ? candles.slice(0, -1) : candles; // 완결 봉만으로 20일 평균
  const turn20 = done.slice(-20).reduce((s, c) => s + c.close * c.volume, 0) / Math.min(20, done.length);
  const todayTurn = lastIsToday ? last.close * last.volume : 0;
  return { now, prevClose, chgPct: now && prevClose ? (now / prevClose - 1) * 100 : null, turn20, todayTurn, lastIsToday };
}

async function main() {
  if (process.argv.includes("--test-tg")) {
    await tgNotify("📡 entry-monitor 가동 확인 — 지엔씨에너지·SNT에너지 감시 시작 (10:15/14:25 KST 평일)");
    return;
  }
  const state = loadState();
  const alerts = [];

  // ── 지엔씨에너지 119850: 진입 구간 대기 ─────────────────────────
  try {
    const g = await snapshot("119850");
    log(`지엔씨 ${g.now}원 (전일比 ${g.chgPct?.toFixed(1)}%)`);
    if (g.now && g.lastIsToday) {
      if (g.now <= 44000 && onceToday(state, "119850:entry44k"))
        alerts.push(`🟢 지엔씨에너지 ${g.now.toLocaleString()}원 — 1차 진입 구간(≤44,000) 도달. EB 물량 소화 조정 매수 기회`);
      else if (g.now <= 46500 && g.chgPct >= 2 && onceToday(state, "119850:rebound"))
        alerts.push(`🟢 지엔씨에너지 ${g.now.toLocaleString()}원 (${g.chgPct.toFixed(1)}%) — 조정 후 반등 시작, 분할 1차 진입 고려`);
      else if (g.now >= 52500 && onceToday(state, "119850:breakout"))
        alerts.push(`🟡 지엔씨에너지 ${g.now.toLocaleString()}원 — 조정 없이 상방 이탈(≥52,500). 대기 전략 재검토 필요`);
    }
    // EB 교환청구 공시 = 오버행 진행 상황
    const gd = (await dartList("00626464")).filter((x) => /교환청구권행사/.test(x.report_nm));
    for (const x of gd) {
      if ((state.lastDartRcept["119850"] ?? "") < x.rcept_no) {
        state.lastDartRcept["119850"] = x.rcept_no;
        alerts.push(`📄 지엔씨에너지 공시: ${x.report_nm.trim()} (${x.rcept_dt}) — EB 물량 출회 진행 중`);
      }
    }
  } catch (e) { log(`지엔씨 체크 실패: ${String(e.message).slice(0, 100)}`); }

  // ── SNT에너지 100840: 바닥 확인 대기 ────────────────────────────
  try {
    const s = await snapshot("100840");
    log(`SNT ${s.now}원 (전일比 ${s.chgPct?.toFixed(1)}%, 오늘 거래대금 ${(s.todayTurn / 1e8).toFixed(0)}억 / 20일평균 ${(s.turn20 / 1e8).toFixed(0)}억)`);
    if (s.now && s.lastIsToday) {
      if (s.chgPct >= 4 && s.todayTurn >= s.turn20 * 1.5 && onceToday(state, "100840:volRebound"))
        alerts.push(`🟢 SNT에너지 ${s.now.toLocaleString()}원 (+${s.chgPct.toFixed(1)}%) — 거래량 동반 반등(평균 ${(s.todayTurn / s.turn20).toFixed(1)}배). 바닥 확인 신호 가능성, 분할 1차 검토`);
      else if (s.now <= 21500 && onceToday(state, "100840:newLow"))
        alerts.push(`🔴 SNT에너지 ${s.now.toLocaleString()}원 — 52주 신저가(20,500) 접근. 하락 가속, 진입 금지 관망`);
    }
    // 최대주주(SNT홀딩스) 지분 변동 공시 — 재매수 확대 여부는 원문 확인 필요
    const sd = (await dartList("00648721")).filter((x) => /최대주주등소유주식변동|임원ㆍ주요주주특정증권등소유상황/.test(x.report_nm));
    for (const x of sd) {
      if ((state.lastDartRcept["100840"] ?? "") < x.rcept_no) {
        state.lastDartRcept["100840"] = x.rcept_no;
        alerts.push(`📄 SNT에너지 공시: ${x.report_nm.trim()} / ${x.flr_nm} (${x.rcept_dt}) — SNT홀딩스 재매수인지 방향 확인 필요`);
      }
    }
  } catch (e) { log(`SNT 체크 실패: ${String(e.message).slice(0, 100)}`); }

  saveState(state);
  if (alerts.length) await tgNotify(alerts.join("\n\n"));
  else log("조건 미충족 — 알림 없음");
}

main().catch((e) => { console.error(e); process.exit(1); });
