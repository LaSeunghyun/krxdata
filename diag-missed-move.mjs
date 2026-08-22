/**
 * diag-missed-move.mjs — "오늘 급등한 종목을 왜 안 들고 있었나" 를 원장으로 실측
 *
 * 왜: 2026-08-04 08:00(NXT 프리) 급등을 봇이 놓쳤다는 사용자 관측.
 *     ai-trader-decisions.jsonl 에 어제 후보의 **판단시점 가격·확신도·승인여부**가 남아 있다
 *     (ai-trader.mjs 주석: "★ counterfactual 측정용"). 그걸 오늘 가격과 대조하면
 *     놓친 것이 ① 신호를 못 찾은 것인지 ② 찾았는데 못 산 것인지 갈린다. 원인이 다르면 처방도 다르다.
 *
 * 가격 소스 = KIS(정규장). Toss 토큰과 무관해 라이브 봇과 경합하지 않는다.
 *   ※ 한계: KIS 는 KRX 정규장만이라 **08:00 NXT 프리 구간은 안 잡힌다**.
 *     따라서 여기서 재는 것은 "어제 종가 → 지금" 이고, 08:00 급등분은 시가 갭에 섞여 들어온다.
 *
 * 토큰은 collect-flow-intraday 가 만든 캐시를 재사용한다(KIS 는 발급 레이트리밋이 있다).
 *
 * 실행: node diag-missed-move.mjs [원장날짜=어제]
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://openapi.koreainvestment.com:9443';
const TOK_F = join(__dirname, 'flow-intraday', '.kis-token.json');
const LEDGER = join(__dirname, 'ai-trader-decisions.jsonl');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const n = (v) => Number(String(v ?? '0').replace(/^([+-])?0*/, '$1')) || 0;

let token = null;
async function getToken() {
  if (!token && existsSync(TOK_F)) {
    try { const j = JSON.parse(readFileSync(TOK_F, 'utf8')); if (j?.v && Date.now() < j.exp - 300_000) token = j; } catch { /* noop */ }
  }
  if (token) return token.v;
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`토큰 실패 ${r.status} — collect-flow-intraday 캐시가 없다`);
  token = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  writeFileSync(TOK_F, JSON.stringify(token));
  return token.v;
}
/** 현재가 + 전일대비. FHKST01010100 */
async function quote(code) {
  await sleep(240);
  const u = new URL(BASE + '/uapi/domestic-stock/v1/quotations/inquire-price');
  u.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  u.searchParams.set('FID_INPUT_ISCD', code);
  const res = await fetch(u, {
    headers: {
      authorization: `Bearer ${await getToken()}`, appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET, tr_id: 'FHKST01010100', custtype: 'P',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const j = await res.json();
  if (j.rt_cd !== '0') throw new Error(String(j.msg1 ?? '').trim().slice(0, 50));
  const o = j.output ?? {};
  return { px: n(o.stck_prpr), chgPct: Number(o.prdy_ctrt), open: n(o.stck_oprc), hi: n(o.stck_hgpr), name: o.hts_kor_isnm };
}

if (!existsSync(LEDGER)) { console.error(`원장 없음: ${LEDGER}`); process.exit(1); }
const YDAY = process.argv[2] ?? (() => { const d = new Date(Date.now() + 9 * 3600_000); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();

const recs = readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(r => r?.ok && String(r.ts).startsWith(YDAY));
if (!recs.length) { console.error(`${YDAY} 원장 기록 없음`); process.exit(1); }

// 후보별로 마지막 등장 기록을 쓴다(가격·승인여부는 마지막 판단 기준)
const cand = new Map();
for (const r of recs) for (const c of (r.candidates ?? [])) {
  cand.set(c.code, { ...c, ts: r.ts, approved: c.approved || cand.get(c.code)?.approved });
}
const held = new Map();
for (const h of (recs.at(-1).holdings ?? [])) held.set(h.code, h);

console.log(`=== ${YDAY} 후보 ${cand.size}종목 · 보유 ${held.size}종목 → 오늘(${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}) 등락 ===`);
console.log('※ KIS 정규장 기준. 08:00 NXT 프리 급등분은 시가 갭에 섞여 있다.\n');

const rows = [];
for (const [code, c] of [...cand, ...[...held].filter(([k]) => !cand.has(k))]) {
  let q;
  try { q = await quote(code); } catch (e) { console.log(`  ${code} 조회실패 ${e.message}`); continue; }
  rows.push({
    code, name: c.name ?? q.name, sub: c.sub ?? null,
    heldFlag: held.has(code), approved: !!c.approved,
    convi: c.conviction ?? null,
    chgPct: q.chgPct, open: q.open, px: q.px, hi: q.hi,
    gapPct: null,
  });
}
// 시가 갭은 현재가·등락률로 역산한 전일종가로 계산한다(KIS 는 전일종가를 별도로 안 준다)
for (const r of rows) {
  const prev = r.chgPct === 0 ? r.px : r.px / (1 + r.chgPct / 100);
  r.gapPct = prev > 0 ? (r.open / prev - 1) * 100 : null;
  r.hiPct = prev > 0 ? (r.hi / prev - 1) * 100 : null;
}
rows.sort((a, b) => b.chgPct - a.chgPct);

const tag = (r) => r.heldFlag ? '보유' : r.approved ? '승인·미체결' : '미승인';
console.log('종목            구분          현재등락   시가갭    당일고가   확신도');
console.log('─'.repeat(76));
for (const r of rows) {
  const p = (v) => v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(2) + '%').padStart(8);
  console.log(`${String(r.name).padEnd(14)} ${tag(r).padEnd(12)} ${p(r.chgPct)} ${p(r.gapPct)} ${p(r.hiPct)}   ${r.convi ?? '-'}`);
}

const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const g = (f) => rows.filter(f).map(r => r.chgPct);
console.log('\n=== 그룹 평균 등락 ===');
for (const [label, f] of [['보유 5종목', r => r.heldFlag], ['AI 승인·슬롯없어 미체결', r => !r.heldFlag && r.approved], ['AI 미승인 후보', r => !r.heldFlag && !r.approved]]) {
  const v = avg(g(f));
  console.log(`  ${label.padEnd(24)} ${v == null ? '해당없음' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'} (n=${g(f).length})`);
}
console.log('\n판정: 보유 평균 < 미체결 평균 이면 "신호는 맞았고 자본이 없어 못 샀다" 다.');
console.log('      보유 평균 ≥ 미체결 평균 이면 "안 산 게 손해가 아니었다" 다.');
