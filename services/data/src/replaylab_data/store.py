"""Parquet bar store: one file per root per UTC year.

Layout (SPEC section 2): `<data dir>/bars/{ROOT}/{YYYY}.parquet`.
Columns: `time` int64 unix seconds UTC (bar OPEN time), `open high low close` float64,
`volume` int64. This is exactly the engine's `Bar` type.

The year in the file name is the UTC year of the bar open time.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .roots import ROOTS, validate_root

BAR_COLUMNS = ["time", "open", "high", "low", "close", "volume"]
PRICE_COLUMNS = ["open", "high", "low", "close"]

BAR_SCHEMA = pa.schema(
    [
        ("time", pa.int64()),
        ("open", pa.float64()),
        ("high", pa.float64()),
        ("low", pa.float64()),
        ("close", pa.float64()),
        ("volume", pa.int64()),
    ]
)


class StoreError(ValueError):
    """Raised for malformed bars or an unreadable store."""


# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------


def find_repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / "docs" / "SPEC.md").is_file():
            return parent
    return None


def resolve_data_dir(override: str | os.PathLike[str] | None = None) -> Path:
    """Data directory: explicit override, else `REPLAYLAB_DATA_DIR`, else `<repo>/data`.

    If the package is not running from a repo checkout (non editable install), the default
    falls back to `./data` in the current directory.
    """
    if override:
        return Path(override).expanduser()
    env = os.environ.get("REPLAYLAB_DATA_DIR")
    if env:
        return Path(env).expanduser()
    repo = find_repo_root()
    return (repo or Path.cwd()) / "data"


def bars_dir(data_dir: Path, root: str) -> Path:
    return data_dir / "bars" / root


def bars_path(data_dir: Path, root: str, year: int) -> Path:
    return bars_dir(data_dir, root) / f"{year:04d}.parquet"


def list_year_files(data_dir: Path, root: str) -> list[tuple[int, Path]]:
    """Year files on disk for a root, ascending by year."""
    folder = bars_dir(data_dir, root)
    if not folder.is_dir():
        return []
    found: list[tuple[int, Path]] = []
    for path in folder.glob("*.parquet"):
        if path.stem.isdigit() and len(path.stem) == 4:
            found.append((int(path.stem), path))
    return sorted(found)


# ---------------------------------------------------------------------------
# Normalizing
# ---------------------------------------------------------------------------


def empty_bars() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "time": pd.Series(dtype="int64"),
            "open": pd.Series(dtype="float64"),
            "high": pd.Series(dtype="float64"),
            "low": pd.Series(dtype="float64"),
            "close": pd.Series(dtype="float64"),
            "volume": pd.Series(dtype="int64"),
        }
    )


def normalize_bars(df: pd.DataFrame) -> pd.DataFrame:
    """Coerce to the on disk dtypes and column order. Raises StoreError on bad data.

    Prices are only required to be finite: CL printed negative prices on 2020-04-20, so a
    positivity check here would reject real data.
    """
    missing = [c for c in BAR_COLUMNS if c not in df.columns]
    if missing:
        raise StoreError(f"bars are missing columns: {', '.join(missing)}")
    out = df[BAR_COLUMNS].copy().reset_index(drop=True)
    for col in PRICE_COLUMNS:
        out[col] = out[col].astype("float64")
    if not np.isfinite(out[PRICE_COLUMNS].to_numpy()).all():
        raise StoreError("bars contain NaN or infinite prices")
    for col in ("time", "volume"):
        series = out[col]
        if series.dtype.kind == "f":
            values = series.to_numpy()
            if not np.isfinite(values).all() or (values % 1 != 0).any():
                raise StoreError(f"{col} must be whole numbers")
        elif series.dtype.kind not in "iu":
            raise StoreError(f"{col} must be numeric, got {series.dtype}")
        out[col] = series.astype("int64")
    if (out["volume"] < 0).any():
        raise StoreError("volume must be >= 0")
    return out


def merge_bars(existing: pd.DataFrame, new: pd.DataFrame) -> pd.DataFrame:
    """Concat, dedupe on `time` (new wins), sort ascending."""
    combined = pd.concat([existing, new], ignore_index=True)
    combined = combined.drop_duplicates(subset="time", keep="last")
    return combined.sort_values("time", kind="stable").reset_index(drop=True)


def utc_years(times: pd.Series) -> np.ndarray:
    """UTC calendar year of each unix seconds value."""
    seconds = times.to_numpy(dtype="int64")
    return seconds.astype("datetime64[s]").astype("datetime64[Y]").astype("int64") + 1970


# ---------------------------------------------------------------------------
# Read and write
# ---------------------------------------------------------------------------


def read_year(data_dir: Path, root: str, year: int) -> pd.DataFrame:
    path = bars_path(data_dir, root, year)
    if not path.is_file():
        return empty_bars()
    try:
        table = pq.read_table(path)
    except (OSError, pa.ArrowException) as exc:
        raise StoreError(f"cannot read {path}: {exc}") from exc
    return normalize_bars(table.to_pandas())


def _write_atomic(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    table = pa.Table.from_pandas(df, schema=BAR_SCHEMA, preserve_index=False)
    pq.write_table(table, tmp, compression="zstd")
    os.replace(tmp, path)


@dataclass(frozen=True)
class YearWrite:
    year: int
    path: Path
    added: int  # bars with a new time
    replaced: int  # bars whose time was already on disk (new data wins)
    total: int  # bars in the file afterwards


@dataclass(frozen=True)
class WriteSummary:
    root: str
    years: list[YearWrite]
    duplicates_in_input: int  # repeated times inside the incoming batch (last wins)

    @property
    def added(self) -> int:
        return sum(y.added for y in self.years)

    @property
    def replaced(self) -> int:
        return sum(y.replaced for y in self.years)


def write_bars(data_dir: Path, root: str, bars: pd.DataFrame) -> WriteSummary:
    """Merge `bars` into the root's year files. Dedupes on time, sorts, writes atomically."""
    root = validate_root(root)
    incoming = normalize_bars(bars)
    deduped = incoming.drop_duplicates(subset="time", keep="last")
    duplicates = len(incoming) - len(deduped)
    if deduped.empty:
        return WriteSummary(root=root, years=[], duplicates_in_input=duplicates)

    years = utc_years(deduped["time"])
    results: list[YearWrite] = []
    for year in sorted(set(years.tolist())):
        chunk = deduped[years == year]
        existing = read_year(data_dir, root, year)
        overlap = int(chunk["time"].isin(existing["time"]).sum()) if len(existing) else 0
        merged = merge_bars(existing, chunk)
        _write_atomic(bars_path(data_dir, root, year), merged)
        results.append(
            YearWrite(
                year=year,
                path=bars_path(data_dir, root, year),
                added=len(chunk) - overlap,
                replaced=overlap,
                total=len(merged),
            )
        )
    return WriteSummary(root=root, years=results, duplicates_in_input=duplicates)


def read_bars(data_dir: Path, root: str, start: int, end: int) -> pd.DataFrame:
    """Bars with `start <= time < end` (unix seconds), sorted ascending."""
    root = validate_root(root)
    if end <= start:
        return empty_bars()
    first_year = datetime.fromtimestamp(start, UTC).year
    last_year = datetime.fromtimestamp(end - 1, UTC).year
    frames: list[pd.DataFrame] = []
    for year, path in list_year_files(data_dir, root):
        if year < first_year or year > last_year:
            continue
        try:
            table = pq.read_table(
                path, filters=[("time", ">=", start), ("time", "<", end)], columns=BAR_COLUMNS
            )
        except (OSError, pa.ArrowException) as exc:
            raise StoreError(f"cannot read {path}: {exc}") from exc
        frames.append(normalize_bars(table.to_pandas()))
    if not frames:
        return empty_bars()
    return pd.concat(frames, ignore_index=True).sort_values("time", kind="stable").reset_index(
        drop=True
    )


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RootInfo:
    root: str
    first: int  # unix seconds, open of the first bar
    last: int  # unix seconds, open of the last bar
    bars: int
    files: int


def root_info(data_dir: Path, root: str) -> RootInfo | None:
    """First/last bar and counts for a root, or None when nothing is on disk."""
    files = list_year_files(data_dir, root)
    counts = 0
    first: int | None = None
    last: int | None = None
    nonempty = 0
    for _year, path in files:
        try:
            times = pq.read_table(path, columns=["time"]).column("time").to_numpy()
        except (OSError, pa.ArrowException) as exc:
            raise StoreError(f"cannot read {path}: {exc}") from exc
        if len(times) == 0:
            continue
        nonempty += 1
        counts += len(times)
        lo, hi = int(times.min()), int(times.max())
        first = lo if first is None else min(first, lo)
        last = hi if last is None else max(last, hi)
    if first is None or last is None:
        return None
    return RootInfo(root=root, first=first, last=last, bars=counts, files=nonempty)


def all_root_info(data_dir: Path) -> list[RootInfo]:
    infos = (root_info(data_dir, r) for r in ROOTS)
    return [i for i in infos if i is not None]
