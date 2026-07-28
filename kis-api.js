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

async function kisGet(path, trId, params, attempt = 0) {
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
  if (j.rt_cd !== '0') {
    const msg = String(j.msg1 ?? res.status);
    // 레이트리밋("초당 거래건수를 초과하였습니다") → 지수 백오프 재시도.
    //   2026-07-27 실측: 앱키를 flow-snapshot·forecast·섀도우가 공유해서 80ms 페이싱에도 15%가 이걸로 실패,
    //   그게 조용히 데이터 결손으로 남았다. 재시도가 없으면 표본이 레이트리밋 패턴에 편향된다.
    if (attempt < 4 && /초당|거래건수|EGW00201/.test(msg)) {
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      return kisGet(path, trId, params, attempt + 1);
    }
    throw new Error(`KIS ${trId}: ${msg}`);
  }
  return j;
}

/**
 * 국내주식 최근 일봉(약 30거래일) — [{date, close, volume, high, low, open}] 최신순.
 * FHKST01010400. Toss와 별개 계좌라 라이브봇 세션 경합 없음. 거래량(acml_vol) 포함 = volRatio 복원용.
 */
export async function getDailyPrices(code) {
  const j = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-daily-price', 'FHKST01010400', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: code,
    FID_PERIOD_DIV_CODE: 'D',
    FID_ORG_ADJ_PRC: '1',
  });
  return (j.output ?? [])
    .filter(r => r.stck_bsop_date && r.stck_clpr)
    .map(r => ({
      date: r.stck_bsop_date,
      close: Number(r.stck_clpr),
      volume: Number(r.acml_vol),
      high: Number(r.stck_hgpr),
      low: Number(r.stck_lwpr),
      open: Number(r.stck_oprc),
    }));
}

/**
 * 국내주식 종목투자의견(애널리스트 리포트) — [{date, firm, opinion, prevOpinion, targetPrice, closeAtReport, deviationPct}] 최신순.
 * FHKST663300C0. 실측 검증(2026-07-24): 삼성전자 90일 53건 OK / 가온전선 1건(NotRated) — 커버리지는 종목마다 큼.
 * prevOpinion(rgbf_invt_opnn)과 비교하면 상향·하향 조정(업/다운그레이드) 감지 가능.
 * ※ 목표가는 애널리스트 특성상 하락장에서 갱신이 늦어 과대(stale)할 수 있음 — 상승여력 해석 시 주의.
 */
export async function getInvestOpinion(code, { days = 90 } = {}) {
  const kst = (t) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
  const j = await kisGet('/uapi/domestic-stock/v1/quotations/invest-opinion', 'FHKST663300C0', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_COND_SCR_DIV_CODE: '16633',
    FID_INPUT_ISCD: code,
    FID_INPUT_DATE_1: kst(Date.now() - days * 86_400_000),
    FID_INPUT_DATE_2: kst(Date.now()),
  });
  return (j.output ?? [])
    .filter(r => r.stck_bsop_date)
    .map(r => ({
      date: r.stck_bsop_date,
      firm: String(r.mbcr_name ?? '').trim(),
      opinion: String(r.invt_opnn ?? '').trim(),
      prevOpinion: String(r.rgbf_invt_opnn ?? '').trim(),
      targetPrice: Number(r.hts_goal_prc) || null,
      closeAtReport: Number(r.stck_prdy_clpr) || null,
      deviationPct: Number(r.dprt) || null,   // 리포트 시점 종가의 목표가 대비 괴리율(%)
    }));
}

/**
 * 당일 1분봉 (기준시각 이전 최대 30건) — FHKST03010200.
 * 2026-07-27 추가: 라이브봇이 쓰는 Toss 세션과 경합 없이 장중 분봉을 보려면 KIS 경로가 유일하다.
 * @param code 종목코드, @param hhmmss 기준시각(미지정=지금). 반환: {now, bars:[{hhmm,o,h,l,c,v}] 오래된순}
 */
export async function getMinuteBars(code, hhmmss) {
  const hh = hhmmss ?? (() => { const d = new Date(Date.now() + 9 * 3600_000); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + '00'; })();
  const j = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
    FID_ETC_CLS_CODE: '',
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: code,
    FID_INPUT_HOUR_1: hh,
    FID_PW_DATA_INCU_YN: 'N',
  });
  const o1 = j.output1 ?? {};
  const bars = (j.output2 ?? [])
    .filter(r => r.stck_prpr && r.cntg_vol != null)
    .map(r => ({ hhmm: String(r.stck_cntg_hour ?? '').slice(0, 4), o: Number(r.stck_oprc), h: Number(r.stck_hgpr), l: Number(r.stck_lwpr), c: Number(r.stck_prpr), v: Number(r.cntg_vol) }))
    .reverse(); // KIS는 최신순 → 오래된순으로
  return { now: Number(o1.stck_prpr) || (bars.at(-1)?.c ?? 0), prevClose: Number(o1.stck_prdy_clpr) || null, acmlVol: Number(o1.acml_vol) || null, bars };
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
