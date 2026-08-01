import 'dotenv/config';
import { getDailyPrices } from './kis-api.js';
const picks = [['000150','두산',1001000],['011070','LG이노텍',462500],['161390','한국타이어',68000],['009150','삼성전기',1052000],['443060','HD현대마린',182700]];
console.log('종목            현재     20일점대점  20일고점대비  (필터40 발동?)');
for (const [code,name,entry] of picks) {
  const d = await getDailyPrices(code);          // 최신순
  const rows = (d??[]).slice(0,26).map(r=>({d:r.date,c:Number(r.close),h:Number(r.high)}));
  if (rows.length < 21) { console.log(name,'데이터부족',rows.length); continue; }
  const cur = rows[0].c;
  const p2p = (cur / rows[20].c - 1) * 100;                        // 1321행이 재는 값
  const hi20 = Math.max(...rows.slice(0,21).map(r=>r.h||r.c));     // 20일 고점
  const dd = (cur / hi20 - 1) * 100;                              // 고점대비 낙폭
  const fire40 = p2p < -40, fireDD40 = dd < -40;
  console.log(`${name.padEnd(12)} ${cur.toLocaleString().padStart(9)} ${p2p.toFixed(1).padStart(9)}% ${dd.toFixed(1).padStart(11)}%   점대점:${fire40?'O':'X'} / 고점대비:${fireDD40?'O':'X'}`);
  await new Promise(r=>setTimeout(r,180));
}
