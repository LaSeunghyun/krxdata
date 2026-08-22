/**
 * diag-selloff-character.mjs — 하락의 성격 판정: 투매(항복) vs 매수실종(거래위축) vs 갭 리프라이싱
 *
 * ═══ 왜 ═══
 * 2026-08-03 세션에서 "거래량 0.4~0.9배 → 투매가 아니라 매수실종"이라고 단정했는데,
 * 근거가 거래량비 하나였고 그 하나로는 세 가지를 가릴 수 없었다. 실제로:
 *   - 오늘 하락의 대부분은 **갭**(전일종가 108,820 → 시가 101,980)이다. 갭은 거래 없이 벌어지므로
 *     거래량이 낮은 게 당연하다 → 거래량비만 보면 항상 "매수실종"으로 오판한다.
 *   - 급락 구간(07-24~28) 수급은 외국인 -10.6조 / 개인 +11.9조였다. 매수 주체가 대량으로 있었다.
 * 그래서 하나가 아니라 **네 지표를 같이** 봐야 한다.
 *
 * ═══ 네 지표 (전부 KIS KRX 확정 일봉 + 수급 테이블로 측정 가능) ═══
 *  1) 갭% vs 장중%      — 하락이 밤새 리프라이싱인가, 장중 매매의 결과인가
 *  2) 거래량비(20일)     — 투매면 물량이 터진다. 위축이면 안 터진다
 *  3) CLV = (C-L)/(H-L) — 종가가 저가에 붙으면 끝까지 받아주는 매수가 없었다는 뜻
 *  4) 투자자별 순매수     — 누가 팔고 누가 받았나. **T+0 불가**(장마감 후 확정)
 *
 * ═══ 측정 불가 (중요) ═══
 * 교과서적 판별자는 **호가 잔량(매수측 depth)과 체결강도**다. 이건 이 시스템에 없다:
 * Toss 일봉·KIS 일봉 어디에도 호가가 없고, KIS 호가 API(FHKST01010200)는 실시간 스냅샷만 줘서
 * 과거 backfill 이 불가능하다. 필요하면 **앞으로 수집**해야 한다(장중 주기적 스냅샷 적재).
 * 즉 아래 판정은 근사이고, "호가가 말랐다"는 직접 증거는 아니다.
 *
 * ═══ 임계값 (사전 선언 · 관례적 값이며 백테로 검증된 값이 아니다) ═══
 *   갭 지배      : |갭%| >= 전체 등락의 70%
 *   물량 폭증    : 거래량비 >= 1.5
 *   물량 위축    : 거래량비 <  1.0
 *   저가 마감    : CLV <= 0.30
 *   고가 마감    : CLV >= 0.60
 *
 * 사용: node diag-selloff-character.mjs [from] [to] [code...]
 *   예: node diag-selloff-character.mjs 20260720 20260803 069500 229200 005930
 */
import { getDailyHistory } from './kis-daily-history.mjs';

const GAP_DOMINANT = 0.70;
const VOL_SURGE = 1.5;
const VOL_DRY = 1.0;
const CLV_LOW = 0.30;
const CLV_HIGH = 0.60;

const args = process.argv.slice(2);
const FROM = args[0] ?? '20260720';
const TO = args[1] ?? '20260803';
const CODES = args.length > 2 ? args.slice(2) : ['069500', '229200', '005930'];
const NAME = { '069500': 'KODEX200(코스피)', '229200': '코스닥150', '005930': '삼성전자' };

/** 수급(투자자별 순매수, 억원). 없으면 null — 오늘 것은 장마감 후에야 들어온다. */
async function loadFlows(codes, from, to) {
  const ref = process.env.SUPABASE_PROJECT_REF, key = process.env.SUPABASE_MANAGEMENT_KEY;
  if (!ref || !key) return null;
  const sql = `SELECT date, stock_code,
      ROUND((frgn_amt_mil/100)::numeric,0) AS f,
      ROUND((orgn_amt_mil/100)::numeric,0) AS o,
      ROUND((prsn_amt_mil/100)::numeric,0) AS p
    FROM stock_investor_flows
    WHERE stock_code IN (${codes.map(c => `'${c}'`).join(',')}) AND date BETWEEN '${from}' AND '${to}'`;
  try {
    const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    const m = new Map();
    for (const x of j) m.set(`${x.stock_code}|${x.date}`, { f: Number(x.f), o: Number(x.o), p: Number(x.p) });
    return m;
  } catch { return null; }
}

/**
 * 하락일의 성격 분류. 상승일은 분류하지 않는다(이 도구의 질문이 아니다).
 * 판정 순서가 중요하다 — 갭 지배를 먼저 걸러야 거래량비 오판(위 주석의 실패 사례)을 막는다.
 */
function classify({ retPct, gapPct, intraPct, volRatio, clv }) {
  if (retPct >= 0) return '상승일(해당없음)';
  // 갭 지배는 **갭이 하락 방향일 때만** 성립한다. 절대값만 보면 "갭 +2.64% 로 열렸다가
  // 종일 밀려 -0.72% 마감"(삼성전자 07-30) 같은 날이 "갭 리프라이싱"으로 오분류된다 —
  // 그건 정반대로 장중에 팔린 날이다.
  if (gapPct < 0 && Math.abs(gapPct) / Math.abs(retPct) >= GAP_DOMINANT) {
    return `갭 리프라이싱(장중 ${intraPct >= 0 ? '+' : ''}${intraPct.toFixed(1)}%)`;
  }
  // 갭은 상승인데 종가는 하락 = 장중 매도가 전부다. 이 경우 장중 기준으로 판정한다.
  if (gapPct > 0) {
    if (volRatio >= VOL_SURGE && clv <= CLV_LOW) return `장중 투매 — 갭상승(+${gapPct.toFixed(1)}%) 후 물량 터지며 저가 마감`;
    if (volRatio < VOL_DRY && clv <= CLV_LOW) return `장중 매수실종 — 갭상승(+${gapPct.toFixed(1)}%) 후 거래 위축에 저가 마감`;
  }
  if (volRatio >= VOL_SURGE && clv <= CLV_LOW) return '투매(항복) — 물량 터지고 저가 마감';
  if (volRatio >= VOL_SURGE && clv >= CLV_HIGH) return '투매 후 흡수 — 물량 터졌지만 되돌림';
  if (volRatio < VOL_DRY && clv <= CLV_LOW) return '매수실종 — 거래 위축에 저가 마감';
  if (volRatio < VOL_DRY) return '거래 위축(방향 애매)';
  return '혼재 — 판정 보류';
}

const flows = await loadFlows(CODES, FROM, TO);
if (!flows) console.log('※ 수급 조회 불가(키 부재 또는 실패) — 3지표만으로 판정한다\n');

for (const code of CODES) {
  const bars = await getDailyHistory(code, FROM, TO, { adj: '0' });
  if (!bars?.length) { console.log(`${code}: 데이터 없음`); continue; }
  // 거래량 20일 평균은 "그날 이전 20일"로 잡는다 — 당일을 포함하면 폭증일이 스스로를 희석한다.
  console.log(`\n═══ ${NAME[code] ?? code} (${code}) ═══`);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    const prevWin = bars.slice(Math.max(0, i - 20), i).map(x => Number(x.volume) || 0);
    if (prevWin.length < 5) continue;
    const avgVol = prevWin.reduce((a, c) => a + c, 0) / prevWin.length;
    const v = Number(b.volume) || 0;
    const volRatio = avgVol > 0 ? v / avgVol : 1;
    const retPct = (Number(b.close) / Number(prev.close) - 1) * 100;
    const gapPct = (Number(b.open) / Number(prev.close) - 1) * 100;
    const intraPct = (Number(b.close) / Number(b.open) - 1) * 100;
    const rng = Number(b.high) - Number(b.low);
    const clv = rng > 0 ? (Number(b.close) - Number(b.low)) / rng : 0.5;
    const fl = flows?.get(`${code}|${b.date}`);
    const flTxt = fl ? ` | 외${fl.f >= 0 ? '+' : ''}${fl.f}억 기${fl.o >= 0 ? '+' : ''}${fl.o}억 개${fl.p >= 0 ? '+' : ''}${fl.p}억` : ' | 수급없음';
    console.log(
      `  ${b.date} ${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%` +
      ` (갭 ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)} / 장중 ${intraPct >= 0 ? '+' : ''}${intraPct.toFixed(2)})` +
      ` 량 ${volRatio.toFixed(2)}배 CLV ${clv.toFixed(2)}${flTxt}`
    );
    if (retPct < 0) console.log(`      → ${classify({ retPct, gapPct, intraPct, volRatio, clv })}`);
  }
}

console.log(`
※ 한계: 호가 잔량·체결강도는 이 시스템에 없다(KIS 호가 API 는 실시간 스냅샷만 → backfill 불가).
   "매수실종"은 거래위축+저가마감의 **간접 증거**이고 호가가 말랐다는 직접 증거가 아니다.
   당일 수급은 장마감 후 확정이라 장중에는 3지표만으로 판단해야 한다.`);
