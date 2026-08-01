/** diag-report-save.mjs — forecast 보고서 paper_state 저장·조회 경로 검증 (1회용). */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
};
// forecast-run.mjs 와 **동일한** 헬퍼 (복사, 변형 금지)
const jsonb = (o) => (o == null ? 'NULL' : `$j$${JSON.stringify(o).replace(/\$/g, '')}$j$::jsonb`);

const KEY = 'fc_report:TEST:2026-08-01';
const payload = { phase: 'pre', date: '2026-08-01', hm: '07:00', engine: 'test', quality: 'A',
  text: '■ 시장 브리핑 테스트\n- 나스닥 -2.1%, 필라델피아 반도체 -3.4%\n- 환율 1,380원/$ · 특수문자 \'단일\' "이중" 10% (a) [b] {c}' };

console.log('1) paper_state 스키마 확인');
console.log(JSON.stringify(await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='paper_state' ORDER BY ordinal_position`)));

console.log('\n2) INSERT');
const ins = await q(`INSERT INTO paper_state (k, data, updated_at)
  VALUES ('${KEY}', ${jsonb(payload)}, NOW())
  ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
console.log('결과:', JSON.stringify(ins));

console.log('\n3) 키 존재 확인 (LIKE)');
console.log(JSON.stringify(await q(`SELECT k, updated_at FROM paper_state WHERE k LIKE 'fc_report:%'`)));

console.log('\n4) stock-live.morningBrief 와 동일한 쿼리');
const today = '2026-08-01';
const rows = await q(`SELECT data->>'text' AS t, data->>'hm' AS hm FROM paper_state
  WHERE k IN ('fc_report:pre:${today}', 'fc_report:close:${today}') ORDER BY k = 'fc_report:pre:${today}' DESC LIMIT 1`);
console.log('결과:', JSON.stringify(rows));

console.log('\n5) TEST 키로 같은 형태 조회 (경로 자체가 되는지)');
const rows2 = await q(`SELECT data->>'text' AS t, data->>'hm' AS hm FROM paper_state WHERE k = '${KEY}'`);
console.log('결과:', JSON.stringify(rows2));
if (rows2?.[0]?.t) console.log('본문 복원 확인:\n---\n' + rows2[0].t + '\n---');

console.log('\n6) 정리');
console.log(JSON.stringify(await q(`DELETE FROM paper_state WHERE k = '${KEY}'`)));
