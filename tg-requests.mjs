/**
 * tg-requests.mjs — telegram-agent → stock-live 단방향 요청 채널.
 *
 * writer 는 telegram-agent 단독(append-only), reader 는 stock-live 단독이다.
 *   파일마다 writer 가 하나이므로 락이 필요 없다.
 *
 * 커서를 타임스탬프가 아니라 **소비한 줄 수**로 두는 이유: append-only 파일에서는 줄 수가
 *   안정적인 위치 지시자이고, 같은 초에 두 요청이 들어와도 중복 처리·유실이 없다.
 *
 * 쓰는 쪽(telegram-agent)은 사용자 명령을 그대로 담고, 판정은 전부 읽는 쪽(stock-live)이 한다.
 *   승인·격리해제는 봇 상태를 바꾸는 일이라 상태 소유자가 결정해야 한다.
 */
import { existsSync, appendFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DIR = dirname(fileURLToPath(import.meta.url));
const FILE = '.tg-requests.jsonl';

/** 요청 1건 append. 실패는 던진다 — 조용히 사라지면 사용자가 승인했는데 아무 일도 안 난다. */
export function appendRequest(req, dir = DEFAULT_DIR) {
  const row = { ts: new Date().toISOString(), ...req };
  appendFileSync(join(dir, FILE), JSON.stringify(row) + '\n');
  return row;
}

/**
 * @param {number} consumed  이미 소비한 줄 수
 * @returns {{items:object[], lines:number, skipped:number}}
 *   lines = 새 커서(파일의 현재 줄 수). 깨진 줄도 커서를 전진시킨다 — 안 그러면 무한 재시도가 된다.
 */
export function readRequestsAfter(consumed = 0, dir = DEFAULT_DIR) {
  const p = join(dir, FILE);
  if (!existsSync(p)) return { items: [], lines: Number(consumed) || 0, skipped: 0 };
  let all;
  try { all = readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== ''); }
  catch { return { items: [], lines: Number(consumed) || 0, skipped: 0 }; }

  const cur = Math.max(0, Number(consumed) || 0);
  // 파일이 줄어들었다(회전·재생성) → 과거 요청을 소급 실행하지 않고 커서만 맞춘다.
  if (all.length < cur) return { items: [], lines: all.length, skipped: 0 };

  const items = []; let skipped = 0;
  for (const line of all.slice(cur)) {
    try { items.push(JSON.parse(line)); } catch { skipped++; }
  }
  return { items, lines: all.length, skipped };
}
