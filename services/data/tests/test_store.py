import pandas as pd
import pyarrow.parquet as pq
import pytest

from helpers import epoch, make_bars
from replaylab_data import store
from replaylab_data.store import BAR_COLUMNS, StoreError


def test_write_creates_layout_and_exact_bar_schema(data_dir):
    bars = make_bars(epoch("2024-01-02T14:30:00"), 5)
    summary = store.write_bars(data_dir, "NQ", bars)

    path = data_dir / "bars" / "NQ" / "2024.parquet"
    assert path.is_file()
    schema = pq.read_schema(path)
    assert [f.name for f in schema] == BAR_COLUMNS
    assert [str(f.type) for f in schema] == [
        "int64",
        "double",
        "double",
        "double",
        "double",
        "int64",
    ]
    assert summary.added == 5
    assert summary.replaced == 0
    assert not list(path.parent.glob("*.tmp"))


def test_round_trip_is_lossless(data_dir):
    bars = make_bars(epoch("2024-01-02T14:30:00"), 50)
    store.write_bars(data_dir, "ES", bars)
    back = store.read_bars(data_dir, "ES", 0, epoch("2025-01-01T00:00:00"))
    pd.testing.assert_frame_equal(back, bars)


def test_splits_files_by_utc_year(data_dir):
    t = epoch("2023-12-31T23:58:00")
    store.write_bars(data_dir, "NQ", make_bars(t, 4))  # 23:58, 23:59, 00:00, 00:01
    first = store.read_year(data_dir, "NQ", 2023)
    second = store.read_year(data_dir, "NQ", 2024)
    assert list(first["time"]) == [t, t + 60]
    assert list(second["time"]) == [t + 120, t + 180]


def test_merge_dedupes_on_time_new_wins_and_sorts(data_dir):
    t0 = epoch("2024-01-02T14:30:00")
    old = make_bars(t0, 5)  # t0 .. t0+4m
    store.write_bars(data_dir, "NQ", old)

    new = make_bars(t0 + 3 * 60, 4, base=30000.0)  # overlaps the last 2, adds 2
    summary = store.write_bars(data_dir, "NQ", new)

    assert summary.added == 2
    assert summary.replaced == 2
    merged = store.read_year(data_dir, "NQ", 2024)
    assert list(merged["time"]) == [t0 + i * 60 for i in range(7)]
    assert merged["time"].is_monotonic_increasing
    assert merged["time"].is_unique
    # first three untouched, overlap and tail come from the new batch
    assert list(merged["open"][:3]) == list(old["open"][:3])
    assert list(merged["open"][3:]) == list(new["open"])


def test_rewriting_the_same_bars_is_idempotent(data_dir):
    bars = make_bars(epoch("2024-01-02T14:30:00"), 10)
    store.write_bars(data_dir, "NQ", bars)
    again = store.write_bars(data_dir, "NQ", bars)
    assert again.added == 0
    assert again.replaced == 10
    assert len(store.read_year(data_dir, "NQ", 2024)) == 10


def test_unsorted_input_with_duplicates_is_sorted_and_deduped(data_dir):
    t0 = epoch("2024-01-02T14:30:00")
    bars = make_bars(t0, 4)
    messy = pd.concat([bars.iloc[[3, 1]], bars.iloc[[0, 2]], bars.iloc[[1]]], ignore_index=True)
    messy.loc[messy.index[-1], "close"] = 99999.0  # the later duplicate of t0+1m wins

    summary = store.write_bars(data_dir, "NQ", messy)

    assert summary.duplicates_in_input == 1
    out = store.read_year(data_dir, "NQ", 2024)
    assert list(out["time"]) == [t0 + i * 60 for i in range(4)]
    assert out.loc[1, "close"] == 99999.0


def test_empty_write_does_nothing(data_dir):
    summary = store.write_bars(data_dir, "NQ", make_bars(0, 0))
    assert summary.years == []
    assert not (data_dir / "bars").exists()


def test_read_bars_window_is_start_inclusive_end_exclusive_across_years(data_dir):
    t = epoch("2023-12-31T23:58:00")
    store.write_bars(data_dir, "NQ", make_bars(t, 6))  # 23:58 .. 00:03
    got = store.read_bars(data_dir, "NQ", t + 60, t + 4 * 60)
    assert list(got["time"]) == [t + 60, t + 120, t + 180]
    assert store.read_bars(data_dir, "NQ", t, t).empty


def test_read_bars_missing_root_is_empty(data_dir):
    assert store.read_bars(data_dir, "GC", 0, 10**9).empty


def test_micro_root_is_rejected_by_the_store(data_dir):
    with pytest.raises(ValueError, match="micro"):
        store.write_bars(data_dir, "MNQ", make_bars(0, 1))


def test_negative_prices_are_stored_cl_went_negative_in_2020(data_dir):
    bars = make_bars(epoch("2020-04-20T18:00:00"), 2, base=-37.0)
    store.write_bars(data_dir, "CL", bars)
    assert store.read_year(data_dir, "CL", 2020)["open"].iloc[0] == -37.0


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda d: d.drop(columns=["volume"]), "missing columns"),
        (lambda d: d.assign(close=float("nan")), "NaN or infinite"),
        (lambda d: d.assign(high=float("inf")), "NaN or infinite"),
        (lambda d: d.assign(volume=-1), "volume must be >= 0"),
        (lambda d: d.assign(volume=1.5), "whole numbers"),
        (lambda d: d.assign(time=d["time"].astype(str)), "must be numeric"),
    ],
)
def test_normalize_rejects_bad_bars(mutate, message):
    with pytest.raises(StoreError, match=message):
        store.normalize_bars(mutate(make_bars(0, 2)))


def test_normalize_casts_to_disk_dtypes():
    odd = pd.DataFrame(
        {"time": [60.0], "open": [1], "high": [2], "low": [1], "close": [2], "volume": [3.0]}
    )
    out = store.normalize_bars(odd)
    assert [str(t) for t in out.dtypes] == [
        "int64",
        "float64",
        "float64",
        "float64",
        "float64",
        "int64",
    ]


def test_info_counts_and_ranges(data_dir):
    t = epoch("2023-12-31T23:58:00")
    store.write_bars(data_dir, "NQ", make_bars(t, 6))
    store.write_bars(data_dir, "GC", make_bars(epoch("2024-03-04T00:00:00"), 3))

    infos = {i.root: i for i in store.all_root_info(data_dir)}
    assert set(infos) == {"NQ", "GC"}
    assert infos["NQ"].first == t
    assert infos["NQ"].last == t + 5 * 60
    assert infos["NQ"].bars == 6
    assert infos["NQ"].files == 2
    assert store.root_info(data_dir, "ES") is None


def test_resolve_data_dir_precedence(monkeypatch, tmp_path):
    monkeypatch.setenv("REPLAYLAB_DATA_DIR", str(tmp_path / "from_env"))
    assert store.resolve_data_dir() == tmp_path / "from_env"
    assert store.resolve_data_dir(tmp_path / "explicit") == tmp_path / "explicit"
    monkeypatch.delenv("REPLAYLAB_DATA_DIR")
    default = store.resolve_data_dir()
    assert default.name == "data"
    assert (default.parent / "docs" / "SPEC.md").is_file()  # <repo>/data in a checkout


def test_unreadable_file_raises_store_error(data_dir):
    path = data_dir / "bars" / "NQ" / "2024.parquet"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not parquet")
    with pytest.raises(StoreError):
        store.read_year(data_dir, "NQ", 2024)
