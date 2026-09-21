from fastapi import APIRouter

from .. import db, fal_service

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/history")
async def get_history(limit: int = 200):
    jobs = await db.list_jobs(limit=limit)
    for job in jobs:
        spec = fal_service.MODELS.get(job["model"])
        job["model_label"] = spec.label if spec else job["model"]
    return {"jobs": jobs}
