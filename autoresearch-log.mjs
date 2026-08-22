// autoresearch 로그 포맷 + 기각축 대조 + 세션 검증. 순수 함수만 둔다.
// 설계서 §7·§10 대응. 검증 스크립트가 없으면 §10 은 선언에 그치고,
// "발견 0건"과 "루프가 통째로 죽어 0건"을 구분할 수 없다.

export const LOG_COLUMNS = Object.freeze([
  'commit', 'axis_id', 'delta_calmar', 'median_final',
  'noise_floor_pass', 'is_oos_agree', 'seeds_n', 'status', 'description',
]);

// ★ 기각축으로 병합해도 되는 것은 `discard` 뿐이다. 나머지는 "재봐야 하거나 못 잰" 상태다.
//   not-wired    = 배선 미적용·파라미터 무감도. 시도조차 못 했다.
//   inconclusive = |ΔCalmar| < 노이즈 바닥. 방법론 §1 "판정 불가 — 채택도 기각도 하지 않는다".
//                  (2026-08-22 R1 에서 실제로 필요해져 추가. discard 로 적었다면 바닥에 묻힌 축을
//                   "기각됨"으로 표에 올려 이후 탐색을 영구히 막았을 것이다 — not-wired 와 같은 오염 경로)
export const LOG_STATUSES = Object.freeze(['keep', 'discard', 'inconclusive', 'not-wired', 'contaminated', 'crash']);

// 기각축 표에 병합해도 되는 status. verifySession 과 사람 절차가 공유한다.
export const MERGEABLE_TO_REJECTED = Object.freeze(['discard']);

export function formatLogRow(row) {
  return LOG_COLUMNS
    .map(col => String(row[col] ?? '').replace(/[\t\r\n]+/g, ' '))
    .join('\t');
}

export function parseLogRow(line) {
  const cells = line.split('\t');
  const row = {};
  LOG_COLUMNS.forEach((col, i) => { row[col] = cells[i] ?? ''; });
  return row;
}

export function parseLog(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const isHeader = lines[0].split('\t')[0] === LOG_COLUMNS[0];
  return (isHeader ? lines.slice(1) : lines).map(parseLogRow);
}

// rejected-axes.tsv: axis_id \t keywords(| 구분, AND) \t note
export function parseAxes(text) {
  return String(text).split(/\r?\n/)
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => line.split('\t'))
    .filter(cells => cells[0] && cells[0] !== 'axis_id')
    .map(([axis_id, keywords, note]) => ({
      axis_id,
      keywords: String(keywords ?? '').split('|').map(k => k.trim().toLowerCase()).filter(Boolean),
      note: note ?? '',
    }));
}

// 키워드 AND. 부분 일치로 발화하면 정당한 신규 축까지 막으므로 전부 포함을 요구한다.
export function matchRejectedAxis(description, axes) {
  const text = String(description ?? '').toLowerCase();
  for (const axis of axes) {
    if (axis.keywords.length && axis.keywords.every(k => text.includes(k))) return axis;
  }
  return null;
}

/**
 * 설계서 §10 의 4개 기준을 일괄 assert 한다.
 * @returns {{pass: boolean, failures: string[], rounds: number, keeps: number}}
 */
export function verifySession(logRows, {
  axes = [], floorPinned = false, floorCalmar = null, probeFired = false,
  mainCommitBefore = null, mainCommitAfter = null, requiredSeeds = 30,
} = {}) {
  const failures = [];
  const keeps = logRows.filter(r => r.status === 'keep');

  // ① 기각축을 다시 제안하지 않았다
  for (const row of logRows) {
    const hit = matchRejectedAxis(row.description, axes);
    if (hit) failures.push(`rejected-axis-reproposed: ${row.commit || '(no commit)'} → ${hit.axis_id}`);
  }

  // ② 교차오염 센서가 살아 있었다 — 한 번도 발화하지 않은 게이트는 죽은 게이트와 구분 불가
  if (!probeFired) failures.push('contamination-probe-did-not-fire: 게이트 생존 미증명');

  // ③ 바닥 미달·IS/OOS 불일치·시드 미충원 keep 이 없다
  if (keeps.length && !floorPinned) {
    failures.push('floor-unpinned-but-keep-exists: 노이즈 바닥이 이 구간에 pin 되지 않았다');
  }
  for (const row of keeps) {
    if (String(row.noise_floor_pass) !== 'true') failures.push(`keep-without-floor-pass: ${row.commit}`);
    if (String(row.is_oos_agree) !== 'true') failures.push(`keep-without-is-oos-agreement: ${row.commit}`);
    if (!(Number(row.seeds_n) >= requiredSeeds)) {
      failures.push(`keep-with-insufficient-seeds: ${row.commit} (n=${row.seeds_n} < ${requiredSeeds})`);
    }
    // 사람이 적은 boolean 을 그대로 믿지 않는다 — 바닥 수치와 직접 대조한다(설계서 §10).
    if (Number.isFinite(floorCalmar)) {
      const delta = Number(row.delta_calmar);
      if (!Number.isFinite(delta) || !(delta > floorCalmar)) {
        failures.push(`keep-below-floor: ${row.commit} (Δ=${row.delta_calmar || '(빈값)'} ≤ 바닥 ${floorCalmar})`);
      }
    }
  }

  // ④ main 이 변하지 않았다
  if (mainCommitBefore && mainCommitAfter && mainCommitBefore !== mainCommitAfter) {
    failures.push(`main-moved: ${mainCommitBefore} → ${mainCommitAfter}`);
  }

  return { pass: failures.length === 0, failures, rounds: logRows.length, keeps: keeps.length };
}
