import { execSync } from 'child_process';

const sweeps = [
  // 1. baseline live
  { name: 'Baseline (live-current)', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 5' },
  
  // 2. rsi2 maxHoldR 단축 (3일 vs 2일 vs 4일)
  { name: 'maxHoldR 3일', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3' },
  { name: 'maxHoldR 2일', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 2' },
  { name: 'maxHoldR 4일', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 4' },

  // 3. rsiVol 투매 거래량 강화 (1.5, 1.75, 2.0)
  { name: 'rsiVol 1.5 + maxHoldR 3', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.5 --maxholdr 3' },
  { name: 'rsiVol 1.75 + maxHoldR 3', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.75 --maxholdr 3' },
  { name: 'rsiVol 2.0 + maxHoldR 3', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 2.0 --maxholdr 3' },

  // 4. 타겟 익절 타이트화 (tp1r 0.8 => +4.8%, tp2r 1.5 => +9%)
  { name: 'tp1R 0.8 / tp2R 1.5 + maxHoldR 3', flags: '--slots 5 --trail 6 --tp1r 0.8 --tp2r 1.5 --rsivol 1.25 --maxholdr 3' },
  { name: 'tp1R 0.75 / tp2R 1.25 + maxHoldR 3', flags: '--slots 5 --trail 6 --tp1r 0.75 --tp2r 1.25 --rsivol 1.25 --maxholdr 3' },

  // 5. 손절 및 트레일 조정
  { name: 'trail 5 + maxHoldR 3', flags: '--slots 5 --trail 5 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3' },
  { name: 'stoppct 5 + maxHoldR 3', flags: '--slots 5 --trail 6 --stoppct 5 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3' },

  // 6. 슬롯 및 유니버스 조정
  { name: 'slots 3 + maxHoldR 3', flags: '--slots 3 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3' },
  { name: 'slots 4 + maxHoldR 3', flags: '--slots 4 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3' },
  { name: 'liveuni 300 + maxHoldR 3', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3 --liveuni 300' },
  { name: 'liveuni 200 + maxHoldR 3', flags: '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3 --liveuni 200' },
];

console.log(`=== 전략 파라미터 스윕 시작 (${sweeps.length}개 조합) ===\n`);

const results = [];

for (const s of sweeps) {
  const cmd = `node backtest-swing.mjs --strategies combo-v2 --live-parity --skipneutralrsi ${s.flags} --no-freshness-check`;
  try {
    const out = execSync(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8' });
    
    // Parse output
    const winMatch = out.match(/combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/);
    if (winMatch) {
      const trades = parseInt(winMatch[1]);
      const winRate = parseInt(winMatch[2]);
      const pf = parseFloat(winMatch[3]);
      const cagr = parseFloat(winMatch[4]);
      const mdd = parseFloat(winMatch[5]);
      const avgHold = parseFloat(winMatch[7]);
      const calmar = mdd !== 0 ? (cagr / mdd).toFixed(2) : '0';

      results.push({
        name: s.name,
        trades,
        winRate,
        pf,
        cagr,
        mdd,
        avgHold,
        calmar: parseFloat(calmar)
      });
      console.log(`[OK] ${s.name.padEnd(35)} | 승률: ${winRate}% | CAGR: ${cagr}% | MDD: ${mdd}% | Calmar: ${calmar} | 보유: ${avgHold}일`);
    } else {
      console.log(`[PARSING FAILED] ${s.name}`);
    }
  } catch (e) {
    console.error(`[ERROR] ${s.name}: ${e.message}`);
  }
}

console.log('\n=== 종합 랭킹 (Calmar = CAGR/MDD 순) ===\n');
results.sort((a, b) => b.calmar - a.calmar);
console.log('이름                                    | 승률 | CAGR   | MDD    | Calmar | 보유일수 | 체결수');
console.log('─────────────────────────────────────────────────────────────────────────────────────────────');
for (const r of results) {
  console.log(`${r.name.padEnd(38)} | ${String(r.winRate).padStart(3)}% | ${String(r.cagr).padStart(5)}% | ${String(r.mdd).padStart(5)}% | ${String(r.calmar).padStart(6)} | ${String(r.avgHold).padStart(5)}일 | ${r.trades}회`);
}

console.log('\n=== 종합 랭킹 (승률 순) ===\n');
results.sort((a, b) => b.winRate - a.winRate);
for (const r of results) {
  console.log(`${r.name.padEnd(38)} | ${String(r.winRate).padStart(3)}% | ${String(r.cagr).padStart(5)}% | ${String(r.mdd).padStart(5)}% | ${String(r.calmar).padStart(6)} | ${String(r.avgHold).padStart(5)}일 | ${r.trades}회`);
}
