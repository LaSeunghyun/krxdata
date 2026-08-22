/**
 * diag-top-gainers.mjs — 오늘 급등 상위가 봇 유니버스·후보에 있었는지 판정
 *
 * 왜: 2026-08-04 아침 급등을 놓쳤다는 관측. diag-missed-move 로 보니 어제 후보 19종목 중
 *     최대 상승이 +2.29% 로 "급등"이 아니었다 → 사용자가 본 종목은 **후보 밖**일 가능성이 크다.
 *     그렇다면 원인은 AI 판단이나 자본이 아니라 **유니버스 정의**다. 원인이 다르면 처방도 다르다.
 *
 * 방법: KIS 등락률 상위(FHPST01700000)로 실제 급등 상위를 받고,
 *       ① 시총 상위 420 유니버스(라이브 조건과 동일)에 있는가
 *       ② 있었다면 왜 후보가 아니었나(rsi2/hi120 조건 미달인가)
 *
 * 레이트 주의: collect-flow-intraday 가 동시에 KIS 를 쓰므로 페이싱을 넉넉히 준다(600ms).
 *   08-04 실측: 240ms 로 돌렸다가 "초당 거래건수를 초과하였습니다" 로 1건 유실했다.
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://openapi.koreainvestment.com:9443';
const TOK_F = join(__dirname, 'flow-intraday', '.kis-token.json');
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
  if (!j.access_token) throw new Error(`토큰 실패 ${r.status}`);
  token = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  writeFileSync(TOK_F, JSON.stringify(token));
  return token.v;
}
async function kis(path, trId, params, pace = 600) {
  await sleep(pace);
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
  if (j.rt_cd !== '0') throw new Error(`${j.msg_cd ?? ''} ${String(j.msg1 ?? '').trim()}`.slice(0, 70));
  return j;
}
async function db(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j?.message ?? 'DB 오류');
  return j;
}

// 라이브와 동일한 유니버스 조건 (stock-live.mjs:213)
const uni = await db(`
  SELECT stock_code, corp_name, mrkt_ctg, market_cap_tril, avg_turnover_20d
  FROM stock_analysis
  WHERE current_price >= 1000 AND current_price < 3000000 AND avg_turnover_20d >= 3000000000
  ORDER BY market_cap_tril DESC NULLS LAST LIMIT 420`);
const uniSet = new Map(uni.map(r => [r.stock_code, r]));
// 유동성 필터 전 전체(왜 빠졌는지 구분용)
const all = await db(`SELECT stock_code, corp_name, mrkt_ctg, market_cap_tril, avg_turnover_20d, current_price FROM stock_analysis`);
const allMap = new Map(all.map(r => [r.stock_code, r]));

console.log(`유니버스 420 로드 · stock_analysis 전체 ${all.length}종목\n`);
console.log('=== 오늘 등락률 상위 (KOSPI+KOSDAQ) ===');

const out = [];
for (const [iscd, label] of [['0000', '전체']]) {
  const j = await kis('/uapi/domestic-stock/v1/ranking/fluctuation', 'FHPST01700000', {
    fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20170', fid_input_iscd: iscd,
    fid_rank_sort_cls_code: '0',          // 0=상승률순
    fid_input_cnt_1: '0', fid_prc_cls_code: '0', fid_input_price_1: '', fid_input_price_2: '',
    fid_vol_cnt: '', fid_trgt_cls_code: '0', fid_trgt_exls_cls_code: '0', fid_div_cls_code: '0', fid_rsfl_rate1: '', fid_rsfl_rate2: '',
  });
  for (const r of (j.output ?? []).slice(0, 25)) {
    const code = r.stck_shrn_iscd ?? r.mksc_shrn_iscd;
    out.push({
      code, name: r.hts_kor_isnm, chg: Number(r.prdy_ctrt), px: n(r.stck_prpr),
      inUni: uniSet.has(code), meta: allMap.get(code),
    });
  }
}

console.log('종목                등락      시총(조)  일평균거래대금  유니버스  제외사유');
console.log('─'.repeat(88));
let inUniCount = 0;
for (const r of out) {
  const m = r.meta;
  let why = '';
  if (r.inUni) { inUniCount++; why = '— 포함'; }
  else if (!m) why = 'stock_analysis 에 없음(미수집)';
  else if (Number(m.avg_turnover_20d ?? 0) < 3e9) why = `거래대금 ${(Number(m.avg_turnover_20d ?? 0) / 1e8).toFixed(0)}억 < 30억`;
  else if (Number(m.current_price ?? 0) < 1000) why = '주가 < 1,000원';
  else why = `시총 순위 420위 밖 (${Number(m.market_cap_tril ?? 0).toFixed(2)}조)`;
  console.log(
    `${String(r.name).slice(0, 16).padEnd(17)} ${((r.chg >= 0 ? '+' : '') + r.chg.toFixed(2) + '%').padStart(8)}  ` +
    `${m ? Number(m.market_cap_tril ?? 0).toFixed(2).padStart(7) : '      -'}  ` +
    `${m ? ((Number(m.avg_turnover_20d ?? 0) / 1e8).toFixed(0) + '억').padStart(10) : '         -'}  ` +
    `${(r.inUni ? '●' : '·').padStart(6)}   ${why}`
  );
}
console.log(`\n=== 판정 ===`);
console.log(`  급등 상위 25종목 중 유니버스 포함: ${inUniCount}건 / 25`);
console.log(`  → 포함이 적으면 원인은 AI 판단·자본이 아니라 **유니버스 정의**(시총 420 + 거래대금 30억)다.`);
console.log(`  → 포함이 많으면 원인은 진입조건(rsi2 과매도 / hi120 돌파)이 이 급등을 못 잡는다는 것이다.`);
