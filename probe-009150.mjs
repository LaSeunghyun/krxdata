import 'dotenv/config';
import { getMinuteBars, getDailyPrices } from './kis-api.js';
const code = '009150', entry = 1052000, stop = entry * 0.85;
const times = ['093000','100000','103000','110000','113000','120000','123000','130000','133000','140000','143000','150000','153000'];
const seen = new Map(); let live = 0, prevClose = null;
for (const t of times) {
  try { const { bars, now, prevClose: pc } = await getMinuteBars(code, t);
    live = now || live; prevClose = pc ?? prevClose;
    for (const b of bars) seen.set(b.hhmm, b);
  } catch (e) { console.log('ERR', t, String(e.message).slice(0,60)); }
  await new Promise(r=>setTimeout(r,180));
}
const keys=[...seen.keys()].sort();
console.log(`현재가 ${live.toLocaleString()} / 전일종가 ${prevClose?.toLocaleString()} / 봉 ${keys.length} (${keys[0]}~${keys.at(-1)})`);
console.log(`진입 ${entry.toLocaleString()} · -15%선 ${stop.toLocaleString()} · 현재 ${((live/entry-1)*100).toFixed(2)}%`);
let first=null, lo=Infinity, loT=null;
for (const k of keys){const v=seen.get(k); if(v.l&&v.l<lo){lo=v.l;loT=k;} if(!first&&v.l&&v.l<=stop)first=k;}
console.log(`장중최저 ${lo.toLocaleString()} @${loT} (${((lo/entry-1)*100).toFixed(2)}%) · -15%선 최초터치 ${first??'없음'}`);
console.log('--- 30분 스냅샷 ---');
for(const k of keys) if(k.slice(2)==='00'||k.slice(2)==='30'){const v=seen.get(k);console.log(k, v.c.toLocaleString(), `${((v.c/entry-1)*100).toFixed(1)}%`);}
console.log('--- 일봉 최근 12 ---');
const d = await getDailyPrices(code);
console.log((d??[]).slice(0,12).map(r=>`${r.date} ${Number(r.close).toLocaleString()}`).join('\n'));
