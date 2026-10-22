from decimal import Decimal

import pytest

from replaylab_data.spend import (
    SpendError,
    SpendLedger,
    check_cap,
    fmt_usd,
    to_money,
)


def test_cap_check_is_inclusive_of_the_cap():
    assert check_cap(Decimal("90"), Decimal("10"), Decimal("100")).allowed
    assert not check_cap(Decimal("90"), Decimal("10.000001"), Decimal("100")).allowed
    assert check_cap(Decimal("0"), Decimal("0"), Decimal("100")).remaining == Decimal("100")


def test_money_is_decimal_and_rounds_up_for_estimates():
    assert to_money(2.587353944778, round_up=True) == Decimal("2.587354")
    assert to_money(0.1) + to_money(0.2) == Decimal("0.3")  # no binary float drift
    assert fmt_usd(Decimal("2.001")) == "$2.01"
    assert fmt_usd(Decimal("1234.5")) == "$1,234.50"
    with pytest.raises(SpendError):
        to_money("abc")
    with pytest.raises(SpendError):
        to_money(float("nan"))


def test_missing_ledger_is_zero(data_dir):
    assert SpendLedger(data_dir).total() == 0


def test_reserve_finish_release(data_dir):
    ledger = SpendLedger(data_dir)
    first = ledger.reserve(Decimal("1.25"), {"root": "NQ"})
    second = ledger.reserve(Decimal("2.00"), {"root": "ES"})
    assert ledger.total() == Decimal("3.25")
    ledger.finish(first)
    ledger.release(second)
    assert ledger.total() == Decimal("1.25")
    assert [e["status"] for e in ledger.entries()] == ["complete", "rejected"]


def test_hand_edited_total_is_respected(data_dir):
    data_dir.mkdir()
    (data_dir / "spend.json").write_text('{"total_usd": 40.5}', encoding="utf-8")
    ledger = SpendLedger(data_dir)
    assert ledger.total() == Decimal("40.5")
    ledger.reserve(Decimal("1"), {})
    assert ledger.total() == Decimal("41.5")
