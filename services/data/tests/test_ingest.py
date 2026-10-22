"""Ingest with a mocked Databento client. No test here can reach the network."""

import json
from datetime import date
from decimal import Decimal

import databento
import pandas as pd
import pytest
from helpers import FakeHistorical, default_rows, epoch, make_dbn_store, write_spend

from replaylab_data import databento_ingest as ing
from replaylab_data import store
from replaylab_data.roots import RootError
from replaylab_data.spend import DEFAULT_CAP, SpendError, SpendLedger

EXPECTED_KW = {
    "dataset": "GLBX.MDP3",
    "symbols": ["NQ.v.0"],
    "schema": "ohlcv-1m",
    "stype_in": "continuous",
    "start": "2024-01-01",
    "end": "2024-04-01",  # --end 2024-03-31 is inclusive, Databento's end is exclusive
}


def run(data_dir, client, *, cap="100.00", confirmed=False, end="2024-03-31", root="NQ"):
    lines: list[str] = []
    result = ing.run_ingest(
        data_dir=data_dir,
        req=ing.make_request(root, "2024-01-01", end),
        cap=Decimal(cap),
        confirmed=confirmed,
        client_factory=lambda: client,
        echo=lines.append,
    )
    return result, "\n".join(lines)


# --- conversion to the Bar shape -------------------------------------------------------------


def test_conversion_from_a_real_dbnstore_matches_the_bar_type():
    rows = default_rows()
    frame = make_dbn_store(rows).to_df(price_type="fixed", pretty_ts=False, map_symbols=False)
    bars = ing.bars_from_dbn_frame(frame)

    assert list(bars.columns) == ["time", "open", "high", "low", "close", "volume"]
    assert [str(t) for t in bars.dtypes] == [
        "int64", "float64", "float64", "float64", "float64", "int64"
    ]
    # time = unix seconds of the bar OPEN (ts_event is the inclusive start of the interval)
    assert list(bars["time"]) == [r[0] for r in rows]
    assert bars["time"].iloc[0] == epoch("2024-01-02T14:30:00")
    # exact floats, no 1e-9 scaling noise
    assert list(bars["open"]) == [r[1] for r in rows]
    assert list(bars["high"]) == [r[2] for r in rows]
    assert list(bars["low"]) == [r[3] for r in rows]
    assert list(bars["close"]) == [r[4] for r in rows]
    assert list(bars["volume"]) == [r[5] for r in rows]


def test_fixed_point_division_has_no_float_noise():
    price = 21016.75
    rows = [(epoch("2024-01-02T14:30:00"), price, price + 1, price - 1, price, 1, 1)]
    frame = make_dbn_store(rows).to_df(price_type="fixed", pretty_ts=False, map_symbols=False)
    assert frame["open"].iloc[0] == 21016750000000  # 1 unit = 1e-9
    assert ing.bars_from_dbn_frame(frame)["open"].iloc[0] == 21016.75


def test_default_to_df_form_converts_to_the_same_bars():
    store_obj = make_dbn_store(default_rows())
    fixed = ing.bars_from_dbn_frame(
        store_obj.to_df(price_type="fixed", pretty_ts=False, map_symbols=False)
    )
    pretty = ing.bars_from_dbn_frame(store_obj.to_df(map_symbols=False))  # float, UTC datetimes
    pd.testing.assert_frame_equal(fixed, pretty)


def test_empty_frame_converts_to_empty_bars():
    frame = make_dbn_store([]).to_df(price_type="fixed", pretty_ts=False, map_symbols=False)
    assert ing.bars_from_dbn_frame(frame).empty


# --- request validation ----------------------------------------------------------------------


def test_micros_are_rejected_with_the_full_size_root_message():
    with pytest.raises(RootError, match="Micros use their full size root's bars"):
        ing.make_request("MNQ", "2024-01-01", "2024-01-31")


def test_request_dates():
    req = ing.make_request("nq", "2024-01-01", "2024-03-31")
    assert (req.root, req.symbol) == ("NQ", "NQ.v.0")
    assert req.api_start == "2024-01-01"
    assert req.api_end == "2024-04-01"
    assert ing.make_request("ES", date(2024, 2, 1), date(2024, 2, 1)).api_end == "2024-02-02"
    with pytest.raises(ing.IngestError, match="before"):
        ing.make_request("NQ", "2024-02-01", "2024-01-01")
    with pytest.raises(ing.IngestError, match="--start"):
        ing.make_request("NQ", "Jan 1", "2024-01-02")


# --- the cost guard --------------------------------------------------------------------------


def test_without_yes_it_prints_the_estimate_and_downloads_nothing(data_dir):
    client = FakeHistorical(cost=2.587353944778)
    result, out = run(data_dir, client)

    assert result.status == "estimate_only"
    assert "estimate   $2.59" in out
    assert "Nothing downloaded" in out
    assert len(client.cost_calls) == 1
    assert client.range_calls == []  # get_range was never called
    assert not (data_dir / "bars").exists()
    assert not (data_dir / "spend.json").exists()


def test_exact_databento_calls():
    client = FakeHistorical()
    ing.estimate_cost(client, ing.make_request("NQ", "2024-01-01", "2024-03-31"))
    ing.fetch_bars(client, ing.make_request("NQ", "2024-01-01", "2024-03-31"))
    assert client.cost_calls == [EXPECTED_KW]
    assert client.range_calls == [EXPECTED_KW]  # same arguments for the estimate and the pull


def test_with_yes_it_downloads_stores_and_records_spend(data_dir):
    client = FakeHistorical(cost=1.5)
    result, out = run(data_dir, client, confirmed=True)

    assert result.status == "downloaded"
    assert result.bars == 5
    assert client.range_calls == [EXPECTED_KW]
    stored = store.read_year(data_dir, "NQ", 2024)
    assert list(stored["time"]) == [r[0] for r in default_rows()]

    ledger = json.loads((data_dir / "spend.json").read_text())
    assert ledger["total_usd"] == 1.5
    assert ledger["entries"][0]["status"] == "complete"
    assert ledger["entries"][0]["root"] == "NQ"
    assert ledger["entries"][0]["start"] == "2024-01-01"
    assert ledger["entries"][0]["end"] == "2024-03-31"
    assert ledger["entries"][0]["cost_usd"] == 1.5
    assert "Downloading" in out


def test_spend_accumulates_across_downloads(data_dir):
    run(data_dir, FakeHistorical(cost=1.5), confirmed=True)
    run(data_dir, FakeHistorical(cost=2.25), confirmed=True, root="ES")
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("3.75")
    assert len(ledger.entries()) == 2


def test_estimate_rounds_up_so_the_ledger_never_understates():
    client = FakeHistorical(cost=0.0000001)
    req = ing.make_request("NQ", "2024-01-01", "2024-01-02")
    assert ing.estimate_cost(client, req) == Decimal("0.000001")


# --- the spend cap ---------------------------------------------------------------------------


def test_cap_refuses_when_total_plus_estimate_passes_it(data_dir):
    write_spend(data_dir, "99.00")
    client = FakeHistorical(cost=2.00)
    result, out = run(data_dir, client, confirmed=True)

    assert result.status == "refused"
    assert "REFUSED" in out
    assert "$101.00" in out
    assert client.range_calls == []
    assert not (data_dir / "bars").exists()
    assert SpendLedger(data_dir).total() == Decimal("99.00")  # unchanged


def test_cap_allows_exactly_the_cap(data_dir):
    write_spend(data_dir, "98.00")
    client = FakeHistorical(cost=2.00)
    result, _ = run(data_dir, client, confirmed=True)
    assert result.status == "downloaded"
    assert SpendLedger(data_dir).total() == Decimal("100.00")


def test_cap_uses_the_cap_option(data_dir):
    client = FakeHistorical(cost=5.00)
    result, _ = run(data_dir, client, cap="4.99", confirmed=True)
    assert result.status == "refused"
    assert client.range_calls == []
    result, _ = run(data_dir, client, cap="5.00", confirmed=True)
    assert result.status == "downloaded"


def test_default_cap_is_100_dollars_under_the_free_credits():
    assert DEFAULT_CAP == Decimal("100.00")


def test_dry_run_warns_when_yes_would_be_refused(data_dir):
    write_spend(data_dir, "99.50")
    client = FakeHistorical(cost=1.00)
    result, out = run(data_dir, client, confirmed=False)
    assert result.status == "estimate_only"
    assert "--yes would be REFUSED" in out
    assert client.range_calls == []


def test_corrupt_ledger_blocks_everything_rather_than_assuming_zero(data_dir):
    data_dir.mkdir()
    (data_dir / "spend.json").write_text("{not json", encoding="utf-8")
    client = FakeHistorical()
    with pytest.raises(SpendError, match="refusing to assume"):
        run(data_dir, client, confirmed=True)
    assert client.range_calls == []


def test_failed_download_keeps_the_spend_counted(data_dir):
    client = FakeHistorical(cost=3.00, range_error=ConnectionError("dropped"))
    with pytest.raises(ConnectionError):
        run(data_dir, client, confirmed=True)
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("3.00")
    assert ledger.entries()[0]["status"] == "failed"
    assert not (data_dir / "bars").exists()


def test_databento_4xx_rejection_releases_the_reservation(data_dir):
    err = databento.BentoClientError(http_status=422, message="data_end_after_available_end")
    client = FakeHistorical(cost=3.00, range_error=err)
    with pytest.raises(databento.BentoClientError):
        run(data_dir, client, confirmed=True)
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("0.00")
    assert ledger.entries()[0]["status"] == "rejected"


def test_micro_root_never_builds_a_client(data_dir):
    def factory():
        raise AssertionError("client must not be built for a micro root")

    with pytest.raises(RootError):
        ing.run_ingest(
            data_dir=data_dir,
            req=ing.make_request("MES", "2024-01-01", "2024-01-02"),
            cap=DEFAULT_CAP,
            confirmed=True,
            client_factory=factory,
        )


# --- API key ---------------------------------------------------------------------------------


def test_missing_key_is_an_error(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(store, "find_repo_root", lambda: None)
    with pytest.raises(ing.IngestError, match="DATABENTO_API_KEY"):
        ing.load_api_key()


def test_key_comes_from_the_environment_then_a_dotenv_file(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(store, "find_repo_root", lambda: None)
    (tmp_path / ".env").write_text("OTHER=1\nexport DATABENTO_API_KEY='db-from-file'\n")
    assert ing.load_api_key() == "db-from-file"
    monkeypatch.setenv("DATABENTO_API_KEY", "db-from-env")
    assert ing.load_api_key() == "db-from-env"


def test_make_client_never_reaches_the_network_in_tests(monkeypatch):
    monkeypatch.setenv("DATABENTO_API_KEY", "db-test")
    with pytest.raises(AssertionError, match="never construct a real"):
        ing.make_client()  # conftest blocks databento.Historical
