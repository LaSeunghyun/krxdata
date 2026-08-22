/**
 * judge-flow-intraday.mjs — collect-flow-intraday.mjs 수집분 판정 (장마감 후 실행)
 *
 * 사전 선언한 질문과 기준 (수집 전에 정한다 — 결과 보고 기준을 바꾸면 판정이 아니다):
 *
 *  Q1 "장중에 실제로 갱신되는가" (가집계)
 *      판정: 하루 동안 estN(채워진 gb 개수)이 **1 → 5 로 증가하는 것을 관측**하면 ⭕.
 *      5개가 처음부터 끝까지 고정이면 ❌(장중 갱신이 아니라 전일값 캐시 의심).
 *      추가로 각 gb 가 처음 등장한 시각을 뽑아 KRX 공표시각 가설(09:30/10:00/11:30/13:20/14:30)과 대조.
 *
 *  Q2 "프로그램 누적이 장중에 자라는가 · 지연은 얼마"
 *      판정: pgHour(데이터 시각)와 폴링 시각 차이의 중위값 < 120초면 ⭕ 실시간급.
 *      pg 누적이 단조롭게 변하지 않고 고정이면 ❌.
 *
 *  Q3 "프로그램이 확정 외국인의 대리로 쓸 만한가" (08-03 1일 표본 재확인)
 *      정규화오차 = |프로그램최종 − 확정외국인| / 당일거래량. 중위값 < 2%p 면 ⭕.
 *      ※ 상대오차(/확정값)로 재면 분모 0 근처 종목이 지표를 지배한다 — 08-03 에 그 실수를 했다.
 *
 * 실행: node judge-flow-intraday.mjs [YYYYMMDD]
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY = process.argv[2] ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
const F = join(__dirname, 'flow-intraday', `flow-${DAY}.jsonl`);
if (!existsSync(F)) { console.error(`수집 파일 없음: ${F}\n먼저 collect-flow-intraday.mjs 를 장중에 돌려야 한다.`); process.exit(1); }

const rows = readFileSync(F, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
if (!rows.length) { console.error('수집 행 0'); process.exit(1); }

const BASE = 'https://openapi.koreainvestment.com:9443';
const TOK_F = join(__dirname, 'flow-intraday', '.kis-token.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const n = (v) => Number(String(v ?? '0').replace(/^([+-])?0*/, '$1')) || 0;
/**
 * 중위값. 짝수 표본은 **중간 두 값의 평균**이다.
 * 처음엔 s[floor(n/2)] 로 썼는데 그건 짝수에서 큰 쪽을 집는다 — n=2 에서 두 값이 0.04%p / 34.50%p
 * 일 때 34.50 이 "중위값"으로 나와 판정을 뒤집었다(2026-08-03 실측).
 */
const med = (xs) => {
  const s = xs.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

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
  if (!j.access_token) throw new Error(`토큰 실패 ${r.status}`);
  token = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return token.v;
}
async function confirmedFlow(code) {
  await sleep(240);
  const u = new URL(BASE + '/uapi/domestic-stock/v1/quotations/inquire-investor');
  u.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  u.searchParams.set('FID_INPUT_ISCD', code);
  const res = await fetch(u, {
    headers: {
      authorization: `Bearer ${await getToken()}`, appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET, tr_id: 'FHKST01010900', custtype: 'P',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const j = await res.json();
  if (j.rt_cd !== '0') throw new Error(String(j.msg1 ?? '').trim().slice(0, 60));
  const t = (j.output ?? []).find(r => r.stck_bsop_date === DAY);
  return t ? { f: n(t.frgn_ntby_qty), o: n(t.orgn_ntby_qty), p: n(t.prsn_ntby_qty) } : null;
}

const codes = [...new Set(rows.map(r => r.code))];
const hms = [...new Set(rows.map(r => r.hm))].sort((a, b) => a - b);
console.log(`=== ${DAY} 수집 요약 ===`);
console.log(`행 ${rows.length} · 종목 ${codes.length} · 폴 ${hms.length}회 · 시각 ${String(hms[0]).padStart(4, '0')} ~ ${String(hms.at(-1)).padStart(4, '0')}\n`);

// ── Q1: 가집계 gb 증가 관측 ────────────────────────────────────────────────
console.log('=== Q1: 가집계 gb 개수 변화 (장중 갱신 증명) ===');
const gbFirstSeen = new Map();                       // gb → 처음 관측된 hm
let sawGrowth = false;
for (const code of codes) {
  const rs = rows.filter(r => r.code === code && r.estN != null).sort((a, b) => a.hm - b.hm);
  if (!rs.length) { console.log(`  ${code}: 가집계 수집 실패`); continue; }
  const seq = rs.map(r => r.estN);
  const uniq = [...new Set(seq)];
  if (uniq.length > 1) sawGrowth = true;
  console.log(`  ${code}: estN ${seq[0]} → ${seq.at(-1)} (관측된 값 ${uniq.join(',')})`);
  for (const r of rs) for (const e of (r.est ?? [])) {
    const k = `${code}|${e.gb}`;
    if (!gbFirstSeen.has(k)) gbFirstSeen.set(k, r.hm);
  }
}
console.log(`\n  gb 최초 관측 시각 (KRX 공표시각 가설 1=0930 2=1000 3=1130 4=1320 5=1430):`);
const HYP = { 1: 930, 2: 1000, 3: 1130, 4: 1320, 5: 1430 };
for (const gb of [1, 2, 3, 4, 5]) {
  const seen = codes.map(c => gbFirstSeen.get(`${c}|${gb}`)).filter(v => v != null);
  if (!seen.length) { console.log(`    gb=${gb}: 미관측`); continue; }
  const first = Math.min(...seen);
  console.log(`    gb=${gb}: 최초 ${String(first).padStart(4, '0')} · 가설 ${HYP[gb]} · ${first <= HYP[gb] + 10 && first >= HYP[gb] - 10 ? '일치' : `차이 ${first - HYP[gb]}`}`);
}
console.log(`  판정 Q1: ${sawGrowth ? '⭕ 장중 갱신 확인 (estN 이 증가했다)' : '❌ 변화 없음 — 장중 갱신 미확인'}`);

// ── Q2: 프로그램 누적 성장 · 데이터 지연 ──────────────────────────────────
console.log('\n=== Q2: 프로그램매매 장중 성장 · 데이터 지연 ===');
const lags = [];
for (const code of codes) {
  const rs = rows.filter(r => r.code === code && r.pg != null).sort((a, b) => a.hm - b.hm);
  if (!rs.length) { console.log(`  ${code}: 프로그램 수집 실패`); continue; }
  const moved = new Set(rs.map(r => r.pg)).size > 1;
  for (const r of rs) {
    if (!r.pgHour || String(r.pgHour).length < 6) continue;
    const dh = Number(String(r.pgHour).slice(0, 2)), dm = Number(String(r.pgHour).slice(2, 4)), ds = Number(String(r.pgHour).slice(4, 6));
    const pollSec = Math.floor(r.hm / 100) * 3600 + (r.hm % 100) * 60;
    lags.push(pollSec - (dh * 3600 + dm * 60 + ds));
  }
  console.log(`  ${code}: ${(rs[0].pg / 1000).toFixed(0)} → ${(rs.at(-1).pg / 1000).toFixed(0)}천주 · ${moved ? '변동 있음' : '고정(의심)'}`);
}
const mLag = med(lags);
console.log(`  데이터 지연 중위값: ${mLag == null ? '측정불가' : mLag + '초'} (n=${lags.length})`);
console.log(`  판정 Q2: ${mLag == null ? '측정불가' : mLag < 120 ? '⭕ 실시간급(2분 이내)' : `❌ 지연 ${mLag}초`}`);

// ── Q3: 프로그램 vs 확정 외국인 ───────────────────────────────────────────
console.log('\n=== Q3: 프로그램 최종 vs 확정 외국인 (정규화오차 = |차이|/거래량) ===');
console.log('종목      거래량(천주)  확정외국인  가집계외  프로그램 │ 가집계오차 프로그램오차');
console.log('─'.repeat(92));
const eA = [], eP = [];
for (const code of codes) {
  const rs = rows.filter(r => r.code === code).sort((a, b) => a.hm - b.hm);
  const last = rs.at(-1);
  let c = null;
  try { c = await confirmedFlow(code); } catch (e) { console.log(`${code}  확정 조회 실패: ${e.message}`); continue; }
  if (!c) { console.log(`${code}  확정 데이터 없음(당일 미반영)`); continue; }
  const vol = last?.vol ?? 0;
  const aF = last?.est?.length ? last.est.at(-1).f : null;
  const pg = last?.pg ?? null;
  const nA = aF == null || !vol ? null : Math.abs(aF - c.f) / vol * 100;
  const nP = pg == null || !vol ? null : Math.abs(pg - c.f) / vol * 100;
  if (nA != null) eA.push(nA);
  if (nP != null) eP.push(nP);
  const k = (v) => v == null ? '     -' : (v / 1000).toFixed(0).padStart(6);
  const p = (v) => v == null ? '     -' : (v.toFixed(2) + '%p').padStart(9);
  console.log(`${code}  ${k(vol)}      ${k(c.f)}   ${k(aF)}  ${k(pg)} │ ${p(nA)}  ${p(nP)}`);
}
const mA = med(eA), mP = med(eP);
console.log(`\n  가집계 중위 ${mA == null ? '-' : mA.toFixed(2) + '%p'} (n=${eA.length}) · 프로그램 중위 ${mP == null ? '-' : mP.toFixed(2) + '%p'} (n=${eP.length})`);
console.log(`  판정 Q3: 프로그램 ${mP == null ? '측정불가' : mP < 2 ? '⭕ 대리 후보 (채택은 MC 백테 필요)' : '❌ 오차 큼'}`);

console.log(`\n※ 표본 = ${DAY} 하루. 종목별 신뢰도 맵에는 여러 날이 필요하다.`);
