"""Test helpers. Everything is generated here; nothing touches the network.

`FakeHistorical` stands in for `databento.Historical`. Its `timeseries.get_range` returns a
REAL `DBNStore` built in memory (databento_dbn encodes the bytes), so the conversion code is
tested against the library's actual `to_df()` output, not a hand made frame.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import databento
import databento_dbn as dbn
import pandas as pd

from replaylab_data.store import empty_bars

NS = 1_000_000_000


def epoch(text: str) -> int:
    """Unix seconds for an ISO UTC string like 2024-01-02T09:30:00."""
    return int(datetime.fromisoformat(text).replace(tzinfo=UTC).timestamp())


def make_bars(start: int, count: int, *, step: int = 60, base: float = 21000.0) -> pd.DataFrame:
    """Deterministic Bar frame: times start, start+step, ... prices on a 0.25 grid."""
    if count == 0:
        return empty_bars()
    rows = []
    for i in range(count):
        o = base + (i % 10) * 0.25
        rows.append(
            {
                "time": start + i * step,
                "open": o,
                "high": o + 1.0,
                "low": o - 1.0,
                "close": o + 0.25,
                "volume": 100 + i,
            }
        )
    return pd.DataFrame(rows).astype(
        {
            "time": "int64",
            "open": "float64",
            "high": "float64",
            "low": "float64",
            "close": "float64",
            "volume": "int64",
        }
    )


def make_dbn_store(rows: list[tuple[int, float, float, float, float, int, int]]):
    """Real DBNStore with ohlcv-1m records.

    rows: (ts_event_seconds, open, high, low, close, volume, instrument_id).
    Prices are encoded as Databento fixed point (int, 1e-9 units).
    """
    metadata = dbn.Metadata(
        dataset="GLBX.MDP3",
        start=rows[0][0] * NS if rows else 0,
        stype_in=dbn.SType.CONTINUOUS,
        stype_out=dbn.SType.INSTRUMENT_ID,
        schema=dbn.Schema.OHLCV_1M,
        symbols=["NQ.v.0"],
        partial=[],
        not_found=[],
        mappings=[],
        end=(rows[-1][0] + 60) * NS if rows else 0,
    )
    payload = bytes(metadata)
    for ts, o, h, low, c, v, instrument_id in rows:
        msg = dbn.OHLCVMsg(
            publisher_id=1,
            instrument_id=instrument_id,
            ts_event=ts * NS,
            open=round(o * NS),
            high=round(h * NS),
            low=round(low * NS),
            close=round(c * NS),
            volume=v,
            rtype=int(dbn.RType.OHLCV_1M),
        )
        payload += bytes(msg)
    return databento.DBNStore.from_bytes(payload)


class _Metadata:
    def __init__(self, owner: FakeHistorical) -> None:
        self._owner = owner

    def get_cost(self, **kwargs: Any) -> float:
        self._owner.cost_calls.append(kwargs)
        return self._owner.cost


class _Timeseries:
    def __init__(self, owner: FakeHistorical) -> None:
        self._owner = owner

    def get_range(self, **kwargs: Any):
        self._owner.range_calls.append(kwargs)
        if self._owner.range_error is not None:
            raise self._owner.range_error
        return make_dbn_store(self._owner.rows)


class FakeHistorical:
    """Records calls; returns a canned cost and a real DBNStore."""

    def __init__(
        self,
        *,
        cost: float = 1.5,
        rows: list[tuple[int, float, float, float, float, int, int]] | None = None,
        range_error: Exception | None = None,
    ) -> None:
        self.cost = cost
        self.rows = rows if rows is not None else default_rows()
        self.range_error = range_error
        self.cost_calls: list[dict[str, Any]] = []
        self.range_calls: list[dict[str, Any]] = []
        self.metadata = _Metadata(self)
        self.timeseries = _Timeseries(self)


def default_rows() -> list[tuple[int, float, float, float, float, int, int]]:
    """Five 1m bars on 2024-01-02, with an instrument change (a roll) after the third."""
    t0 = epoch("2024-01-02T14:30:00")
    return [
        (t0 + 0 * 60, 16000.25, 16001.00, 15999.50, 16000.75, 120, 111),
        (t0 + 1 * 60, 16000.75, 16002.50, 16000.50, 16002.25, 95, 111),
        (t0 + 2 * 60, 16002.25, 16002.75, 16001.00, 16001.25, 80, 111),
        (t0 + 3 * 60, 16120.00, 16121.25, 16119.75, 16120.50, 60, 222),
        (t0 + 4 * 60, 16120.50, 16120.75, 16119.50, 16119.75, 70, 222),
    ]


def write_spend(data_dir, total: str) -> None:
    """Pre-seed spend.json with a running total."""
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "spend.json").write_text(
        f'{{"version": 1, "total_usd": {Decimal(total)}, "entries": []}}\n', encoding="utf-8"
    )
