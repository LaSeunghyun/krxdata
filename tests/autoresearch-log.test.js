import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_COLUMNS, LOG_STATUSES,
  formatLogRow, parseLog, parseAxes, matchRejectedAxis, verifySession,
} from '../autoresearch-log.mjs';

const AXES = parseAxes([
  'axis_id\tkeywords\tnote',
  'rotation\t로테이션\t0승 30패',
  'down_rsi_block\tdown|rsi2|차단\tΔ-0.35',
].join('\n'));

const keepRow = (over = {}) => ({
  commit: 'abc1234', axis_id: 'new-axis', delta_calmar: '0.62', median_final: '22000000',
  noise_floor_pass: 'true', is_oos_agree: 'true', seeds_n: '30', status: 'keep',
  description: '손절 폭을 넓힌다', ...over,
});

test('log has the columns and statuses the spec defines', () => {
  assert.deepEqual([...LOG_COLUMNS], [
    'commit', 'axis_id', 'delta_calmar', 'median_final',
    'noise_floor_pass', 'is_oos_agree', 'seeds_n', 'status', 'description',
  ]);
  assert.deepEqual([...LOG_STATUSES], ['keep', 'discard', 'not-wired', 'contaminated', 'crash']);
});

// 설명에 탭이 들어가면 열이 밀린다 — 원본 program.md 도 TSV 를 쓰는 이유가 이것이다.
test('formatLogRow neutralizes tabs and newlines in free text', () => {
  const line = formatLogRow(keepRow({ description: 'a\tb\nc' }));
  assert.equal(line.split('\t').length, LOG_COLUMNS.length);
  assert.ok(line.endsWith('a b c'));
});

test('parseLog skips the header row', () => {
  const text = [LOG_COLUMNS.join('\t'), formatLogRow(keepRow())].join('\n');
  const rows = parseLog(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'keep');
  assert.equal(rows[0].seeds_n, '30');
});

test('parseAxes splits keywords and ignores comments', () => {
  const axes = parseAxes('# 주석\naxis_id\tkeywords\tnote\nrotation\t로테이션|이익전환\t메모');
  assert.equal(axes.length, 1);
  assert.deepEqual(axes[0].keywords, ['로테이션', '이익전환']);
});

test('matchRejectedAxis fires when every keyword of an axis is present', () => {
  assert.equal(matchRejectedAxis('로테이션을 다시 켜본다', AXES).axis_id, 'rotation');
  assert.equal(matchRejectedAxis('DOWN 레짐 rsi2 를 전면 차단', AXES).axis_id, 'down_rsi_block');
});

test('matchRejectedAxis does not fire on a partial keyword hit', () => {
  // 'down' 과 'rsi2' 는 있지만 '차단' 이 없다 → 다른 축이다.
  assert.equal(matchRejectedAxis('DOWN 레짐에서 rsi2 를 더 산다', AXES), null);
});

test('verifySession passes a clean session', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: true, floorCalmar: 0.316, probeFired: true,
    mainCommitBefore: 'deadbee', mainCommitAfter: 'deadbee',
  });
  assert.equal(v.pass, true, JSON.stringify(v.failures));
  assert.equal(v.keeps, 1);
});

// 사람이 적은 noise_floor_pass 를 그대로 믿으면 오기입 keep 이 통과한다 → 바닥 수치와 직접 대조한다.
test('verifySession rejects a keep whose delta_calmar does not clear the pinned floor', () => {
  const v = verifySession([keepRow({ delta_calmar: '0.20', noise_floor_pass: 'true' })], {
    axes: AXES, floorPinned: true, floorCalmar: 0.316, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-below-floor')));
});

test('verifySession rejects a keep with an unparseable delta_calmar', () => {
  const v = verifySession([keepRow({ delta_calmar: '' })], {
    axes: AXES, floorPinned: true, floorCalmar: 0.316, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-below-floor')));
});

test('verifySession fails when a rejected axis was reproposed', () => {
  const v = verifySession([keepRow({ description: '로테이션 재시도' })], {
    axes: AXES, floorPinned: true, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('rejected-axis-reproposed')));
});

// 한 번도 발화하지 않은 게이트는 죽은 게이트와 구분할 수 없다.
test('verifySession fails when the contamination probe never fired', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: true, probeFired: false,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('contamination-probe-did-not-fire')));
});

test('verifySession rejects keep rows that skipped the noise floor or IS/OOS', () => {
  const v = verifySession(
    [keepRow({ noise_floor_pass: 'false' }), keepRow({ is_oos_agree: 'false' })],
    { axes: AXES, floorPinned: true, probeFired: true, mainCommitBefore: 'a', mainCommitAfter: 'a' },
  );
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-without-floor-pass')));
  assert.ok(v.failures.some(f => f.includes('keep-without-is-oos-agreement')));
});

test('verifySession rejects keep confirmed on fewer than 30 seeds', () => {
  const v = verifySession([keepRow({ seeds_n: '6' })], {
    axes: AXES, floorPinned: true, probeFired: true, mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('keep-with-insufficient-seeds')));
});

test('verifySession refuses any keep while the noise floor is unpinned', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: false, probeFired: true, mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('floor-unpinned-but-keep-exists')));
});

test('verifySession fails when main moved during the session', () => {
  const v = verifySession([keepRow()], {
    axes: AXES, floorPinned: true, floorCalmar: 0.316, probeFired: true,
    mainCommitBefore: 'aaaaaaa', mainCommitAfter: 'bbbbbbb',
  });
  assert.equal(v.pass, false);
  assert.ok(v.failures.some(f => f.includes('main-moved')));
});

// 발견 0건은 실패가 아니다 — 3승 46패 영역에서 6회 루프의 기대 발견 수는 1건 미만이다.
test('verifySession passes a session with zero findings', () => {
  const rows = [keepRow({ status: 'discard', description: '무해한 시도' })];
  const v = verifySession(rows, {
    axes: AXES, floorPinned: false, probeFired: true,
    mainCommitBefore: 'a', mainCommitAfter: 'a',
  });
  assert.equal(v.pass, true, JSON.stringify(v.failures));
  assert.equal(v.keeps, 0);
});
