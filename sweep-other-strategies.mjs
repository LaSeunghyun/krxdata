import { execSync } from 'child_process';

const strategies = [
  { name: 'combo-v2 (Baseline)', flags: '--strategies combo-v2 --live-parity --skipneutralrsi --rsivol 1.25 --slots 5 --trail 6 --tp1r 1 --tp2r 2 --liveuni 420' },
  { name: 'bb-mr (BB 평균회귀)', flags: '--strategies bb-mr --slots 5 --bbperiod 20 --bbmult 2.0 --stoppct 7' },
  { name: 'bb-brk (BB 스퀴즈 돌파)', flags: '--strategies bb-brk --slots 5 --bbperiod 20 --bbmult 2.0 --stoppct 7 --trail 8' },
  { name: 'hma-turn (Hull 반전추종)', flags: '--strategies hma-turn --slots 5 --hmaperiod 25 --stoppct 7' },
  { name: 'hma-dip (Hull 하단눌림)', flags: '--strategies hma-dip --slots 5 --hmaperiod 25 --stoppct 7' },
  { name: 'vb (변동성 돌파 k=0.5)', flags: '--strategies vb --slots 5' },
  { name: 'rsi2-pit (과매도 단독)', flags: '--strategies rsi2-pit --slots 5 --stoppct 7' },
  { name: 'hi120 (신고가 돌파 단독)', flags: '--strategies hi120 --slots 5 --trail 8' },
  { name: 'gapfollow (갭업 추종)', flags: '--strategies gapfollow --slots 5 --trail 8' },
];

console.log(`=== 다른 기법 비교 스윕 시작 (${strategies.length}개 전략) ===\n`);

const results = [];

for (const s of strategies) {
  const cmd = `node backtest-swing.mjs ${s.flags} --no-freshness-check`;
  try {
    const out = execSync(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8' });
    
    // Parse output for any strategy name
    const winMatch = out.match(/([\w-]+)\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/);
    if (winMatch) {
      const stratName = winMatch[1];
      const trades = parseInt(winMatch[2]);
      const winRate = parseInt(winMatch[3]);
      const pf = parseFloat(winMatch[4]);
      const cagr = parseFloat(winMatch[5]);
      const mdd = parseFloat(winMatch[6]);
      const avgHold = parseFloat(winMatch[8]);
      const calmar = mdd !== 0 ? (cagr / mdd).toFixed(2) : '0';

      results.push({
        label: s.name,
        stratName,
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

console.log('\n=== 종합 전략 랭킹 (Calmar 순) ===\n');
results.sort((a, b) => b.calmar - a.calmar);
for (const r of results) {
  console.log(`${r.label.padEnd(35)} | 승률: ${String(r.winRate).padStart(3)}% | CAGR: ${String(r.cagr).padStart(5)}% | MDD: ${String(r.mdd).padStart(5)}% | Calmar: ${String(r.calmar).padStart(6)} | 보유: ${r.avgHold}일 | ${r.trades}회`);
}
