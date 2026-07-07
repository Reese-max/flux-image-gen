from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from fastapi import Request


@dataclass(frozen=True)
class UsageEvent:
    date: str
    checkedAt: str
    route: str
    outcome: str
    statusCode: int
    errorCode: str
    provider: str
    model: str
    imageCount: int
    durationMs: int
    estimatedCostUsd: float
    actorHash: str


_lock = threading.Lock()
_events_by_date: dict[str, list[dict[str, Any]]] = {}


def today_key() -> str:
    return datetime.now(UTC).date().isoformat()


def parse_date_key(value: str | None = None) -> str:
    if value is None or not str(value).strip():
        return today_key()
    raw = str(value).strip()
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError as exc:
        raise ValueError("date 必須使用 YYYY-MM-DD") from exc


def actor_hash_from_request(request: Request | None) -> str:
    if request is None:
        return "unknown"
    forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for")
    raw = forwarded.split(",")[0].strip() if forwarded else ""
    if not raw and request.client:
        raw = request.client.host or ""
    if not raw:
        return "unknown"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return f"ip:{digest}"


def estimate_cost_usd(provider: str, image_count: int, settings: Any) -> float:
    if image_count <= 0:
        return 0.0
    if str(provider or "").lower() == "demo":
        return 0.0
    cost_per_image = float(getattr(settings, "usage_estimated_cost_usd_per_image", 0.0) or 0.0)
    return round(cost_per_image * image_count, 6)


def _log_path(settings: Any, date_key: str) -> Path:
    log_dir = Path(str(getattr(settings, "usage_log_dir", "logs") or "logs"))
    return log_dir / f"usage-{date_key}.jsonl"


def _append_jsonl(event: dict[str, Any], settings: Any) -> None:
    if not bool(getattr(settings, "usage_logging_enabled", True)):
        return
    path = _log_path(settings, event["date"])
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    except OSError:
        # Metrics must never break image generation. Keep the in-memory counter even if disk logging fails.
        return


def record_usage_event(
    *,
    request: Request | None,
    settings: Any,
    route: str,
    outcome: str,
    status_code: int,
    duration_ms: int,
    model: str | None = None,
    provider: str | None = None,
    image_count: int = 0,
    error_code: str | None = None,
) -> dict[str, Any]:
    date_key = today_key()
    normalized_outcome = "success" if outcome == "success" else "error"
    safe_image_count = max(0, int(image_count or 0)) if normalized_outcome == "success" else 0
    event = UsageEvent(
        date=date_key,
        checkedAt=datetime.now(UTC).isoformat(),
        route=str(route or "unknown"),
        outcome=normalized_outcome,
        statusCode=int(status_code),
        errorCode=str(error_code or ""),
        provider=str(provider or "unknown"),
        model=str(model or "unknown"),
        imageCount=safe_image_count,
        durationMs=max(0, int(duration_ms or 0)),
        estimatedCostUsd=estimate_cost_usd(str(provider or "unknown"), safe_image_count, settings),
        actorHash=actor_hash_from_request(request),
    )
    payload = event.__dict__.copy()
    with _lock:
        _events_by_date.setdefault(date_key, []).append(payload)
    _append_jsonl(payload, settings)
    return payload


def _inc_bucket(bucket: dict[str, dict[str, Any]], key: str, event: dict[str, Any]) -> None:
    safe_key = key or "unknown"
    item = bucket.setdefault(
        safe_key,
        {"requests": 0, "successes": 0, "failures": 0, "images": 0, "estimatedCostUsd": 0.0},
    )
    item["requests"] += 1
    if event["outcome"] == "success":
        item["successes"] += 1
    else:
        item["failures"] += 1
    item["images"] += int(event.get("imageCount", 0) or 0)
    item["estimatedCostUsd"] = round(item["estimatedCostUsd"] + float(event.get("estimatedCostUsd", 0) or 0), 6)


def summarize_usage(date_key: str | None = None, settings: Any | None = None) -> dict[str, Any]:
    normalized_date = parse_date_key(date_key)
    with _lock:
        events = list(_events_by_date.get(normalized_date, []))

    total = len(events)
    successes = sum(1 for event in events if event["outcome"] == "success")
    failures = total - successes
    generated_images = sum(int(event.get("imageCount", 0) or 0) for event in events if event["outcome"] == "success")
    total_duration = sum(int(event.get("durationMs", 0) or 0) for event in events)
    estimated_cost = round(sum(float(event.get("estimatedCostUsd", 0) or 0) for event in events), 6)
    by_model: dict[str, dict[str, Any]] = {}
    by_provider: dict[str, dict[str, Any]] = {}
    by_route: dict[str, dict[str, Any]] = {}
    by_actor: dict[str, dict[str, Any]] = {}
    by_error_code: dict[str, int] = {}

    for event in events:
        _inc_bucket(by_model, str(event.get("model") or "unknown"), event)
        _inc_bucket(by_provider, str(event.get("provider") or "unknown"), event)
        _inc_bucket(by_route, str(event.get("route") or "unknown"), event)
        _inc_bucket(by_actor, str(event.get("actorHash") or "unknown"), event)
        error_code = str(event.get("errorCode") or "")
        if error_code:
            by_error_code[error_code] = by_error_code.get(error_code, 0) + 1

    threshold = int(getattr(settings, "usage_alert_daily_generations", 0) or 0) if settings is not None else 0
    alerts = []
    if threshold > 0 and generated_images >= threshold:
        alerts.append(
            {
                "code": "daily_generation_threshold",
                "message": "今日生成量已達提醒門檻",
                "threshold": threshold,
                "actual": generated_images,
            }
        )

    return {
        "date": normalized_date,
        "totalRequests": total,
        "successRequests": successes,
        "failedRequests": failures,
        "generatedImages": generated_images,
        "estimatedCostUsd": estimated_cost,
        "errorRate": round(failures / total, 4) if total else 0.0,
        "averageGenerationMs": round(total_duration / total) if total else 0,
        "byModel": by_model,
        "byProvider": by_provider,
        "byRoute": by_route,
        "byActor": by_actor,
        "byErrorCode": by_error_code,
        "alerts": alerts,
        "updatedAt": datetime.now(UTC).isoformat(),
    }


def reset_usage_metrics() -> None:
    with _lock:
        _events_by_date.clear()
