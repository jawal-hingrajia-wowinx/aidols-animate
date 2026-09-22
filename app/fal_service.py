from __future__ import annotations

from pathlib import Path
from typing import Callable

import fal_client


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


# fal caps the reference clip by mode: video-led handles complex motion for
# longer, image-led is meant for shorter camera moves.
MAX_SECONDS_BY_ORIENTATION = {"video": 30, "image": 10}


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

    def max_seconds(self, character_orientation: str) -> int:
        return MAX_SECONDS_BY_ORIENTATION.get(character_orientation, 30)


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
