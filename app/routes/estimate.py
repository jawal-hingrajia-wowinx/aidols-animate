from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import fal_service, pricing

router = APIRouter(prefix="/api", tags=["estimate"])


class EstimateRequest(BaseModel):
    # measured in the browser off the reference clip's metadata; there's no
    # ffmpeg on Vercel and probing server-side would mean downloading the video
    duration_seconds: float = Field(gt=0)
    character_orientation: Literal["image", "video"] = "video"


@router.post("/estimate")
async def estimate_cost(req: EstimateRequest):
    return await pricing.estimate(
        fal_service.DEFAULT_MODEL_KEY,
        req.duration_seconds,
        req.character_orientation,
    )
