"""
fetch-krx-flows.py — KRX 과거 투자자별 매매동향 백필 (2026-07-25, 사용자 제안 pykrx 경로).
  배경: KIS getInvestorDaily는 30일 고정, KRX 직접 POST는 봇차단(LOGOUT). pykrx + KRX 회원로그인으로
        종목별 전 기간(2023~) 수급을 **호출 1회/종목**으로 확보 가능(실측: 삼성전자 3년 731행).
  용도: "같은 hi120 돌파 중 기관·외국인이 사는 것만" 판별자 검증(백테 연동).
  출력: krx-flows.json  { code: { "YYYYMMDD": [기관, 외국인, 개인] } }  (단위: 원)
  실행: python fetch-krx-flows.py [--universe]     (기본=cv2-dump 거래종목, --universe=유동성 전체)
  env : KRX_ID, KRX_PW (.env — git 무시됨)
"""
import json, os, sys, time, pathlib

HERE = pathlib.Path(__file__).parent
# .env 로드 (dotenv 의존 없이 최소 파싱)
for line in (HERE / '.env').read_text(encoding='utf-8', errors='ignore').splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())

if not os.environ.get('KRX_ID') or not os.environ.get('KRX_PW'):
    sys.exit('KRX_ID/KRX_PW 미설정')

from pykrx import stock  # noqa: E402  (자격증명 주입 후 import 필수)

START, END = '20230101', '20260726'
OUT = HERE / 'krx-flows.json'

# 대상 종목
if '--universe' in sys.argv:
    # universe-codes.json = node로 미리 추출한 유동성 유니버스 (Python에서 Supabase 직접호출은 403)
    codes = json.loads((HERE / 'universe-codes.json').read_text(encoding='utf-8'))
else:
    dump = json.loads((HERE / 'cv2-dump.json').read_text(encoding='utf-8'))
    codes = sorted({t['code'] for t in dump['books']['combo-v2']['trades']})

out = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
print(f'대상 {len(codes)}종목 (이미 수집 {len(out)})', flush=True)

done = fails = 0
t0 = time.time()
for i, code in enumerate(codes):
    if code in out:
        done += 1
        continue
    for attempt in range(3):
        try:
            df = stock.get_market_trading_value_by_date(START, END, code)
            rec = {}
            for dt, row in df.iterrows():
                rec[dt.strftime('%Y%m%d')] = [
                    int(row.get('기관합계', 0) or 0),
                    int(row.get('외국인합계', 0) or 0),
                    int(row.get('개인', 0) or 0),
                ]
            out[code] = rec
            break
        except Exception as e:
            if attempt == 2:
                fails += 1
                out[code] = {}   # 실패도 기록(재시도 루프 방지). 빈 dict = 데이터 없음
                print(f'  {code} 실패: {type(e).__name__} {str(e)[:70]}', flush=True)
            time.sleep(1.5 * (attempt + 1))
    done += 1
    time.sleep(0.25)
    if done % 25 == 0:
        OUT.write_text(json.dumps(out), encoding='utf-8')
        print(f'  {done}/{len(codes)} (실패 {fails}) {time.time()-t0:.0f}s', flush=True)

OUT.write_text(json.dumps(out), encoding='utf-8')
rows = sum(len(v) for v in out.values())
covered = sum(1 for v in out.values() if v)
print(f'완료: {done}종목, 일별 {rows}행, 데이터 있는 종목 {covered}/{done} (실패 {fails})')
