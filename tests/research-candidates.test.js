import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateCommand, RESEARCH_CANDIDATES, shouldExecuteJob } from '../research-candidates.mjs';

test('research registry stays within nine unique preregistered candidates', () => {
  assert.ok(RESEARCH_CANDIDATES.length <= 9);
  assert.equal(new Set(RESEARCH_CANDIDATES.map(candidate => candidate.id)).size, RESEARCH_CANDIDATES.length);
});

test('research registry does not revive rejected all-in, universe expansion or rotation tests', () => {
  const args = RESEARCH_CANDIDATES.flatMap(candidate => candidate.args ?? []).join(' ');
  assert.doesNotMatch(args, /--slots 1(?:\s|$)/);
  assert.doesNotMatch(args, /--rsiuni (?:100|200)(?:\s|$)/);
  assert.doesNotMatch(args, /--rotate(?:\s|$)/);
});

test('buildCandidateCommand adds each common run argument exactly once', () => {
  const candidate = RESEARCH_CANDIDATES.find(row => row.id === 'A1');
  const command = buildCandidateCommand(candidate, {
    from: '20230102',
    to: '20260611',
    capital: 6_000_000,
    dump: 'out.json',
    seed: 7,
    subsample: 0.8,
    stress: 1,
  });
  assert.deepEqual(command.slice(0, 7), [
    'backtest-swing.mjs', '--from', '20230102', '--to', '20260611', '--capital', '6000000',
  ]);
  for (const flag of ['--dump', '--seed', '--subsample', '--stress']) {
    assert.equal(command.filter(value => value === flag).length, 1);
  }
});

test('unavailable and derived candidates are not executable', () => {
  for (const id of ['A3', 'C3']) {
    const candidate = RESEARCH_CANDIDATES.find(row => row.id === id);
    assert.throws(() => buildCandidateCommand(candidate, {}), /not executable/);
  }
});

test('shouldExecuteJob can refresh one candidate while reusing other raw dumps', () => {
  assert.equal(shouldExecuteJob({ dumpExists: true, force: false, forcedCandidateIds: new Set(['B2']), candidateId: 'B2' }), true);
  assert.equal(shouldExecuteJob({ dumpExists: true, force: false, forcedCandidateIds: new Set(['B2']), candidateId: 'A1' }), false);
  assert.equal(shouldExecuteJob({ dumpExists: false, force: false, forcedCandidateIds: new Set(), candidateId: 'A1' }), true);
});
