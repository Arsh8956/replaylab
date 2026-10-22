"""Databento ingest (SPEC sections 2 and 8).

Confirmed against the databento-python docs (see README):
  * `Historical.timeseries.get_range(dataset, start, end=None, symbols=None, schema="trades",
    stype_in="raw_symbol", stype_out="instrument_id", limit=None, path=None) -> DBNStore`
  * `Historical.metadata.get_cost(dataset, start, end=None, symbols=None, schema="trades",
    stype_in="raw_symbol", limit=None) -> float` (US dollars)
  * `DBNStore.to_df(price_type="float", pretty_ts=True, map_symbols=True, schema=None, tz=UTC,
    count=None)`. For `ohlcv-1m` there is no `ts_recv`, so the index is `ts_event`, the
    INCLUSIVE START of the bar. Fixed prices are int64 in units of 1e-9.

We ask for `price_type="fixed"` and `pretty_ts=False` so the index is raw unix nanoseconds
(uint64) and prices are int64. Prices become floats by dividing by 1e9, which is correctly
rounded (no 21016.750000000004 noise), and times become int seconds by integer division.

`start` and `end` are UTC. Databento's `end` is exclusive; our CLI `--end` is an inclusive
calendar date, so we send the next day.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd

from .roots import DATASET, SCHEMA, STYPE_IN, continuous_symbol, validate_root
from .spend import SpendLedger, check_cap, fmt_usd, to_money
from .store import BAR_COLUMNS, WriteSummary, normalize_bars, write_bars

FIXED_PRICE_SCALE = 1_000_000_000  # Databento fixed point: 1 unit = 1e-9
NS_PER_SECOND = 1_000_000_000
API_KEY_ENV = "DATABENTO_API_KEY"


class IngestError(RuntimeError):
    """Raised for bad ingest input or a missing key."""


# ---------------------------------------------------------------------------
# API key and client
# ---------------------------------------------------------------------------


def _read_env_file(path: Path) -> str | None:
    """Value of DATABENTO_API_KEY from a simple KEY=VALUE .env file, if present."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        match = re.match(rf"\s*(?:export\s+)?{API_KEY_ENV}\s*=\s*(.*?)\s*$", line)
        if match:
            value = match.group(1).strip().strip("'\"")
            return value or None
    return None


def load_api_key() -> str:
    """Key from the environment, else from a `.env` in the repo root or current directory."""
    key = os.environ.get(API_KEY_ENV)
    if key:
        return key
    from .store import find_repo_root

    candidates = [Path.cwd() / ".env"]
    repo = find_repo_root()
    if repo:
        candidates.append(repo / ".env")
    for path in candidates:
        key = _read_env_file(path)
        if key:
            return key
    raise IngestError(f"{API_KEY_ENV} is not set. Put it in your environment or in a .env file.")


def make_client() -> Any:
    """A databento.Historical client. Imported lazily; never constructed in tests."""
    import databento as db

    return db.Historical(load_api_key())


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IngestRequest:
    root: str
    start: date  # inclusive, 00:00 UTC
    end: date  # inclusive calendar day

    @property
    def symbol(self) -> str:
        return continuous_symbol(self.root)

    @property
    def api_start(self) -> str:
        return self.start.isoformat()

    @property
    def api_end(self) -> str:
        """Databento's `end` is exclusive, so send midnight after the last wanted day."""
        return (self.end + timedelta(days=1)).isoformat()


def make_request(root: str, start: str | date, end: str | date) -> IngestRequest:
    """Validate the root (micros are rejected) and the date range."""
    valid_root = validate_root(root)
    start_d = _parse_date(start, "--start")
    end_d = _parse_date(end, "--end")
    if end_d < start_d:
        raise IngestError(f"--end {end_d} is before --start {start_d}")
    return IngestRequest(root=valid_root, start=start_d, end=end_d)


def _parse_date(value: str | date, flag: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise IngestError(f"{flag} must be a date like 2024-01-31, got {value!r}") from exc


# ---------------------------------------------------------------------------
# Databento calls
# ---------------------------------------------------------------------------


def estimate_cost(client: Any, req: IngestRequest) -> Decimal:
    """Databento's cost estimate in USD, rounded up to 6 places. Free to call."""
    cost = client.metadata.get_cost(
        dataset=DATASET,
        symbols=[req.symbol],
        schema=SCHEMA,
        stype_in=STYPE_IN,
        start=req.api_start,
        end=req.api_end,
    )
    return to_money(cost, round_up=True)


def fetch_bars(client: Any, req: IngestRequest) -> pd.DataFrame:
    """Download the range and return it in the Bar shape. Costs money."""
    store = client.timeseries.get_range(
        dataset=DATASET,
        symbols=[req.symbol],
        schema=SCHEMA,
        stype_in=STYPE_IN,
        start=req.api_start,
        end=req.api_end,
    )
    frame = store.to_df(price_type="fixed", pretty_ts=False, map_symbols=False)
    return bars_from_dbn_frame(frame)


def bars_from_dbn_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Convert a `DBNStore.to_df()` ohlcv-1m frame to the Bar shape.

    Accepts the `price_type="fixed", pretty_ts=False` form (uint64 ns index, int64 prices in
    1e-9 units). Also accepts float prices and a tz aware DatetimeIndex, so the default
    `to_df()` form converts to the same bars.
    """
    if len(frame) == 0:
        return normalize_bars(pd.DataFrame({c: pd.Series(dtype="float64") for c in BAR_COLUMNS}))

    index = frame.index
    if isinstance(index, pd.DatetimeIndex):
        if index.tz is None:
            index = index.tz_localize("UTC")
        seconds = (index - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1)
        times = seconds.to_numpy(dtype="int64")
    else:
        times = (index.to_numpy(dtype="uint64") // NS_PER_SECOND).astype("int64")

    out = pd.DataFrame({"time": times})
    for col in ("open", "high", "low", "close"):
        values = frame[col]
        if values.dtype.kind in "iu":
            out[col] = values.to_numpy(dtype="int64") / FIXED_PRICE_SCALE
        else:
            out[col] = values.to_numpy(dtype="float64").round(9)
    out["volume"] = frame["volume"].to_numpy(dtype="int64")
    return normalize_bars(out)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IngestResult:
    status: str  # "estimate_only" | "refused" | "downloaded"
    estimate: Decimal
    total_before: Decimal
    cap: Decimal
    bars: int = 0
    summary: WriteSummary | None = None


def run_ingest(
    *,
    data_dir: Path,
    req: IngestRequest,
    cap: Decimal,
    confirmed: bool,
    client_factory: Callable[[], Any] = make_client,
    echo: Callable[[str], None] = print,
) -> IngestResult:
    """Estimate, then (only when `confirmed` and under the cap) download and store.

    Order: estimate -> print -> exit unless `confirmed` -> cap check -> reserve spend ->
    download -> write. Nothing is downloaded without `confirmed`.
    """
    client = client_factory()
    estimate = estimate_cost(client, req)
    ledger = SpendLedger(data_dir)
    total = ledger.total()
    check = check_cap(total, estimate, cap)

    echo(f"Databento {DATASET} {SCHEMA}, {req.symbol} (stype_in={STYPE_IN})")
    echo(f"  range      {req.start} to {req.end} inclusive (UTC)")
    echo(f"  estimate   {fmt_usd(estimate)}")
    echo(
        f"  spent so far {fmt_usd(total)}, cap {fmt_usd(cap)}, "
        f"after this {fmt_usd(check.projected)}"
    )

    if not confirmed:
        if not check.allowed:
            echo(
                f"  --yes would be REFUSED: {fmt_usd(check.projected)} is over the "
                f"{fmt_usd(cap)} cap."
            )
        echo("Nothing downloaded. Re-run with --yes to download.")
        return IngestResult("estimate_only", estimate, total, cap)

    if not check.allowed:
        echo(
            f"REFUSED: {fmt_usd(total)} spent + {fmt_usd(estimate)} estimate = "
            f"{fmt_usd(check.projected)}, over the {fmt_usd(cap)} cap. Nothing downloaded."
        )
        echo("Raise --cap only if you have checked your Databento credits.")
        return IngestResult("refused", estimate, total, cap)

    index = ledger.reserve(
        estimate,
        {
            "root": req.root,
            "symbol": req.symbol,
            "dataset": DATASET,
            "schema": SCHEMA,
            "start": req.start.isoformat(),
            "end": req.end.isoformat(),
        },
    )
    echo("Downloading...")
    try:
        bars = fetch_bars(client, req)
    except Exception as exc:
        if _is_client_rejection(exc):
            ledger.release(index)
            echo("Databento rejected the request; the estimate was taken back out of spend.json.")
        else:
            ledger.finish(index, "failed")
            echo(
                "Download failed. The estimate stays counted in spend.json (Databento may "
                "have billed some data). Edit total_usd by hand if you confirm no charge."
            )
        raise

    summary = write_bars(data_dir, req.root, bars)
    ledger.finish(index, "complete")
    return IngestResult("downloaded", estimate, total, cap, bars=len(bars), summary=summary)


def _is_client_rejection(exc: Exception) -> bool:
    """True for a 4xx from Databento: the request was refused before any data was sent."""
    try:
        from databento import BentoClientError
    except ImportError:  # pragma: no cover
        return False
    return isinstance(exc, BentoClientError)
