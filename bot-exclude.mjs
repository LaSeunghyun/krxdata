/**
 * bot-exclude.mjs — 동적 봇 제외목록 (사용자가 텔레그램으로 수동 매수한 종목).
 *   stock-live(자동봇)는 이 목록 종목을 LIVE_EXCLUDE와 함께 "전혀 안 건드림"(청산·슬롯계산·재매수 스킵).
 *   tg-order가 수동 매수 성공 시 add, 전량 매도 성공 시 remove. 파일 공유(VM ~/krxdata).
 *   목적: 자동봇(combo-v2 자기 픽) vs 사용자 수동 촉매픽 분리 = A+C 모델. 봇이 수동픽을 자기 규칙으로 매도하는 것 방지.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const FILE = join(dirname(fileURLToPath(import.meta.url)), '.bot-exclude.json');

export function readBotExclude() {
  try { return existsSync(FILE) ? new Set(JSON.parse(readFileSync(FILE, 'utf8'))) : new Set(); }
  catch { return new Set(); }
}
export function addBotExclude(code) {
  const s = readBotExclude(); s.add(String(code));
  try { writeFileSync(FILE, JSON.stringify([...s])); } catch { /* best-effort */ }
  return s;
}
export function removeBotExclude(code) {
  const s = readBotExclude(); s.delete(String(code));
  try { writeFileSync(FILE, JSON.stringify([...s])); } catch { /* best-effort */ }
  return s;
}
