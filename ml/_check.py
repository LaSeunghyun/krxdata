"""Prereq check for the stock-ML pipeline: .env creds, packages, Supabase REST pull."""
import importlib
from pathlib import Path

env = {}
envp = Path(__file__).resolve().parent.parent / '.env'  # C:\claudeT\files\.env
if envp.exists():
    for line in envp.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
print('.env found:', envp.exists())
print('SUPABASE_URL set:', bool(env.get('SUPABASE_URL')),
      '| SERVICE_KEY set:', bool(env.get('SUPABASE_SERVICE_KEY')),
      '| DART_API_KEY set:', bool(env.get('DART_API_KEY')))

for pkg in ['pandas', 'numpy', 'lightgbm', 'sklearn', 'requests', 'pyarrow']:
    try:
        importlib.import_module(pkg)
        print(f'pkg {pkg}: OK')
    except Exception:
        print(f'pkg {pkg}: MISSING')

url, key = env.get('SUPABASE_URL'), env.get('SUPABASE_SERVICE_KEY')
try:
    import requests
    r = requests.get(f'{url}/rest/v1/stock_prices',
                     params={'select': 'stock_code,date,close', 'limit': 3, 'order': 'date.desc'},
                     headers={'apikey': key, 'Authorization': f'Bearer {key}'}, timeout=20)
    print('REST /stock_prices:', r.status_code, '| rows:', len(r.json()) if r.ok else r.text[:150])
    # count via HEAD + Prefer count
    r2 = requests.get(f'{url}/rest/v1/stock_prices', params={'select': 'stock_code', 'limit': 1},
                      headers={'apikey': key, 'Authorization': f'Bearer {key}',
                               'Prefer': 'count=exact', 'Range': '0-0'}, timeout=20)
    print('stock_prices count header:', r2.headers.get('Content-Range'))
except Exception as e:
    print('REST FAIL:', repr(e))
