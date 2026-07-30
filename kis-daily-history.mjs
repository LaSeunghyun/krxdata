/**
 * kis-daily-history.mjs — KIS 기간별 일봉(FHKST03010100) 수집 · KRX 정규장 확정 종가
 *
 * ═══ 왜 별 파일인가 ═══
 * kis-api.js 는 VM의 라이브 서비스(ai-shadow·forecast)가 import한다. 연구용 신규 함수를
 * 거기 넣으면 VM 동기화 대상이 되고 회귀 위험이 생긴다 → 로컬 연구 전용으로 분리.
 *
 * ═══ 목적 ═══
 * 2026-07-30 확정: Toss 일봉 = KRX정규장 + NXT(프리 08:00~08:50 · 애프터 15:30~20:00) 통합.
 * (상위집합 제약 Toss고가>=KIS고가 AND Toss저가<=KIS저가 가 390/390 = 100% 만족)
 * 백테는 그 NXT통합 종가로 검증됐는데 라이브 15:35 판정은 사실상 KRX 종가를 읽는다
 * → MA3 청산조건 판정이 5.1% 뒤집힌다(10:10 대칭 = 편향 아닌 노이즈).
 * 정합화(가): 라이브를 KRX 종가로 통일하고 **백테도 KRX 종가로 재검증**한다.
 * 그 재검증에 필요한 KRX 확정 일봉 전체 히스토리를 만드는 게 이 모듈이다.
 *
 * ═══ 수정주가 주의 ═══
 * FID_ORG_ADJ_PRC: '0'=수정주가반영 · '1'=미반영(원주가).
 * kis-api.js 의 getDailyPrices 는 '1'(원주가)을 쓴다. Toss는 수정주가로 보이므로
 * 장기 히스토리 비교에는 '0'을 써야 한다 — 이 모듈은 기본 '0', 검증용으로 둘 다 뽑을 수 있게 한다.
 * (26거래일 표본에서 상위집합 100%가 성립한 건 그 구간에 권리변동이 없었기 때문이다.
 *  868거래일로 늘리면 분할·무상증자가 섞여 설정 차이가 그대로 오염으로 남는다.)
 *
 * FHKST03010100 은 호출당 최대 100행 → 868거래일이면 종목당 9~10회 페이징.
 */
import 'dotenv/config';

const BASE = 'https://openapi.koreainvestment.com:9443';
let token = null;

async function getToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const res = await fetch(`${BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`토큰 발급 실패: ${res.status} ${j.error_description ?? ''}`);
  token = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
  return token.value;
}

/**
 * 전역 레이트 게이트 (2026-07-30).
 * 워커별 페이싱만 두면 동시성 N배로 총 속도가 N배가 되어 EGW00201(초당 거래건수 초과)이 난다.
 * 실측: 동시 12발 중 2발 즉시 거부. 워커 3개·페이싱 260ms(≈11.5 req/s)로 50종목 중 11종목 유실.
 * → 요청 **시작 시각**을 프로세스 전역에서 직렬화해 최소 간격을 강제한다. 이러면 워커 수와
 *   무관하게 총 throughput이 상한에 묶이고, 동시성은 지연 은닉에만 쓰인다.
 */
const GATE_MS = Number(process.env.KIS_GATE_MS ?? 120);   // ≈8.3 req/s — 실측 한계보다 낮게
let gate = Promise.resolve();
let lastAt = 0;
function rateGate() {
  gate = gate.then(async () => {
    const wait = lastAt + GATE_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
  });
  return gate;
}

const RETRY_MAX = 6;
async function kisGet(path, trId, params, attempt = 0) {
  await rateGate();
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let j, httpStatus = 0;
  try {
    const res = await fetch(u, {
      headers: {
        authorization: `Bearer ${await getToken()}`,
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
        tr_id: trId,
        custtype: 'P',
      },
      signal: AbortSignal.timeout(25_000),
    });
    httpStatus = res.status;
    j = await res.json();
  } catch (e) {
    // 네트워크·타임아웃도 재시도 대상 (조용한 결손 방지)
    if (attempt < RETRY_MAX) {
      await new Promise(r => setTimeout(r, 300 * 2 ** attempt + Math.floor(Math.random() * 200)));
      return kisGet(path, trId, params, attempt + 1);
    }
    throw new Error(`KIS ${trId} 통신실패: ${String(e.message).slice(0, 60)}`);
  }
  if (j.rt_cd !== '0') {
    const msg = String(j.msg1 ?? httpStatus);
    const code = String(j.msg_cd ?? '');
    // 레이트리밋은 지수백오프+지터로 재시도. 재시도가 없으면 결손이 조용히 남아 표본이 편향된다(2026-07-27 교훈).
    if (attempt < RETRY_MAX && (/초당|거래건수|EGW00201/.test(msg) || code === 'EGW00201' || httpStatus >= 500)) {
      await new Promise(r => setTimeout(r, 300 * 2 ** attempt + Math.floor(Math.random() * 200)));
      return kisGet(path, trId, params, attempt + 1);
    }
    throw new Error(`KIS ${trId}: ${msg}${code ? ` (${code})` : ''}`);
  }
  return j;
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * 한 종목의 KRX 정규장 일봉을 기간 전체로 수집. 최신순 → 오름차순으로 반환.
 * @param {string} code 6자리
 * @param {string} from YYYYMMDD (포함)
 * @param {string} to   YYYYMMDD (포함)
 * @param {{adj?: '0'|'1', paceMs?: number}} opt adj '0'=수정주가(기본) · '1'=원주가
 * @returns {Promise<Array<{date,open,high,low,close,volume}>>} 날짜 오름차순, 중복 제거
 */
export async function getDailyHistory(code, from, to, opt = {}) {
  const adj = opt.adj ?? '0';
  const paceMs = opt.paceMs ?? 260;
  const seen = new Map();
  let cursorTo = to;
  for (let guard = 0; guard < 40; guard++) {              // 40*100 = 4,000거래일 상한
    const j = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: from,
      FID_INPUT_DATE_2: cursorTo,
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: adj,
    });
    const rows = (j.output2 ?? []).filter(r => r?.stck_bsop_date && r?.stck_clpr);
    if (!rows.length) break;
    let oldest = null;
    for (const r of rows) {
      const d = r.stck_bsop_date;
      if (d < from) continue;
      if (!oldest || d < oldest) oldest = d;
      if (!seen.has(d)) seen.set(d, {
        date: d,
        open: Number(r.stck_oprc), high: Number(r.stck_hgpr),
        low: Number(r.stck_lwpr), close: Number(r.stck_clpr),
        volume: Number(r.acml_vol),
      });
    }
    if (!oldest || oldest <= from) break;
    // 다음 페이지: 가장 오래된 날짜의 하루 전까지
    const prev = new Date(`${oldest.slice(0, 4)}-${oldest.slice(4, 6)}-${oldest.slice(6, 8)}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const next = ymd(prev);
    if (next >= cursorTo) break;                          // 진전이 없으면 중단(무한루프 방지)
    cursorTo = next;
    await new Promise(r => setTimeout(r, paceMs));
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── CLI: 파일럿 검증 ─────────────────────────────────────────────────────────
// process.argv[1]은 `node -e`로 import될 때 undefined다 — 가드가 죽으면 import 자체가 실패한다.
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const code = process.argv[2] ?? '005930';
  const from = process.argv[3] ?? '20230102';
  const to = process.argv[4] ?? '20260729';
  for (const adj of ['0', '1']) {
    const t0 = Date.now();
    const rows = await getDailyHistory(code, from, to, { adj });
    const label = adj === '0' ? '수정주가' : '원주가  ';
    console.log(`${label} ${code}: ${rows.length}행 · ${rows[0]?.date} ~ ${rows.at(-1)?.date} · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
    if (rows.length) console.log(`         첫봉 c=${rows[0].close.toLocaleString()} · 끝봉 c=${rows.at(-1).close.toLocaleString()}`);
  }
}
