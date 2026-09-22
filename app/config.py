import hashlib
import os
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

FAL_KEY = os.getenv("FAL_KEY", "")
DATABASE_URL = os.getenv("DATABASE_URL", "")

SAMPLES_DIR = BASE_DIR / "samples"
SAMPLES_MANIFEST = SAMPLES_DIR / "manifest.json"

# Scratch space for an uploaded file between receiving it and forwarding it to
# fal.ai/Blob; never relied on to persist, so the OS temp dir works both
# locally and on Vercel's ephemeral /tmp.
UPLOAD_DIR = Path(tempfile.gettempdir()) / "aidols-uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Single shared login for the whole app — this is an internal demo, not a
# multi-user product, so one credential pair from the environment is enough.
AUTH_USERNAME = os.getenv("AUTH_USERNAME", "")
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "")

# Signing key for the session cookie. A random per-process key would silently
# log everyone out on each serverless cold start, so fall back to a value
# derived from the credentials: stable across instances, and rotating the
# password invalidates existing sessions for free.
SESSION_SECRET = os.getenv("SESSION_SECRET", "") or hashlib.sha256(
    f"{AUTH_USERNAME}:{AUTH_PASSWORD}".encode()
).hexdigest()

SESSION_MAX_AGE = 60 * 60 * 24 * 7  # a week
