#!/usr/bin/env node
/**
 * diag-ownership.mjs — 소유권 판정 읽기전용 미리보기. **아무것도 쓰지 않는다.**
 *
 * `stock-live.mjs --plan` 은 매수 후보만 출력하고 종료하므로 보유 판정 경로를 타지 않는다.
 *   배포 전에 "어느 종목이 격리되고 어느 종목이 복원되는가"를 미리 보려면 이게 필요하다.
 *
 * ⚠️ 토스 API 는 VM IP 만 화이트리스트다. **VM 에서 실행한다:**
 *      ssh ... "cd ~/krxdata && node diag-ownership.mjs"
 * ⚠️ state·저널도 VM 에만 있다. 로컬 실행은 전부 sub 미상으로 보여 무의미하다.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getAccounts, getHoldings } from './toss-api.js';
import { classifyPosition } from './position-ownership.mjs';
import { readBotExclude, readBotExcludeManual, readBotExcludeAuto } from './bot-exclude.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const readJson = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };

const st = readJson(join(__dirname, 'stock-live-state.json'));
if (!st) console.log('⚠️ stock-live-state.json 이 없다 — 전부 sub 미상으로 보인다. VM 에서 실행하고 있는지 확인할 것.\n');

// 판정용 저널: 손상 시 null (stock-live 의 readJournalTradesSafe 와 같은 규칙)
let trades = null;
for (const p of [join(__dirname, 'stock-live-journal.json'), join(__dirname, 'stock-live-journal.json.bak')]) {
  const j = readJson(p);
  if (j && Array.isArray(j.trades)) { trades = j.trades; break; }
}
console.log(trades ? `저널 ${trades.length}건 로드` : '⚠️ 저널을 읽을 수 없다 → 전부 판정 보류(unknown)로 나올 것');

const excl = readBotExclude(__dirname);
console.log(`격리 목록: 수동 ${[...readBotExcludeManual(__dirname)].join(',') || '없음'} / 자동 ${[...readBotExcludeAuto(__dirname)].join(',') || '없음'}\n`);

const seq = (await getAccounts())[0].accountSeq;
const h = await getHoldings(seq);
const items = (h?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0);
if (!items.length) console.log('보유 0종목.');

let nUser = 0, nBot = 0, nUnknown = 0, nExcl = 0;
for (const i of items) {
  if (excl.has(i.symbol)) { console.log(`[격리됨] ${i.name}(${i.symbol}) ${i.quantity}주 — 봇이 건드리지 않는다`); nExcl++; continue; }
  const cls = classifyPosition({
    code: i.symbol, brokerQty: Number(i.quantity), currentPx: Number(i.lastPrice),
    meta: st?.meta?.[i.symbol], trades,
  });
  const tag = cls.kind === 'user' ? '[→자동격리]' : cls.kind === 'bot' ? '[봇관리]' : '[판정보류]';
  const extra = cls.restoreMeta ? ` → meta 복원 sub=${cls.restoreMeta.sub} 진입 ${cls.restoreMeta.entry.toLocaleString()} hi ${cls.restoreMeta.hi.toLocaleString()}` : '';
  console.log(`${tag} ${i.name}(${i.symbol}) ${i.quantity}주 — ${cls.why}${extra}`);
  if (cls.kind === 'user') nUser++; else if (cls.kind === 'bot') nBot++; else nUnknown++;
}
console.log(`\n요약: 격리대상 ${nUser} · 봇관리 ${nBot} · 판정보류 ${nUnknown} · 이미격리 ${nExcl}`);
if (nUnknown) console.log('⚠️ 판정보류가 있다 — 저널을 못 읽은 것이다. 배포 전에 원인을 찾을 것.');
console.log('※ 이 스크립트는 아무 파일도 쓰지 않는다.');
