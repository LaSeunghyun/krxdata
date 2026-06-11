/**
 * portfolio.js — 포트폴리오 원장 (portfolio_positions)
 *
 * 진입/청산을 기록하고 스톱로스(-25%)·절반익절(+100%) 규칙을 자동 점검한다.
 * 리포트에만 존재하던 리밸런싱 규칙을 실제 추적 가능하게 만든 것.
 *
 * node portfolio.js enter 005930 [--weight 10] [--price 60000]
 * node portfolio.js check
 * node portfolio.js close 005930 [--reason manual] [--price 60000]
 * node portfolio.js report
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STOP_LOSS_PCT, HALF_PROFIT_PCT } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

// ── 순수 로직 ────────────────────────────────────────────────
export function evalPosition(entryPrice, currentPrice, status) {
  if (!(entryPrice > 0) || !(currentPrice > 0)) return null;
  const ret = +((currentPrice / entryPrice - 1) * 100).toFixed(2);
  if (ret <= STOP_LOSS_PCT) return { ret, action: "stop_loss" };
  if (ret >= HALF_PROFIT_PCT && status === "open") return { ret, action: "half_profit" };
  return { ret, action: "hold" };
}

// ── IO ───────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

async function rest(pathQ, opts = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathQ}`, { ...opts, headers });
  if (!r.ok) throw new Error(`${pathQ.split("?")[0]}: HTTP ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function currentPriceOf(code) {
  const rows = await rest(`stock_analysis?stock_code=eq.${code}&select=corp_name,current_price`);
  return rows?.[0] ?? null;
}

export async function checkOpenPositions() {
  const open = await rest(`portfolio_positions?status=neq.closed&select=*`);
  const results = [];
  for (const p of open ?? []) {
    const cur = await currentPriceOf(p.stock_code);
    if (!cur) continue;
    const ev = evalPosition(Number(p.entry_price), Number(cur.current_price), p.status);
    if (ev) results.push({ ...p, current_price: cur.current_price, ...ev });
  }
  return results;
}

function printCheck(results) {
  if (!results.length) { console.log("[포트폴리오] 보유 포지션 없음"); return; }
  console.log("\n========== 포트폴리오 점검 ==========");
  console.log("종목명          코드      진입가     현재가    수익률   상태          조치");
  console.log("─".repeat(80));
  for (const r of results) {
    const act = r.action === "stop_loss" ? "🔴 스톱로스 청산!" : r.action === "half_profit" ? "🟢 절반 익절!" : "—";
    console.log(
      `${(r.corp_name ?? "").slice(0, 12).padEnd(14)} ${r.stock_code}  ` +
      `${Number(r.entry_price).toLocaleString().padStart(9)}  ${Number(r.current_price).toLocaleString().padStart(9)}  ` +
      `${String(r.ret + "%").padStart(8)}  ${r.status.padEnd(12)} ${act}`
    );
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE 미설정"); process.exit(1); }
  const [cmd, code] = process.argv.slice(2);
  const argVal = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

  if (cmd === "enter") {
    if (!code) throw new Error("종목코드 필요: node portfolio.js enter <code>");
    const cur = await currentPriceOf(code);
    if (!cur && !argVal("--price")) throw new Error(`${code}: stock_analysis에 없음 — --price 필수`);
    const price = Number(argVal("--price") ?? cur.current_price);
    if (!(price > 0)) throw new Error("유효한 진입가 없음");
    await rest(`portfolio_positions`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        stock_code: code, corp_name: cur?.corp_name ?? null,
        entry_price: price, weight_pct: Number(argVal("--weight") ?? 5),
      }),
    });
    console.log(`✅ 진입 기록: ${cur?.corp_name ?? ""}(${code}) @ ${price.toLocaleString()}원`);
  } else if (cmd === "check") {
    printCheck(await checkOpenPositions());
  } else if (cmd === "close") {
    if (!code) throw new Error("종목코드 필요: node portfolio.js close <code>");
    const cur = await currentPriceOf(code);
    const price = Number(argVal("--price") ?? cur?.current_price ?? 0);
    await rest(`portfolio_positions?stock_code=eq.${code}&status=neq.closed`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "closed", exit_date: new Date().toISOString().slice(0, 10),
        exit_price: price > 0 ? price : null, exit_reason: argVal("--reason") ?? "manual",
      }),
    });
    console.log(`✅ 청산 기록: ${code} @ ${price > 0 ? price.toLocaleString() + "원" : "가격미상"}`);
  } else if (cmd === "report") {
    const all = await rest(`portfolio_positions?select=*&order=entry_date`);
    if (!all?.length) { console.log("[포트폴리오] 기록 없음"); return; }
    let wRet = 0, wSum = 0;
    for (const p of all) {
      const px = p.status === "closed"
        ? Number(p.exit_price)
        : Number((await currentPriceOf(p.stock_code))?.current_price ?? 0);
      const ret = p.entry_price > 0 && px > 0 ? (px / p.entry_price - 1) * 100 : null;
      if (ret != null && p.status !== "closed") { wRet += ret * Number(p.weight_pct); wSum += Number(p.weight_pct); }
      console.log(
        `${p.status === "closed" ? "✔" : "●"} ${(p.corp_name ?? "").slice(0, 12).padEnd(14)} ${p.stock_code} ` +
        `${p.entry_date}  ${Number(p.entry_price).toLocaleString().padStart(9)} → ${px > 0 ? px.toLocaleString().padStart(9) : "    -    "} ` +
        `(${ret != null ? ret.toFixed(1) : "-"}%) ${p.exit_reason ?? ""}`
      );
    }
    if (wSum > 0) console.log(`\n보유 포지션 가중 평균 수익률: ${(wRet / wSum).toFixed(2)}%`);
  } else {
    console.log("사용법: node portfolio.js enter <code> [--weight N] [--price P] | check | close <code> [--reason R] | report");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("[오류]", e.message); process.exit(1); });
}
