from __future__ import annotations

import time

import httpx

from . import config, fal_service

FAL_ESTIMATE_URL = "https://api.fal.ai/v1/models/pricing/estimate"

# The unit price for a model changes rarely, so fetch it once and multiply
# locally: every subsequent estimate is instant and changing the reference clip
# or the orientation costs no API round trip.
_PRICE_CACHE_TTL = 3600.0
_price_cache: dict[str, tuple[float, float]] = {}  # fal_id -> (price, fetched_at)

# fal rate-limits this endpoint (429 after a short burst). Without remembering
# the failure we'd retry on every estimate and pay the request timeout each
# time, so back off for a while and serve the rate card instead.
_FAILURE_BACKOFF = 300.0
_failure_cache: dict[str, float] = {}  # fal_id -> failed_at

# Keep the network wait short: this sits in front of a UI that updates as the
# user picks a clip, and the rate card is always there to fall back on.
_REQUEST_TIMEOUT = 6.0


async def _fetch_price_per_second(fal_id: str) -> float | None:
    """Ask fal what one billing unit of this model costs. Returns None if the
    answer isn't usable, so the caller can fall back to the rate card."""
    if not config.FAL_KEY:
        return None

    payload = {
        "estimate_type": "unit_price",
        "endpoints": {fal_id: {"unit_quantity": 1}},
    }
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
        response = await client.post(
            FAL_ESTIMATE_URL,
            headers={"Authorization": f"Key {config.FAL_KEY}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    price = data.get("total_cost")
    if not isinstance(price, (int, float)) or price <= 0:
        return None
    return float(price)


def _rate_card(fal_id: str) -> tuple[float, str]:
    spec = next(s for s in fal_service.MODELS.values() if s.fal_id == fal_id)
    return spec.price_per_second, "rate-card"


async def get_price_per_second(fal_id: str) -> tuple[float, str]:
    """(price_per_second, source) where source is 'fal' or 'rate-card'."""
    now = time.monotonic()

    cached = _price_cache.get(fal_id)
    if cached and now - cached[1] < _PRICE_CACHE_TTL:
        return cached[0], "fal"

    failed_at = _failure_cache.get(fal_id)
    if failed_at is not None and now - failed_at < _FAILURE_BACKOFF:
        return _rate_card(fal_id)

    try:
        price = await _fetch_price_per_second(fal_id)
    except Exception:
        price = None

    if price is None:
        _failure_cache[fal_id] = now
        return _rate_card(fal_id)

    _price_cache[fal_id] = (price, now)
    _failure_cache.pop(fal_id, None)
    return price, "fal"


async def estimate(model_key: str, duration_seconds: float, character_orientation: str) -> dict:
    spec = fal_service.MODELS[model_key]
    max_seconds = spec.max_seconds(character_orientation)

    seconds_billed = max(0.0, float(duration_seconds))
    clamped = seconds_billed > max_seconds
    if clamped:
        seconds_billed = float(max_seconds)

    price_per_second, source = await get_price_per_second(spec.fal_id)

    return {
        "model": spec.key,
        "model_label": spec.label,
        "seconds_billed": round(seconds_billed, 2),
        "price_per_second": round(price_per_second, 6),
        "cost": round(seconds_billed * price_per_second, 4),
        "currency": "USD",
        "source": source,
        "clamped": clamped,
        "max_seconds": max_seconds,
    }
