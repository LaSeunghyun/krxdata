// 수동 빈 슬롯 매수 — 화신정공(126640) BUY를 live_queue에 적재 (executeLiveQueue가 집행)
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
const buy = [{ side: 'BUY', code: '126640', name: '화신정공', close: 6420, atrMult: 0.5, reason: 'combo hi120 돌파 +11.7%', ctx: { sub: 'hi120', regime: 'UP', breakoutPct: '11.7', atrMult: '0.50' } }];
const j = JSON.stringify(buy).replace(/\$/g, '');
await q(`INSERT INTO paper_state (k, data, updated_at) VALUES ('live_queue', $j$${j}$j$::jsonb, NOW()) ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
console.log('live_queue 주입 완료: 화신정공 BUY');
