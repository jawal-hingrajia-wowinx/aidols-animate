import json

from fastapi import APIRouter

from .. import config

router = APIRouter(prefix="/api/samples", tags=["samples"])


@router.get("")
def list_samples():
    manifest = json.loads(config.SAMPLES_MANIFEST.read_text())
    samples = []
    for sample in manifest.get("samples", []):
        video_url = sample.get("video_url")
        samples.append({**sample, "available": bool(video_url)})
    return {"samples": samples}
