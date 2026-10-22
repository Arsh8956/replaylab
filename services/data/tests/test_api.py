import pytest
from fastapi.testclient import TestClient

from helpers import epoch, make_bars
from replaylab_data import store
from replaylab_data.api import create_app

DAY = 86400


@pytest.fixture
def seeded(data_dir):
    """NQ: 3000 bars from 2023-12-31 23:58 UTC (crosses a year file). ES: 3 bars."""
    t = epoch("2023-12-31T23:58:00")
    store.write_bars(data_dir, "NQ", make_bars(t, 3000))
    store.write_bars(data_dir, "ES", make_bars(epoch("2024-01-02T14:30:00"), 3, base=5000.0))
    return data_dir


@pytest.fixture
def client(seeded):
    return TestClient(create_app(seeded))


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_markets_lists_roots_on_disk_with_ranges(client):
    r = client.get("/markets")
    assert r.status_code == 200
    by_root = {m["root"]: m for m in r.json()}
    assert set(by_root) == {"NQ", "ES"}
    assert by_root["NQ"] == {
        "root": "NQ",
        "start": "2023-12-31T23:58:00Z",
        "end": "2024-01-03T01:57:00Z",
        "bars": 3000,
    }
    assert by_root["ES"]["bars"] == 3


def test_markets_empty(data_dir):
    assert TestClient(create_app(data_dir)).get("/markets").json() == []


def test_bars_returns_exactly_the_bar_type(client):
    r = client.get("/bars", params={"root": "ES", "start": "2024-01-02", "end": "2024-01-03"})
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 3
    for bar in body:
        assert set(bar) == {"time", "open", "high", "low", "close", "volume"}
        assert type(bar["time"]) is int
        assert type(bar["volume"]) is int
        for k in ("open", "high", "low", "close"):
            assert isinstance(bar[k], float)
    assert body[0] == {
        "time": epoch("2024-01-02T14:30:00"),
        "open": 5000.0,
        "high": 5001.0,
        "low": 4999.0,
        "close": 5000.25,
        "volume": 100,
    }
    assert [b["time"] for b in body] == sorted(b["time"] for b in body)


def test_bars_window_is_start_inclusive_end_exclusive_and_spans_year_files(client):
    t = epoch("2023-12-31T23:58:00")
    r = client.get(
        "/bars",
        params={"root": "NQ", "start": "2023-12-31T23:59:00Z", "end": "2024-01-01T00:02:00+00:00"},
    )
    assert [b["time"] for b in r.json()] == [t + 60, t + 120, t + 180]


def test_bars_accepts_iso_dates_and_offsets(client):
    t = epoch("2024-01-02T14:30:00")
    r = client.get(
        "/bars",
        params={
            "root": "ES",
            "start": "2024-01-02T09:30:00-05:00",
            "end": "2024-01-02T09:32:00-05:00",
        },
    )
    assert [b["time"] for b in r.json()] == [t, t + 60]


def test_bars_no_rows_in_range_is_an_empty_list(client):
    r = client.get("/bars", params={"root": "ES", "start": "2025-01-01", "end": "2025-01-02"})
    assert r.status_code == 200
    assert r.json() == []


def test_31_days_is_allowed_beyond_is_400(client):
    ok = client.get("/bars", params={"root": "NQ", "start": "2024-01-01", "end": "2024-02-01"})
    assert ok.status_code == 200  # exactly 31 days
    too_long = client.get(
        "/bars", params={"root": "NQ", "start": "2024-01-01", "end": "2024-02-02"}
    )
    assert too_long.status_code == 400
    assert "31 days" in too_long.json()["detail"]
    one_second = client.get(
        "/bars",
        params={"root": "NQ", "start": "2024-01-01T00:00:00Z", "end": "2024-02-01T00:00:01Z"},
    )
    assert one_second.status_code == 400


@pytest.mark.parametrize(
    ("params", "fragment"),
    [
        ({"root": "ZN", "start": "2024-01-01", "end": "2024-01-02"}, "Unknown root"),
        ({"root": "MNQ", "start": "2024-01-01", "end": "2024-01-02"}, "full size root"),
        ({"root": "NQ", "start": "2024-01-02", "end": "2024-01-01"}, "end must be after start"),
        ({"root": "NQ", "start": "2024-01-02", "end": "2024-01-02"}, "end must be after start"),
        ({"root": "NQ", "start": "yesterday", "end": "2024-01-02"}, "ISO 8601"),
        ({"root": "NQ", "start": "2024-01-01", "end": "2024-13-45T00:00:00"}, "ISO 8601"),
    ],
)
def test_bad_requests_are_400(client, params, fragment):
    r = client.get("/bars", params=params)
    assert r.status_code == 400
    assert fragment in r.json()["detail"]


def test_missing_params_are_422(client):
    assert client.get("/bars", params={"root": "NQ"}).status_code == 422


def test_root_with_no_data_is_404_with_a_hint(client):
    r = client.get("/bars", params={"root": "GC", "start": "2024-01-01", "end": "2024-01-02"})
    assert r.status_code == 404
    assert "ingest" in r.json()["detail"]


def test_cors_allows_local_dev_origins_only(client):
    for origin in ("http://localhost:5173", "http://127.0.0.1:4173"):
        r = client.get("/health", headers={"Origin": origin})
        assert r.headers["access-control-allow-origin"] == origin
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_cors_preflight(client):
    r = client.options(
        "/bars",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_extra_cors_origins_from_env(seeded, monkeypatch):
    monkeypatch.setenv("REPLAYLAB_CORS_ORIGINS", "https://replay.example, https://x.example")
    c = TestClient(create_app(seeded))
    r = c.get("/health", headers={"Origin": "https://replay.example"})
    assert r.headers["access-control-allow-origin"] == "https://replay.example"


def test_json_floats_survive_round_trip_without_noise(data_dir):
    t = epoch("2024-01-02T14:30:00")
    bars = make_bars(t, 1)
    bars.loc[0, ["open", "high", "low", "close"]] = [21016.75, 21018.0, 21009.5, 21016.75]
    store.write_bars(data_dir, "NQ", bars)
    body = (
        TestClient(create_app(data_dir))
        .get("/bars", params={"root": "NQ", "start": "2024-01-02", "end": "2024-01-03"})
        .json()
    )
    assert (body[0]["open"], body[0]["high"], body[0]["low"], body[0]["close"]) == (
        21016.75,
        21018.0,
        21009.5,
        21016.75,
    )
