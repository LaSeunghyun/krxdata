/**
 * kis-extra.mjs - 신규 수집기용 KIS 조회 헬퍼. kis-api.js(매매 경로 import)는 건드리지 않는다.
 * 토큰은 kis-api.js 와 같은 디스크 캐시(.kis-token.json)를 읽는다. 없거나 만료면 직접 발급한다.
 * 모든 호출은 throttle 오류에 대해 백오프 재시도(lib/retry.mjs).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { withBackoff } from './lib/retry.mjs';

const BASE = 'https://openapi.koreainvestment.com:9443';
const TOKEN_CACHE = join(dirname(fileURLToPath(import.meta.url)), '.kis-token.json');
let token = null;

async function getToken() {
  if (!token && existsSync(TOKEN_CACHE)) {
    try { const t = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')); if (t?.value && t?.expiresAt) token = t; } catch {}
  }
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const res = await fetch(`${BASE}/oauth2/tokenP`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`KIS 토큰 발급 실패: ${res.status} ${j.error_description ?? ''}`);
  token = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  try { writeFileSync(TOKEN_CACHE, JSON.stringify(token)); } catch {}
  return token.value;
}

/** KIS GET. rt_cd !== '0' 이면 throw(메시지에 tr_id 접두). throttle 은 withBackoff 로 재시도. */
export async function kisGetRetry(path, trId, params) {
  return withBackoff(async () => {
    const u = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await fetch(u, {
      headers: { authorization: `Bearer ${await getToken()}`, appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET, tr_id: trId, custtype: 'P' },
      signal: AbortSignal.timeout(20_000),
    });
    let j;
    try { j = await res.json(); } catch { throw new Error(`KIS ${trId}: 비JSON 응답 HTTP ${res.status}`); }
    if (j.rt_cd !== '0') throw new Error(`KIS ${trId}: ${String(j.msg1 ?? j.message ?? res.status)} [${j.msg_cd ?? ''}]`);
    return j;
  }, { retries: 2, base: 700 }); // 이 계층이 유일한 KIS 재시도 층: 호출당 최대 3회
}
