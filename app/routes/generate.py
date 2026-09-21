from __future__ import annotations

import asyncio
import json
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from .. import config, db, fal_service, storage

router = APIRouter(prefix="/api", tags=["generate"])


class GenerateRequest(BaseModel):
    image_url: str
    video_url: Optional[str] = None
    sample_id: Optional[str] = None
    character_orientation: Literal["image", "video"] = "video"
    prompt: Optional[str] = None
    keep_original_sound: bool = True
    models: list[str] = Field(default_factory=lambda: [fal_service.DEFAULT_MODEL_KEY])

    @field_validator("models")
    @classmethod
    def _validate_models(cls, models: list[str]) -> list[str]:
        if not models:
            raise ValueError("Select at least one model")
        unknown = [m for m in models if m not in fal_service.MODELS]
        if unknown:
            raise ValueError(f"Unknown model(s): {', '.join(unknown)}")
        return models

    @model_validator(mode="after")
    def _one_video_source(self):
        if not self.video_url and not self.sample_id:
            raise ValueError("Provide either video_url or sample_id")
        return self


def _resolve_sample(sample_id: str) -> dict | None:
    manifest = json.loads(config.SAMPLES_MANIFEST.read_text())
    for sample in manifest.get("samples", []):
        if sample["id"] == sample_id:
            return sample
    return None


async def _submit_one(model_key: str, job_id: str, image_url: str, video_url: str, req: GenerateRequest):
    await db.create_job(
        job_id=job_id,
        model=model_key,
        image_url=image_url,
        video_url=video_url,
        source=f"sample:{req.sample_id}" if req.sample_id else "upload",
        character_orientation=req.character_orientation,
        prompt=req.prompt,
        keep_original_sound=req.keep_original_sound,
    )
    try:
        request_id = await fal_service.submit_generation(
            model_key,
            image_url=image_url,
            video_url=video_url,
            character_orientation=req.character_orientation,
            prompt=req.prompt,
            keep_original_sound=req.keep_original_sound,
        )
    except Exception as exc:
        await db.update_status(job_id, "failed", error=str(exc))
        return {"job_id": job_id, "model": model_key, "error": str(exc)}

    await db.set_fal_request_id(job_id, request_id, status="submitted")
    return {"job_id": job_id, "model": model_key}


@router.get("/models")
def list_models():
    return {
        "models": [
            {"key": spec.key, "label": spec.label} for spec in fal_service.MODELS.values()
        ]
    }


@router.post("/generate")
async def generate(req: GenerateRequest):
    if req.sample_id:
        sample = _resolve_sample(req.sample_id)
        if not sample:
            raise HTTPException(404, f"Unknown sample_id: {req.sample_id}")
        if not sample.get("video_url"):
            raise HTTPException(404, f"Sample video not available yet: {req.sample_id}")
        video_url = sample["video_url"]
    else:
        video_url = req.video_url

    jobs = await asyncio.gather(
        *[
            _submit_one(model_key, uuid.uuid4().hex, req.image_url, video_url, req)
            for model_key in req.models
        ]
    )
    return {"jobs": jobs}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    if job["status"] in ("completed", "failed") or not job["fal_request_id"]:
        return job

    if job["model"] not in fal_service.MODELS:
        await db.update_status(job_id, "failed", error=f"Model '{job['model']}' is no longer available")
        return await db.get_job(job_id)

    status = await fal_service.get_status(job["model"], job["fal_request_id"])
    status_name = type(status).__name__  # Queued / InProgress / Completed

    if status_name == "Completed":
        try:
            result = await fal_service.get_result(job["model"], job["fal_request_id"])
        except Exception as exc:
            await db.update_status(job_id, "failed", error=str(exc))
        else:
            video = result.get("video") or {}
            result_url = video.get("url")
            await db.update_status(job_id, "completed", result_url=result_url)

            # fal.ai's hosted result expires (~7 days) — pull a durable copy onto Blob now.
            if result_url:
                try:
                    stored_url = await storage.store_result_video(job_id, result_url)
                    await db.set_stored_result_url(job_id, stored_url)
                except Exception:
                    pass  # job still shows "completed" via the fal URL even if re-hosting fails
    else:
        await db.update_status(job_id, status_name.lower())

    return await db.get_job(job_id)
