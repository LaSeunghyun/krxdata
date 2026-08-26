/**
 * bot-exclude.mjs — 격리 목록 (봇이 건드리지 않는 종목).
 *
 * 격리는 "봇이 무시" 가 아니라 **"사용자 소유" 관리 모드**다. stock-live 의 emitSellSignals 가
 *   격리된 종목만 대상으로 목표·손절 도달 알림을 보낸다(자동매도는 없다).
 *
 * ★ 2026-08-26: 파일을 둘로 나눴다. writer 를 파일별로 하나씩 고정해 락 없이 경합을 없앤다.
 *     .bot-exclude.json       ← writer: tg-order / telegram-agent (사용자가 텔레그램으로 산 것)
 *     .bot-exclude-auto.json  ← writer: stock-live (소유 판정으로 자동 격리한 것)
 *   `removeBotExclude` 를 "두 파일 모두 제거" 로 만들면 tg-order 가 자동 파일의 두 번째 writer 가
 *   되어 이 원칙이 깨진다. 그래서 제거도 파일별로 분리했다.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DIR = dirname(fileURLToPath(import.meta.url));
const MANUAL = '.bot-exclude.json';
const AUTO = '.bot-exclude-auto.json';

const readSet = (dir, name) => {
  const p = join(dir, name);
  try { return existsSync(p) ? new Set(JSON.parse(readFileSync(p, 'utf8')).map(String)) : new Set(); }
  catch { return new Set(); }
};
const writeSet = (dir, name, s) => writeFileSync(join(dir, name), JSON.stringify([...s]));

export function readBotExclude(dir = DEFAULT_DIR) {
  return new Set([...readSet(dir, MANUAL), ...readSet(dir, AUTO)]);
}
export function readBotExcludeManual(dir = DEFAULT_DIR) { return readSet(dir, MANUAL); }
export function readBotExcludeAuto(dir = DEFAULT_DIR) { return readSet(dir, AUTO); }

// 수동 파일 (writer: tg-order / telegram-agent). 기존 동작 유지 — 쓰기 실패는 best-effort.
export function addBotExclude(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, MANUAL); s.add(String(code));
  try { writeSet(dir, MANUAL, s); } catch { /* best-effort */ }
  return s;
}
export function removeBotExclude(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, MANUAL); s.delete(String(code));
  try { writeSet(dir, MANUAL, s); } catch { /* best-effort */ }
  return s;
}

// 자동 파일 (writer: stock-live). **쓰기 실패를 삼키지 않는다** — 격리 실패는 호출부가 경보해야 한다.
export function addBotExcludeAuto(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, AUTO); s.add(String(code));
  writeSet(dir, AUTO, s);
  return s;
}
export function removeBotExcludeAuto(code, dir = DEFAULT_DIR) {
  const s = readSet(dir, AUTO); s.delete(String(code));
  writeSet(dir, AUTO, s);
  return s;
}
