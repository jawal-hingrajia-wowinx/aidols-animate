from __future__ import annotations

import httpx
from vercel.blob import AsyncBlobClient

_client = AsyncBlobClient()


async def upload_bytes(pathname: str, data: bytes, content_type: str | None = None) -> str:
    result = await _client.put(
        pathname,
        data,
        access="public",
        add_random_suffix=True,
        content_type=content_type,
    )
    return result.url


async def store_result_video(job_id: str, fal_result_url: str) -> str:
    """fal.ai's hosted result expires (~7 days) — pull it down and re-host it
    on Blob storage so the link in History stays valid indefinitely."""
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(fal_result_url)
        response.raise_for_status()
        data = response.content

    return await upload_bytes(f"results/{job_id}.mp4", data, content_type="video/mp4")
