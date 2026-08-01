/**
 * verify-brief-key.mjs — 아침 브리핑 키 포맷 왕복 검증 (1회용).
 *
 * 왜 필요한가: 이전 검증 스크립트(diag-report-save.mjs)는 저장·조회 **양쪽 다 자기가 만든 대시 키**를
 * 써서 왕복에 성공했고, 그래서 "저장·조회 경로 정상"이라고 보고했다. 실제 코드는 저장측이
 * `toKstDateKey()`(대시 제거), 조회측이 `today`(대시 포함)라 **영원히 안 잡히는 상태**였는데
 * 테스트가 코드를 검증한 게 아니라 자기 자신을 검증해서 그걸 가렸다.
 * → 이번엔 **양쪽 산식을 각 소스에서 그대로 가져와** 비교한다.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { toKstDateKey } from './trading-time.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
};
const jsonb = (o) => `$j$${JSON.stringify(o).replace(/\$/g, '')}$j$::jsonb`;

// ── 저장측 산식: forecast-run.mjs 의 `kstDate()` = toKstDateKey() ──
const saveKey = `fc_report:pre:${toKstDateKey()}`;
// ── 조회측 산식: stock-live.mjs 의 `today = now().slice(0,10)` → morningBrief 내부 `today.replace(/-/g,'')` ──
const kst = () => new Date(Date.now() + 9 * 3_600_000);
const today = kst().toISOString().replace('T', ' ').slice(0, 19).slice(0, 10);
const dk = today.replace(/-/g, '');
const readKey = `fc_report:pre:${dk}`;

console.log(`저장측 키(forecast-run): ${saveKey}`);
console.log(`조회측 키(stock-live)  : ${readKey}`);
console.log(`키 일치: ${saveKey === readKey ? '✅ YES' : '❌ NO — 여전히 불일치'}`);

console.log('\n실제 왕복 검증:');
await q(`INSERT INTO paper_state (k, data, updated_at)
  VALUES ('${saveKey}', ${jsonb({ phase: 'pre', date: toKstDateKey(), hm: '07:00', text: '■ 브리핑 키 검증\n- 나스닥 -2.1%, 필라델피아 반도체 -3.4%\n- 이 줄이 보이면 stock-live 가 브리핑을 읽는다' })}, NOW())
  ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
console.log('  저장 완료(저장측 산식으로)');

const rows = await q(`SELECT data->>'text' AS t, data->>'hm' AS hm FROM paper_state
  WHERE k IN ('fc_report:pre:${dk}', 'fc_report:close:${dk}') ORDER BY k = 'fc_report:pre:${dk}' DESC LIMIT 1`);
if (rows?.[0]?.t) console.log(`  조회 성공(조회측 산식으로) → ${rows[0].hm}\n---\n${rows[0].t}\n---`);
else console.log('  ❌ 조회 실패 — 브리핑이 여전히 안 잡힌다');

await q(`DELETE FROM paper_state WHERE k = '${saveKey}'`);
console.log('테스트 행 정리 완료');
process.exit(rows?.[0]?.t ? 0 : 1);
