import json, io, sys
from collections import defaultdict
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DUMP = sys.argv[1] if len(sys.argv) > 1 else 'evolve-final-trades.json'
SINCE = sys.argv[2] if len(sys.argv) > 2 else '2025-01-01'

names = {}
for f in ['kospi-all.json', 'kosdaq-all.json']:
    try:
        j = json.load(open(f, encoding='utf-8'))
        for it in j.get('all', []):
            names[str(it.get('stockCode', '')).zfill(6)] = it.get('corp_name', '')
    except Exception:
        pass

d = json.load(open(DUMP, encoding='utf-8'))
book = list(d['books'].values())[0]
tr = book['trades']

def nm(c):
    return names.get(c, c)

def line(t):
    return (f"{t['day']} {nm(t['code']):<12s} {t['ctx']['sub']:<5s} "
            f"진입 {t['entry']:>9,} → 청산 {t['exit']:>9,} {t['hold']}일 "
            f"{t['reason']:<10s} 레짐 {t['ctx']['regime']:<7s} {t['pnl']/1000:+10,.0f}k")

by = defaultdict(lambda: [0, 0, 0])
for t in tr:
    k = (t['ctx']['sub'], t['reason'])
    by[k][0] += 1
    by[k][1] += 1 if t['pnl'] > 0 else 0
    by[k][2] += t['pnl']
print('=== sub × 청산사유 (전체) ===')
for k in sorted(by, key=lambda k: -by[k][2]):
    n, w, p = by[k]
    print(f'{k[0]:<6s} {k[1]:<12s} n={n:4d} 승률={w/n*100:3.0f}% 누적={p/1000:+11,.0f}k')

v = [t for t in tr if t['day'] >= SINCE]
v.sort(key=lambda t: -t['pnl'])
print(f'\n=== {SINCE}~ 최대 수익 7건 ===')
for t in v[:7]:
    print(line(t))
print(f'\n=== {SINCE}~ 최대 손실 7건 ===')
for t in v[-7:]:
    print(line(t))

yr = defaultdict(int)
for t in tr:
    yr[t['day'][:4]] += t['pnl']
print('\n=== 연도별 실현손익 ===')
for y in sorted(yr):
    print(f'{y}: {yr[y]/1000:+12,.0f}k')

sl = [t for t in tr if t['reason'] == 'stop_loss']
if sl:
    print(f'\nstop_loss: n={len(sl)} 평균 {sum(t["pnl"] for t in sl)/len(sl)/1000:+,.0f}k '
          f'누적 {sum(t["pnl"] for t in sl)/1000:+,.0f}k')

hd = defaultdict(lambda: [0, 0])
for t in tr:
    b = '1-2' if t['hold'] <= 2 else '3-5' if t['hold'] <= 5 else '6-10' if t['hold'] <= 10 else '11+'
    hd[b][0] += 1
    hd[b][1] += t['pnl']
print('\n=== 보유일수별 ===')
for b in ['1-2', '3-5', '6-10', '11+']:
    if b in hd:
        n, p = hd[b]
        print(f'{b:<5s} n={n:4d} 누적={p/1000:+11,.0f}k')

rg = defaultdict(lambda: [0, 0, 0])
for t in tr:
    k = (t['ctx']['sub'], t['ctx']['regime'])
    rg[k][0] += 1
    rg[k][1] += 1 if t['pnl'] > 0 else 0
    rg[k][2] += t['pnl']
print('\n=== sub × 레짐 ===')
for k in sorted(rg, key=lambda k: -rg[k][2]):
    n, w, p = rg[k]
    print(f'{k[0]:<6s} {k[1]:<8s} n={n:4d} 승률={w/n*100:3.0f}% 누적={p/1000:+11,.0f}k')
