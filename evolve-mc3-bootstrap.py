# MC v3: 월 정렬 경로 리샘플링 부트스트랩
# v2의 f-캘리브레이션(기하 근사) 결함 수정:
#   - v2는 런별 유효투입비율 f를 역산해 거래 수익률을 스케일 — f=0 경계 해가
#     p1~p5를 정확히 원금 30,000원으로 고정시키는 인공물 발생
#   - v3는 실제 풀시뮬 120런(자본 30,000원, 정수주·호가단위·수수료 모두 반영)의
#     "월별 수익률"을 달력 월 단위로 정렬 리샘플 — 같은 달은 같은 시장 레짐을 공유하므로
#     레짐 정렬을 보존하면서 유니버스 표본 운(런 간 분산)만 섞는다
import json, glob, io, sys, random, statistics as st
from datetime import date, timedelta
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

CAPITAL = 30_000
N_PATHS = 100_000
YEARS = 1.44  # 2025-01 ~ 2026-06

runs = []  # 런별 {month: 수익률}
files = sorted(glob.glob('evolve-mc2-s2-r*.json'))
months_all = set()
for fn in files:
    d = json.load(open(fn, encoding='utf-8'))
    b = list(d['books'].values())[0]
    # 청산 시점 근사: 진입일 + 보유일(영업일→달력일 ×1.45)
    evs = []
    for t in b['trades']:
        y, m, dd = int(t['day'][:4]), int(t['day'][5:7]), int(t['day'][8:10])
        ex = date(y, m, dd) + timedelta(days=round(t['hold'] * 1.45))
        evs.append((ex, t['pnl']))
    evs.sort()
    eq = CAPITAL
    mret = {}
    cur, mpnl, meq0 = None, 0, CAPITAL
    for ex, pnl in evs:
        key = (ex.year, ex.month)
        if key != cur:
            if cur is not None:
                mret[cur] = mpnl / meq0
            cur, mpnl, meq0 = key, 0, eq
        mpnl += pnl
        eq += pnl
    if cur is not None:
        mret[cur] = mpnl / meq0
    runs.append(mret)
    months_all.update(mret.keys())

months = sorted(months_all)
# 월별 수익률 풀: 거래 없던 달은 0% (현금 보유)
pool = {m: [r.get(m, 0.0) for r in runs] for m in months}

rng = random.Random(20260613)
finals, mdds, ruined = [], [], 0
for _ in range(N_PATHS):
    eq, peak, mdd = CAPITAL, CAPITAL, 0.0
    for m in months:
        eq *= max(1 + pool[m][rng.randrange(len(runs))], 0.01)
        if eq > peak:
            peak = eq
        dd = 1 - eq / peak
        if dd > mdd:
            mdd = dd
    finals.append(eq)
    mdds.append(mdd)
    if eq < CAPITAL:
        ruined += 1

finals.sort(); mdds.sort()
def q(arr, p):
    return arr[int((len(arr) - 1) * p)]
print(f'풀시뮬 {len(runs)}런 × {len(months)}개월 → 월 정렬 리샘플 경로 {N_PATHS:,}개')
print(f'최종자본 분포 (원금 {CAPITAL:,}원, 2025-01~2026-06):')
for p, lbl in [(.01, 'p1 (최악 1%)'), (.05, 'p5'), (.25, 'p25'), (.5, '중앙값'), (.75, 'p75'), (.95, 'p95'), (.99, 'p99 (최상 1%)')]:
    v = q(finals, p)
    cagr = ((v / CAPITAL) ** (1 / YEARS) - 1) * 100
    print(f'  {lbl:14s}: {v:>10,.0f}원  (연 {cagr:+.0f}%)')
print(f'원금손실 확률: {ruined / N_PATHS * 100:.1f}%')
print(f'2배 이상 확률: {sum(1 for f in finals if f >= CAPITAL * 2) / N_PATHS * 100:.1f}%')
print(f'MDD(월 단위): 중앙값 {st.median(mdds) * 100:.0f}% / p95 {q(mdds, .95) * 100:.0f}%')
# 실측 120런 분포와 대조 (검증)
act = []
for fn in files:
    d = json.load(open(fn, encoding='utf-8'))
    act.append(list(d['books'].values())[0]['cash'])
act.sort()
print(f'[검증] 실측 120런: min {act[0]:,} / p25 {act[len(act)//4]:,} / med {st.median(act):,.0f} / p75 {act[len(act)*3//4]:,} / max {act[-1]:,}')
