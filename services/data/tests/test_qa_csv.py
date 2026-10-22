"""QA attacks on CSV import: malformed rows, mixed timezones, duplicates, unsorted input, DST.

Tests named `test_BUG_*` are expected to fail against the current implementation.
"""

from __future__ import annotations

import pytest

from helpers import epoch
from replaylab_data.csv_import import CsvImportError, parse_csv_file, parse_csv_text

H = "time,open,high,low,close,volume\n"


def row(t: str, o=100.0, h=101.0, low=99.0, c=100.5, v=10) -> str:
    return f"{t},{o},{h},{low},{c},{v}\n"


# --- never silently dropped -----------------------------------------------------------------


def test_BUG_a_stray_quote_does_not_swallow_the_rows_after_it():
    """One unbalanced quote makes csv.reader glue the rest of the file into a single field. The
    good rows below it vanish under one misleading 'expected 6 fields' error."""
    good_after = "".join(row(f"2024-01-02T15:{i:02d}:00Z") for i in range(10))
    text = (
        H + row("2024-01-02T14:30:00Z") + '2024-01-02T14:31:00Z,"100,101,99,100.5,10\n' + good_after
    )
    res = parse_csv_text(text)
    assert len(res.bars) == 1 + 10  # the first row and the ten rows after the bad one
    assert [e.line for e in res.errors] == [3]


def test_BUG_a_single_huge_volume_is_one_bad_row_not_a_crash():
    text = H + row("2024-01-02T14:30:00Z") + row("2024-01-02T14:31:00Z", v="1e30")
    res = parse_csv_text(text)  # must not raise OverflowError
    assert len(res.bars) == 1
    assert [e.line for e in res.errors] == [3]


def test_BUG_volume_just_over_int64_is_one_bad_row_not_a_whole_file_error():
    text = H + row("2024-01-02T14:30:00Z") + row("2024-01-02T14:31:00Z", v=2**63)
    res = parse_csv_text(text)
    assert len(res.bars) == 1
    assert [e.line for e in res.errors] == [3]


def test_BUG_a_field_over_the_csv_module_limit_is_a_bad_row_or_import_error_not_a_raw_csv_error():
    text = (
        H + row("2024-01-02T14:30:00Z") + "2024-01-02T14:31:00Z,1,2,0.5,1," + "9" * 200_000 + "\n"
    )
    try:
        res = parse_csv_text(text)
    except CsvImportError:
        return
    assert len(res.errors) >= 1


@pytest.mark.parametrize(
    "stamp",
    [
        "1969-12-31T23:59:00Z",
        "0024-01-02T14:30:00Z",
        "0001-01-01T00:00:00Z",
        "2101-01-01T00:00:00Z",
    ],
)
def test_BUG_implausible_years_are_bad_rows_like_out_of_range_epochs(stamp):
    """Epoch cells outside 1970 to 2100 are rejected; the same instant as text is not. A typo like
    0024-01-02 would write a bar into a 0024.parquet nobody looks at."""
    res = parse_csv_text(H + row(stamp))
    assert len(res.bars) == 0
    assert len(res.errors) == 1


def test_every_bad_shape_is_reported_with_its_physical_line():
    text = (
        H  # 1
        + row("2024-01-02T14:30:00Z")  # 2 ok
        + "2024-01-02T14:31:00Z,1,2\n"  # 3 too few fields
        + row("garbage")  # 4 bad time
        + row("2024-01-02T14:33:00Z", o="abc")  # 5 bad number
        + row("2024-01-02T14:34:00Z", h=98.0)  # 6 high < low
        + row("2024-01-02T14:35:00Z", o=105.0)  # 7 open above high
        + row("2024-01-02T14:36:00Z", v=-1)  # 8 negative volume
        + row("2024-01-02T14:37:00Z", v=1.5)  # 9 fractional volume
        + row("2024-01-02T14:38:30Z")  # 10 not on a minute
        + row("2024-01-02T14:39:00Z", o=0.0, low=0.0)  # 11 zero price
        + row("2024-01-02T14:40:00Z", c="nan")  # 12 nan
        + row("2024-01-02T14:41:00Z", h="inf")  # 13 inf
        + "\n"  # 14 blank: skipped, not an error
        + row("2024-01-02T14:42:00Z")  # 15 ok
    )
    res = parse_csv_text(text)
    assert [e.line for e in res.errors] == [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    assert len(res.bars) == 2
    assert res.rows_read == 13
    assert len(res.bars) + len(res.errors) == res.rows_read


def test_thousands_separators_and_decimal_commas_are_reported_not_misread():
    text = H.replace(",", ";") + "2024-01-02T14:30:00Z;21000,25;21001,00;20999,50;21000,75;10\n"
    res = parse_csv_text(text)
    assert len(res.bars) == 0
    assert len(res.errors) == 1
    quoted = parse_csv_text(H + '2024-01-02T14:30:00Z,"21,000.25","21,001.00",20999,21000,10\n')
    assert len(quoted.bars) == 0
    assert len(quoted.errors) == 1


def test_whitespace_padding_blank_lines_and_trailing_spaces_are_tolerated():
    text = (
        "\n\n  time , open,high ,low,close , volume \n\n 2024-01-02T14:30:00Z , 1,2,0.5, 1, 5 \n\n"
    )
    res = parse_csv_text(text)
    assert len(res.bars) == 1
    assert res.errors == []


@pytest.mark.parametrize("eol", ["\n", "\r\n", "\r"])
def test_every_line_ending_gives_the_same_bars_and_line_numbers(eol):
    text = (H + row("2024-01-02T14:30:00Z") + "junk\n" + row("2024-01-02T14:32:00Z")).replace(
        "\n", eol
    )
    res = parse_csv_text(text)
    assert len(res.bars) == 2
    assert [e.line for e in res.errors] == [3]


def test_utf16_export_is_a_clean_file_error_not_garbage_bars(tmp_path):
    f = tmp_path / "excel.csv"
    f.write_bytes((H + row("2024-01-02T14:30:00Z")).encode("utf-16"))
    with pytest.raises(CsvImportError):
        parse_csv_file(f)


def test_nul_bytes_are_row_errors_not_crashes():
    res = parse_csv_text(H + row("2024-01-02T14:30:00Z") + "2024-01-02T14:31:00Z,1,2,0.5,1,5\x00\n")
    assert len(res.bars) == 1
    assert len(res.errors) == 1


def test_header_problems_are_file_level_errors():
    with pytest.raises(CsvImportError):
        parse_csv_text("time,open,high,low,close\n2024-01-02T14:30:00Z,1,2,0.5,1\n")  # no volume
    with pytest.raises(CsvImportError):
        parse_csv_text("time,open,open,low,close,volume\n")  # duplicate column
    with pytest.raises(CsvImportError):
        parse_csv_text("")
    with pytest.raises(CsvImportError):
        parse_csv_text("\n\n   \n")


# --- timezones --------------------------------------------------------------------------------


def test_mixed_offsets_in_one_file_are_all_normalised_to_utc_and_sorted():
    text = (
        H
        + row("2024-01-02T09:32:00-05:00")  # 14:32Z
        + row("2024-01-02T14:30:00Z")  # 14:30Z
        + row("2024-01-02T20:31:00+05:30")  # 15:01Z
        + row("2024-01-02 09:31:00")  # naive, read in tz=America/New_York: 14:31Z
        + row("1704205980")  # epoch seconds, 14:33Z, tz does not apply
    )
    res = parse_csv_text(text, tz="America/New_York")
    base = epoch("2024-01-02T14:30:00")
    assert list(res.bars["time"]) == [base, base + 60, base + 120, base + 180, base + 31 * 60]
    assert res.errors == []


def test_same_instant_written_two_ways_is_a_duplicate_first_wins():
    text = H + row("2024-01-02T09:30:00-05:00", v=11) + row("2024-01-02T14:30:00Z", v=777)
    res = parse_csv_text(text)
    assert len(res.bars) == 1
    assert res.bars["volume"].iloc[0] == 11
    assert len(res.errors) == 1
    assert "first seen on line 2" in res.errors[0].message


def test_duplicate_in_an_unsorted_file_keeps_the_first_line_not_the_first_time():
    text = (
        H
        + row("2024-01-02T14:31:00Z", v=1)
        + row("2024-01-02T14:30:00Z")
        + row("2024-01-02T14:31:00Z", v=2)
    )
    res = parse_csv_text(text)
    assert list(res.bars["time"]) == [epoch("2024-01-02T14:30:00"), epoch("2024-01-02T14:31:00")]
    assert res.bars["volume"].iloc[1] == 1
    assert [e.line for e in res.errors] == [4]


def test_triplicate_timestamp_reports_two_errors():
    text = H + row("2024-01-02T14:30:00Z") * 3
    res = parse_csv_text(text)
    assert len(res.bars) == 1
    assert [e.line for e in res.errors] == [3, 4]


def test_fully_reversed_file_comes_out_ascending():
    rows = "".join(row(f"2024-01-02T15:{m:02d}:00Z") for m in range(59, -1, -1))
    res = parse_csv_text(H + rows)
    assert list(res.bars["time"]) == sorted(res.bars["time"])
    assert len(res.bars) == 60


def test_dst_week_in_new_york_wall_time_spring_forward():
    """Fri 2024-03-08 16:59 EST, nothing on Saturday, Sun 2024-03-10 18:00 EDT (clocks changed at
    02:00 that morning). A bar at 02:30 on the 10th does not exist."""
    text = (
        H
        + row("2024-03-08 16:59:00")
        + row("2024-03-10 01:59:00")
        + row("2024-03-10 02:30:00")
        + row("2024-03-10 03:00:00")
        + row("2024-03-10 18:00:00")
    )
    res = parse_csv_text(text, tz="America/New_York")
    assert list(res.bars["time"]) == [
        epoch("2024-03-08T21:59:00"),  # EST = UTC-5
        epoch("2024-03-10T06:59:00"),  # still EST
        epoch("2024-03-10T07:00:00"),  # 03:00 EDT = UTC-4
        epoch("2024-03-10T22:00:00"),  # Sunday open, EDT
    ]
    assert [e.line for e in res.errors] == [4]
    assert "does not exist" in res.errors[0].message


def test_dst_week_in_new_york_wall_time_fall_back():
    text = (
        H
        + row("2024-11-01 17:00:00")  # Fri, EDT, the halt starts
        + row("2024-11-03 00:59:00")
        + row("2024-11-03 01:30:00")  # happens twice
        + row("2024-11-03 02:00:00")
        + row("2024-11-03 18:00:00")  # Sunday open, EST
    )
    res = parse_csv_text(text, tz="America/New_York")
    assert list(res.bars["time"]) == [
        epoch("2024-11-01T21:00:00"),
        epoch("2024-11-03T04:59:00"),
        epoch("2024-11-03T07:00:00"),
        epoch("2024-11-03T23:00:00"),
    ]
    assert [e.line for e in res.errors] == [4]
    assert "ambiguous" in res.errors[0].message


def test_separate_date_and_time_columns_with_us_dates_and_a_dst_gap():
    text = (
        "Date,Time,Open,High,Low,Close,Volume\n"
        "03/10/2024,01:59,1,2,0.5,1,5\n"
        "03/10/2024,02:00,1,2,0.5,1,5\n"
        "03/10/2024,03:00,1,2,0.5,1,5\n"
    )
    res = parse_csv_text(text, tz="America/New_York")
    assert len(res.bars) == 2
    assert [e.line for e in res.errors] == [3]


def test_every_new_york_minute_of_a_year_maps_to_a_distinct_unique_utc_minute():
    """Brute force: no collisions and the only rejected wall times are the DST gap and the
    repeated hour."""
    import datetime as dt

    lines = [H.rstrip("\n")]
    d = dt.datetime(2024, 1, 1)
    # one row per 30 minutes keeps it quick; the gap and repeat hours are hit exactly
    while d.year == 2024:
        lines.append(f"{d:%Y-%m-%d %H:%M:%S},1,2,0.5,1,5")
        d += dt.timedelta(minutes=30)
    res = parse_csv_text("\n".join(lines) + "\n", tz="America/New_York")
    bad = {e.line: e.message for e in res.errors}
    assert len(res.bars) == len(set(res.bars["time"]))
    assert len(bad) == 2 + 2  # 02:00 and 02:30 on Mar 10; 01:00 and 01:30 on Nov 3
    assert sum("does not exist" in m for m in bad.values()) == 2
    assert sum("ambiguous" in m for m in bad.values()) == 2


def test_negative_cl_rows_pass_but_zero_does_not():
    ok = parse_csv_text(H + row("2020-04-20T19:00:00Z", 1.75, 2.0, -37.63, -36.98, 5000))
    assert ok.bars["low"].iloc[0] == -37.63
    zero = parse_csv_text(H + row("2020-04-20T19:01:00Z", 0.0, 1.0, -1.0, 0.0, 5))
    assert len(zero.bars) == 0
    neg_zero = parse_csv_text(H + row("2020-04-20T19:02:00Z", -0.0, 1.0, -1.0, 0.5, 5))
    assert len(neg_zero.bars) == 0


def test_twenty_thousand_rows_import_in_reasonable_time():
    import time

    rows = "".join(
        f"{epoch('2024-01-02T14:30:00') + i * 60},{100 + (i % 7) * 0.25},{102},{99},"
        f"{100 + (i % 5) * 0.25},{i % 50}\n"
        for i in range(20_000)
    )
    t0 = time.perf_counter()
    res = parse_csv_text(H + rows)
    assert len(res.bars) == 20_000
    assert res.errors == []
    assert time.perf_counter() - t0 < 10
