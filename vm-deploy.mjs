#!/usr/bin/env node
/**
 * vm-deploy.mjs — VM 배포 가드 (2026-08-22)
 *
 * ═══ 왜 ═══
 * VM 의 `~/krxdata` 는 git 레포가 아니다(`vm.sh` 주석). 배포는 파일별 scp 뿐이라
 * **의존성을 빠뜨린 부분 배포**가 구조적으로 가능하다.
 * 실제로 오늘 `validate-hypotheses.mjs` 가 신규 `validation-lib.mjs` 를 import 하게 됐는데,
 * 그것만 올렸다면 VM 일일 크론이 import 실패로 죽었다(사람이 알아채기 전까지 조용히).
 *
 * 이 스크립트는 **로컬 import 폐쇄(transitive closure)** 를 계산해서
 *   ① 폐쇄 안의 파일이 VM 에 없거나 다르면 자동으로 배포 세트에 넣고
 *   ② 배포 후 VM 에서 실제로 import 가 되는지 확인한다.
 * "scp 성공 = 동작" 이 아니다.
 *
 * ═══ 사용 ═══
 *   node vm-deploy.mjs --check-only              # CI용. SSH 없이 폐쇄가 전부 git 추적인지만 검사
 *   node vm-deploy.mjs <file>...                 # 파일 배포(폐쇄 자동 보강)
 *   node vm-deploy.mjs --entry stock-live.mjs    # 진입점의 폐쇄 전체를 배포
 *   옵션: --allow-dirty(미커밋 허용) · --skip-tests · --dry-run
 */
import { spawnSync, execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, relative, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const VM_IP = '134.185.111.69';
const VM_KEY = join(process.env.HOME || process.env.USERPROFILE, '.ssh', 'oracle-vm');
const VM_DIR = '~/krxdata';

/**
 * VM 에서 실제로 도는 진입점. `crontab -l` + `systemctl cat` 실측(2026-08-22).
 * 여기 없는 파일은 --check-only 가 검사하지 않는다 → VM 에 새 크론을 걸면 여기 추가한다.
 */
const VM_ENTRY_POINTS = [
  'stock-live.mjs', 'telegram-agent.mjs', 'watchdog.mjs',
  'validate-hypotheses.mjs', 'refresh-candles-kis.mjs', 'shadow-1m.mjs', 'shadow-eval.mjs',
  'watch-1m.mjs', 'ai-shadow.mjs', 'measure-slippage.mjs', 'account-snapshot.mjs',
  'daily-review.mjs', 'entry-monitor.mjs',
];

// 정적 import / export from / 동적 import() 의 **상대경로만** 딴다. 패키지는 VM 의 node_modules 몫이다.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function localImportsOf(file) {
  let src;
  try { src = readFileSync(join(__dirname, file), 'utf8'); } catch { return []; }
  const out = new Set();
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    const rel = relative(__dirname, resolve(dirname(join(__dirname, file)), spec)).replace(/\\/g, '/');
    out.add(rel);
  }
  return [...out];
}

function closureOf(entries) {
  const seen = new Set();
  const stack = [...entries];
  const missing = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(join(__dirname, f))) { missing.push(f); continue; }
    for (const dep of localImportsOf(f)) if (!seen.has(dep)) stack.push(dep);
  }
  return { files: [...seen].sort(), missing };
}

const git = (...a) => execFileSync('git', a, { cwd: __dirname, encoding: 'utf8' }).trim();
const ssh = (cmd) => spawnSync('ssh', ['-i', VM_KEY, '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=20', `ubuntu@${VM_IP}`, cmd], { encoding: 'utf8', timeout: 120000 });

// ─────────────────────────────────────────────────────────────
// --check-only : CI 에서 SSH 없이 도는 검사
// ─────────────────────────────────────────────────────────────
if (has('--check-only')) {
  const { files, missing } = closureOf(VM_ENTRY_POINTS);
  let bad = 0;

  if (missing.length) {
    console.error(`✗ 로컬에 없는 import 대상 ${missing.length}건: ${missing.join(', ')}`);
    bad++;
  }

  // 폐쇄 안의 파일이 git 밖에 있으면 = 새 clone 에 없다 = 배포·복구가 불가능한 상태다.
  const tracked = new Set(git('ls-files').split('\n'));
  const untracked = files.filter(f => existsSync(join(__dirname, f)) && !tracked.has(f));
  if (untracked.length) {
    console.error(`✗ VM 진입점이 의존하는데 git 밖인 파일 ${untracked.length}건:`);
    for (const f of untracked) console.error(`    ${f}`);
    console.error('  → 커밋하거나 의존을 끊어라. git 밖 의존은 배포·복구가 불가능하다.');
    bad++;
  }

  console.log(`진입점 ${VM_ENTRY_POINTS.length}개 · import 폐쇄 ${files.length}파일`);
  if (bad) process.exit(1);
  console.log('✓ 폐쇄가 전부 git 추적 상태다.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// 배포
// ─────────────────────────────────────────────────────────────
const entry = argOf('--entry', null);
const named = argv.filter(a => !a.startsWith('--') && a !== entry);
const roots = entry ? [entry] : named;
if (!roots.length) {
  console.error('사용법: node vm-deploy.mjs <file>... | --entry <file> | --check-only');
  console.error('옵션: --allow-dirty --skip-tests --dry-run');
  process.exit(2);
}
for (const f of roots) if (!existsSync(join(__dirname, f))) { console.error(`없는 파일: ${f}`); process.exit(2); }

// ① 미커밋 배포 차단 — "배포는 됐는데 git 엔 없다" 가 이 저장소의 반복 사고다(2026-08-22 844줄).
if (!has('--allow-dirty')) {
  const dirty = git('status', '--porcelain', '--', ...roots);
  if (dirty) {
    console.error('✗ 미커밋 변경이 있다. 배포본과 git 이 갈리면 나중에 무엇이 돌고 있는지 알 수 없다:');
    console.error(dirty);
    console.error('  → 커밋하거나 --allow-dirty 로 명시적으로 넘겨라.');
    process.exit(1);
  }
}

// ② 테스트
if (!has('--skip-tests')) {
  console.log('테스트 실행...');
  const t = spawnSync('npm', ['test'], { cwd: __dirname, encoding: 'utf8', shell: true, timeout: 600000 });
  const out = (t.stdout || '') + (t.stderr || '');
  const fail = out.match(/^# fail (\d+)/m);
  if (t.status !== 0 || (fail && Number(fail[1]) > 0)) {
    console.error('✗ 테스트 실패 — 배포 중단');
    console.error(out.slice(-1500));
    process.exit(1);
  }
  console.log(`  ${out.match(/^# pass (\d+)/m)?.[1] ?? '?'}건 통과`);
}

// ③ import 폐쇄 계산
const { files: closure, missing } = closureOf(roots);
if (missing.length) { console.error(`✗ 로컬에 없는 import 대상: ${missing.join(', ')}`); process.exit(1); }
console.log(`import 폐쇄: ${closure.length}파일 (요청 ${roots.length})`);

// ④ VM 과 대조 — 없거나 다른 것을 배포 세트에 자동 편입. 이게 이 스크립트의 핵심이다.
// ★ 줄바꿈 정규화 후 비교한다. 로컬은 CRLF(Windows git autocrlf)·VM 은 LF 라
//   그냥 md5 로 재면 **내용이 같은데도 전부 "다름"으로 나온다**(2026-08-22 실측: bot-exclude.mjs).
//   그대로 두면 매번 전 파일을 재배포하고, 진짜 변경이 그 소음에 묻힌다.
const remote = ssh(`cd ${VM_DIR} && for f in ${closure.map(f => `'${f}'`).join(' ')}; do ` +
  `if [ -f "$f" ]; then printf '%s %s\\n' "$(tr -d '\\r' < "$f" | md5sum | cut -d' ' -f1)" "$f"; fi; done 2>&1`);
if (remote.status !== 0 && !remote.stdout) { console.error(`✗ VM 접속 실패: ${remote.stderr?.slice(0, 200)}`); process.exit(1); }
const remoteMd5 = new Map();
for (const line of (remote.stdout || '').split('\n')) {
  const m = line.match(/^([0-9a-f]{32})\s+(.+)$/);
  if (m) remoteMd5.set(m[2].trim(), m[1]);
}
const { createHash } = await import('crypto');
const localMd5 = (f) => createHash('md5')
  .update(readFileSync(join(__dirname, f), 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex');

const toSend = [];
for (const f of closure) {
  const r = remoteMd5.get(f);
  const l = localMd5(f);
  if (!r) { toSend.push(f); console.log(`  + ${f}  (VM 에 없음)`); }
  else if (r !== l) { toSend.push(f); console.log(`  ~ ${f}  (내용 다름)`); }
}
if (!toSend.length) { console.log('✓ VM 이 이미 최신이다. 보낼 것 없음.'); process.exit(0); }

const added = toSend.filter(f => !roots.includes(f));
if (added.length) {
  console.log(`\n★ 요청에 없던 의존성 ${added.length}건을 함께 보낸다 — 이게 없으면 VM 에서 import 가 죽는다:`);
  for (const f of added) console.log(`    ${f}`);
}

if (has('--dry-run')) { console.log(`\n[dry-run] 전송 대상 ${toSend.length}건: ${toSend.join(' ')}`); process.exit(0); }

// ⑤ 한 번의 scp 로 함께 전송 — 부분 배포 상태를 만들지 않는다.
console.log(`\n전송 ${toSend.length}건...`);
const scp = spawnSync('scp', ['-i', VM_KEY, '-o', 'StrictHostKeyChecking=accept-new',
  ...toSend, `ubuntu@${VM_IP}:${VM_DIR}/`], { cwd: __dirname, encoding: 'utf8', timeout: 300000 });
if (scp.status !== 0) { console.error(`✗ 전송 실패: ${scp.stderr}`); process.exit(1); }

// ⑥ md5 재검증
const verify = ssh(`cd ${VM_DIR} && for f in ${toSend.map(f => `'${basename(f)}'`).join(' ')}; do ` +
  `printf '%s %s\\n' "$(tr -d '\\r' < "$f" | md5sum | cut -d' ' -f1)" "$f"; done 2>&1`);
let mismatch = 0;
for (const f of toSend) {
  const line = (verify.stdout || '').split('\n').find(l => l.trim().endsWith(basename(f)));
  const r = line?.match(/^([0-9a-f]{32})/)?.[1];
  const ok = r === localMd5(f);
  console.log(`  ${ok ? 'OK  ' : '★불일치'} ${f}`);
  if (!ok) mismatch++;
}
if (mismatch) { console.error('✗ md5 불일치 — 배포 실패'); process.exit(1); }

// ⑦ ★ 전송 성공은 동작 성공이 아니다. VM 에서 실제로 import 되는지 본다.
console.log('\nVM 에서 import 검증...');
const entriesTouched = VM_ENTRY_POINTS.filter(e => closureOf([e]).files.some(f => toSend.includes(f)));
for (const e of entriesTouched) {
  const chk = ssh(`cd ${VM_DIR} && node --check ${e} 2>&1`);
  console.log(`  ${chk.status === 0 ? 'OK  ' : '✗ FAIL'} node --check ${e}${chk.status === 0 ? '' : ' — ' + (chk.stdout || chk.stderr || '').slice(0, 200)}`);
  if (chk.status !== 0) mismatch++;
}
if (mismatch) { console.error('\n✗ VM 문법 검사 실패 — 롤백을 검토하라'); process.exit(1); }

console.log(`\n✓ 배포 완료 (${toSend.length}파일, 영향 진입점 ${entriesTouched.length}개)`);
console.log('※ 실행 중 프로세스는 재시작 전까지 옛 코드다: bash vm.sh restart / wd-restart / bot-restart');
