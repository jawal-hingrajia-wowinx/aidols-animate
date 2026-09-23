import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from .. import config, fal_service

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_VIDEO_TYPES = {"video/mp4", "video/quicktime", "video/webm"}
# Vercel Functions cap the request body at 4.5MB; stay under that with margin
# for multipart overhead. This only constrains the proxied path below, which is
# now just a fallback — the browser normally uploads straight to fal via
# /api/uploads/token and is not bound by this at all.
MAX_FILE_SIZE = 4 * 1024 * 1024  # 4MB


async def _save_and_upload(file: UploadFile, allowed_types: set[str], subdir: str) -> str:
    if file.content_type not in allowed_types:
        raise HTTPException(400, f"Unsupported file type: {file.content_type}")

    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(400, "File too large (max 4MB)")

    ext = Path(file.filename or "").suffix
    temp_path = config.UPLOAD_DIR / f"{subdir}-{uuid.uuid4().hex}{ext}"
    temp_path.write_bytes(contents)

    try:
        return await fal_service.upload_local_file(temp_path)
    except Exception as exc:
        raise HTTPException(502, f"Failed to upload to fal.ai: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)


@router.post("/image")
async def upload_image(file: UploadFile = File(...)):
    url = await _save_and_upload(file, ALLOWED_IMAGE_TYPES, "image")
    return {"image_url": url}


@router.post("/video")
async def upload_video(file: UploadFile = File(...)):
    url = await _save_and_upload(file, ALLOWED_VIDEO_TYPES, "video")
    return {"video_url": url}


@router.post("/token")
async def upload_token():
    """Mint a browser-usable fal upload credential so large files skip the
    4.5MB function body limit entirely."""
    try:
        token = await fal_service.get_cdn_upload_token()
    except Exception as exc:
        raise HTTPException(502, f"Couldn't get an upload token: {exc}") from exc

    return JSONResponse(
        {
            "upload_url": token["upload_url"],
            "authorization": token["authorization"],
            "expires_at": token["expires_at"],
        },
        # it's a credential: keep it out of the CDN and any shared cache
        headers={"Cache-Control": "no-store, private"},
    )
