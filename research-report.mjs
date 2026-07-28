function formatPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '-';
}

function formatWon(value) {
  return Number.isFinite(value) ? `${Math.round(value).toLocaleString('ko-KR')}원` : '-';
}

export function validateResearchSummary(summary) {
  if (!summary || !Array.isArray(summary.candidates) || !Array.isArray(summary.portfolios)) {
    throw new Error('research summary shape is invalid');
  }
  for (const row of [...summary.candidates, ...summary.portfolios]) {
    for (const section of ['base', 'mc', 'stress']) {
      for (const [key, value] of Object.entries(row[section] ?? {})) {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${row.id}.${section}.${key} must be finite`);
      }
    }
    if (row.reachProbability != null && !Number.isFinite(row.reachProbability)) {
      throw new Error(`${row.id}.reachProbability must be finite`);
    }
  }
  return true;
}

function resultTable(rows) {
  const header = '| ID | 후보 | 등급 | CAGR | MDD | MC MDD 중앙/최악 | 스트레스 최종/MDD | 1억원 도달률 |';
  const divider = '|---|---|---:|---:|---:|---:|---:|---:|';
  const body = rows.map(row => {
    if (row.unavailable) return `| ${row.id} | ${row.name} | REJECTED | - | - | - | 데이터 없음 | - |`;
    return `| ${row.id} | ${row.name} | ${row.grade} | ${formatPct(row.base?.cagr)} | ${formatPct(row.base?.mdd)} | ${formatPct(row.mc?.medianMdd)} / ${formatPct(row.mc?.worstMdd)} | ${formatWon(row.stress?.finalCapital)} / ${formatPct(row.stress?.mdd)} | ${formatPct(row.reachProbability)} |`;
  });
  return [header, divider, ...body].join('\n');
}

function failureReasonList(rows) {
  return rows.map(row => `- ${row.id}: ${(row.failureReasons?.length ? row.failureReasons : ['미기록']).join(', ')}`).join('\n');
}

export function buildResearchReport(summary) {
  validateResearchSummary(summary);
  const eligible = summary.portfolios.filter(row => row.grade === 'LIVE_ELIGIBLE');
  const conclusion = eligible.length
    ? `위험·수익·데이터·shadow 기준을 모두 통과한 후보는 ${eligible.map(row => row.id).join(', ')}다.`
    : '현재 증거로 LIVE_ELIGIBLE인 전략은 없다. 실계좌 설정을 변경하지 않는다.';
  return `# 600만원→1억원 바벨 전략 연구 결과

- 생성시각: ${summary.generatedAt}
- 초기자본: ${formatWon(summary.assumptions.initialCapital)}
- 목표: ${summary.assumptions.targetYears}년 내 ${formatWon(summary.assumptions.targetCapital)}
- 필요 CAGR: ${summary.assumptions.requiredCagr.toFixed(2)}%

## 데이터 한계

- 사용 가능 일봉: ${summary.dataQuality.start}~${summary.dataQuality.end}
- 현재 상장종목 중심으로 **생존편향 존재**
- point-in-time 전체 유니버스: ${summary.dataQuality.pointInTimeUniverse ? '충족' : '미충족'}
- 상장폐지 종목 포함: ${summary.dataQuality.includesDelisted ? '충족' : '미충족'}
- 이 데이터 한계를 통과하지 못하면 결과가 좋아도 LIVE_ELIGIBLE로 승격하지 않는다.

## 단독 후보

${resultTable(summary.candidates)}

## 코어 2/3 + 위성 1/3

${resultTable(summary.portfolios)}

## 탈락 사유

${failureReasonList([...summary.candidates, ...summary.portfolios])}

## 결론

${conclusion}

등급은 CAGR만이 아니라 MC MDD 중앙값 20% 이하, 최악 30% 이하, 비용 스트레스 원금 보전과 MDD 35% 이하, 데이터 품질 및 shadow 60거래일을 함께 적용했다.
`;
}
