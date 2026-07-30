/**
 * diag-toss-kis-close.mjs — Toss 일봉 종가 vs KIS 정규장 종가 대조 (2026-07-30)
 *
 * ═══ 왜 ═══
 * 2026-07-29 15:35 판정(실제로는 리부트로 17:39 지연 실행)에서 봇이 읽은 종가가
 * KIS 정규장 종가와 어긋났다:
 *   삼성전자 Toss 212,000 vs KIS 208,500 (+1.68%)
 *   하이브   Toss 167,700 vs KIS 170,300 (-1.53%)
 *   한국항공 Toss 118,000 vs KIS 117,500 (+0.43%)
 *   카카오   Toss  35,300 vs KIS  35,300 (0.00%)
 *
 * ═══ 판정할 분기 ═══
 * (A) Toss의 **확정된** 일봉 종가 = KRX 정규장 종가
 *     → 어제 어긋난 건 장중(NXT 진행중) 스냅샷을 읽은 일시적 artifact.
 *       백테는 오염 없음. 라이브 15:35 읽기만 문제 → 수정 범위가 작다.
 * (B) Toss의 확정된 일봉 종가 = NXT 애프터(~20:00) 최종가
 *     → 백테의 종가 자체가 KRX 종가가 아니다. `closeToday > ma` 비교는
 *       백테에선 양쪽 다 NXT통합이라 내부일관적이지만, 라이브 15:35에선
 *       closeToday만 NXT 5분치이고 ma는 NXT확정 과거봉 → **비대칭**.
 *
 * 근거 단서(기존 실측): diag-rsi2-exit-1m.mjs:155 "일봉 시가는 88.9%가 08시 첫봉과 일치
 * → 일봉이 KRX+NXT 통합", forecast-intraday.mjs:5 "토스 1분봉 = 정규장+NXT프리+NXT애프터 통합".
 * 시가가 NXT프리(08:00)를 반영한다면 종가도 NXT애프터(20:00)를 반영할 것이라는 대칭 가설.
 *
 * ═══ 방법 ═══
 * 로컬 candles-daily.jsonl(Toss 수집분, 07-24까지 = 전부 확정봉)과
 * KIS getDailyPrices(~30거래일, 정규장 확정)를 **겹치는 날짜**에서 종목별로 대조.
 * Toss 토큰이 필요 없다 → 라이브봇 세션 경합 없음.
 *
 * 판정 기준(사전 선언):
 *   · 불일치율 < 5% 이고 |평균괴리| < 0.05% → (A) 확정봉은 KRX 종가와 같다
 *   · 불일치율 > 30% 또는 |평균괴리| > 0.2%  → (B) 확정봉이 NXT를 포함한다
 *   · 그 사이 → 미확정, 추가 검증 필요
 *
 * 실행: node diag-toss-kis-close.mjs [--codes 005930,035720,...] [--days 30]
 */
import 'dotenv/config';
import { createReadStream } from 'fs';
import readline from 'readline';
import { getDailyPrices } from './kis-api.js';

const argOf = (k, d) => { const i = process.argv.lastIndexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

// 보유 5종목 + 대형/중형/소형 대조군. NXT 참여는 유동성에 비례하므로 규모를 섞는다.
const DEFAULT_CODES = [
  '005930', '035720', '352820', '047810', '138930',   // 현재 보유
  '000660', '005380', '035420', '051910', '207940',   // 대형
  '086520', '112040', '214150', '145020', '096770',   // 중형
];
const CODES = argOf('--codes', DEFAULT_CODES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const NAMES = {
  '005930': '삼성전자', '035720': '카카오', '352820': '하이브', '047810': '한국항공우주', '138930': 'BNK금융지주',
  '000660': 'SK하이닉스', '005380': '현대차', '035420': 'NAVER', '051910': 'LG화학', '207940': '삼성바이오로직스',
  '086520': '에코프로', '112040': '위메이드', '214150': '클래시스', '145020': '휴젤', '096770': 'SK이노베이션',
};

// ── 1) 로컬 Toss 일봉 로드 ────────────────────────────────────────────────────
const want = new Set(CODES);
const toss = new Map();   // code → Map(YYYYMMDD → close)
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => {
    const head = l.slice(0, 40);
    for (const c of want) {
      if (!head.includes(`"${c}"`)) continue;
      try {
        const j = JSON.parse(l);
        if (j.code !== c) continue;
        const m = new Map();
        for (let i = 0; i < j.d.length; i++) m.set(String(j.d[i]), j.c[i]);
        toss.set(c, m);
      } catch {}
    }
  });
  rl.on('close', res);
});

// ── 2) KIS 정규장 일봉 대조 ───────────────────────────────────────────────────
const rows = [];
for (const code of CODES) {
  const tm = toss.get(code);
  if (!tm) { console.error(`! ${code} 로컬 Toss 일봉 없음 — 건너뜀`); continue; }
  let kis;
  try { kis = await getDailyPrices(code); }
  catch (e) { console.error(`! ${code} KIS 실패: ${String(e.message).slice(0, 60)}`); continue; }
  await new Promise(r => setTimeout(r, 350));   // KIS 초당 제한 회피

  for (const k of kis) {
    const tc = tm.get(k.date);
    if (tc == null) continue;                    // 겹치지 않는 날짜
    rows.push({ code, date: k.date, toss: tc, kis: k.close, diffPct: (tc / k.close - 1) * 100 });
  }
  process.stdout.write('.');
}
console.log('');

if (!rows.length) { console.error('겹치는 표본 0건 — 판정 불가'); process.exit(1); }

// ── 3) 집계 ───────────────────────────────────────────────────────────────────
const mismatch = rows.filter(r => r.toss !== r.kis);
const absPct = rows.map(r => Math.abs(r.diffPct)).sort((a, b) => a - b);
const mean = rows.reduce((s, r) => s + r.diffPct, 0) / rows.length;
const meanAbs = absPct.reduce((s, v) => s + v, 0) / absPct.length;
const med = absPct[Math.floor(absPct.length / 2)];
const p95 = absPct[Math.floor(absPct.length * 0.95)];

const dates = [...new Set(rows.map(r => r.date))].sort();
console.log(`=== 표본 ===`);
console.log(`종목 ${new Set(rows.map(r => r.code)).size}개 · 종목·일 ${rows.length}건 · 날짜 ${dates[0]} ~ ${dates.at(-1)}`);

console.log(`\n=== 전체 괴리 (Toss일봉종가 / KIS정규장종가 - 1) ===`);
console.log(`불일치(값이 다른 건)  ${mismatch.length}/${rows.length} = ${(mismatch.length / rows.length * 100).toFixed(1)}%`);
console.log(`평균 괴리(부호포함)   ${mean >= 0 ? '+' : ''}${mean.toFixed(4)}%`);
console.log(`평균 |괴리|           ${meanAbs.toFixed(4)}%`);
console.log(`중앙 |괴리|           ${med.toFixed(4)}%   ·  p95 |괴리| ${p95.toFixed(4)}%`);

console.log(`\n=== 종목별 ===`);
console.log('종목                 표본  불일치   평균괴리   최대|괴리|');
for (const code of CODES) {
  const rs = rows.filter(r => r.code === code);
  if (!rs.length) continue;
  const mm = rs.filter(r => r.toss !== r.kis).length;
  const mn = rs.reduce((s, r) => s + r.diffPct, 0) / rs.length;
  const mx = Math.max(...rs.map(r => Math.abs(r.diffPct)));
  console.log(`${(NAMES[code] ?? code).padEnd(14)}${String(rs.length).padStart(6)}${(mm + '/' + rs.length).padStart(8)}   ${(mn >= 0 ? '+' : '') + mn.toFixed(4)}%`.padEnd(58) + `${mx.toFixed(3)}%`);
}

if (mismatch.length) {
  console.log(`\n=== 불일치 상위 12건 ===`);
  for (const r of mismatch.slice().sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct)).slice(0, 12)) {
    console.log(`${r.date} ${(NAMES[r.code] ?? r.code).padEnd(14)} Toss ${r.toss.toLocaleString().padStart(9)} · KIS ${r.kis.toLocaleString().padStart(9)} → ${(r.diffPct >= 0 ? '+' : '') + r.diffPct.toFixed(3)}%`);
  }
}

// ── 4) 사전 선언 기준으로 판정 ────────────────────────────────────────────────
const mmRate = mismatch.length / rows.length * 100;
console.log(`\n=== 판정 (기준은 결과 보기 전 선언) ===`);
if (mmRate < 5 && Math.abs(mean) < 0.05) {
  console.log(`(A) 확정 Toss 일봉 종가 = KRX 정규장 종가.`);
  console.log(`    → 백테는 오염 없음. 어제 괴리는 NXT 진행중 스냅샷을 읽은 라이브 artifact.`);
  console.log(`    → 수정 범위: 라이브 15:35 판정이 '확정 정규장 종가'를 읽도록 보장하는 것만.`);
} else if (mmRate > 30 || Math.abs(mean) > 0.2) {
  console.log(`(B) 확정 Toss 일봉 종가가 NXT를 포함한다.`);
  console.log(`    → 백테의 종가가 KRX 종가가 아니다. 라이브 15:35은 NXT 5분치만 반영 → 비대칭.`);
  console.log(`    → 수정 범위: 판정 시점 또는 종가 소스 정합화. 백테 재검증 필요.`);
} else {
  console.log(`미확정 — 불일치율 ${mmRate.toFixed(1)}% · 평균괴리 ${mean.toFixed(4)}%가 두 기준 사이.`);
  console.log(`    → 추가 검증 필요(NXT 참여종목만 분리, 1분봉 20:00 최종가 직접 대조).`);
}
console.log(`\n※ 로컬 candles-daily.jsonl은 07-24까지 = 전부 확정봉이다(장중 스냅샷 아님).`);
console.log(`※ KIS FID_ORG_ADJ_PRC='1' = 원주가. 수정주가 이벤트가 있으면 그 종목·날짜는 괴리로 나온다.`);
