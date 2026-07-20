import json, io, sys
from collections import defaultdict
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

names = {}
for f in ['kospi-all.json', 'kosdaq-all.json']:
    try:
        j = json.load(open(f, encoding='utf-8'))
        for it in j.get('all', []):
            names[str(it.get('stockCode', '')).zfill(6)] = it.get('corp_name', '')
    except Exception:
        pass

def nm(c):
    return names.get(c, c)

REASON = {'tp_half': '1R절반익절', 'tp_quarter': '2R추가익절', 'trailing': '트레일링',
          'ma5_exit': 'MA3회귀익절', 'stop_loss': '손절-7%', 'max_hold': '만기', 'eov': '기간종료'}
SIG = {'hi120': '120일신고가돌파', 'rsi2': 'RSI2 과매도반등'}

for run in sys.argv[1:]:
    try:
        d = json.load(open(f'evolve-mc-run{run}-trades.json', encoding='utf-8'))
    except Exception as e:
        print(f'run{run}: 덤프 없음 ({e})')
        continue
    tr = d['books']['combo-v2']['trades']
    tr.sort(key=lambda t: -t['pnl'])
    win = sum(1 for t in tr if t['pnl'] > 0)
    pnl = sum(t['pnl'] for t in tr)
    sl = sum(t['pnl'] for t in tr if t['reason'] == 'stop_loss')
    trl = sum(t['pnl'] for t in tr if t['reason'] == 'trailing')
    print(f'--- run{run}: {len(tr)}건 승률 {win/len(tr)*100:.0f}% 실현손익 {pnl/1000:+,.0f}k (손절 {sl/1000:+,.0f}k, 트레일 {trl/1000:+,.0f}k)')
    print('  [수익 TOP3]')
    for t in tr[:3]:
        print(f"  {nm(t['code']):<10s} {t['day']} 매도 | 매수가 {t['entry']:,} → {t['exit']:,} ({t['hold']}일) | 사유: {SIG.get(t['ctx'].get('sub'),'')}→{REASON.get(t['reason'],t['reason'])} | {t['pnl']/1000:+,.0f}k")
    print('  [손실 TOP2]')
    for t in tr[-2:]:
        print(f"  {nm(t['code']):<10s} {t['day']} 매도 | 매수가 {t['entry']:,} → {t['exit']:,} ({t['hold']}일) | 사유: {SIG.get(t['ctx'].get('sub'),'')}→{REASON.get(t['reason'],t['reason'])} | {t['pnl']/1000:+,.0f}k")
