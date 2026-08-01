import 'dotenv/config';
import { getDailyPrices } from './kis-api.js';
// 진입 시점 기준 20일 점대점 낙폭 — ①07-29 종가(백테 의미론) ②07-30 진입가(라이브 의미론)
const picks=[['009150','삼성전기',1052000],['011070','LG이노텍',462500],['000150','두산',1001000],['161390','한국타이어',68000],['443060','HD현대마린',182700]];
console.log('종목         07-29종가기준  진입가기준   (50% 필터 발동?)');
for(const [code,name,entry] of picks){
  const d=await getDailyPrices(code);
  const r=(d??[]).map(x=>({d:x.date,c:Number(x.close)}));   // 최신순, r[0]=07-30
  const c29=r[1].c, base29=r[21].c;                          // 07-29 기준 20거래일 전
  const base30=r[20].c;                                      // 07-30 기준 20거래일 전
  const dd29=(c29/base29-1)*100, dd30=(entry/base30-1)*100;
  console.log(`${name.padEnd(10)} ${dd29.toFixed(1).padStart(9)}%  ${dd30.toFixed(1).padStart(9)}%   ${dd29<-50?'O':'X'} / ${dd30<-50?'O':'X'}`);
  await new Promise(r=>setTimeout(r,180));
}
