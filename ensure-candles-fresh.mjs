/**
 * ensure-candles-fresh.mjs — candles-daily.jsonl 캐시 최신성 자동 보장 (2026-07-24 등록).
 *   배경: 6주간 갱신을 깜빡해서 PEAD 리서치가 조용히 좁은(오래된) 표본으로 진행됐던 사고 재발 방지.
 *   라이브봇(stock-live.service) 활성 시간대(08:00~20:00 KST, marketOpen 동일기준)엔 자동갱신 스킵 —
 *   같은 계정 Toss 레이트리밋(10TPS)이 프로세스별 독립이라 동시 호출시 429 경합 발생(실측 확인, 2026-07-24).
 *   갱신 성공 시 VM에 백업 scp까지 자동 수행(로컬 PC 고장 대비 이중화, 별도 스토리지 비용 없음).
 *
 * 사용: backtest-swing.mjs 등 연구 스크립트 최상단에서
 *   import { ensureCandlesFresh } from './ensure-candles-fresh.mjs';
 *   await ensureCandlesFresh();
 */
import { createReadStream } from 'fs';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, 'candles-daily.jsonl');
const REFRESH_SCRIPT = join(__dirname, 'refresh-candles-tail.mjs');
const VM_HOST = 'ubuntu@134.185.111.69';
const VM_KEY = join(homedir(), '.ssh', 'oracle-vm');
const VM_BACKUP_PATH = '~/krxdata-backup/candles-daily.jsonl';

function marketWindowActive() {
  const h = new Date(Date.now() + 9 * 3600000).getUTCHours(); // KST hour
  return h >= 8 && h < 20;
}

async function getMaxDate() {
  let maxD = '';
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: createReadStream(CACHE_FILE) });
    rl.on('line', (line) => { if (!line.trim()) return; const o = JSON.parse(line); const last = o.d[o.d.length - 1]; if (last > maxD) maxD = last; });
    rl.on('close', resolve);
  });
  return maxD;
}

/** @returns {Promise<{fresh:boolean, skipped:boolean, maxDate:string}>} */
export async function ensureCandlesFresh({ autoBackup = true } = {}) {
  const kstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
  const maxDate = await getMaxDate();
  if (maxDate >= kstToday) {
    console.log(`[캐시체크] 최신(${maxDate}) — 갱신 불필요`);
    return { fresh: true, skipped: false, maxDate };
  }
  console.log(`[캐시체크] stale 감지 — 최신 ${maxDate}, 오늘 ${kstToday}`);
  if (marketWindowActive()) {
    console.log('[캐시체크] ⚠ 지금 08:00~20:00 KST(라이브봇 활성 추정 구간) — 429 경합 위험으로 자동갱신 스킵. 장 마감 후 직접 node refresh-candles-tail.mjs 실행 요망.');
    return { fresh: false, skipped: true, maxDate };
  }
  console.log('[캐시체크] 장시간 외 확인 — 자동 갱신 시작(refresh-candles-tail.mjs 로직)...');
  const r = spawnSync('node', [REFRESH_SCRIPT], { cwd: __dirname, encoding: 'utf8', stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('[캐시체크] 자동 갱신 실패 — 수동 확인 필요');
    return { fresh: false, skipped: false, maxDate };
  }
  const newMaxDate = await getMaxDate();
  console.log(`[캐시체크] 갱신 완료 — 최신 ${newMaxDate}`);
  if (autoBackup) {
    console.log('[캐시체크] VM 백업 중...');
    const bk = spawnSync('ssh', ['-i', VM_KEY, '-o', 'StrictHostKeyChecking=no', VM_HOST, `mkdir -p ~/krxdata-backup`], { encoding: 'utf8' });
    const scp = spawnSync('scp', ['-i', VM_KEY, '-o', 'StrictHostKeyChecking=no', CACHE_FILE, `${VM_HOST}:${VM_BACKUP_PATH}`], { encoding: 'utf8' });
    if (scp.status === 0) console.log('[캐시체크] VM 백업 완료');
    else console.log('[캐시체크] VM 백업 실패(무해 — 로컬 갱신은 정상):', scp.stderr?.slice(0, 150));
  }
  return { fresh: true, skipped: false, maxDate: newMaxDate };
}
