import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const files = [
  "batch.js",
  "config.js",
  "daily-ranking.js",
  "dart-financials-backfill.js",
  "db-upsert.js",
  "db.js",
  "mcp-input.js",
  "mcp-server.js",
  "patch-marketcap.js",
  "push-to-supabase.mjs",
  "score-kosdaq.js",
  "score-kospi-full.js",
  "score-top100.js",
  "server.js",
  "stock-utils.js",
  "test-filter.js",
  "verify-supabase.mjs",
  "tests/data-refresh.test.js",
  "tests/mcp-input.test.js",
  "tests/project-contract.test.js",
];

let failed = false;

for (const file of files) {
  const fullPath = path.join(projectRoot, file);
  const result = spawnSync(process.execPath, ["--check", fullPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`\nSyntax check failed: ${file}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

if (failed) process.exit(1);

console.log(`Syntax check passed for ${files.length} files.`);
