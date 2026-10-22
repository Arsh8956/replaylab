"""QA attacks on the spend ledger, the cap, and the reserve/release lifecycle.

Everything uses the mocked Databento client from helpers.py. No network.
Tests whose names start with `test_BUG_` or end in `_known_limitation` are expected to fail
against the current implementation: they document a real gap, they are not typos.
"""

from __future__ import annotations

import contextlib
import json
from decimal import Decimal
from pathlib import Path

import databento
import pytest

from helpers import FakeHistorical, write_spend
from replaylab_data import cli
from replaylab_data import databento_ingest as ing
from replaylab_data.spend import SpendError, SpendLedger


def run(data_dir, client, *, cap="100.00", confirmed=True, start="2024-01-02", end="2024-01-02"):
    lines: list[str] = []
    result = ing.run_ingest(
        data_dir=data_dir,
        req=ing.make_request("NQ", start, end),
        cap=Decimal(cap),
        confirmed=confirmed,
        client_factory=lambda: client,
        echo=lines.append,
    )
    return result


# --- estimates that should never be believed --------------------------------------------------


def test_BUG_negative_estimate_never_lowers_the_ledger_or_downloads(data_dir):
    """A negative cost from the API (bug, or a credit note) must not be booked as a refund."""
    write_spend(data_dir, "50.00")
    client = FakeHistorical(cost=-20.0)
    with contextlib.suppress(Exception):  # raising is an acceptable way to refuse
        run(data_dir, client)
    assert SpendLedger(data_dir).total() >= Decimal("50.00")
    assert client.range_calls == []


def test_zero_estimate_is_allowed_and_recorded_as_a_complete_entry(data_dir):
    client = FakeHistorical(cost=0.0)
    result = run(data_dir, client)
    assert result.status == "downloaded"
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("0")
    assert [e["status"] for e in ledger.entries()] == ["complete"]


def test_non_finite_or_missing_estimates_refuse_without_downloading(data_dir):
    for cost in (float("nan"), float("inf"), None):
        client = FakeHistorical(cost=cost)
        with pytest.raises(SpendError):
            run(data_dir, client)
        assert client.range_calls == []
    assert not (data_dir / "spend.json").exists()


@pytest.mark.parametrize("cost", [1e30, 1e300])
def test_absurd_estimate_through_the_cli_is_a_clean_nonzero_exit(data_dir, cost, capsys):
    client = FakeHistorical(cost=cost)
    rc = cli.main(
        [
            "--data-dir",
            str(data_dir),
            "ingest",
            "--root",
            "NQ",
            "--start",
            "2024-01-02",
            "--end",
            "2024-01-02",
            "--yes",
        ],
        client_factory=lambda: client,
    )
    assert rc != 0
    assert client.range_calls == []
    assert "Traceback" not in capsys.readouterr().err
    assert not (data_dir / "bars").exists()


# --- cap arithmetic -------------------------------------------------------------------------


def test_cap_edge_to_the_microdollar(data_dir):
    write_spend(data_dir, "99.999999")
    # exactly reaches the cap: allowed
    ok = FakeHistorical(cost=0.000001)
    assert run(data_dir, ok).status == "downloaded"
    assert SpendLedger(data_dir).total() == Decimal("100.000000")
    # one more micro dollar: refused, nothing downloaded, ledger untouched
    bad = FakeHistorical(cost=0.000001)
    before = (data_dir / "spend.json").read_bytes()
    assert run(data_dir, bad).status == "refused"
    assert bad.range_calls == []
    assert (data_dir / "spend.json").read_bytes() == before


def test_estimate_that_rounds_up_over_the_cap_is_refused(data_dir):
    write_spend(data_dir, "99.999999")
    client = FakeHistorical(cost=0.0000011)  # rounds UP to 0.000002
    assert run(data_dir, client).status == "refused"
    assert client.range_calls == []


def test_a_thousand_reservations_of_ten_cents_do_not_drift(data_dir):
    ledger = SpendLedger(data_dir)
    for _ in range(1000):
        ledger.reserve(Decimal("0.100000"), {"root": "NQ"})
    assert ledger.total() == Decimal("100.000000")
    assert json.loads((data_dir / "spend.json").read_text())["total_usd"] == 100.0


def test_release_everything_returns_to_exactly_zero(data_dir):
    ledger = SpendLedger(data_dir)
    idx = [ledger.reserve(Decimal("0.333333"), {"root": "NQ"}) for _ in range(300)]
    for i in idx:
        ledger.release(i)
    assert ledger.total() == Decimal("0.000000")
    assert {e["status"] for e in ledger.entries()} == {"rejected"}


def test_release_never_drives_the_total_negative(data_dir):
    ledger = SpendLedger(data_dir)
    i = ledger.reserve(Decimal("5.00"), {"root": "NQ"})
    # hand edit in the middle of a download: the ledger now says less than the reservation
    (data_dir / "spend.json").write_text(
        json.dumps(
            {"version": 1, "total_usd": 1.0, "entries": [{"cost_usd": 5.0, "status": "pending"}]}
        ),
        encoding="utf-8",
    )
    ledger.release(i)
    assert ledger.total() == Decimal("0")


# --- lifecycle ------------------------------------------------------------------------------


class _SnoopingClient(FakeHistorical):
    """Records what spend.json says at the instant the (billable) download is requested."""

    def __init__(self, ledger_path: Path, **kw):
        super().__init__(**kw)
        self.ledger_path = ledger_path
        self.seen_at_download: dict | None = None
        original = self.timeseries.get_range

        def get_range(**kwargs):
            self.seen_at_download = json.loads(self.ledger_path.read_text())
            return original(**kwargs)

        self.timeseries.get_range = get_range  # type: ignore[method-assign]


def test_reservation_is_already_on_disk_when_the_download_starts(data_dir):
    client = _SnoopingClient(data_dir / "spend.json", cost=7.25)
    run(data_dir, client)
    seen = client.seen_at_download
    assert seen is not None
    assert seen["total_usd"] == 7.25
    assert [e["status"] for e in seen["entries"]] == ["pending"]
    assert SpendLedger(data_dir).entries()[0]["status"] == "complete"


def test_5xx_from_databento_keeps_the_reservation(data_dir):
    err = databento.BentoServerError(http_status=503, message="busy")
    client = FakeHistorical(cost=4.0, range_error=err)
    with pytest.raises(databento.BentoServerError):
        run(data_dir, client)
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("4")
    assert ledger.entries()[0]["status"] == "failed"


def test_4xx_release_keeps_earlier_spend_and_entries_intact(data_dir):
    write_spend(data_dir, "12.345678")
    err = databento.BentoClientError(http_status=402, message="payment required")
    client = FakeHistorical(cost=2.5, range_error=err)
    with pytest.raises(databento.BentoClientError):
        run(data_dir, client)
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("12.345678")
    assert [e["status"] for e in ledger.entries()] == ["rejected"]
    assert client.range_calls  # it did try once, and only once
    assert len(client.range_calls) == 1


def test_a_failed_disk_write_after_download_keeps_the_money_counted(data_dir):
    data_dir.mkdir(parents=True)
    (data_dir / "bars").write_text("a file where the bars directory should be")
    client = FakeHistorical(cost=3.0)
    with pytest.raises(OSError):
        run(data_dir, client)
    assert SpendLedger(data_dir).total() == Decimal("3")


def test_dry_run_leaves_no_ledger_and_no_data(data_dir):
    client = FakeHistorical(cost=9.0)
    result = run(data_dir, client, confirmed=False)
    assert result.status == "estimate_only"
    assert client.range_calls == []
    assert not (data_dir / "spend.json").exists()
    assert not (data_dir / "bars").exists()


def test_refused_run_touches_nothing(data_dir):
    write_spend(data_dir, "95.00")
    before = (data_dir / "spend.json").read_bytes()
    client = FakeHistorical(cost=6.0)
    assert run(data_dir, client).status == "refused"
    assert client.range_calls == []
    assert (data_dir / "spend.json").read_bytes() == before
    assert not (data_dir / "bars").exists()


# --- corrupt ledger ---------------------------------------------------------------------------

CORRUPT = [
    "",
    "{",
    "[]",
    "null",
    "42",
    '{"total_usd": "abc"}',
    '{"total_usd": NaN}',
    '{"total_usd": Infinity}',
    '{"total_usd": null}',
    '{"total_usd": true}',
    '{"total_usd": [1]}',
    '{"total_usd": {"a": 1}}',
    '{"entries": "x"}',
    '{"entries": {"a": 1}}',
]


@pytest.mark.parametrize("text", CORRUPT)
@pytest.mark.parametrize("confirmed", [False, True])
def test_corrupt_ledger_blocks_ingest_and_is_left_alone(data_dir, text, confirmed):
    data_dir.mkdir(parents=True)
    path = data_dir / "spend.json"
    path.write_text(text, encoding="utf-8")
    client = FakeHistorical(cost=1.0)
    with pytest.raises(SpendError):
        run(data_dir, client, confirmed=confirmed)
    assert client.range_calls == []
    assert path.read_text(encoding="utf-8") == text
    assert not (data_dir / "bars").exists()


def test_binary_garbage_ledger_blocks_ingest(data_dir):
    data_dir.mkdir(parents=True)
    (data_dir / "spend.json").write_bytes(b"\xff\xfe\x00\x01garbage")
    client = FakeHistorical(cost=1.0)
    with pytest.raises(SpendError):
        run(data_dir, client)
    assert client.range_calls == []


def test_ledger_that_is_a_directory_blocks_ingest(data_dir):
    (data_dir / "spend.json").mkdir(parents=True)
    client = FakeHistorical(cost=1.0)
    with pytest.raises((SpendError, OSError)):
        run(data_dir, client)
    assert client.range_calls == []


def test_BUG_negative_total_in_the_ledger_is_treated_as_corrupt(data_dir):
    """A negative running total would hand out extra budget beyond the cap."""
    write_spend(data_dir, "-50.00")
    client = FakeHistorical(cost=120.0)  # 120 - 50 = 70, would pass a $100 cap
    try:
        result = run(data_dir, client)
    except SpendError:
        return
    assert result.status != "downloaded"
    assert client.range_calls == []


def test_corrupt_ledger_error_names_the_file_and_refuses_to_assume_zero(data_dir):
    data_dir.mkdir(parents=True)
    (data_dir / "spend.json").write_text("{", encoding="utf-8")
    with pytest.raises(SpendError) as exc:
        SpendLedger(data_dir).total()
    assert "spend.json" in str(exc.value)
    assert "$0" in str(exc.value)


# --- the CLI cap flag -------------------------------------------------------------------------


@pytest.mark.parametrize("cap", ["1e30", "99999999999999999999999"])
def test_BUG_huge_cap_flag_is_a_usage_error_not_a_traceback(data_dir, cap):
    argv = [
        "--data-dir",
        str(data_dir),
        "ingest",
        "--root",
        "NQ",
        "--start",
        "2024-01-02",
        "--end",
        "2024-01-02",
        "--cap",
        cap,
    ]
    try:
        rc = cli.main(argv, client_factory=lambda: FakeHistorical())
    except SystemExit as exc:  # argparse usage error
        assert exc.code == 2
        return
    assert isinstance(rc, int)  # any clean return is fine; an escaping exception is the bug


@pytest.mark.parametrize("cap", ["0", "-5", "0.0000001", "abc", "nan", "inf", ""])
def test_nonsense_caps_are_usage_errors(data_dir, cap):
    argv = [
        "--data-dir",
        str(data_dir),
        "ingest",
        "--root",
        "NQ",
        "--start",
        "2024-01-02",
        "--end",
        "2024-01-02",
        "--cap",
        cap,
    ]
    with pytest.raises(SystemExit) as exc:
        cli.main(argv, client_factory=lambda: FakeHistorical())
    assert exc.value.code == 2


# --- no file lock -----------------------------------------------------------------------------


def test_BUG_two_overlapping_ingests_both_count_known_limitation(data_dir):
    """SPEC 8: every download's cost is added to spend.json. Without a lock, a second ingest that
    reserves between the first one's read and write is silently overwritten (lost update), so the
    cap can be passed by running two ingests at once. Deterministic: the second reservation runs
    inside the first one's save."""
    a = SpendLedger(data_dir)
    b = SpendLedger(data_dir)
    real_save = a._save
    fired = []

    def save_with_interleaving(data):
        if not fired:
            fired.append(1)
            b.reserve(Decimal("4.00"), {"root": "ES"})  # another process, mid flight
        real_save(data)

    a._save = save_with_interleaving  # type: ignore[method-assign]
    a.reserve(Decimal("3.00"), {"root": "NQ"})
    assert SpendLedger(data_dir).total() == Decimal("7.00")
    assert len(SpendLedger(data_dir).entries()) == 2
