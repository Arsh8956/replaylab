"""`replaylab-data` command line (SPEC section 8).

Exit codes: 0 ok (including an estimate only run), 1 error, 2 usage error (argparse),
3 ingest refused by the spend cap.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from . import __version__
from .csv_import import CsvImportError, parse_csv_file
from .databento_ingest import IngestError, make_client, make_request, run_ingest
from .roots import RootError, validate_root
from .spend import DEFAULT_CAP, SpendError, SpendLedger, fmt_usd, to_money
from .store import StoreError, all_root_info, resolve_data_dir, write_bars

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 3
MAX_ERRORS_SHOWN = 100


def _money_arg(value: str) -> Decimal:
    try:
        amount = to_money(value)
    except SpendError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc
    if amount <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return amount


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="replaylab-data",
        description="ReplayLab data service: Databento ingest, CSV import, Parquet bars, API.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument(
        "--data-dir",
        help="data directory (default: $REPLAYLAB_DATA_DIR, else <repo>/data)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    ing = sub.add_parser(
        "ingest",
        help="pull 1m bars from Databento (prints the cost estimate; downloads only with --yes)",
    )
    ing.add_argument("--root", required=True, help="NQ, ES, YM, RTY, CL or GC (no micros)")
    ing.add_argument("--start", required=True, help="first day, YYYY-MM-DD (UTC)")
    ing.add_argument("--end", required=True, help="last day INCLUSIVE, YYYY-MM-DD (UTC)")
    ing.add_argument("--yes", action="store_true", help="actually download (spends credits)")
    ing.add_argument(
        "--cap",
        type=_money_arg,
        default=DEFAULT_CAP,
        help="refuse if total spend plus this estimate would pass this many USD (default 100.00)",
    )

    imp = sub.add_parser("import-csv", help="import a 1m bars CSV export")
    imp.add_argument("file", help="CSV file")
    imp.add_argument("--root", required=True, help="NQ, ES, YM, RTY, CL or GC (no micros)")
    imp.add_argument(
        "--tz",
        default="UTC",
        help="IANA timezone of timestamps without an offset (default UTC), e.g. America/New_York",
    )
    imp.add_argument("--strict", action="store_true", help="write nothing if any row is bad")
    imp.add_argument("--all-errors", action="store_true", help="list every bad row")

    sub.add_parser("info", help="roots on disk with first/last bar and counts")

    srv = sub.add_parser("serve", help="run the bars API for local development")
    srv.add_argument("--host", default="127.0.0.1")
    srv.add_argument("--port", type=int, default=8000)
    return parser


def _iso(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%d %H:%M")


def cmd_ingest(args: argparse.Namespace, data_dir: Path, client_factory: Callable[[], Any]) -> int:
    req = make_request(args.root, args.start, args.end)
    result = run_ingest(
        data_dir=data_dir,
        req=req,
        cap=args.cap,
        confirmed=args.yes,
        client_factory=client_factory,
    )
    if result.status == "refused":
        return EXIT_REFUSED
    if result.status == "downloaded":
        print(f"Downloaded {result.bars:,} bars for {req.root}.")
        if result.summary:
            for y in result.summary.years:
                print(f"  {y.path}: +{y.added:,} new, {y.replaced:,} replaced, {y.total:,} total")
        print(f"Spend ledger: {SpendLedger(data_dir).path}")
    return EXIT_OK


def cmd_import_csv(args: argparse.Namespace, data_dir: Path) -> int:
    root = validate_root(args.root)
    path = Path(args.file)
    if not path.is_file():
        raise CsvImportError(f"file not found: {path}")
    result = parse_csv_file(path, tz=args.tz)
    errors = result.errors
    print(f"Read {result.rows_read:,} data rows from {path}")

    if errors and args.strict:
        _print_errors(errors, args.all_errors)
        print(f"{len(errors):,} bad rows and --strict is set. Nothing written.")
        return EXIT_ERROR
    if result.bars.empty:
        _print_errors(errors, args.all_errors)
        print("No valid bars to import. Nothing written.")
        return EXIT_ERROR

    summary = write_bars(data_dir, root, result.bars)
    first, last = int(result.bars["time"].iloc[0]), int(result.bars["time"].iloc[-1])
    print(f"Imported {len(result.bars):,} bars into {root} ({_iso(first)} to {_iso(last)} UTC).")
    for y in summary.years:
        print(f"  {y.path}: +{y.added:,} new, {y.replaced:,} replaced, {y.total:,} total")
    if errors:
        print(f"{len(errors):,} bad rows were NOT imported:")
        _print_errors(errors, args.all_errors, header=False)
    return EXIT_OK


def _print_errors(errors: list, show_all: bool, header: bool = True) -> None:
    if not errors:
        return
    if header:
        print(f"{len(errors):,} bad rows:")
    shown = errors if show_all else errors[:MAX_ERRORS_SHOWN]
    for err in shown:
        print(f"  line {err.line}: {err.message}")
    hidden = len(errors) - len(shown)
    if hidden > 0:
        print(f"  ... and {hidden:,} more (use --all-errors to list them all)")


def cmd_info(data_dir: Path) -> int:
    print(f"Data directory: {data_dir}")
    infos = all_root_info(data_dir)
    if not infos:
        print("No bars on disk. Use `replaylab-data ingest` or `replaylab-data import-csv`.")
    else:
        print(f"{'ROOT':<5} {'FIRST BAR (UTC)':<17} {'LAST BAR (UTC)':<17} {'BARS':>10}  FILES")
        for i in infos:
            print(f"{i.root:<5} {_iso(i.first):<17} {_iso(i.last):<17} {i.bars:>10,}  {i.files}")
    ledger = SpendLedger(data_dir)
    if ledger.path.exists():
        print(f"Databento spend so far: {fmt_usd(ledger.total())} (ledger {ledger.path})")
    return EXIT_OK


def cmd_serve(args: argparse.Namespace, data_dir: Path) -> int:
    import uvicorn

    from .api import create_app

    uvicorn.run(create_app(data_dir), host=args.host, port=args.port)
    return EXIT_OK


def main(
    argv: Sequence[str] | None = None,
    *,
    client_factory: Callable[[], Any] | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    data_dir = resolve_data_dir(args.data_dir)
    try:
        if args.command == "ingest":
            return cmd_ingest(args, data_dir, client_factory or make_client)
        if args.command == "import-csv":
            return cmd_import_csv(args, data_dir)
        if args.command == "info":
            return cmd_info(data_dir)
        if args.command == "serve":
            return cmd_serve(args, data_dir)
    except (RootError, IngestError, CsvImportError, StoreError, SpendError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except Exception as exc:  # Databento and network errors
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_ERROR
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
