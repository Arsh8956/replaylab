"""QA attacks on the Parquet store and the bars endpoint: exact Bar shape, window edges, weird
inputs, partial corruption.

Tests named `test_BUG_*` are expected to fail against the current implementation.
"""

from __future__ import annotations

import json
import re

import pandas as pd
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from helpers import epoch, make_bars
from replaylab_data import store
from replaylab_data.api import create_app
from replaylab_data.roots import ROOTS

BAR_KEYS = ["time", "open", "high", "low", "close", "volume"]


@pytest.fixture
def client_for(data_dir):
    def make():
        return TestClient(create_app(data_dir))

    return make


# --- on disk shape ------------------------------------------------------------------------------


@pytest.mark.parametrize("root", ROOTS)
def test_every_root_writes_exactly_the_bar_schema_and_no_index_column(data_dir, root):
    store.write_bars(data_dir, root, make_bars(epoch("2024-01-02T14:30:00"), 50))
    path = data_dir / "bars" / root / "2024.parquet"
    schema = pq.read_schema(path)
    assert schema.names == BAR_KEYS
    assert [str(t) for t in schema.types] == [
        "int64",
        "double",
        "double",
        "double",
        "double",
        "int64",
    ]
    assert schema.equals(store.BAR_SCHEMA, check_metadata=False)


def test_no_tmp_files_are_left_behind_and_stray_tmp_files_are_ignored(data_dir):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:30:00"), 5))
    assert [p.name for p in (data_dir / "bars" / "NQ").iterdir()] == ["2024.parquet"]
    (data_dir / "bars" / "NQ" / "2025.parquet.tmp").write_bytes(b"half written")
    (data_dir / "bars" / "NQ" / "notes.txt").write_text("hi")
    (data_dir / "bars" / "NQ" / "99.parquet").write_bytes(b"not a year")
    assert [y for y, _ in store.list_year_files(data_dir, "NQ")] == [2024]
    info = store.root_info(data_dir, "NQ")
    assert info is not None
    assert info.bars == 5


def test_a_crash_while_writing_leaves_the_previous_file_intact(data_dir, monkeypatch):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:30:00"), 5))
    before = (data_dir / "bars" / "NQ" / "2024.parquet").read_bytes()

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(store.pq, "write_table", boom)
    with pytest.raises(OSError):
        store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T15:30:00"), 5))
    assert (data_dir / "bars" / "NQ" / "2024.parquet").read_bytes() == before


def test_BUG_store_rejects_bars_whose_ohlc_cannot_exist(data_dir):
    """The CSV importer checks low <= open, close <= high. write_bars does not, so any other
    producer can put a bar with high below low on disk and into a replay."""
    bad = pd.DataFrame(
        {
            "time": [60],
            "open": [10.0],
            "high": [5.0],
            "low": [20.0],
            "close": [100.0],
            "volume": [1],
        }
    )
    with pytest.raises(store.StoreError):
        store.write_bars(data_dir, "NQ", bad)


# --- HTTP shape --------------------------------------------------------------------------------


def test_http_bars_are_exactly_the_engine_bar_type_in_the_raw_json(data_dir, client_for):
    store.write_bars(data_dir, "CL", make_bars(epoch("2024-01-02T14:30:00"), 20, base=70.07))
    r = client_for().get("/bars", params={"root": "CL", "start": "2024-01-02", "end": "2024-01-03"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    body = r.json()
    assert len(body) == 20
    for bar in body:
        assert list(bar) == BAR_KEYS  # exactly these keys, no extras, no index
        assert type(bar["time"]) is int
        assert type(bar["volume"]) is int
        assert all(isinstance(bar[k], float) for k in ("open", "high", "low", "close"))
        assert (
            bar["low"]
            <= min(bar["open"], bar["close"])
            <= max(bar["open"], bar["close"])
            <= bar["high"]
        )
    # integers stay integers on the wire: JS reads 1704205800 either way, a Python client would not
    assert re.search(r'"time":\d+,"open"', r.text)
    assert re.search(r'"volume":\d+\}', r.text)
    assert "e+" not in r.text.lower() and "nan" not in r.text.lower()
    # ascending, unique, minute aligned
    times = [b["time"] for b in body]
    assert times == sorted(set(times))
    assert all(t % 60 == 0 for t in times)


def test_http_and_disk_agree_bit_for_bit(data_dir, client_for):
    df = make_bars(epoch("2024-01-02T14:30:00"), 500, base=2300.1)
    store.write_bars(data_dir, "RTY", df)
    r = client_for().get(
        "/bars", params={"root": "RTY", "start": "2024-01-02", "end": "2024-01-04"}
    )
    got = pd.DataFrame(r.json())[BAR_KEYS]
    disk = store.read_bars(data_dir, "RTY", 0, 2**32)
    pd.testing.assert_frame_equal(got, disk)
    assert got.to_dict("records") == df.to_dict("records")


def test_big_numbers_do_not_turn_into_floats_or_scientific_notation(data_dir, client_for):
    df = make_bars(epoch("2024-01-02T14:30:00"), 3)
    df["volume"] = [2**53 - 1, 10**12, 0]
    df["open"] = [0.01, 123456.75, 0.1]
    df["low"] = [0.01, 123456.75, 0.1]
    df["high"] = [0.5, 123457.0, 0.2]
    df["close"] = [0.25, 123456.75, 0.1]
    store.write_bars(data_dir, "CL", df)
    r = client_for().get("/bars", params={"root": "CL", "start": "2024-01-02", "end": "2024-01-03"})
    assert [b["volume"] for b in r.json()] == [2**53 - 1, 10**12, 0]
    assert [b["open"] for b in r.json()] == [0.01, 123456.75, 0.1]
    assert "e-" not in r.text.lower()


# --- window semantics ---------------------------------------------------------------------------


def test_window_edges_to_the_second(data_dir, client_for):
    t = epoch("2024-01-02T14:30:00")
    store.write_bars(data_dir, "NQ", make_bars(t, 10))
    c = client_for()

    def get(s, e):
        r = c.get("/bars", params={"root": "NQ", "start": s, "end": e})
        assert r.status_code == 200
        return [b["time"] for b in r.json()]

    assert get("2024-01-02T14:30:00Z", "2024-01-02T14:33:00Z") == [t, t + 60, t + 120]
    assert get("2024-01-02T14:30:01Z", "2024-01-02T14:33:00Z") == [t + 60, t + 120]
    assert get("2024-01-02T14:29:59Z", "2024-01-02T14:30:00Z") == []  # end exclusive
    assert get("2024-01-02T14:29:59Z", "2024-01-02T14:30:01Z") == [t]
    assert get("2024-01-02T09:30:00-05:00", "2024-01-02T09:32:00-05:00") == [t, t + 60]
    assert get("2024-01-02T14:30:00", "2024-01-02T14:32:00") == [t, t + 60]  # naive is UTC


def test_exactly_31_days_ok_one_second_more_is_400(data_dir, client_for):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:30:00"), 5))
    c = client_for()
    ok = c.get(
        "/bars",
        params={"root": "NQ", "start": "2024-01-01T00:00:00Z", "end": "2024-02-01T00:00:00Z"},
    )
    over = c.get(
        "/bars",
        params={"root": "NQ", "start": "2024-01-01T00:00:00Z", "end": "2024-02-01T00:00:01Z"},
    )
    assert ok.status_code == 200
    assert over.status_code == 400
    assert "31" in over.json()["detail"]


def test_31_day_window_across_new_year_reads_both_year_files(data_dir, client_for):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2023-12-31T23:00:00"), 180))
    r = client_for().get("/bars", params={"root": "NQ", "start": "2023-12-15", "end": "2024-01-15"})
    assert r.status_code == 200
    times = [b["time"] for b in r.json()]
    assert len(times) == 180
    assert times == sorted(times)
    assert epoch("2024-01-01T00:00:00") in times


def test_gap_years_and_dates_outside_the_data_are_empty_not_errors(data_dir, client_for):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2022-06-01T14:30:00"), 5))
    store.write_bars(data_dir, "NQ", make_bars(epoch("2025-06-01T14:30:00"), 5))
    c = client_for()
    for s, e in [
        ("2024-01-01", "2024-01-20"),
        ("2010-01-01", "2010-01-02"),
        ("2030-01-01", "2030-01-02"),
    ]:
        r = c.get("/bars", params={"root": "NQ", "start": s, "end": e})
        assert (r.status_code, r.json()) == (200, [])


def test_404_only_when_the_root_has_nothing_on_disk(data_dir, client_for):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:30:00"), 5))
    c = client_for()
    assert (
        c.get(
            "/bars", params={"root": "ES", "start": "2024-01-02", "end": "2024-01-03"}
        ).status_code
        == 404
    )
    assert (
        c.get(
            "/bars", params={"root": "NQ", "start": "2024-01-02", "end": "2024-01-03"}
        ).status_code
        == 200
    )
    assert (
        c.get(
            "/bars", params={"root": "nq", "start": "2024-01-02", "end": "2024-01-03"}
        ).status_code
        == 200
    )


@pytest.mark.parametrize(
    ("start", "end"),
    [
        ("2024-01-02", "2024-01-02"),  # empty window
        ("2024-01-03", "2024-01-02"),  # reversed
        ("2024-13-01", "2024-01-02"),
        ("2024-01-02", "tomorrow"),
        ("", "2024-01-02"),
        ("2024-01-02T25:00:00Z", "2024-01-03"),
        ("1704205800", "1704292200"),  # epoch seconds are not ISO
    ],
)
def test_bad_windows_are_400_with_a_message(data_dir, client_for, start, end):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:30:00"), 5))
    r = client_for().get("/bars", params={"root": "NQ", "start": start, "end": end})
    assert r.status_code == 400
    assert r.json()["detail"]


@pytest.mark.parametrize(
    ("start", "end"),
    [
        ("0001-01-01T00:00:00+05:00", "0001-01-10"),  # UTC instant is in year 0
        ("9999-12-30", "9999-12-31T23:59:59-05:00"),  # UTC instant is in year 10000
        ("0001-01-01T00:00:00+14:00", "0001-01-02"),
    ],
)
def test_BUG_extreme_dates_are_400_or_empty_never_a_500(data_dir, start, end):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:30:00"), 5))
    c = TestClient(create_app(data_dir), raise_server_exceptions=False)
    r = c.get("/bars", params={"root": "NQ", "start": start, "end": end})
    assert r.status_code in (200, 400)


# --- damaged stores ---------------------------------------------------------------------------


def test_one_corrupt_year_only_breaks_queries_that_need_it(data_dir, client_for):
    store.write_bars(data_dir, "NQ", make_bars(epoch("2023-06-01T14:30:00"), 5))
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-06-03T14:30:00"), 5))
    (data_dir / "bars" / "NQ" / "2023.parquet").write_bytes(b"PAR1 definitely not parquet")
    c = TestClient(create_app(data_dir), raise_server_exceptions=False)
    ok = c.get("/bars", params={"root": "NQ", "start": "2024-06-01", "end": "2024-06-10"})
    assert ok.status_code == 200 and len(ok.json()) == 5
    broken = c.get("/bars", params={"root": "NQ", "start": "2023-06-01", "end": "2023-06-10"})
    assert broken.status_code == 500
    assert "2023.parquet" in broken.json()["detail"]
    assert c.get("/markets").status_code == 500
    assert c.get("/health").status_code == 200


def test_a_parquet_file_with_the_wrong_columns_is_a_clean_error(data_dir):
    folder = data_dir / "bars" / "NQ"
    folder.mkdir(parents=True)
    pd.DataFrame({"t": [1], "px": [2.0]}).to_parquet(folder / "2024.parquet")
    c = TestClient(create_app(data_dir), raise_server_exceptions=False)
    r = c.get("/bars", params={"root": "NQ", "start": "2024-01-01", "end": "2024-01-02"})
    assert r.status_code == 500
    assert "Traceback" not in r.text


def test_data_written_after_the_app_started_is_served_without_a_restart(data_dir, client_for):
    c = client_for()
    assert (
        c.get(
            "/bars", params={"root": "NQ", "start": "2024-01-02", "end": "2024-01-03"}
        ).status_code
        == 404
    )
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:30:00"), 5))
    r = c.get("/bars", params={"root": "NQ", "start": "2024-01-02", "end": "2024-01-03"})
    assert r.status_code == 200 and len(r.json()) == 5
    store.write_bars(data_dir, "NQ", make_bars(epoch("2024-01-02T14:35:00"), 5))
    r = c.get("/bars", params={"root": "NQ", "start": "2024-01-02", "end": "2024-01-03"})
    assert len(r.json()) == 10
    markets = {m["root"]: m for m in c.get("/markets").json()}
    assert markets["NQ"]["bars"] == 10


def test_markets_start_and_end_are_first_and_last_bar_open_times(data_dir, client_for):
    t = epoch("2024-01-02T14:30:00")
    store.write_bars(data_dir, "GC", make_bars(t, 7))
    m = client_for().get("/markets").json()
    assert m == [
        {"root": "GC", "start": "2024-01-02T14:30:00Z", "end": "2024-01-02T14:36:00Z", "bars": 7}
    ]


def test_json_round_trip_of_the_whole_response_is_lossless(data_dir, client_for):
    df = make_bars(epoch("2024-01-02T14:30:00"), 1000, base=70.07)
    store.write_bars(data_dir, "CL", df)
    r = client_for().get("/bars", params={"root": "CL", "start": "2024-01-02", "end": "2024-01-04"})
    assert json.loads(r.text) == df.to_dict("records")
