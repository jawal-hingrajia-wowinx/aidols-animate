"""One-time migration: upload the local sample reference videos to Vercel
Blob and write the resulting public URLs into samples/manifest.json.

Run once, locally, after setting BLOB_READ_WRITE_TOKEN:

    source .venv/bin/activate
    python scripts/migrate_samples_to_blob.py

The local files under samples/videos/ are left untouched and can be deleted
afterward (or kept as the source of truth for a future re-upload) -- the
running app only ever reads samples/manifest.json going forward.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, storage  # noqa: E402

# sample id -> local source file (samples/videos/<file>)
SOURCE_FILES = {
    "celebration-jump": "ronaldo_sui_v2.mp4",
    "penalty-shot": "penalty-shot.mp4",
    "freestyle-night-pitch": "freestyle-night-pitch.mp4",
    "freestyle-parking-lot": "freestyle-parking-lot.mp4",
}


async def main() -> None:
    manifest = json.loads(config.SAMPLES_MANIFEST.read_text())

    for sample in manifest.get("samples", []):
        sample_id = sample["id"]
        filename = SOURCE_FILES.get(sample_id)
        if not filename:
            print(f"skip {sample_id}: no local source file mapped")
            continue

        local_path = config.SAMPLES_DIR / "videos" / filename
        if not local_path.exists():
            print(f"skip {sample_id}: {local_path} not found")
            continue

        print(f"uploading {sample_id} ({local_path.name}, {local_path.stat().st_size / 1_000_000:.1f} MB)...")
        data = local_path.read_bytes()
        url = await storage.upload_bytes(f"samples/{filename}", data, content_type="video/mp4")
        sample["video_url"] = url
        print(f"  -> {url}")

    config.SAMPLES_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"\nWrote {config.SAMPLES_MANIFEST}")


if __name__ == "__main__":
    asyncio.run(main())
