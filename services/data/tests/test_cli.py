import os
import subprocess
import sys

from helpers import FakeHistorical, epoch, write_spend
from replaylab_data import store
from replaylab_data.cli import EXIT_ERROR, EXIT_OK, EXIT_REFUSED, main

INGEST = ["ingest", "--root", "NQ", "--start", "2024-01-01", "--end", "2024-03-31"]


def call(argv, data_dir, client=None):
    factory = (lambda: client) if client is not None else None
    return main(["--data-dir", str(data_dir), *argv], client_factory=factory)


# --- ingest ----------------------------------------------------------------------------------


def test_ingest_without_yes_prints_estimate_and_exits_without_downloading(data_dir, capsys):
    client = FakeHistorical(cost=4.2)
    assert call(INGEST, data_dir, client) == EXIT_OK
    out = capsys.readouterr().out
    assert "estimate   $4.20" in out
    assert "Re-run with --yes" in out
    assert client.range_calls == []
    assert not (data_dir / "bars").exists()


def test_ingest_yes_downloads_and_reports(data_dir, capsys):
    client = FakeHistorical(cost=4.2)
    assert call([*INGEST, "--yes"], data_dir, client) == EXIT_OK
    out = capsys.readouterr().out
    assert "Downloaded 5 bars for NQ" in out
    assert (data_dir / "bars" / "NQ" / "2024.parquet").is_file()
    assert len(client.range_calls) == 1


def test_ingest_over_cap_exits_3_and_downloads_nothing(data_dir, capsys):
    write_spend(data_dir, "99.00")
    client = FakeHistorical(cost=2.0)
    assert call([*INGEST, "--yes"], data_dir, client) == EXIT_REFUSED
    assert "REFUSED" in capsys.readouterr().out
    assert client.range_calls == []


def test_ingest_cap_flag(data_dir):
    client = FakeHistorical(cost=4.2)
    assert call([*INGEST, "--yes", "--cap", "4.19"], data_dir, client) == EXIT_REFUSED
    assert call([*INGEST, "--yes", "--cap", "4.20"], data_dir, client) == EXIT_OK


def test_ingest_micro_is_an_error_naming_the_full_size_root(data_dir, capsys):
    argv = ["ingest", "--root", "MNQ", "--start", "2024-01-01", "--end", "2024-01-31", "--yes"]
    client = FakeHistorical()
    assert call(argv, data_dir, client) == EXIT_ERROR
    err = capsys.readouterr().err
    assert "micro" in err and "use NQ" in err
    assert client.cost_calls == [] and client.range_calls == []


def test_ingest_without_a_key_is_a_clean_error(data_dir, capsys, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(store, "find_repo_root", lambda: None)
    assert call(INGEST, data_dir) == EXIT_ERROR
    assert "DATABENTO_API_KEY" in capsys.readouterr().err


def test_ingest_api_failure_is_a_clean_error(data_dir, capsys):
    client = FakeHistorical(range_error=ConnectionError("dropped"))
    assert call([*INGEST, "--yes"], data_dir, client) == EXIT_ERROR
    assert "ConnectionError" in capsys.readouterr().err


# --- import-csv ------------------------------------------------------------------------------


def write_csv(path, *rows):
    path.write_text("\n".join(["Time,Open,High,Low,Close,Volume", *rows]) + "\n")
    return path


def test_import_csv_writes_bars_and_reports_bad_rows(data_dir, tmp_path, capsys):
    f = write_csv(
        tmp_path / "x.csv",
        "2024-01-02 09:30:00,1,2,0.5,1.5,10",
        "2024-01-02 09:31:00,oops,2,0.5,1.5,10",
        "2024-01-02 09:32:00,1,2,0.5,1.5,10",
    )
    argv = ["import-csv", str(f), "--root", "NQ", "--tz", "America/New_York"]
    assert call(argv, data_dir) == EXIT_OK
    out = capsys.readouterr().out
    assert "Read 3 data rows" in out
    assert "Imported 2 bars into NQ" in out
    assert "1 bad rows were NOT imported" in out
    assert "line 3:" in out
    bars = store.read_year(data_dir, "NQ", 2024)
    assert list(bars["time"]) == [epoch("2024-01-02T14:30:00"), epoch("2024-01-02T14:32:00")]


def test_import_csv_merges_with_existing_bars(data_dir, tmp_path, capsys):
    a = write_csv(tmp_path / "a.csv", "2024-01-02 09:30:00,1,2,0.5,1.5,10")
    b = write_csv(
        tmp_path / "b.csv",
        "2024-01-02 09:30:00,5,6,4,5.5,99",
        "2024-01-02 09:31:00,1,2,0.5,1.5,10",
    )
    call(["import-csv", str(a), "--root", "ES"], data_dir)
    call(["import-csv", str(b), "--root", "ES"], data_dir)
    out = capsys.readouterr().out
    assert "+1 new, 1 replaced, 2 total" in out
    bars = store.read_year(data_dir, "ES", 2024)
    assert list(bars["open"]) == [5.0, 1.0]


def test_import_csv_strict_writes_nothing_when_any_row_is_bad(data_dir, tmp_path, capsys):
    f = write_csv(tmp_path / "x.csv", "2024-01-02 09:30:00,1,2,0.5,1.5,10", "nope,1,2,0.5,1.5,10")
    assert call(["import-csv", str(f), "--root", "NQ", "--strict"], data_dir) == EXIT_ERROR
    assert "Nothing written" in capsys.readouterr().out
    assert not (data_dir / "bars").exists()


def test_import_csv_all_bad_rows_is_an_error(data_dir, tmp_path, capsys):
    f = write_csv(tmp_path / "x.csv", "nope,1,2,0.5,1.5,10")
    assert call(["import-csv", str(f), "--root", "NQ"], data_dir) == EXIT_ERROR
    assert "line 2" in capsys.readouterr().out


def test_import_csv_truncates_long_error_lists_but_says_so(data_dir, tmp_path, capsys):
    rows = [f"bad{i},1,2,0.5,1.5,10" for i in range(120)] + ["2024-01-02 09:30:00,1,2,0.5,1.5,10"]
    f = write_csv(tmp_path / "x.csv", *rows)
    call(["import-csv", str(f), "--root", "NQ"], data_dir)
    out = capsys.readouterr().out
    assert "120 bad rows were NOT imported" in out
    assert "... and 20 more" in out
    call(["import-csv", str(f), "--root", "NQ", "--all-errors"], data_dir)
    assert "line 121:" in capsys.readouterr().out


def test_import_csv_rejects_micros_missing_files_and_bad_tz(data_dir, tmp_path, capsys):
    f = write_csv(tmp_path / "x.csv", "2024-01-02 09:30:00,1,2,0.5,1.5,10")
    assert call(["import-csv", str(f), "--root", "MNQ"], data_dir) == EXIT_ERROR
    assert "use NQ" in capsys.readouterr().err
    assert call(["import-csv", str(tmp_path / "nope.csv"), "--root", "NQ"], data_dir) == EXIT_ERROR
    assert "file not found" in capsys.readouterr().err
    assert call(["import-csv", str(f), "--root", "NQ", "--tz", "Mars/X"], data_dir) == EXIT_ERROR
    assert "unknown timezone" in capsys.readouterr().err
    assert not (data_dir / "bars").exists()


# --- info ------------------------------------------------------------------------------------


def test_info_lists_roots_and_spend(data_dir, tmp_path, capsys):
    assert call(["info"], data_dir) == EXIT_OK
    assert "No bars on disk" in capsys.readouterr().out

    f = write_csv(
        tmp_path / "x.csv",
        "2024-01-02 09:30:00,1,2,0.5,1.5,10",
        "2024-01-02 09:31:00,1,2,0.5,1.5,10",
    )
    call(["import-csv", str(f), "--root", "GC"], data_dir)
    write_spend(data_dir, "12.5")
    capsys.readouterr()
    assert call(["info"], data_dir) == EXIT_OK
    out = capsys.readouterr().out
    assert "GC" in out and "2024-01-02 09:30" in out and "2024-01-02 09:31" in out
    assert "$12.50" in out


def test_module_entry_point_runs(data_dir):
    env = {**os.environ, "REPLAYLAB_DATA_DIR": str(data_dir)}
    done = subprocess.run(
        [sys.executable, "-m", "replaylab_data.cli", "info"],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert done.returncode == 0
    assert "No bars on disk" in done.stdout
