"""CSV import (SPEC section 2).

Reads a 1m bars export with flexible header names and an IANA timezone for naive timestamps.
Bad rows are collected with their line numbers and never silently dropped.

Time handling, per row:
  * Epoch numbers (9+ digits) are unix seconds, milliseconds, microseconds, or nanoseconds by
    magnitude. They are UTC by definition, so `tz` does not apply.
  * Text with an explicit offset or `Z` uses that offset.
  * Naive text is read as `tz` wall time. Wall times that do not exist or happen twice
    (DST changes) are reported as bad rows rather than guessed.
  * Separate `date` and `time` columns are joined.
The time must be the bar OPEN and fall on a whole minute.

A row is bad when: wrong field count, unreadable time or number, a zero or non finite price,
high < low, open or close outside [low, high], volume negative or not a whole number, time not
on a whole minute, or a repeated time (the first occurrence is kept). Negative prices are
allowed: CL printed below zero on 2020-04-20.
"""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd

from .store import normalize_bars

HEADER_ALIASES: dict[str, set[str]] = {
    "time": {
        "time",
        "timestamp",
        "datetime",
        "date_time",
        "date_and_time",
        "ts",
        "ts_event",
        "bar_time",
        "open_time",
        "opentime",
        "time_utc",
        "utc_time",
        "local_time",
    },
    "date": {"date", "day"},
    "open": {"open", "o", "open_price", "opening_price"},
    "high": {"high", "h", "high_price"},
    "low": {"low", "l", "low_price"},
    "close": {"close", "c", "close_price", "closing_price", "last"},
    "volume": {"volume", "vol", "v", "tick_volume", "qty", "quantity"},
}

_DATE_TIME_FORMATS = (
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y%m%d %H%M%S",
    "%Y%m%d %H:%M:%S",
    "%Y%m%d %H%M",
    "%Y%m%d %H:%M",
)
_EPOCH_RE = re.compile(r"^[+-]?\d{9,}(\.\d+)?$")
_MAX_EPOCH_SECONDS = 4_102_444_800  # 2100-01-01


class CsvImportError(ValueError):
    """Raised for problems with the whole file (bad header, unknown timezone, empty)."""


@dataclass(frozen=True)
class RowError:
    line: int  # 1 based physical line in the file where the row starts
    message: str


@dataclass
class CsvParseResult:
    bars: pd.DataFrame
    errors: list[RowError] = field(default_factory=list)
    rows_read: int = 0  # non blank data rows seen


def _norm_header(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def map_headers(header: list[str]) -> dict[str, int]:
    """Map canonical names (time, date, open, high, low, close, volume) to column indexes."""
    found: dict[str, int] = {}
    for idx, raw in enumerate(header):
        norm = _norm_header(raw)
        for canonical, aliases in HEADER_ALIASES.items():
            if norm in aliases:
                if canonical in found:
                    raise CsvImportError(
                        f"header has two columns for {canonical!r}: "
                        f"{header[found[canonical]]!r} and {raw!r}"
                    )
                found[canonical] = idx
                break
    # A lone "date" column is the timestamp.
    if "time" not in found and "date" in found:
        found["time"] = found.pop("date")
    missing = [c for c in ("time", "open", "high", "low", "close", "volume") if c not in found]
    if missing:
        raise CsvImportError(
            f"could not find column(s) {', '.join(missing)} in header {header!r}. "
            "Expected time, open, high, low, close, volume (common aliases are accepted)."
        )
    return found


def _sniff_delimiter(first_line: str) -> str:
    counts = {d: first_line.count(d) for d in (",", ";", "\t", "|")}
    best = max(counts, key=lambda d: counts[d])
    return best if counts[best] > 0 else ","


def _epoch_to_seconds(raw: str) -> int:
    value = float(raw)
    magnitude = abs(value)
    if magnitude >= 1e17:
        value /= 1e9
    elif magnitude >= 1e14:
        value /= 1e6
    elif magnitude >= 1e11:
        value /= 1e3
    if value != int(value):
        raise ValueError("fractional seconds are not allowed")
    seconds = int(value)
    if not 0 <= seconds < _MAX_EPOCH_SECONDS:
        raise ValueError(f"epoch value {raw} is outside 1970 to 2100")
    return seconds


def _parse_naive_or_aware(text: str) -> datetime:
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in _DATE_TIME_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ValueError(f"unrecognized time {text!r}")


def parse_time(raw_time: str, raw_date: str | None, zone: ZoneInfo) -> int:
    """Unix seconds UTC for one row's time cell (and optional date cell). Raises ValueError."""
    raw_time = raw_time.strip()
    if not raw_time:
        raise ValueError("empty time")
    if _EPOCH_RE.match(raw_time):
        return _epoch_to_seconds(raw_time)
    candidates = [raw_time]
    if raw_date is not None and raw_date.strip():
        # Separate date and time columns: try them joined first, then the time cell alone
        # (some exports repeat a full timestamp in the time column next to a date column).
        candidates.insert(0, f"{raw_date.strip()} {raw_time}")
    first_error: ValueError | None = None
    for text in candidates:
        try:
            parsed = _parse_naive_or_aware(text)
            break
        except ValueError as exc:
            first_error = first_error or exc
    else:
        raise first_error or ValueError(f"unrecognized time {raw_time!r}")
    if parsed.tzinfo is not None:
        return int(parsed.astimezone(UTC).timestamp())

    local = parsed.replace(tzinfo=zone)
    # Ambiguous (clock repeats) when both folds give different offsets.
    first = local.replace(fold=0).utcoffset()
    second = local.replace(fold=1).utcoffset()
    if first != second:
        raise ValueError(
            f"{text} is ambiguous in {zone.key} (clocks go back); use an export with offsets"
        )
    as_utc = local.astimezone(UTC)
    # Nonexistent (clock skips) when the round trip does not return the same wall time.
    if as_utc.astimezone(zone).replace(tzinfo=None) != parsed:
        raise ValueError(f"{text} does not exist in {zone.key} (clocks go forward)")
    return int(as_utc.timestamp())


def _parse_float(raw: str, name: str) -> float:
    text = raw.strip()
    if not text:
        raise ValueError(f"empty {name}")
    try:
        value = float(text)
    except ValueError as exc:
        raise ValueError(f"{name} {raw!r} is not a number") from exc
    if not math.isfinite(value):
        raise ValueError(f"{name} {raw!r} is not finite")
    return value


def _parse_volume(raw: str) -> int:
    value = _parse_float(raw, "volume")
    if value < 0:
        raise ValueError(f"volume {raw!r} is negative")
    if value != int(value):
        raise ValueError(f"volume {raw!r} is not a whole number")
    return int(value)


def _get_zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CsvImportError(
            f"unknown timezone {tz!r}; use an IANA name like UTC or America/New_York"
        ) from exc


def parse_csv_text(text: str, tz: str = "UTC") -> CsvParseResult:
    """Parse CSV text into bars plus a list of bad rows. Raises CsvImportError for file level
    problems (no header, missing columns, unknown timezone)."""
    zone = _get_zone(tz)
    text = text.lstrip("﻿")
    stream = io.StringIO(text, newline="")
    first_line = next((ln for ln in text.splitlines() if ln.strip()), "")
    if not first_line:
        raise CsvImportError("file is empty")
    reader = csv.reader(stream, delimiter=_sniff_delimiter(first_line))

    cols: dict[str, int] | None = None
    width = 0
    date_idx: int | None = None
    prev_line = 0
    rows: list[tuple[int, int, float, float, float, float, int]] = []
    errors: list[RowError] = []
    seen: dict[int, int] = {}
    rows_read = 0

    for record in reader:
        start_line = prev_line + 1
        prev_line = reader.line_num
        if not record or all(not cell.strip() for cell in record):
            continue
        if cols is None:
            cols = map_headers(record)
            width = len(record)
            if "time" in cols:
                date_idx = _date_column_index(record, cols)
            continue
        rows_read += 1
        if len(record) != width:
            errors.append(RowError(start_line, f"expected {width} fields, got {len(record)}"))
            continue
        try:
            raw_date = record[date_idx] if date_idx is not None else None
            time = parse_time(record[cols["time"]], raw_date, zone)
            if time % 60 != 0:
                raise ValueError("time is not on a whole minute (is this 1m data?)")
            o = _parse_float(record[cols["open"]], "open")
            h = _parse_float(record[cols["high"]], "high")
            low = _parse_float(record[cols["low"]], "low")
            c = _parse_float(record[cols["close"]], "close")
            volume = _parse_volume(record[cols["volume"]])
            if 0.0 in (o, h, low, c):
                raise ValueError("price is zero")
            if h < low:
                raise ValueError(f"high {h} is below low {low}")
            if not (low <= o <= h and low <= c <= h):
                raise ValueError(
                    f"open {o} or close {c} is outside the high/low range {low} to {h}"
                )
        except ValueError as exc:
            errors.append(RowError(start_line, str(exc)))
            continue
        if time in seen:
            errors.append(
                RowError(
                    start_line,
                    f"duplicate time {_iso(time)} (first seen on line {seen[time]}); row skipped",
                )
            )
            continue
        seen[time] = start_line
        rows.append((start_line, time, o, h, low, c, volume))

    if cols is None:
        raise CsvImportError("file has no header row")

    frame = pd.DataFrame(
        {
            "time": [r[1] for r in rows],
            "open": [r[2] for r in rows],
            "high": [r[3] for r in rows],
            "low": [r[4] for r in rows],
            "close": [r[5] for r in rows],
            "volume": [r[6] for r in rows],
        }
    ).astype(
        {
            "time": "int64",
            "open": "float64",
            "high": "float64",
            "low": "float64",
            "close": "float64",
            "volume": "int64",
        }
    )
    bars = normalize_bars(frame).sort_values("time", kind="stable").reset_index(drop=True)
    return CsvParseResult(bars=bars, errors=errors, rows_read=rows_read)


def _date_column_index(header: list[str], cols: dict[str, int]) -> int | None:
    """Index of a separate `date` column when the header has both date and time columns."""
    for idx, raw in enumerate(header):
        if _norm_header(raw) in HEADER_ALIASES["date"] and idx != cols["time"]:
            return idx
    return None


def _iso(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_text_file(path: str | Path) -> str:
    raw = Path(path).read_bytes()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def parse_csv_file(path: str | Path, tz: str = "UTC") -> CsvParseResult:
    return parse_csv_text(read_text_file(path), tz=tz)
