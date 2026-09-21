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
