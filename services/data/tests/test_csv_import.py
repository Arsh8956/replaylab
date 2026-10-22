import pytest

from helpers import epoch
from replaylab_data.csv_import import CsvImportError, parse_csv_file, parse_csv_text

HEADER = "time,open,high,low,close,volume"


def csv(*rows: str, header: str = HEADER) -> str:
    return "\n".join([header, *rows]) + "\n"


def test_canonical_file():
    result = parse_csv_text(
        csv(
            "2024-01-02T14:30:00Z,16000.25,16001.00,15999.50,16000.75,120",
            "2024-01-02T14:31:00Z,16000.75,16002.50,16000.50,16002.25,95",
        )
    )
    assert result.errors == []
    assert result.rows_read == 2
    assert list(result.bars["time"]) == [epoch("2024-01-02T14:30:00"), epoch("2024-01-02T14:31:00")]
    assert list(result.bars["close"]) == [16000.75, 16002.25]
    assert [str(t) for t in result.bars.dtypes] == [
        "int64",
        "float64",
        "float64",
        "float64",
        "float64",
        "int64",
    ]


@pytest.mark.parametrize(
    "header",
    [
        "Timestamp,Open,High,Low,Close,Volume",
        "DateTime,O,H,L,C,Vol",
        "TIME , OPEN , HIGH , LOW , CLOSE , VOLUME",
        "ts_event,open_price,high_price,low_price,close_price,tick_volume",
        "Date,Open,High,Low,Close,Qty",
        "time,open,high,low,close,volume,symbol,ignored",
    ],
)
def test_flexible_headers(header):
    extra = ",ES,x" if header.endswith("ignored") else ""
    result = parse_csv_text(csv(f"2024-01-02T14:30:00Z,1,2,0.5,1.5,10{extra}", header=header))
    assert result.errors == []
    assert len(result.bars) == 1
    assert result.bars.iloc[0].to_dict() == {
        "time": epoch("2024-01-02T14:30:00"),
        "open": 1.0,
        "high": 2.0,
        "low": 0.5,
        "close": 1.5,
        "volume": 10,
    }


def test_semicolon_delimiter_bom_and_separate_date_and_time_columns():
    text = "﻿Date;Time;Open;High;Low;Close;Volume\n2024-01-02;14:30:00;1;2;0.5;1.5;10\n"
    result = parse_csv_text(text)
    assert result.errors == []
    assert result.bars["time"].iloc[0] == epoch("2024-01-02T14:30:00")


def test_us_style_date_and_compact_formats():
    result = parse_csv_text(
        csv("01/02/2024 14:30,1,2,0.5,1.5,10", "20240102 143100,1,2,0.5,1.5,10")
    )
    assert result.errors == []
    assert list(result.bars["time"]) == [epoch("2024-01-02T14:30:00"), epoch("2024-01-02T14:31:00")]


def test_epoch_seconds_milliseconds_and_nanoseconds():
    t = epoch("2024-01-02T14:30:00")
    result = parse_csv_text(
        csv(
            f"{t},1,2,0.5,1.5,10",
            f"{(t + 60) * 1000},1,2,0.5,1.5,10",
            f"{(t + 120) * 1_000_000_000},1,2,0.5,1.5,10",
            f"{t + 180}.0,1,2,0.5,1.5,10",
        )
    )
    assert result.errors == []
    assert list(result.bars["time"]) == [t, t + 60, t + 120, t + 180]


def test_epoch_ignores_the_timezone_option():
    t = epoch("2024-01-02T14:30:00")
    result = parse_csv_text(csv(f"{t},1,2,0.5,1.5,10"), tz="Asia/Tokyo")
    assert result.bars["time"].iloc[0] == t


def test_naive_times_use_the_tz_option_default_utc():
    row = "2024-01-02 09:30:00,1,2,0.5,1.5,10"
    assert parse_csv_text(csv(row)).bars["time"].iloc[0] == epoch("2024-01-02T09:30:00")
    est = parse_csv_text(csv(row), tz="America/New_York")
    assert est.bars["time"].iloc[0] == epoch("2024-01-02T14:30:00")  # EST = UTC-5


def test_tz_option_follows_dst():
    result = parse_csv_text(csv("2024-07-02 09:30:00,1,2,0.5,1.5,10"), tz="America/New_York")
    assert result.bars["time"].iloc[0] == epoch("2024-07-02T13:30:00")  # EDT = UTC-4


def test_explicit_offsets_win_over_tz():
    result = parse_csv_text(csv("2024-01-02T09:30:00-05:00,1,2,0.5,1.5,10"), tz="Asia/Tokyo")
    assert result.bars["time"].iloc[0] == epoch("2024-01-02T14:30:00")


def test_dst_ambiguous_and_nonexistent_times_are_reported_not_guessed():
    result = parse_csv_text(
        csv(
            "2024-11-03 01:30:00,1,2,0.5,1.5,10",  # clocks go back: happens twice
            "2024-03-10 02:30:00,1,2,0.5,1.5,10",  # clocks go forward: never happens
            "2024-03-10 03:30:00,1,2,0.5,1.5,10",  # fine
        ),
        tz="America/New_York",
    )
    assert [e.line for e in result.errors] == [2, 3]
    assert "ambiguous" in result.errors[0].message
    assert "does not exist" in result.errors[1].message
    assert len(result.bars) == 1


def test_bad_rows_are_reported_with_line_numbers_and_never_dropped_silently():
    text = (
        "time,open,high,low,close,volume\n"  # line 1
        "2024-01-02T14:30:00Z,1,2,0.5,1.5,10\n"  # 2 ok
        "2024-01-02T14:31:00Z,abc,2,0.5,1.5,10\n"  # 3 not a number
        "\n"  # 4 blank, ignored
        "2024-01-02T14:32:00Z,1,0.5,2,1.5,10\n"  # 5 high < low
        "2024-01-02T14:33:00Z,3,2,0.5,1.5,10\n"  # 6 open outside range
        "2024-01-02T14:34:00Z,1,2,0.5,1.5,-4\n"  # 7 negative volume
        "2024-01-02T14:35:00Z,1,2,0.5,1.5,1.5\n"  # 8 fractional volume
        "2024-01-02T14:36:00Z,1,2,0.5,1.5\n"  # 9 wrong field count
        "2024-01-02T14:37:30Z,1,2,0.5,1.5,10\n"  # 10 not a whole minute
        "garbage,1,2,0.5,1.5,10\n"  # 11 unreadable time
        "2024-01-02T14:39:00Z,0,2,0,1.5,10\n"  # 12 zero price
        ",1,2,0.5,1.5,10\n"  # 13 empty time
        "2024-01-02T14:41:00Z,1,2,0.5,1.5,\n"  # 14 empty volume
        "2024-01-02T14:42:00Z,nan,2,0.5,1.5,10\n"  # 15 NaN
        "2024-01-02T14:30:00Z,1,2,0.5,1.5,99\n"  # 16 duplicate of line 2
        "2024-01-02T14:43:00Z,1,2,0.5,1.5,10\n"  # 17 ok
    )
    result = parse_csv_text(text)

    by_line = {e.line: e.message for e in result.errors}
    assert sorted(by_line) == [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    assert "not a number" in by_line[3]
    assert "below low" in by_line[5]
    assert "outside the high/low range" in by_line[6]
    assert "negative" in by_line[7]
    assert "whole number" in by_line[8]
    assert "expected 6 fields, got 5" in by_line[9]
    assert "whole minute" in by_line[10]
    assert "unrecognized time" in by_line[11]
    assert "zero" in by_line[12]
    assert "empty time" in by_line[13]
    assert "empty volume" in by_line[14]
    assert "not finite" in by_line[15]
    assert "duplicate time" in by_line[16] and "line 2" in by_line[16]

    assert list(result.bars["time"]) == [epoch("2024-01-02T14:30:00"), epoch("2024-01-02T14:43:00")]
    assert result.bars["volume"].iloc[0] == 10  # the first of the duplicates is kept
    assert result.rows_read == len(result.bars) + len(result.errors)  # nothing vanishes


def test_out_of_order_rows_are_sorted():
    result = parse_csv_text(
        csv(
            "2024-01-02T14:32:00Z,1,2,0.5,1.5,10",
            "2024-01-02T14:30:00Z,1,2,0.5,1.5,10",
            "2024-01-02T14:31:00Z,1,2,0.5,1.5,10",
        )
    )
    assert result.errors == []
    assert result.bars["time"].is_monotonic_increasing


def test_negative_prices_are_valid_cl_2020():
    result = parse_csv_text(csv("2020-04-20T18:00:00Z,-10,-5,-40,-37.63,10"))
    assert result.errors == []
    assert result.bars["close"].iloc[0] == -37.63


def test_leading_blank_lines_shift_the_reported_line_numbers():
    result = parse_csv_text("\n\n" + csv("bad,1,2,0.5,1.5,10"))
    assert [e.line for e in result.errors] == [4]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "empty"),
        ("a,b,c\n1,2,3\n", "could not find column"),
        ("time,open,high,low,close\n1,2,3,4,5\n", "volume"),
        ("time,open,high,low,close,volume,o\n", "two columns"),
    ],
)
def test_file_level_problems_raise(text, message):
    with pytest.raises(CsvImportError, match=message):
        parse_csv_text(text)


def test_unknown_timezone_raises():
    with pytest.raises(CsvImportError, match="unknown timezone"):
        parse_csv_text(csv("2024-01-02 09:30:00,1,2,0.5,1.5,10"), tz="Mars/Olympus")


def test_header_only_file_gives_no_bars_and_no_errors():
    result = parse_csv_text(HEADER + "\n")
    assert result.bars.empty
    assert result.errors == []
    assert result.rows_read == 0


def test_parse_file_handles_utf8_bom_and_latin1(tmp_path):
    good = tmp_path / "a.csv"
    good.write_bytes(("﻿" + csv("2024-01-02T14:30:00Z,1,2,0.5,1.5,10")).encode("utf-8"))
    assert len(parse_csv_file(good).bars) == 1

    latin = tmp_path / "b.csv"
    latin.write_bytes(
        "time,open,high,low,close,volume,Bezeichnung\n"
        "2024-01-02T14:30:00Z,1,2,0.5,1.5,10,Zuckerrübe\n".encode("latin-1")
    )
    assert len(parse_csv_file(latin).bars) == 1
