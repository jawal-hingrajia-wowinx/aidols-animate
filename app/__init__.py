from pathlib import Path

from dotenv import load_dotenv

_BASE_DIR = Path(__file__).resolve().parent.parent

# .env for locally-set values (FAL_KEY); .env.local is what `vercel env pull`
# writes (DATABASE_URL, BLOB_READ_WRITE_TOKEN, etc.) — load both, unconditionally,
# before any submodule (which may read env vars at import time) is imported.
load_dotenv(_BASE_DIR / ".env")
load_dotenv(_BASE_DIR / ".env.local")
