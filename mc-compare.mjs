import { execSync } from 'child_process';

const seeds = [101, 202, 303, 404, 505];

console.log('=== Monte Carlo 5-시드 강건함 비교 ===\n');

function runMc(name, flags) {
  console.log(`[MC 시뮬레이션] ${name}...`);
  const cagrs = [];
  const mdds = [];
  const winRates = [];
  
  for (const seed of seeds) {
    const cmd = `node backtest-swing.mjs --strategies combo-v2 --live-parity --skipneutralrsi ${flags} --subsample 0.8 --seed ${seed} --no-freshness-check`;
    try {
      const out = execSync(cmd, { cwd: 'C:\\claudeT\\files', encoding: 'utf8' });
      const winMatch = out.match(/combo-v2\s+(\d+)\s+(\d+)%\s+([\d.]+)\s+([\d.-]+)%\s+([\d.-]+)%\s+(\d+)%\s+([\d.]+)일/);
      if (winMatch) {
        winRates.push(parseInt(winMatch[2]));
        cagrs.push(parseFloat(winMatch[4]));
        mdds.push(parseFloat(winMatch[5]));
      }
    } catch (e) {
      console.error(`Seed ${seed} error: ${e.message}`);
    }
  }

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);

  return {
    name,
    cagrAvg: avg(cagrs),
    cagrMed: median(cagrs),
    mddAvg: avg(mdds),
    mddMed: median(mdds),
    winAvg: avg(winRates),
  };
}

const baseRes = runMc('Baseline (slots 5, maxHoldR 5)', '--slots 5 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --liveuni 420');
const candRes = runMc('고수익/고회전 조합 (slots 4, maxHoldR 3)', '--slots 4 --trail 6 --tp1r 1 --tp2r 2 --rsivol 1.25 --maxholdr 3 --liveuni 420');

console.log('\n=== Monte Carlo 5-시드 최종 비교 결과 ===\n');
console.log('설정                             | 평균 승률 | CAGR (평균 / 중앙) | MDD (평균 / 중앙)');
console.log('───────────────────────────────────────────────────────────────────────────────────');
console.log(`${baseRes.name.padEnd(32)} |   ${baseRes.winAvg}%   |  ${baseRes.cagrAvg}% / ${baseRes.cagrMed}%    |  ${baseRes.mddAvg}% / ${baseRes.mddMed}%`);
console.log(`${candRes.name.padEnd(32)} |   ${candRes.winAvg}%   |  ${candRes.cagrAvg}% / ${candRes.cagrMed}%    |  ${candRes.mddAvg}% / ${candRes.mddMed}%`);
