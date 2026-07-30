/**
 * verify-20260730.mjs — forecast-20260730.md 예측의 사후 채점용 스냅샷 수집
 *
 * 예측을 세운 뒤(08:02 KST) 사후에 값을 고칠 수 없게 하려면 관측을 기계가 찍어야 한다.
 * 지정 시각에 KIS로 스냅샷을 남긴다. 출력은 append-only(verify-20260730.jsonl).
 *
 * KIS는 KRX 정규장만 준다 → NXT 프리마켓(08:00~08:50) 예측(A-1)은 이걸로 검증 불가.
 * 대신 라이브봇 state의 lastPx(NXT 폴링값)를 프록시로 함께 기록한다.
 *
 * 실행: node verify-20260730.mjs
 */
import 'dotenv/config';
import { appendFileSync } from 'fs';
import { execSync } from 'child_process';
import { getDailyPrices } from './kis-api.js';

const OUT = 'verify-20260730.jsonl';
const TODAY = '20260730';

const HELD = { '005930': '삼성전자', '035720': '카카오', '352820': '하이브', '047810': '한국항공우주', '138930': 'BNK금융지주' };
const SOBUJANG = { '036930': '주성엔지니어링', '348210': '넥스틴', '240810': '원익IPS', '005290': '동진쎄미켐', '357780': '솔브레인', '084370': '유진테크', '042700': '한미반도체' };
const REF = { '000660': 'SK하이닉스' };
const ALL = { ...HELD, ...SOBUJANG, ...REF };

// 07-29 KRX 확정 종가 (기준선 — 예측 작성 시 사용한 값과 동일해야 한다)
const BASE = {
  '005930': 208500, '035720': 35300, '352820': 170300, '047810': 117500, '138930': 14960,
  '036930': 116100, '348210': 26400, '240810': 83200, '005290': 34300, '357780': 233500,
  '084370': 96800, '042700': 167600, '000660': 1401000,
};

// 채점 체크포인트 (KST HHMM). 09:00 개장 직후·09:30·11:00·15:35 종가확정 후.
const CHECKPOINTS = ['0902', '0931', '1100', '1540'];

const kstNow = () => {
  const d = new Date(Date.now() + 9 * 3_600_000);
  return { hhmm: String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0'), iso: d.toISOString().replace('Z', '+09:00') };
};

function botLastPx() {
  try {
    const raw = execSync(
      `ssh -i ~/.ssh/oracle-vm -o StrictHostKeyChecking=no -o ConnectTimeout=15 ubuntu@134.185.111.69 "cat ~/krxdata/stock-live-state.json"`,
      { encoding: 'utf8', timeout: 30_000 }
    );
    const st = JSON.parse(raw);
    const out = {};
    for (const [c, m] of Object.entries(st.meta ?? {})) out[c] = { lastPx: m.lastPx, exitAt: m.exitAt ?? null, judgedDay: m.judgedDay ?? null };
    return out;
  } catch (e) { return { _error: String(e.message).slice(0, 80) }; }
}

async function snapshot(label) {
  const rec = { label, at: kstNow().iso, quotes: {}, bot: botLastPx() };
  for (const [c, nm] of Object.entries(ALL)) {
    try {
      const d = await getDailyPrices(c);
      const t = d.find(r => r.date === TODAY);
      const prev = d.find(r => r.date < TODAY);
      rec.quotes[c] = t
        ? { name: nm, open: t.open, high: t.high, low: t.low, cur: t.close, base: BASE[c],
            chgPct: Number(((t.close / BASE[c] - 1) * 100).toFixed(2)),
            gapPct: Number(((t.open / BASE[c] - 1) * 100).toFixed(2)) }
        : { name: nm, note: '금일 봉 없음', prevDate: prev?.date ?? null, base: BASE[c] };
    } catch (e) { rec.quotes[c] = { name: nm, error: String(e.message).slice(0, 60) }; }
    await new Promise(r => setTimeout(r, 350));
  }
  appendFileSync(OUT, JSON.stringify(rec) + '\n');
  const s = Object.values(rec.quotes).filter(q => q.chgPct != null);
  console.log(`[${label} @ ${rec.at.slice(11, 16)}] 수집 ${s.length}종목 · 삼성전자 ${rec.quotes['005930']?.cur ?? '-'} (${rec.quotes['005930']?.chgPct ?? '-'}%)`);
  return rec;
}

// 시작 즉시 1회(프리마켓 상태 기록) → 이후 체크포인트마다
await snapshot('pre-open');
const done = new Set();
while (done.size < CHECKPOINTS.length) {
  const { hhmm } = kstNow();
  const hit = CHECKPOINTS.find(c => !done.has(c) && hhmm >= c);
  if (hit) { done.add(hit); await snapshot(hit); continue; }
  if (hhmm >= '1600') break;                       // 안전 종료
  await new Promise(r => setTimeout(r, 20_000));
}
console.log(`완료 — ${OUT} 에 ${done.size + 1}개 스냅샷`);
