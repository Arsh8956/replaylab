import pytest

from replaylab_data.roots import MICRO_TO_ROOT, ROOTS, RootError, continuous_symbol, validate_root


def test_valid_roots():
    assert ROOTS == ("NQ", "ES", "YM", "RTY", "CL", "GC")
    for root in ROOTS:
        assert validate_root(root) == root


def test_root_is_case_and_space_insensitive():
    assert validate_root(" nq ") == "NQ"


@pytest.mark.parametrize(("micro", "full"), sorted(MICRO_TO_ROOT.items()))
def test_micros_are_rejected_with_a_pointer_to_the_full_size_root(micro, full):
    with pytest.raises(RootError) as err:
        validate_root(micro)
    message = str(err.value)
    assert "Micros use their full size root's bars" in message
    assert f"use {full}" in message


def test_unknown_root():
    with pytest.raises(RootError, match="Unknown root"):
        validate_root("ZN")


def test_continuous_symbol_is_front_month_by_volume():
    assert continuous_symbol("NQ") == "NQ.v.0"
