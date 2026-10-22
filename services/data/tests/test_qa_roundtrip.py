"""QA: the Python importer, the Parquet store and the HTTP endpoint against fixtures shared with
the engine's own CSV parser (packages/engine/test/fixtures). Both sides must agree on every bar.

Tests named `test_BUG_*` are expected to fail against the current implementation.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from helpers import epoch
from replaylab_data.api import create_app
from replaylab_data.csv_import import parse_csv_text
from replaylab_data.store import write_bars

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "engine" / "test" / "fixtures"


def load_json(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def serve(data_dir, csv_name: str, root: str, tz: str, start: str, end: str) -> list[dict]:
    res = parse_csv_text((FIXTURES / csv_name).read_text(encoding="utf-8"), tz)
    assert res.errors == []
    write_bars(data_dir, root, res.bars)
    r = TestClient(create_app(data_dir)).get(
        "/bars", params={"root": root, "start": start, "end": end}
    )
    assert r.status_code == 200
    return r.json()


def test_fixtures_exist():
    for name in (
        "dst-weeks-ny.csv",
        "dst-weeks-ny.spring.api.json",
        "dst-weeks-ny.fall.api.json",
        "cl-negative-2020-04-20.csv",
        "cl-negative-2020-04-20.api.json",
    ):
        assert (FIXTURES / name).is_file(), name


def test_new_york_wall_clock_csv_across_both_dst_weekends_serves_the_pinned_bars(data_dir):
    spring = serve(
        data_dir, "dst-weeks-ny.csv", "NQ", "America/New_York", "2024-03-01", "2024-03-31"
    )
    fall = serve(data_dir, "dst-weeks-ny.csv", "NQ", "America/New_York", "2024-10-29", "2024-11-28")
    assert spring == load_json("dst-weeks-ny.spring.api.json")
    assert fall == load_json("dst-weeks-ny.fall.api.json")


def test_dst_instants_are_the_hand_computed_utc_times(data_dir):
    spring = serve(
        data_dir, "dst-weeks-ny.csv", "NQ", "America/New_York", "2024-03-01", "2024-03-31"
    )
    fall = serve(data_dir, "dst-weeks-ny.csv", "NQ", "America/New_York", "2024-10-29", "2024-11-28")
    assert [b["time"] for b in spring] == [
        epoch("2024-03-08T21:58:00"),  # Fri 16:58 EST
        epoch("2024-03-08T21:59:00"),
        epoch("2024-03-10T22:00:00"),  # Sun 18:00 EDT: the clocks changed that morning
        epoch("2024-03-10T22:01:00"),
        epoch("2024-03-10T22:02:00"),
        epoch("2024-03-11T13:30:00"),  # Mon 09:30 EDT
        epoch("2024-03-11T13:31:00"),
    ]
    assert [b["time"] for b in fall] == [
        epoch("2024-11-01T20:59:00"),  # Fri 16:59 EDT
        epoch("2024-11-03T23:00:00"),  # Sun 18:00 EST: the clocks changed back that morning
        epoch("2024-11-03T23:01:00"),
        epoch("2024-11-04T14:30:00"),  # Mon 09:30 EST
    ]


def test_every_served_bar_is_exactly_the_engine_bar_type(data_dir):
    bars = serve(data_dir, "dst-weeks-ny.csv", "NQ", "America/New_York", "2024-03-01", "2024-03-31")
    bars += serve(
        data_dir, "dst-weeks-ny.csv", "NQ", "America/New_York", "2024-10-29", "2024-11-28"
    )
    assert len(bars) == 11
    for b in bars:
        assert list(b) == ["time", "open", "high", "low", "close", "volume"]
        assert type(b["time"]) is int
        assert type(b["volume"]) is int
        for k in ("open", "high", "low", "close"):
            assert type(b[k]) is float
            assert (b[k] * 4) == int(b[k] * 4)  # on the NQ 0.25 grid exactly
        assert b["low"] <= min(b["open"], b["close"]) <= max(b["open"], b["close"]) <= b["high"]


def test_negative_cl_csv_serves_the_pinned_bars(data_dir):
    got = serve(data_dir, "cl-negative-2020-04-20.csv", "CL", "UTC", "2020-04-20", "2020-04-21")
    assert got == load_json("cl-negative-2020-04-20.api.json")
    assert [b["low"] for b in got] == [17.5, 1.0, -37.63, -40.32, -37.63]


@pytest.mark.parametrize(
    "tz", ["America/New_York", "America/Chicago", "UTC", "Asia/Tokyo", "Europe/London"]
)
def test_same_wall_clock_csv_in_other_zones_shifts_by_exactly_the_zone_offset(data_dir, tz):
    """Guards the tz option: Mon 2024-03-11 09:30 wall time is a different instant in each zone."""
    res = parse_csv_text("time,open,high,low,close,volume\n2024-03-11 09:30:00,1,2,0.5,1,5\n", tz)
    t = int(res.bars["time"].iloc[0])
    expected = {
        "America/New_York": epoch("2024-03-11T13:30:00"),
        "America/Chicago": epoch("2024-03-11T14:30:00"),
        "UTC": epoch("2024-03-11T09:30:00"),
        "Asia/Tokyo": epoch("2024-03-11T00:30:00"),
        "Europe/London": epoch("2024-03-11T09:30:00"),
    }[tz]
    assert t == expected
