from __future__ import annotations

import asyncpg

from . import config

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        # small max_size: each function instance only ever handles a
        # handful of concurrent requests, and Postgres providers aimed at
        # serverless (Neon, Vercel Postgres, Supabase) expect short-lived,
        # modest connection counts per client.
        _pool = await asyncpg.create_pool(config.DATABASE_URL, min_size=0, max_size=5)
    return _pool


async def init_db() -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                fal_request_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                model TEXT NOT NULL DEFAULT 'kling-standard',
                image_url TEXT NOT NULL,
                video_url TEXT NOT NULL,
                source TEXT,
                character_orientation TEXT,
                prompt TEXT,
                keep_original_sound BOOLEAN NOT NULL DEFAULT TRUE,
                result_url TEXT,
                stored_result_url TEXT,
                error TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )


async def create_job(
    job_id: str,
    model: str,
    image_url: str,
    video_url: str,
    source: str,
    character_orientation: str,
    prompt: str | None,
    keep_original_sound: bool,
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO jobs (
                id, status, model, image_url, video_url, source,
                character_orientation, prompt, keep_original_sound
            )
            VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8)
            """,
            job_id,
            model,
            image_url,
            video_url,
            source,
            character_orientation,
            prompt,
            keep_original_sound,
        )


async def set_fal_request_id(job_id: str, fal_request_id: str, status: str = "submitted") -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE jobs SET fal_request_id = $1, status = $2, updated_at = now() WHERE id = $3",
            fal_request_id,
            status,
            job_id,
        )


async def update_status(
    job_id: str,
    status: str,
    result_url: str | None = None,
    error: str | None = None,
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE jobs
            SET status = $1, result_url = COALESCE($2, result_url), error = $3, updated_at = now()
            WHERE id = $4
            """,
            status,
            result_url,
            error,
            job_id,
        )


async def set_stored_result_url(job_id: str, url: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE jobs SET stored_result_url = $1, updated_at = now() WHERE id = $2",
            url,
            job_id,
        )


async def get_job(job_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM jobs WHERE id = $1", job_id)
        return dict(row) if row else None


async def list_jobs(limit: int = 200) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1", limit)
        return [dict(row) for row in rows]
