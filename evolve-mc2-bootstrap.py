import json, io, sys, random, statistics as st
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# slots2 풀 시뮬 50런에서 거래 수익률 풀 + 런별 최종자본 추출
pool = []        # 거래당 수익률 (포지션 가치 대비)
counts = []      # 런당 거래 수
run_data = []    # (런별 거래 수익률 리스트, 최종자본)
for s in range(1, 251):
    try:
        d = json.load(open(f'evolve-mc2-s2-r{s}.json', encoding='utf-8'))
    except Exception:
        continue
    book = list(d['books'].values())[0]
    tr = book['trades']
    counts.append(len(tr))
    rets = []
    for t in tr:
        basis = t['entry'] * t['qty']
        if basis > 0:
            rets.append(t['pnl'] / basis)
    pool.extend(rets)
    final = book['cash'] + 0  # 기간말 전량 청산 가정(eov 트레이드 포함됨)
    run_data.append((rets, final))

N_PATHS = 100_000
CAPITAL = 30_000
n_mean = round(st.mean(counts))
rng = random.Random(20260613)

# 캘리브레이션 v2: 런마다 유효 투입비율 f_run을 그 런의 실제 최종자본에 맞춰 역산
# → 경로별로 f를 리샘플링해 "어떤 운(매수가능 러너)을 만나느냐"의 런 간 분산까지 보존
import math
def solve_f(rets, final):
    target = math.log(max(final, 3_000) / CAPITAL)
    lo, hi = 0.0, 1.5
    for _ in range(50):
        mid = (lo + hi) / 2
        tot = 0.0
        for r in rets:
            v = 1 + r * mid
            tot += math.log(v) if v > 0.01 else math.log(0.01)
        if tot > target:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2
f_list = [solve_f(rets, final) for rets, final in run_data if rets]
print(f'[캘리브레이션 v2] 런별 유효 투입비율 f: med {st.median(f_list):.3f} (min {min(f_list):.3f} max {max(f_list):.3f}, n={len(f_list)})')

finals, mdds, ruined = [], [], 0
for _ in range(N_PATHS):
    eq, peak, mdd = CAPITAL, CAPITAL, 0.0
    f = f_list[rng.randrange(len(f_list))]          # 경로별 운(매수가능 환경) 리샘플
    n = counts[rng.randrange(len(counts))]          # 경로별 거래 수 리샘플
    for _ in range(n):
        r = pool[rng.randrange(len(pool))]
        v = 1 + r * f
        eq *= v if v > 0.01 else 0.01
        if eq > peak:
            peak = eq
        dd = 1 - eq / peak
        if dd > mdd:
            mdd = dd
        if eq < CAPITAL * 0.1:   # -90% 파산 간주
            break
    finals.append(eq)
    mdds.append(mdd)
    if eq < CAPITAL:
        ruined += 1

finals.sort()
def q(p):
    return finals[int((len(finals) - 1) * p)]
years = 1.44  # 2025-01 ~ 2026-06
print(f'거래 풀: {len(pool)}건 (50런), 경로당 거래 수 {n_mean}')
print(f'부트스트랩 경로: {N_PATHS:,}개')
print(f'최종자본 분포 (원금 30,000):')
for p, lbl in [(.01,'p1 (최악 1%)'), (.05,'p5'), (.25,'p25'), (.5,'중앙값'), (.75,'p75'), (.95,'p95'), (.99,'p99 (최상 1%)')]:
    v = q(p)
    cagr = ((v / CAPITAL) ** (1 / years) - 1) * 100
    print(f'  {lbl:14s}: {v:>10,.0f}원  (연 {cagr:+.0f}%)')
print(f'원금손실 확률: {ruined/N_PATHS*100:.1f}%')
print(f'2배 이상 확률: {sum(1 for f in finals if f >= 60000)/N_PATHS*100:.1f}%')
print(f'MDD: 중앙값 {st.median(mdds)*100:.0f}% / p95 {sorted(mdds)[int(N_PATHS*0.95)]*100:.0f}%')
print(f'승률(거래 풀): {sum(1 for r in pool if r > 0)/len(pool)*100:.0f}% | 평균 수익률 {st.mean(pool)*100:+.2f}%/건')
