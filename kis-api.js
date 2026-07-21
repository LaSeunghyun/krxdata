/**
 * kis-api.js — 한국투자증권 OpenAPI 래퍼 (시세성 조회 전용, 주문 없음)
 * 실측 검증(2026-07-21): tokenP 발급 OK, FHKST01010900(종목별 투자자매매동향) OK.
 * 수급(외국인·기관·개인 순매수)은 장마감 후 확정 — 당일 장중엔 빈 값이 정상.
 * env: KIS_APP_KEY, KIS_APP_SECRET (files/.env)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BASE = 'https://openapi.koreainvestment.com:9443';
// 토큰 디스크 캐시: KIS는 토큰 발급 1분당 1회 제한 + 토큰 ~24h 유효.
// 프로세스(forecast-run·검증 스크립트)가 공유하도록 디스크에 캐시 — 재발급 rate-limit(403) 방지.
const TOKEN_CACHE = join(dirname(fileURLToPath(import.meta.url)), '.kis-token.json');

let token = null; // { value, expiresAt }
async function getToken() {
  if (!token && existsSync(TOKEN_CACHE)) {
    try { const t = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')); if (t?.value && t?.expiresAt) token = t; } catch {}
  }
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const res = await fetch(`${BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`KIS 토큰 발급 실패: ${res.status} ${j.error_description ?? ''}`);
  token = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  try { writeFileSync(TOKEN_CACHE, JSON.stringify(token)); } catch {}
  return token.value;
}

export function isKisConfigured(env = process.env) {
  return Boolean(env.KIS_APP_KEY && env.KIS_APP_SECRET);
}

async function kisGet(path, trId, params) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, {
    headers: {
      authorization: `Bearer ${await getToken()}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: trId,
      custtype: 'P',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (j.rt_cd !== '0') throw new Error(`KIS ${trId}: ${j.msg1 ?? res.status}`);
  return j;
}

/**
 * 종목별 일별 투자자 매매동향 — [{date, close, frgn_amt_mil, orgn_amt_mil, prsn_amt_mil}]
 * 금액 단위 백만원(ntby_tr_pbmn). 미확정(빈 값) 행은 제외.
 */
export async function getInvestorDaily(code) {
  const j = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: code,
  });
  return (j.output ?? [])
    .filter(r => r.frgn_ntby_tr_pbmn !== '' && r.frgn_ntby_tr_pbmn != null)
    .map(r => ({
      date: r.stck_bsop_date,
      close: Number(r.stck_clpr),
      frgn_amt_mil: Number(r.frgn_ntby_tr_pbmn),
      orgn_amt_mil: Number(r.orgn_ntby_tr_pbmn),
      prsn_amt_mil: Number(r.prsn_ntby_tr_pbmn),
    }));
}
