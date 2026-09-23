from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import fal_client
import httpx

from . import config

FAL_REST_URL = "https://rest.fal.ai"


def _kling_arguments(
    image_url: str,
    video_url: str,
    character_orientation: str,
    prompt: str | None,
    keep_original_sound: bool,
) -> dict:
    arguments = {
        "image_url": image_url,
        "video_url": video_url,
        "character_orientation": character_orientation,
        "keep_original_sound": keep_original_sound,
    }
    if prompt:
        arguments["prompt"] = prompt
    return arguments


# The app runs video-led only, which fal caps at 30s. (Image-led, meant for
# short camera moves, is capped at 10s — reinstate the distinction here if it
# is ever offered again.)
CHARACTER_ORIENTATION = "video"
MAX_SECONDS = 30


class ModelSpec:
    def __init__(
        self,
        key: str,
        fal_id: str,
        label: str,
        build_arguments: Callable,
        price_per_second: float,
    ):
        self.key = key
        self.fal_id = fal_id
        self.label = label
        self.build_arguments = build_arguments
        # published rate-card price, used only when fal's pricing API can't be
        # reached — the API is authoritative because it honours account pricing.
        self.price_per_second = price_per_second

    @property
    def max_seconds(self) -> int:
        return MAX_SECONDS


MODELS: dict[str, ModelSpec] = {
    spec.key: spec
    for spec in [
        ModelSpec(
            key="kling-pro",
            fal_id="fal-ai/kling-video/v2.6/pro/motion-control",
            label="Kling v2.6 Motion Control (Pro)",
            build_arguments=_kling_arguments,
            price_per_second=0.112,
        ),
    ]
}

DEFAULT_MODEL_KEY = "kling-pro"

# Models we no longer run, kept only so existing History rows stay readable.
RETIRED_MODEL_LABELS = {
    "kling-standard": "Kling v2.6 Motion Control (Standard) — retired",
}


def label_for(model_key: str) -> str:
    spec = MODELS.get(model_key)
    if spec:
        return spec.label
    return RETIRED_MODEL_LABELS.get(model_key, model_key)


async def upload_local_file(path: Path) -> str:
    return await fal_client.upload_file_async(str(path))


async def submit_generation(
    model_key: str,
    image_url: str,
    video_url: str,
    character_orientation: str = "video",
    prompt: str | None = None,
    keep_original_sound: bool = True,
) -> str:
    spec = MODELS[model_key]
    arguments = spec.build_arguments(
        image_url, video_url, character_orientation, prompt, keep_original_sound
    )
    handle = await fal_client.submit_async(spec.fal_id, arguments=arguments)
    return handle.request_id


async def get_status(model_key: str, request_id: str):
    spec = MODELS[model_key]
    return await fal_client.status_async(spec.fal_id, request_id, with_logs=False)


async def get_result(model_key: str, request_id: str) -> dict:
    spec = MODELS[model_key]
    return await fal_client.result_async(spec.fal_id, request_id)


# ---- Browser-direct uploads ----
#
# Vercel caps a function request body at 4.5MB, which a 30s reference clip blows
# straight past. Rather than proxy the bytes, the server mints a short-lived-ish
# CDN credential and the browser POSTs the file to fal directly. FAL_KEY itself
# never reaches the client.
#
# The token fal returns is upload-only - it cannot start generations or spend
# money - but it is valid for 30 days and fal exposes no way to shorten that,
# so treat it as a credential and only hand it to signed-in users.

_cdn_token: dict | None = None
_CDN_REFRESH_MARGIN = timedelta(hours=1)


async def get_cdn_upload_token() -> dict:
    """{upload_url, authorization, expires_at} for a browser to upload with."""
    global _cdn_token

    now = datetime.now(timezone.utc)
    if _cdn_token and _cdn_token["_expires_at"] - now > _CDN_REFRESH_MARGIN:
        return _cdn_token

    if not config.FAL_KEY:
        raise RuntimeError("FAL_KEY is not configured")

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"{FAL_REST_URL}/storage/auth/token?storage_type=fal-cdn-v3",
            headers={
                "Authorization": f"Key {config.FAL_KEY}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            json={},
        )
        response.raise_for_status()
        data = response.json()

    _cdn_token = {
        "upload_url": f"{data['base_url']}/files/upload",
        "authorization": f"{data['token_type']} {data['token']}",
        "expires_at": data["expires_at"],
        "_expires_at": datetime.fromisoformat(data["expires_at"]),
    }
    return _cdn_token
