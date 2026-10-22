"""QA attacks on the Databento ingest path: date semantics, micros, empty/odd downloads, price
fidelity. The Databento client is always the mock from helpers.py.

Tests named `test_BUG_*` are expected to fail against the current implementation.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from helpers import FakeHistorical, epoch
from replaylab_data import cli
from replaylab_data import databento_ingest as ing
from replaylab_data.api import create_app
from replaylab_data.roots import MICRO_TO_ROOT
from replaylab_data.spend import SpendLedger
from replaylab_data.store import read_bars

MICROS = sorted(MICRO_TO_ROOT)


def run(data_dir, client, *, start="2024-01-02", end="2024-01-02", root="NQ", confirmed=True):
    return ing.run_ingest(
        data_dir=data_dir,
        req=ing.make_request(root, start, end),
        cap=Decimal("100"),
        confirmed=confirmed,
        client_factory=lambda: client,
        echo=lambda _s: None,
    )


# --- --end is inclusive, Databento's end is exclusive ---------------------------------------


@pytest.mark.parametrize(
    ("start", "end", "api_start", "api_end"),
    [
        ("2024-01-02", "2024-01-02", "2024-01-02", "2024-01-03"),  # one day ingests one day
        ("2024-12-31", "2024-12-31", "2024-12-31", "2025-01-01"),  # year end
        ("2023-12-31", "2024-01-01", "2023-12-31", "2024-01-02"),  # across New Year
        ("2024-02-28", "2024-02-29", "2024-02-28", "2024-03-01"),  # leap day
        ("2023-02-28", "2023-02-28", "2023-02-28", "2023-03-01"),  # no leap day
        ("2024-03-09", "2024-03-10", "2024-03-09", "2024-03-11"),  # US DST day: UTC, no shift
        ("2024-11-03", "2024-11-03", "2024-11-03", "2024-11-04"),
    ],
)
def test_end_is_inclusive_and_sent_as_the_next_midnight_utc(start, end, api_start, api_end):
    req = ing.make_request("NQ", start, end)
    assert (req.api_start, req.api_end) == (api_start, api_end)


def test_estimate_and_download_ask_databento_for_the_same_window(data_dir):
    client = FakeHistorical(cost=1.0)
    run(data_dir, client, start="2024-02-28", end="2024-02-29")
    cost = client.cost_calls[0]
    got = client.range_calls[0]
    for key in ("dataset", "symbols", "schema", "stype_in", "start", "end"):
        assert cost[key] == got[key]
    assert (got["start"], got["end"]) == ("2024-02-28", "2024-03-01")


def test_date_objects_and_strings_are_equivalent():
    a = ing.make_request("NQ", date(2024, 1, 2), date(2024, 1, 5))
    b = ing.make_request("NQ", "2024-01-02", "2024-01-05")
    assert a == b


@pytest.mark.parametrize("bad", ["2024-02-30", "2024-13-01", "01/02/2024", "", "yesterday"])
def test_bad_dates_are_ingest_errors(bad):
    with pytest.raises(ing.IngestError):
        ing.make_request("NQ", bad, "2024-03-01")
    with pytest.raises(ing.IngestError):
        ing.make_request("NQ", "2024-01-01", bad)


def test_end_before_start_is_an_error_but_single_day_is_fine():
    with pytest.raises(ing.IngestError):
        ing.make_request("NQ", "2024-01-02", "2024-01-01")
    assert ing.make_request("NQ", "2024-01-02", "2024-01-02").end == date(2024, 1, 2)


# --- micros are rejected everywhere, before anything happens ---------------------------------


@pytest.mark.parametrize("micro", MICROS)
def test_micro_is_rejected_by_ingest_cli_without_building_a_client(data_dir, micro, capsys):
    def factory():
        raise AssertionError("no client for a micro")

    rc = cli.main(
        [
            "--data-dir",
            str(data_dir),
            "ingest",
            "--root",
            micro,
            "--start",
            "2024-01-02",
            "--end",
            "2024-01-02",
            "--yes",
        ],
        client_factory=factory,
    )
    err = capsys.readouterr().err
    assert rc == 1
    assert MICRO_TO_ROOT[micro] in err
    assert not (data_dir / "spend.json").exists()
    assert not (data_dir / "bars").exists()


@pytest.mark.parametrize("micro", MICROS)
def test_micro_is_rejected_by_import_csv(data_dir, tmp_path, micro, capsys):
    f = tmp_path / "bars.csv"
    f.write_text(
        "time,open,high,low,close,volume\n2024-01-02T14:30:00Z,1,2,0.5,1,5\n", encoding="utf-8"
    )
    rc = cli.main(["--data-dir", str(data_dir), "import-csv", str(f), "--root", micro])
    assert rc == 1
    assert MICRO_TO_ROOT[micro] in capsys.readouterr().err
    assert not (data_dir / "bars").exists()


@pytest.mark.parametrize("micro", MICROS)
def test_micro_is_rejected_by_the_bars_endpoint_even_with_data_on_disk(data_dir, micro):
    from helpers import make_bars
    from replaylab_data.store import write_bars

    write_bars(data_dir, MICRO_TO_ROOT[micro], make_bars(epoch("2024-01-02T14:30:00"), 5))
    client = TestClient(create_app(data_dir))
    r = client.get("/bars", params={"root": micro, "start": "2024-01-02", "end": "2024-01-03"})
    assert r.status_code == 400
    assert MICRO_TO_ROOT[micro] in r.json()["detail"]
    # lower case and padded spellings are still micros
    r = client.get(
        "/bars", params={"root": f" {micro.lower()} ", "start": "2024-01-02", "end": "2024-01-03"}
    )
    assert r.status_code == 400


@pytest.mark.parametrize("root", ["../ES", "NQ/../ES", "NQ.parquet", "NQ%00", "*", "", "nq nq"])
def test_bars_endpoint_cannot_be_pointed_outside_the_store(data_dir, root):
    client = TestClient(create_app(data_dir))
    r = client.get("/bars", params={"root": root, "start": "2024-01-02", "end": "2024-01-03"})
    assert r.status_code == 400


# --- odd downloads ---------------------------------------------------------------------------


def test_empty_download_is_ok_counts_the_spend_and_writes_nothing(data_dir):
    client = FakeHistorical(cost=1.25, rows=[])
    result = run(data_dir, client)
    assert result.status == "downloaded"
    assert result.bars == 0
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("1.25")
    assert [e["status"] for e in ledger.entries()] == ["complete"]
    assert not list(data_dir.glob("bars/**/*.parquet"))


def test_re_ingesting_the_same_range_is_idempotent_for_bars_and_additive_for_spend(data_dir):
    run(data_dir, FakeHistorical(cost=2.0))
    first = read_bars(data_dir, "NQ", 0, 2**32)
    run(data_dir, FakeHistorical(cost=2.0))
    again = read_bars(data_dir, "NQ", 0, 2**32)
    pd.testing.assert_frame_equal(first, again)
    assert SpendLedger(data_dir).total() == Decimal("4")


def test_ingest_across_new_year_splits_by_utc_year_exactly_at_midnight(data_dir):
    t = epoch("2023-12-31T23:58:00")
    rows = [(t + i * 60, 100.0, 101.0, 99.0, 100.5, 10, 1) for i in range(4)]
    run(data_dir, FakeHistorical(rows=rows), start="2023-12-31", end="2024-01-01")
    files = sorted(p.name for p in data_dir.glob("bars/NQ/*.parquet"))
    assert files == ["2023.parquet", "2024.parquet"]
    a = read_bars(data_dir, "NQ", 0, epoch("2024-01-01T00:00:00"))
    b = read_bars(data_dir, "NQ", epoch("2024-01-01T00:00:00"), 2**32)
    assert list(a["time"]) == [t, t + 60]
    assert list(b["time"]) == [t + 120, t + 180]


def test_unsorted_and_duplicate_bars_from_databento_are_sorted_and_last_wins(data_dir):
    t = epoch("2024-01-02T14:30:00")
    rows = [
        (t + 120, 3.0, 3.5, 2.5, 3.25, 30, 1),
        (t, 1.0, 1.5, 0.5, 1.25, 10, 1),
        (t + 60, 2.0, 2.5, 1.5, 2.25, 20, 1),
        (t + 60, 9.0, 9.5, 8.5, 9.25, 99, 2),  # same minute again: later row wins
    ]
    run(data_dir, FakeHistorical(rows=rows))
    got = read_bars(data_dir, "NQ", 0, 2**32)
    assert list(got["time"]) == [t, t + 60, t + 120]
    assert got.loc[1, "close"] == 9.25
    assert got.loc[1, "volume"] == 99


# --- price and time fidelity -------------------------------------------------------------------


def _fixed_frame(times_s, prices_fixed, volume=1):
    idx = pd.Index(np.asarray(times_s, dtype="uint64") * np.uint64(1_000_000_000))
    p = np.asarray(prices_fixed, dtype="int64")
    return pd.DataFrame(
        {"open": p, "high": p, "low": p, "close": p, "volume": np.full(len(p), volume, "int64")},
        index=idx,
    )


@pytest.mark.parametrize(("tick", "scale"), [(0.01, 100), (0.1, 10), (0.25, 4), (1.0, 1)])
def test_every_price_on_the_grid_converts_to_the_exact_double_you_would_type(tick, scale):
    """CL 0.01, RTY/GC 0.1, NQ/ES 0.25, YM 1: fixed point / 1e9 must equal float('x.xx')."""
    n = 30_000
    units = np.arange(1, n + 1, dtype="int64")  # ticks
    fixed = (units * round(tick * 1e9)).astype("int64")
    out = ing.bars_from_dbn_frame(_fixed_frame(np.arange(n) * 60, fixed))
    decimals = {0.01: 2, 0.1: 1, 0.25: 2, 1.0: 0}[tick]
    want = np.array([float(f"{u * tick:.{decimals}f}") for u in units.tolist()])
    assert (out["close"].to_numpy() == want).all()


def test_negative_cl_prices_survive_ingest_disk_and_http(data_dir):
    """2020-04-20: CL May contract settled at -37.63."""
    t = epoch("2020-04-20T18:00:00")
    rows = [
        (t, 10.01, 10.50, 1.00, 1.75, 900, 1),
        (t + 60, 1.75, 2.00, -37.63, -36.98, 5000, 1),
        (t + 120, -36.98, -0.01, -40.32, -37.63, 4000, 1),
    ]
    run(data_dir, FakeHistorical(rows=rows), root="CL", start="2020-04-20", end="2020-04-20")
    r = TestClient(create_app(data_dir)).get(
        "/bars", params={"root": "CL", "start": "2020-04-20", "end": "2020-04-22"}
    )
    assert r.status_code == 200
    body = r.json()
    assert [b["low"] for b in body] == [1.0, -37.63, -40.32]
    assert [b["close"] for b in body] == [1.75, -36.98, -37.63]
    assert body[1]["time"] == t + 60


def test_bar_time_is_the_open_floor_of_the_nanosecond_timestamp():
    t = epoch("2024-01-02T14:30:00")
    frame = _fixed_frame([t, t + 60], [21_000_250_000_000, 21_000_500_000_000])
    # push the second timestamp to 999,999,999 ns past the minute: still the same bar
    frame.index = pd.Index(np.array([t * 10**9, (t + 60) * 10**9 + 999_999_999], dtype="uint64"))
    out = ing.bars_from_dbn_frame(frame)
    assert list(out["time"]) == [t, t + 60]


def test_nan_prices_in_a_float_frame_are_rejected_not_stored():
    idx = pd.DatetimeIndex(["2024-01-02T14:30:00"], tz="UTC")
    frame = pd.DataFrame(
        {"open": [np.nan], "high": [1.0], "low": [1.0], "close": [1.0], "volume": [1]}, index=idx
    )
    with pytest.raises(ValueError):
        ing.bars_from_dbn_frame(frame)


def test_dst_weekend_bars_keep_their_utc_open_times(data_dir):
    """Sun 2024-03-10 18:00 ET (EDT) = 22:00Z; Fri 2024-03-08 16:59 ET (EST) = 21:59Z. Ingest is
    UTC all the way, so nothing may shift by an hour across the clock change."""
    fri_last = epoch("2024-03-08T21:59:00")
    sun_open = epoch("2024-03-10T22:00:00")
    rows = [
        (fri_last, 100.0, 101.0, 99.0, 100.0, 1, 1),
        (sun_open, 100.0, 101.0, 99.0, 100.0, 1, 1),
    ]
    run(data_dir, FakeHistorical(rows=rows), start="2024-03-08", end="2024-03-10")
    got = read_bars(data_dir, "NQ", 0, 2**32)
    assert list(got["time"]) == [fri_last, sun_open]
