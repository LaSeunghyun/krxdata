/**
 * probe-investor-market2.mjs — inquire-investor-daily-by-market 필드 채우기 (반복 탐색)
 *
 * 1차에서 이 경로는 **실존**이 확인됐다(누락 필드명을 에러로 알려줬다):
 *   FHPTJ04030000 → "FID_INPUT_ISCD_2 없음"
 *   FHPTJ04040000 → "FID_INPUT_DATE_1 없음" (일별 → 장중 아님)
 * 에러가 누락 필드를 하나씩 알려주므로 채워가며 성공 조합을 찾는다.
 *
 * 목표: **시장 단위 투자자별 매매동향이 장중 몇 분 간격으로 나오는지**.
 * 종목별은 하루 5회(KRX 공표시각)로 확정됐다. 시장 단위가 촘촘하면 레짐 판단에는 쓸 수 있다.
 */
import 'dotenv/config';

const BASE = 'https://openapi.koreainvestment.com:9443';
let token = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getToken() {
  if (token && Date.now() < token.exp - 60_000) return token.v;
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

const PATH = '/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market';

async function call(trId, params) {
  await sleep(230);
  const u = new URL(BASE + PATH);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  try {
    const res = await fetch(u, {
      headers: {
        authorization: `Bearer ${await getToken()}`, appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET, tr_id: trId, custtype: 'P',
      },
      signal: AbortSignal.timeout(25_000),
    });
    return await res.json();
  } catch (e) { return { rt_cd: 'X', msg1: String(e.message).slice(0, 60) }; }
}

/** 에러가 알려주는 누락 필드를 채워가며 최대 8회 반복. */
async function autoFill(trId, seed, guesses) {
  let params = { ...seed };
  for (let i = 0; i < 8; i++) {
    const j = await call(trId, params);
    if (j.rt_cd === '0') return { ok: true, params, j };
    const miss = String(j.msg1 ?? '').match(/NOT FOUND \[([A-Z0-9_]+)\]/)?.[1];
    if (!miss) return { ok: false, params, msg: `${j.msg_cd ?? ''} ${String(j.msg1 ?? '').trim()}` };
    params[miss] = guesses[miss] ?? '0';
    console.log(`    누락 ${miss} → '${params[miss]}' 로 채움`);
  }
  return { ok: false, params, msg: '8회 반복 후에도 미해결' };
}

const GUESS = {
  FID_INPUT_ISCD: '0001',            // 0000 전체 · 0001 코스피 · 1001 코스닥
  FID_INPUT_ISCD_1: 'KSP',
  FID_INPUT_ISCD_2: 'KSP',
  FID_COND_MRKT_DIV_CODE: 'U',
  FID_INPUT_DATE_1: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ''),
  FID_INPUT_DATE_2: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ''),
  FID_INPUT_HOUR_1: '0',
  FID_DIV_CLS_CODE: '0',
  FID_COND_SCR_DIV_CODE: '16449',
};

console.log(`실행 KST ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}\n`);

for (const trId of ['FHPTJ04030000', 'FHPTJ04040000']) {
  console.log(`【${trId}】`);
  const r = await autoFill(trId, { FID_INPUT_ISCD: '0001' }, GUESS);
  if (!r.ok) { console.log(`  ✗ 실패: ${r.msg}\n     최종 params ${JSON.stringify(r.params)}\n`); continue; }
  console.log(`  ✓ 성공 params ${JSON.stringify(r.params)}`);
  for (const key of ['output', 'output1', 'output2']) {
    const o = r.j[key];
    if (!o) continue;
    const arr = Array.isArray(o) ? o : [o];
    if (!arr.length) { console.log(`     ${key}: 빈 배열`); continue; }
    console.log(`     ${key}: ${arr.length}행 · 키 ${Object.keys(arr[0]).join(' ')}`);
    for (const row of arr.slice(0, 6)) console.log(`        ${JSON.stringify(row)}`);
  }
  console.log();
}
