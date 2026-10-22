"""FastAPI bars service (SPEC section 8).

  GET /health
  GET /markets                         roots on disk with their first/last bar and counts
  GET /bars?root=NQ&start=ISO&end=ISO  Bar[] exactly as in SPEC section 4

`/bars` returns bars with `start <= time < end`, ascending. Naive ISO timestamps are UTC.
At most 31 days per request; longer ranges get a 400. A micro root gets a 400 that names
the full size root, because micros use their full size root's bars.

Run it with `replaylab-data serve` or `uvicorn replaylab_data.api:app`.
"""

from __future__ import annotations

import os
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .roots import RootError, validate_root
from .store import StoreError, all_root_info, list_year_files, read_bars, resolve_data_dir

MAX_SPAN = timedelta(days=31)
LOCAL_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"


def parse_iso(value: str, name: str) -> int:
    """ISO 8601 date or datetime to unix seconds. Naive values are UTC."""
    text = value.strip()
    try:
        if len(text) <= 10:
            parsed = datetime.combine(date.fromisoformat(text), datetime.min.time())
        else:
            parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{name} must be an ISO 8601 date or datetime like 2024-01-02 or "
            f"2024-01-02T09:30:00Z, got {value!r}",
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return int(parsed.timestamp())


def iso_utc(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def create_app(data_dir: Path | str | None = None) -> FastAPI:
    base = resolve_data_dir(data_dir)
    app = FastAPI(title="ReplayLab data service", version="0.1.0")

    extra = [
        o.strip() for o in os.environ.get("REPLAYLAB_CORS_ORIGINS", "").split(",") if o.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=extra,
        allow_origin_regex=LOCAL_ORIGIN_REGEX,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/markets")
    def markets() -> list[dict[str, Any]]:
        try:
            infos = all_root_info(base)
        except StoreError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return [
            {
                "root": i.root,
                "start": iso_utc(i.first),
                "end": iso_utc(i.last),
                "bars": i.bars,
            }
            for i in infos
        ]

    @app.get("/bars")
    def bars(
        root: str = Query(..., description="NQ, ES, YM, RTY, CL or GC"),
        start: str = Query(..., description="ISO 8601 date or datetime, inclusive"),
        end: str = Query(..., description="ISO 8601 date or datetime, exclusive"),
    ) -> list[dict[str, Any]]:
        try:
            valid_root = validate_root(root)
        except RootError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        start_s = parse_iso(start, "start")
        end_s = parse_iso(end, "end")
        if end_s <= start_s:
            raise HTTPException(status_code=400, detail="end must be after start")
        if end_s - start_s > MAX_SPAN.total_seconds():
            raise HTTPException(
                status_code=400,
                detail=f"range is {(end_s - start_s) / 86400:.2f} days; the maximum is "
                f"{MAX_SPAN.days} days per request",
            )
        try:
            if not list_year_files(base, valid_root):
                raise HTTPException(
                    status_code=404,
                    detail=f"no {valid_root} bars on disk; run replaylab-data ingest or import-csv",
                )
            frame = read_bars(base, valid_root, start_s, end_s)
        except StoreError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return [
            {"time": t, "open": o, "high": h, "low": lo, "close": c, "volume": v}
            for t, o, h, lo, c, v in zip(
                frame["time"].tolist(),
                frame["open"].tolist(),
                frame["high"].tolist(),
                frame["low"].tolist(),
                frame["close"].tolist(),
                frame["volume"].tolist(),
                strict=True,
            )
        ]

    return app


app = create_app()
