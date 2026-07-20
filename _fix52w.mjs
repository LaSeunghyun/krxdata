import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDailyCandles } from "./toss-api.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method:"POST", headers:{Authorization:`Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`,"Content-Type":"application/json"},
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60000) });
  const d = await r.json(); if(!Array.isArray(d)) throw new Error(d?.message??"DB"); return d;
};

const rows = await dbQuery(`SELECT stock_code, corp_name, current_price, high_52w FROM stock_analysis WHERE current_price>0 AND high_52w > current_price*2.5 ORDER BY high_52w::numeric/current_price DESC`);
console.log(`52주 오염 의심: ${rows.length}종목 — 토스 수정주가로 재계산 시작`);

let fixed=0, skip=0, done=0;
const updates=[];
async function worker(list){
  for(const r of list){
    try {
      const c = await getDailyCandles(r.stock_code, 252);
      const highs=c.map(x=>x.high).filter(v=>Number.isFinite(v)&&v>0);
      const lows=c.map(x=>x.low).filter(v=>Number.isFinite(v)&&v>0);
      if(highs.length&&lows.length){
        const nh=Math.max(...highs), nl=Math.min(...lows);
        // 토스 재계산값이 기존보다 확실히 낮으면(오염 정정) 반영
        if(nh < r.high_52w){ updates.push({code:r.stock_code, hi:nh, lo:nl}); fixed++; }
        else skip++;
      } else skip++;
    } catch { skip++; }
    if(++done%50===0) console.log(`  진행 ${done}/${rows.length} (정정대상 ${fixed}, 스킵 ${skip})`);
  }
}
// concurrency 8
const chunks=Array.from({length:8},()=>[]);
rows.forEach((r,i)=>chunks[i%8].push(r));
await Promise.all(chunks.map(worker));

// 배치 UPDATE
console.log(`\n토스 재계산 완료 — DB 반영할 정정: ${updates.length}종목`);
for(let i=0;i<updates.length;i+=100){
  const batch=updates.slice(i,i+100);
  const vals=batch.map(u=>`('${u.code}',${u.hi},${u.lo})`).join(",");
  await dbQuery(`UPDATE stock_analysis AS sa SET high_52w=v.hi, low_52w=v.lo, week52_updated_at=NOW(), updated_at=NOW() FROM (VALUES ${vals}) AS v(code,hi,lo) WHERE sa.stock_code=v.code`);
  console.log(`  UPDATE ${Math.min(i+100,updates.length)}/${updates.length}`);
}
console.log(`\n=== 완료: ${updates.length}종목 52주 고저가 수정주가로 정정, ${rows.length-updates.length}종목은 토스값이 기존과 동일/미커버로 유지 ===`);
