#!/usr/bin/env node
/**
 * collect-cbbw.mjs - 전환사채(CB)·신주인수권부사채(BW) 발행결정 수집 (희석 오버행 기초자료, 2026-10-01).
 *   OpenDART 주요사항보고서 API (DS005): cvbdIsDecsn.json(전환사채권 발행결정), bdwtIsDecsn.json(신주인수권부사채권 발행결정).
 *   절차: list.json(pblntf_ty=B, 85일 창)으로 CB/BW 발행결정 공시가 있는 상장사를 찾고 -> 해당 corp 별로 위 API 호출.
 *   테이블: stock_cb_bw_issues (PK rcept_no) + 뷰 stock_cb_bw_latest (정정본 중 최신 1건).
 *
 *   ※ DART 가 주지 않는 것: 발행 후 "미전환 잔액". 발행 시점의 총액·전환가·전환가능 주식수·전환청구기간만 있다.
 *     미전환 잔액 추정에는 (a) 전환청구권행사 공시(주식수·가액 차감), (b) 전환가액 조정 공시(전환가 변동),
 *     (c) 만기전 취득·소각 공시, (d) 정기보고서의 사채 주석/미상환 사채 현황이 추가로 필요하다.
 *     이 테이블의 new_shares 는 "발행 시점 전액 전환 시" 희석 상한이다.
 *   첨부정정만 있는 건은 구조화 API 에 없어 누락될 수 있다(실측: 서한 011370).
 *   실행: node collect-cbbw.mjs [--since 20231001] [--dry-run]   (일 증분: 기본 최근 14일 창만 list 조회)
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { dartGet, listAll } from './lib/dart.mjs';
import { makeDbQuery, splitWindows, runWithSecondPass } from './lib/retry.mjs';
import { parseBondDecision, sqlNum, sqlStr, isStockCode, kstToday } from './lib/parsers.mjs';
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry-run');
const today = kstToday();
const since = argOf('--since', new Date(Date.now() + 9 * 3_600_000 - 14 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, ''));
const dbQuery = makeDbQuery({ ref: process.env.SUPABASE_PROJECT_REF, key: process.env.SUPABASE_MANAGEMENT_KEY });

const DDL = `
CREATE TABLE IF NOT EXISTS stock_cb_bw_issues (
  rcept_no TEXT PRIMARY KEY, stock_code TEXT NOT NULL, corp_code TEXT NOT NULL, corp_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('CB','BW')), decision_date DATE NOT NULL, bond_round INT, bond_kind TEXT,
  face_amount NUMERIC NOT NULL, issue_method TEXT, coupon_rate NUMERIC, ytm_rate NUMERIC, maturity_date DATE,
  conv_ratio NUMERIC, conv_price NUMERIC, new_shares BIGINT, new_shares_pct NUMERIC,
  period_start DATE, period_end DATE, min_adjust_price NUMERIC, pay_date DATE, is_overseas BOOLEAN,
  raw JSONB, snapshot_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS stock_cb_bw_issues_stock_idx ON stock_cb_bw_issues (stock_code, decision_date DESC);
CREATE OR REPLACE VIEW stock_cb_bw_latest AS
  SELECT DISTINCT ON (corp_code, kind, bond_round, decision_date) *
  FROM stock_cb_bw_issues ORDER BY corp_code, kind, bond_round, decision_date, rcept_no DESC;
SELECT 1;`;

const KIND_BY_TITLE = [['CB', /전환사채권발행결정/], ['BW', /신주인수권부사채권발행결정/]];
const ENDPOINT = { CB: 'cvbdIsDecsn', BW: 'bdwtIsDecsn' };

if (!DRY) await dbQuery(DDL);

// 1) 대상 corp 탐색
const targets = new Map(); // `${kind}|${corp_code}` -> {kind, corp_code, stock_code}
for (const [bgn, end] of splitWindows(since, today, 85)) {
  const list = await listAll({ bgn, end, ty: 'B' });
  let hit = 0;
  for (const x of list) {
    const t = String(x.report_nm ?? '').replace(/\s+/g, '');
    for (const [kind, re] of KIND_BY_TITLE) {
      if (re.test(t) && isStockCode(x.stock_code)) { targets.set(`${kind}|${x.corp_code}`, { kind, corp_code: x.corp_code, stock_code: x.stock_code }); hit++; }
    }
  }
  console.log(`창 ${bgn}~${end}: 공시 ${list.length}건, CB/BW 발행결정 ${hit}건`);
}
console.log(`대상 (종류,회사) ${targets.size}개`);

// 2) 상세 조회 + upsert
let rows = 0, dropped = 0;
const res = await runWithSecondPass([...targets.values()], async (t) => {
  const j = await dartGet(ENDPOINT[t.kind], { corp_code: t.corp_code, bgn_de: since, end_de: today });
  const parsed = (j.list ?? []).map(r => parseBondDecision(t.kind, r, t.stock_code));
  dropped += parsed.filter(p => !p).length;
  const ok = parsed.filter(Boolean);
  if (!ok.length) return;
  if (!DRY) {
    const vals = ok.map(r => `(${sqlStr(r.rcept_no)},${sqlStr(r.stock_code)},${sqlStr(r.corp_code)},${sqlStr(r.corp_name)},${sqlStr(r.kind)},${sqlStr(r.decision_date)},${sqlNum(r.bond_round)},${sqlStr(r.bond_kind)},${sqlNum(r.face_amount)},${sqlStr(r.issue_method)},${sqlNum(r.coupon_rate)},${sqlNum(r.ytm_rate)},${sqlStr(r.maturity_date)},${sqlNum(r.conv_ratio)},${sqlNum(r.conv_price)},${sqlNum(r.new_shares)},${sqlNum(r.new_shares_pct)},${sqlStr(r.period_start)},${sqlStr(r.period_end)},${sqlNum(r.min_adjust_price)},${sqlStr(r.pay_date)},${r.is_overseas},${sqlStr(JSON.stringify(r.raw))}::jsonb)`);
    await dbQuery(`INSERT INTO stock_cb_bw_issues (rcept_no,stock_code,corp_code,corp_name,kind,decision_date,bond_round,bond_kind,face_amount,issue_method,coupon_rate,ytm_rate,maturity_date,conv_ratio,conv_price,new_shares,new_shares_pct,period_start,period_end,min_adjust_price,pay_date,is_overseas,raw)
      VALUES ${vals.join(',')} ON CONFLICT (rcept_no) DO UPDATE SET face_amount=EXCLUDED.face_amount, conv_price=EXCLUDED.conv_price, new_shares=EXCLUDED.new_shares, new_shares_pct=EXCLUDED.new_shares_pct, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, raw=EXCLUDED.raw, snapshot_at=NOW()`);
  }
  rows += ok.length;
}, { passes: 2, passPauseMs: 15_000, pace: 120, log: console.log });

console.log(`CB/BW: 회사 ${res.ok}/${targets.size} 성공, 행 ${rows}, 파싱 제외 ${dropped}${DRY ? ' (dry-run)' : ''}`);
for (const f of res.failed.slice(0, 5)) console.error(`  ${f.item.kind} ${f.item.stock_code} 실패: ${f.error.slice(0, 120)}`);
if (!DRY) console.log(JSON.stringify(await dbQuery(`SELECT kind, count(*) n, count(DISTINCT stock_code) c, min(decision_date) mn, max(decision_date) mx FROM stock_cb_bw_issues GROUP BY 1`)));
if (targets.size && res.ok / targets.size < 0.95) process.exit(2);
