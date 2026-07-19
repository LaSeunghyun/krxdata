#!/usr/bin/env node
/**
 * live-watchdog.mjs — live-day.mjs 감시견. 30초마다 live-day 프로세스 생존 확인, 죽어 있으면 즉시 재시작.
 *   세션 종료시각(live-day-state.json endsAtMs) 지나면 watchdog도 자동 종료.
 *   재시작은 상태 파일 복원이라 신규 매수 없음(유휴현금 있으면 스윕만) — 감시·손절·익절 연속성 보장.
 *
 * 실행: node live-watchdog.mjs   (live-day와 별개 프로세스로 백그라운드 실행)
 */
import { spawn, execFileSync } from 'child_process';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, 'live-day-state.json');
const LOG = join(__dirname, 'live-day-log.txt');
const CHECK_MS = 30_000;
const GO_ARGS = ['live-day.mjs', '--go', '--until', '2026-07-19T11:00:00+09:00', '--tp', '2', '--stop', '15'];

const now = () => new Date(Date.now() + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => { const line = `[${now()}] [watchdog] ${m}`; console.log(line); appendFileSync(LOG, line + '\n'); };

function liveDayRunning() {
  try {
    // Name='node.exe' 조건 필수 — 이게 없으면 이 powershell 쿼리 자신·bash 래퍼가 'live-day.mjs' 문자열을
    // 명령줄에 담아 오탐(항상 살아있다고 판정→재시작 안 함)됨. node 프로세스만 카운트.
    // @()로 배열 강제 — PS 5.1은 단일 객체의 .Count가 $null이라, 미하면 1개 가동 중에도 0으로 오판해 중복 기동됨.
    const ps = "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*live-day.mjs --go*' }).Count";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    return Number(out.trim()) > 0;
  } catch { return false; }
}

function endsAtMs() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')).endsAtMs ?? 0; } catch { return 0; }
}

function restart() {
  log('live-day 미가동 감지 → 재시작');
  const child = spawn('node', GO_ARGS, { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
}

log('watchdog 시작 — 30초 주기 감시');
while (true) {
  const end = endsAtMs();
  if (end && Date.now() >= end + 120_000) { log('세션 종료시각 경과 → watchdog 종료'); break; }
  if (!liveDayRunning()) restart();
  await new Promise(r => setTimeout(r, CHECK_MS));
}
