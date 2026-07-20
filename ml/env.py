"""Load ..\\.env (C:\\claudeT\\files\\.env) and expose Supabase REST creds."""
from __future__ import annotations
from pathlib import Path

_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"  # C:\claudeT\files\.env


def load_env() -> dict:
    env: dict[str, str] = {}
    if not _ENV_PATH.exists():
        raise FileNotFoundError(f".env not found at {_ENV_PATH}")
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


_env = load_env()
SUPABASE_URL: str = _env["SUPABASE_URL"]
SUPABASE_SERVICE_KEY: str = _env["SUPABASE_SERVICE_KEY"]
REST_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
}
