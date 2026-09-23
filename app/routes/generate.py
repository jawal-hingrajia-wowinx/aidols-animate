from __future__ import annotations

import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, model_validator

from .. import config, db, fal_service, storage

router = APIRouter(prefix="/api", tags=["generate"])


class GenerateRequest(BaseModel):
    image_url: str
    video_url: Optional[str] = None
    sample_id: Optional[str] = None
    prompt: Optional[str] = None
    keep_original_sound: bool = True

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


async def _submit_one(
    model_key: str,
    job_id: str,
    image_url: str,
    video_url: str,
    req: GenerateRequest,
    prompt: str | None,
):
    await db.create_job(
        job_id=job_id,
        model=model_key,
        image_url=image_url,
        video_url=video_url,
        source=f"sample:{req.sample_id}" if req.sample_id else "upload",
        character_orientation=fal_service.CHARACTER_ORIENTATION,
        prompt=prompt,
        keep_original_sound=req.keep_original_sound,
    )
    result = {
        "job_id": job_id,
        "model": model_key,
        "model_label": fal_service.label_for(model_key),
    }
    try:
        request_id = await fal_service.submit_generation(
            model_key,
            image_url=image_url,
            video_url=video_url,
            character_orientation=fal_service.CHARACTER_ORIENTATION,
            prompt=prompt,
            keep_original_sound=req.keep_original_sound,
        )
    except Exception as exc:
        await db.update_status(job_id, "failed", error=str(exc))
        return {**result, "error": str(exc)}

    await db.set_fal_request_id(job_id, request_id, status="submitted")
    return result


@router.post("/generate")
async def generate(req: GenerateRequest):
    default_prompt = None
    if req.sample_id:
        sample = _resolve_sample(req.sample_id)
        if not sample:
            raise HTTPException(404, f"Unknown sample_id: {req.sample_id}")
        if not sample.get("video_url"):
            raise HTTPException(404, f"Sample video not available yet: {req.sample_id}")
        video_url = sample["video_url"]
        default_prompt = sample.get("default_prompt")
    else:
        video_url = req.video_url

    # Each sample carries a prompt tuned to its motion — mainly to stop the model
    # dropping the ball, which it does when nothing names it. Anything the user
    # types wins; resolved here rather than in the browser so the default still
    # applies to a direct API call.
    prompt = (req.prompt or "").strip() or default_prompt

    return await _submit_one(
        fal_service.DEFAULT_MODEL_KEY, uuid.uuid4().hex, req.image_url, video_url, req, prompt
    )


def _with_label(job: dict) -> dict:
    return {**job, "model_label": fal_service.label_for(job["model"])}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    if job["status"] in ("completed", "failed") or not job["fal_request_id"]:
        return _with_label(job)

    # an in-flight job from a model we've since retired can't be polled anymore
    if job["model"] not in fal_service.MODELS:
        await db.update_status(
            job_id,
            "failed",
            error=f"Retired model '{job['model']}' — this generation can no longer be tracked",
        )
        return _with_label(await db.get_job(job_id))

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

    return _with_label(await db.get_job(job_id))
