/**
 * halfyear-watch.mjs — 반기(11012) DART 색인 진행을 감시하다 충분히 차면 자동 재적재.
 *
 * 배경: 정기보고서 제출 마감 당일에는 DART 재무 API 색인이 절반도 안 돼(2026-08-14 실측 44.6%)
 * 그대로 적재하면 유니버스의 상당수가 빠진 편향된 데이터가 된다.
 * 매일 1회 색인률을 표본으로 확인하고, 임계치를 넘는 날 한 번만 전량 재적재 + 스크리닝을 돌린다.
 *
 * 완료되면 DONE_MARKER를 남긴다. 래퍼(run-halfyear-watch.cmd)가 이 파일을 보고 이후 실행을 건너뛴다.
 *
 * 실행: node halfyear-watch.mjs [--year 2026] [--code 11012] [--threshold 0.8] [--force]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchYearFinancials, loadCompanies, dbQuery } from "./dart-financials-backfill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const YEAR = getArg("--year", "2026");
const CODE = getArg("--code", "11012");
const THRESHOLD = Number(getArg("--threshold", "0.8"));
const FORCE = args.includes("--force");
const SAMPLE_SIZE = 300;

const DONE_MARKER = path.join(__dirname, `.halfyear-watch-done-${YEAR}${CODE}`);
// stdout에만 쓴다. 래퍼(run-halfyear-watch.cmd)가 halfyear-watch.log로 리다이렉트하는데,
// 스크립트가 같은 파일을 직접 append하면 Windows에서 파일 잠금 충돌(EBUSY)로 즉사한다.
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  if (fs.existsSync(DONE_MARKER) && !FORCE) {
    log(`이미 완료됨 (${path.basename(DONE_MARKER)}) — 종료`);
    return;
  }

  const companies = await loadCompanies();
  const total = companies.length;

  // ── 1. DB에 이미 충분히 들어와 있는지 ──
  const [row] = await dbQuery(
    `SELECT COUNT(*) cnt FROM stock_financials WHERE analysis_year=${Number(YEAR)} AND report_code='${CODE}'`
  );
  const dbCov = Number(row?.cnt ?? 0) / total;
  log(`DB 적재 ${row?.cnt}/${total} = ${(dbCov * 100).toFixed(1)}%`);
  if (dbCov >= THRESHOLD && !FORCE) {
    log(`임계치(${THRESHOLD * 100}%) 충족 — 재적재 불필요, 완료 처리`);
    fs.writeFileSync(DONE_MARKER, new Date().toISOString());
    return;
  }

  // ── 2. DART 색인률 표본 확인 ──
  // 전량 호출(1,681개)은 수분 걸리므로 균등 간격 표본으로 추정한다.
  const step = Math.max(1, Math.floor(total / SAMPLE_SIZE));
  const sample = companies.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
  const found = new Set();
  for (let i = 0; i < sample.length; i += 100) {
    const rows = await fetchYearFinancials(sample.slice(i, i + 100).map(c => c.corp_code), YEAR, CODE);
    rows.forEach(r => found.add(r.corp_code));
    await new Promise(r => setTimeout(r, 300));
  }
  const dartCov = found.size / sample.length;
  log(`DART 색인 표본 ${found.size}/${sample.length} = ${(dartCov * 100).toFixed(1)}%`);

  if (dartCov < THRESHOLD && !FORCE) {
    log(`아직 임계치 미달 — 내일 재확인`);
    return;
  }

  // ── 3. 전량 재적재 + 스크리닝 ──
  log(`임계치 도달 → 전량 재적재 시작`);
  const node = process.execPath;
  const run = (script, extra = []) => {
    const r = spawnSync(node, [path.join(__dirname, script), ...extra], {
      cwd: __dirname, stdio: "inherit", timeout: 30 * 60_000,
    });
    log(`${script} 종료코드 ${r.status}`);
    return r.status === 0;
  };

  if (!run("dart-quarterly-backfill.js", ["--periods", `${YEAR}:${CODE}`])) {
    log(`재적재 실패 — 마커 남기지 않음, 내일 재시도`);
    return;
  }

  const [after] = await dbQuery(
    `SELECT COUNT(*) cnt FROM stock_financials WHERE analysis_year=${Number(YEAR)} AND report_code='${CODE}'`
  );
  const finalCov = Number(after?.cnt ?? 0) / total;
  log(`재적재 후 ${after?.cnt}/${total} = ${(finalCov * 100).toFixed(1)}%`);

  run("screen-halfyear.mjs", ["--year", YEAR]);

  if (finalCov >= THRESHOLD) {
    fs.writeFileSync(DONE_MARKER, new Date().toISOString());
    log(`✅ 완료 — 이후 실행은 건너뜀. 결과: screen-halfyear.json`);
  } else {
    log(`⚠️ 재적재했으나 ${(finalCov * 100).toFixed(1)}%로 임계치 미달 — 내일 재시도`);
  }
}

main().catch(e => { log(`ERROR ${e?.stack ?? e}`); process.exit(1); });
