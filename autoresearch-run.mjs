#!/usr/bin/env node
/**
 * autoresearch 러너 — 게이트 실행과 세션 검증만 한다. MC 판정은 하지 않는다.
 *
 *   node autoresearch-run.mjs --init          # 현재 커밋의 base 지문을 캐시
 *   node autoresearch-run.mjs --gate          # 지금 코드로 게이트 판정 (exit 0=ok)
 *   node autoresearch-run.mjs --probe         # 오염 센서 생존 프로브
 *   node autoresearch-run.mjs --verify        # 세션 종료 검증 (§10)
 *
 * MC 판정(ΔCalmar·6→30시드·IS/OOS·노이즈바닥)은 기존 mc-*.mjs 수동 절차를 쓴다.
 * 사람이 그 결과를 autoresearch-log.tsv 에 기입하고 --verify 가 규율 준수를 검사한다.
 */
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { LIVE_PARITY_BASE } from './validation-registry.mjs';
import { mergeArgs } from './validation-lib.mjs';
import {
  TARGET_STRATEGY, GATE_STRATEGIES,
  fingerprintDump, classifyGate, perturbFingerprint,
} from './autoresearch-gate.mjs';
import { parseLog, parseAxes, verifySession } from './autoresearch-log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const BASE_FILE = join(__dirname, 'autoresearch-base.json');
const LOG_FILE = join(__dirname, 'autoresearch-log.tsv');
const AXES_FILE = join(__dirname, 'rejected-axes.tsv');
const PROBE_FILE = join(__dirname, 'autoresearch-probe.json');

// 방법론 §1-B: 폭락을 반드시 포함한다. 20260724 = 캔들 캐시 최대일(2026-08-21 실측).
// 캔들이 연장되면 이 값을 올린다. base 의 --to 20260611 은 폭락 제외 구간이라 쓰지 않는다.
const TO = argOf('--to', '20260724');
const FROM = argOf('--from', '20230102');

const git = (...args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim();

// 게이트 런: 결정론(subsample 1)·전 게이트 전략 동시. override 는 prepend 해야 argOf 첫값 규칙에서 이긴다.
function gateArgs() {
  return mergeArgs([
    '--strategies', [TARGET_STRATEGY, ...GATE_STRATEGIES].join(','),
    '--from', FROM, '--to', TO,
    '--seed', '1', '--subsample', '1',
  ], LIVE_PARITY_BASE);
}

function runFingerprint() {
  const dumpPath = join(__dirname, `._ar_gate_${process.pid}.json`);
  const r = spawnSync('node', ['backtest-swing.mjs', ...gateArgs(), '--dump', dumpPath],
    { cwd: __dirname, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  if (!existsSync(dumpPath)) {
    console.error('덤프가 생성되지 않았다. 백테스트 실패:');
    console.error(((r.stdout || '') + (r.stderr || '')).slice(-2000));
    return null;
  }
  try {
    // timeout 이 덤프를 반쯤 쓴 채 죽이면 JSON.parse 가 터진다 → null 로 돌려 status=crash 가 되게 한다.
    return fingerprintDump(JSON.parse(readFileSync(dumpPath, 'utf8')));
  } catch (e) {
    console.error(`덤프 파싱 실패(중단된 실행일 수 있다): ${e.message}`);
    return null;
  } finally {
    try { unlinkSync(dumpPath); } catch { /* */ }
  }
}

const loadBase = () => {
  if (!existsSync(BASE_FILE)) {
    console.error(`base 지문이 없다. 먼저 --init 을 돌린다: ${BASE_FILE}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(BASE_FILE, 'utf8'));
};

if (argv.includes('--init')) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'main') {
    console.error('main 에서 --init 하지 않는다. autoresearch/<tag> 브랜치를 먼저 만든다.');
    process.exit(2);
  }
  const dirty = git('status', '--porcelain', '--', 'backtest-swing.mjs');
  if (dirty) {
    console.error('backtest-swing.mjs 에 미커밋 변경이 있다. base 지문은 깨끗한 상태에서 떠야 한다.');
    process.exit(2);
  }
  const fingerprint = runFingerprint();
  if (!fingerprint) process.exit(1);
  writeFileSync(BASE_FILE, JSON.stringify({
    commit: git('rev-parse', '--short', 'HEAD'),
    mainCommit: git('rev-parse', '--short', 'main'),
    branch,
    args: { from: FROM, to: TO, target: TARGET_STRATEGY, gate: [...GATE_STRATEGIES] },
    fingerprint,
  }, null, 2));
  console.log(`base 지문 저장 (commit ${git('rev-parse', '--short', 'HEAD')}, main ${git('rev-parse', '--short', 'main')})`);
  for (const [k, v] of Object.entries(fingerprint)) {
    console.log(`  ${k.padEnd(10)} trades=${v.trades} final=${v.final} maxDD=${v.maxDD}`);
  }
  process.exit(0);
}

if (argv.includes('--gate')) {
  const base = loadBase();
  const candidate = runFingerprint();
  if (!candidate) { console.log('status=crash'); process.exit(1); }
  const verdict = classifyGate(base.fingerprint, candidate);
  console.log(`status=${verdict.status}`);
  if (verdict.missing.length) console.log(`missing=${verdict.missing.join(',')}`);
  if (verdict.changedGate.length) console.log(`changedGate=${verdict.changedGate.join(',')}`);
  console.log(`targetChanged=${verdict.targetChanged}`);
  for (const key of [TARGET_STRATEGY, ...GATE_STRATEGIES]) {
    const b = base.fingerprint[key], c = candidate[key];
    if (b && c) console.log(`  ${key.padEnd(10)} ${b.trades}/${b.final} → ${c.trades}/${c.final}`);
  }
  if (verdict.status === 'not-wired') {
    console.log('\n★ 배선 미적용이다. discard 로 기록하지 말 것 — 기각축 표가 오염된다.');
    console.log('  override 를 prepend 했는지, non-live-parity 분기에 넣지 않았는지 확인한다.');
    console.log('  파라미터 무감도(밴드에 걸리는 체결이 0건)일 수도 있다 — 그것도 discard 가 아니다.');
  }
  if (verdict.status === 'contaminated') {
    console.log('\n★ 교차오염이다. 공유 분기(k===\'combo\'||k===\'combo-v2\')를 cfg.v2 로 가드한다.');
  }
  process.exit(verdict.status === 'ok' ? 0 : 1);
}

if (argv.includes('--probe')) {
  const base = loadBase();
  const strategy = argOf('--probe-strategy', GATE_STRATEGIES[0]);
  const perturbed = perturbFingerprint(base.fingerprint, strategy);
  const verdict = classifyGate(base.fingerprint, perturbed);
  const fired = verdict.status === 'contaminated' && verdict.changedGate.includes(strategy);
  writeFileSync(PROBE_FILE, JSON.stringify({ strategy, fired, verdict }, null, 2));
  console.log(fired
    ? `프로브 발화 확인 — ${strategy} 교란이 contaminated 로 잡혔다.`
    : `프로브 미발화 — 게이트가 죽어 있다. status=${verdict.status}`);
  process.exit(fired ? 0 : 1);
}

if (argv.includes('--verify')) {
  const base = loadBase();
  const rows = existsSync(LOG_FILE) ? parseLog(readFileSync(LOG_FILE, 'utf8')) : [];
  const axes = parseAxes(readFileSync(AXES_FILE, 'utf8'));
  const probe = existsSync(PROBE_FILE) ? JSON.parse(readFileSync(PROBE_FILE, 'utf8')) : { fired: false };
  const floorFile = join(__dirname, 'autoresearch-floor.json');
  const floor = existsSync(floorFile) ? JSON.parse(readFileSync(floorFile, 'utf8')) : {};
  const floorCalmar = floor?.[`${FROM}_${TO}`]?.calmar30 ?? null;
  const floorPinned = Number.isFinite(floorCalmar);

  const result = verifySession(rows, {
    axes,
    floorPinned,
    floorCalmar,
    probeFired: probe.fired === true,
    mainCommitBefore: base.mainCommit,
    mainCommitAfter: git('rev-parse', '--short', 'main'),
  });

  console.log(`rounds=${result.rounds} keeps=${result.keeps} floorPinned=${floorPinned}${floorPinned ? ` (Δ바닥 ${floorCalmar})` : ''}`);
  if (result.pass) {
    console.log('PASS — 4개 기준 전부 통과. 발견 0건이어도 정상이다.');
    process.exit(0);
  }
  console.log('FAIL:');
  for (const f of result.failures) console.log(`  - ${f}`);
  process.exit(1);
}

console.error('사용법: --init | --gate | --probe | --verify  (선택: --to YYYYMMDD)');
process.exit(2);
