/**
 * collect-flow-intraday.mjs — 장중 투자자 수급 갱신 실측 수집기 (2026-08-03 작성, 08-04 판정용)
 *
 * ═══ 왜 로컬에서 도는가 ═══
 * VM 은 총 956MB · swap 0 이고 fwupd 가 131MB 를 낭비해, 08-03 16:19~16:34 에 가용 140MB 까지
 * 떨어져 AI 판단 게이트(minMemMb 250)가 15분간 막혔다. 여기에 수집기를 얹으면 그 게이트를
 * 내가 다시 밟는다. KIS 호출은 Toss 토큰과 무관하므로 로컬에서 돌려도 라이브 봇에 영향이 없다.
 *
 * ═══ 답할 질문 ═══
 *  Q1. investor-trend-estimate(HHPTJ04160200)의 bsop_hour_gb 1~5 가 **장중에 실제로 하나씩 채워지는가**.
 *      08-03 실측은 장마감 후였다 → 5개가 이미 다 차 있었다. gb=1 만 있는 시각(09:30~10:00)을
 *      직접 관측해야 "장중 갱신"이 증명된다. KRX 공표시각 가설: 1=09:30(외국인만) 2=10:00
 *      3=11:30 4=13:20 5=14:30.
 *  Q2. program-trade-by-stock(FHPPG04650100)의 누적 순매수가 장중에 증가하는가. bsop_hour 최신값이
 *      폴링 시각을 따라오는가(=지연 얼마).
 *  Q3. 프로그램 누적 vs 그 시점 가집계의 관계 — 장중 실시간 대리로 쓸 수 있는지.
 *
 * ═══ 설계 ═══
 * 누적값이라 촘촘히 안 찍어도 경로가 복원된다 → **60초 간격**이면 충분하고 KIS 레이트도 안전하다.
 * 매 폴에 (종목수 × 2) 호출. 기본 6종목이면 12콜/분 = 0.2 req/s. KIS 한계(약 8 req/s)의 3%.
 * 전부 JSONL 로 append 한다 — 중간에 죽어도 그때까지가 남는다.
 *
 * 실행: node collect-flow-intraday.mjs            (09:00~15:40 KST 자동 종료)
 *       node collect-flow-intraday.mjs --once     (1회만, 동작 확인용)
 *       node collect-flow-intraday.mjs --codes 005930,000660
 * 판정: node judge-flow-intraday.mjs              (장마감 후 = 확정치 나온 뒤)
 */
import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'flow-intraday');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const BASE = 'https://openapi.koreainvestment.com:9443';
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const ONCE = process.argv.includes('--once');
const POLL_SEC = Number(argOf('--poll', '60'));
// 대형주(프로그램 대리가 성립할 가능성이 높은 군) + 08-03 실측에서 어긋난 종목(LG화학) + 보유 일부
const CODES = String(argOf('--codes', '005930,000660,005380,051910,105560,010950')).split(',').map(s => s.trim()).filter(Boolean);

const kstNow = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
const kstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
const kstHm = () => { const d = new Date(Date.now() + 9 * 3600_000); return d.getUTCHours() * 100 + d.getUTCMinutes(); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const n = (v) => Number(String(v ?? '0').replace(/^([+-])?0*/, '$1')) || 0;

/**
 * 토큰. ★ KIS 는 토큰 **발급**에 강한 레이트리밋이 있다(08-03 실측: 프로브 연속 실행 → 403).
 * 파일에 캐시해 재실행 때 재사용한다 — 1분 간격 루프에서 매번 발급하면 즉시 차단된다.
 */
const TOK_F = join(OUT_DIR, '.kis-token.json');
let token = null;
async function getToken() {
  if (!token && existsSync(TOK_F)) {
    try {
      const j = JSON.parse(readFileSync(TOK_F, 'utf8'));
      if (j?.v && Date.now() < j.exp - 300_000) { token = j; console.log(`[${kstNow()}] 캐시 토큰 재사용`); }
    } catch { /* 손상 → 재발급 */ }
  }
  if (token && Date.now() < token.exp - 300_000) return token.v;
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`토큰 발급 실패 ${r.status} ${j.error_description ?? ''}`);
  token = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  writeFileSync(TOK_F, JSON.stringify(token));
  console.log(`[${kstNow()}] 토큰 신규 발급`);
  return token.v;
}

async function kis(path, trId, params) {
  await sleep(230);
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, {
    headers: {
      authorization: `Bearer ${await getToken()}`, appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET, tr_id: trId, custtype: 'P',
    },
    signal: AbortSignal.timeout(25_000),
  });
  const j = await res.json();
  if (j.rt_cd !== '0') throw new Error(`${j.msg_cd ?? ''} ${String(j.msg1 ?? '').trim()}`.slice(0, 80));
  return j;
}

const OUT = () => join(OUT_DIR, `flow-${kstDate()}.jsonl`);
const rec = (o) => appendFileSync(OUT(), JSON.stringify(o) + '\n');

async function pollOnce() {
  const at = kstNow(), hm = kstHm();
  for (const code of CODES) {
    const row = { at, hm, code };
    try {
      const a = await kis('/uapi/domestic-stock/v1/quotations/investor-trend-estimate', 'HHPTJ04160200', { MKSC_SHRN_ISCD: code });
      // gb 별로 남긴다. **몇 개가 차 있는지**가 Q1 의 답이다.
      row.est = (a.output2 ?? []).map(r => ({ gb: n(r.bsop_hour_gb), f: n(r.frgn_fake_ntby_qty), o: n(r.orgn_fake_ntby_qty) }))
        .sort((x, y) => x.gb - y.gb);
      row.estN = row.est.length;
    } catch (e) { row.estErr = String(e.message); }
    try {
      const p = await kis('/uapi/domestic-stock/v1/quotations/program-trade-by-stock', 'FHPPG04650100',
        { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
      const r0 = (p.output ?? [])[0];
      if (r0) {
        row.pg = n(r0.whol_smtn_ntby_qty);
        row.pgAmt = n(r0.whol_smtn_ntby_tr_pbmn);
        row.pgHour = String(r0.bsop_hour);          // 데이터 시각 — 폴링 시각과의 차이가 지연이다
        row.vol = n(r0.acml_vol);
        row.px = n(r0.stck_prpr);
      }
    } catch (e) { row.pgErr = String(e.message); }
    rec(row);
    const est = row.estN == null ? 'err' : `gb${row.estN}개${row.est?.length ? `(최신 외${(row.est.at(-1).f / 1000).toFixed(0)}천주)` : ''}`;
    console.log(`  ${code} ${est} · 프로그램 ${row.pg == null ? 'err' : (row.pg / 1000).toFixed(0) + '천주 @' + row.pgHour}`);
  }
}

console.log(`=== 장중 수급 수집 시작 ${kstNow()} · ${CODES.length}종목 · ${POLL_SEC}초 간격 ===`);
console.log(`출력: ${OUT()}`);
if (ONCE) { await pollOnce(); process.exit(0); }

// 09:00 이전이면 대기, 15:40 넘으면 종료. 장중만 찍는다(장외 값은 Q1·Q2 에 무의미).
while (true) {
  const hm = kstHm();
  if (hm >= 1540) { console.log(`[${kstNow()}] 15:40 경과 — 수집 종료. 판정: node judge-flow-intraday.mjs`); break; }
  if (hm < 900) { console.log(`[${kstNow()}] 장 시작 대기(09:00)…`); await sleep(60_000); continue; }
  console.log(`[${kstNow()}]`);
  try { await pollOnce(); } catch (e) { console.log(`  폴 실패(계속): ${String(e.message).slice(0, 80)}`); }
  await sleep(POLL_SEC * 1000);
}
