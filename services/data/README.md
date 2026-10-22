# replaylab-data

ReplayLab's data service (SPEC sections 2, 4, 8): Databento ingest, CSV import, a Parquet bar store, and a small FastAPI bars endpoint. Python 3.11+.

Replay never calls Databento. You pull once, the bars live on disk, and the app reads them from disk or over the local API.

## Setup

```bash
cd services/data
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

This installs the `replaylab-data` command. Run the tests and lint with:

```bash
pytest
ruff check
```

The tests never touch the network. `databento.Historical` is blocked in `tests/conftest.py` and the client is mocked with a fake that returns a real in-memory `DBNStore`.

## Where bars live

`data/bars/{ROOT}/{YYYY}.parquet` under `REPLAYLAB_DATA_DIR` (default `<repo>/data`, or `./data` if the package is not running from a repo checkout). `--data-dir DIR` before the subcommand overrides both.

Columns match the engine's `Bar` type exactly: `time` int64 unix seconds UTC of the bar OPEN, `open high low close` float64, `volume` int64. The year in the file name is the UTC year of the bar open. Every write merges with what is on disk, dedupes on `time` (the new data wins), sorts, and replaces the file atomically.

Valid roots: `NQ ES YM RTY CL GC`. Micros use their full size root's bars (MNQ on NQ, MES on ES, MYM on YM, M2K on RTY, MCL on CL, MGC on GC), so `ingest`, `import-csv`, and the API reject micro symbols and say which root to use.

Prices are stored as received, including negatives (CL printed below zero on 2020-04-20).

## Databento ingest

```bash
export DATABENTO_API_KEY=db-...      # or put it in a gitignored .env at the repo root

# 1. Estimate only. Prints the cost and exits. Nothing is downloaded.
replaylab-data ingest --root NQ --start 2024-01-01 --end 2024-03-31

# 2. Download, only if you pass --yes and the spend cap allows it.
replaylab-data ingest --root NQ --start 2024-01-01 --end 2024-03-31 --yes
```

`--start` and `--end` are UTC dates and `--end` is inclusive (the request sent to Databento ends at midnight after it, because Databento's `end` is exclusive). The pull is `GLBX.MDP3`, schema `ohlcv-1m`, symbol `{ROOT}.v.0` with `stype_in="continuous"` (front month rolled by volume, unadjusted prices, rolls show up as gaps).

### Spend cap

Every download's estimate is added to `data/spend.json` before the download starts (so a crash still counts). `--yes` refuses, exits 3, and downloads nothing when `total spent + this estimate > --cap`. The default `--cap` is `100.00`, under the $125.00 free credits.

```bash
replaylab-data ingest --root ES --start 2024-01-01 --end 2024-12-31 --cap 50.00
```

Behavior to know:
- Without `--yes`, if the run would be refused the output says so.
- A Databento 4xx rejection (request refused before any data) takes the estimate back out. Any other failure leaves it counted; edit `total_usd` in `spend.json` by hand if you confirm Databento did not charge.
- `total_usd` is the source of truth, so you can edit it by hand to account for spend made elsewhere (Databento's portal, other scripts).
- A missing ledger means $0. A corrupt ledger is an error, never $0.
- Still set the team monthly limit on Databento's Billing page. The cap only counts what this CLI spends.

## CSV import

```bash
replaylab-data import-csv ~/Downloads/nq_1m.csv --root NQ --tz America/New_York
```

- Header names are flexible and case insensitive: `time / timestamp / datetime / ts / date`, `open / o`, `high / h`, `low / l`, `close / c / last`, `volume / vol / v / qty`. Extra columns are ignored. Separate `date` and `time` columns are joined.
- Delimiter is sniffed (comma, semicolon, tab, pipe). A UTF-8 BOM is fine.
- Times: epoch seconds, milliseconds, or nanoseconds are read as UTC. Text with `Z` or an offset uses it. Text without one is read in `--tz` (an IANA name, default `UTC`). The time must be the bar OPEN and on a whole minute.
- Bad rows are listed with their line numbers and are never silently dropped: wrong field count, unreadable time or number, zero price, high below low, open or close outside the high/low range, negative or fractional volume, a time off the minute, a repeated time (first kept), and DST wall times that do not exist or happen twice.
- Good rows are still imported. `--strict` writes nothing if any row is bad. `--all-errors` lists every bad row (the default shows the first 100 and a count of the rest).

## Info

```bash
replaylab-data info
```

Roots on disk with first and last bar (UTC), bar counts, file counts, and the Databento spend so far.

## API

```bash
replaylab-data serve                  # http://127.0.0.1:8000
replaylab-data serve --port 8001
# or: uvicorn replaylab_data.api:app
```

| Endpoint | Returns |
|---|---|
| `GET /health` | `{"status": "ok"}` |
| `GET /markets` | `[{"root": "NQ", "start": "2024-01-02T14:30:00Z", "end": "2024-03-28T20:59:00Z", "bars": 12345}]` for roots on disk. `start` and `end` are the open of the first and last bar. |
| `GET /bars?root=NQ&start=2024-01-02&end=2024-01-03` | `Bar[]`: `[{"time": 1704205800, "open": 16000.25, "high": 16001.0, "low": 15999.5, "close": 16000.75, "volume": 120}]` |

`/bars` rules: `start` is inclusive and `end` is exclusive, both ISO 8601 (a date or a datetime; no offset means UTC); at most 31 days per request, longer is a 400. Other 400s: unknown root, micro root (message names the full size root), bad date, `end` not after `start`. 404 when that root has nothing on disk. Missing query parameters give FastAPI's 422.

CORS allows `http://localhost:*` and `http://127.0.0.1:*` for local dev. Add more origins with `REPLAYLAB_CORS_ORIGINS=https://a.example,https://b.example`.

## Confirmed against the databento-python docs

Checked on databento.com/docs (and against the installed `databento` 0.88.0 docstrings) before coding:

- `Historical.timeseries.get_range(dataset, start, end=None, symbols=None, schema="trades", stype_in="raw_symbol", stype_out="instrument_id", limit=None, path=None) -> DBNStore`: <https://databento.com/docs/api-reference-historical/timeseries/timeseries-get-range>
- `Historical.metadata.get_cost(dataset, start, end=None, symbols=None, schema="trades", stype_in="raw_symbol", limit=None) -> float` (US dollars; `end` exclusive): <https://databento.com/docs/api-reference-historical/metadata/metadata-get-cost>
- `DBNStore.to_df(price_type="float", pretty_ts=True, map_symbols=True, schema=None, tz=UTC, count=None)`. The index is `ts_recv` if the schema has it, otherwise `ts_event`. `price_type="fixed"` gives int64 prices in 1e-9 units: <https://databento.com/docs/api-historical/helpers/dbn-store-to-df?lang=python>
- OHLCV records have no `ts_recv`; `ts_event` is the inclusive start of the bar; no trades in an interval means no bar: <https://databento.com/docs/schemas-and-data-formats/ohlcv>
- `NQ.v.0` is root, volume roll rule, rank 0; used with `stype_in="continuous"`; prices are the original unadjusted prints: <https://databento.com/docs/standards-and-conventions/symbology>

We call `to_df(price_type="fixed", pretty_ts=False, map_symbols=False)`, so the index is raw `ts_event` nanoseconds (uint64) and prices are exact integers. Seconds are `ns // 1_000_000_000` and prices are `int / 1e9` (correctly rounded, no float noise).

## Layout

```
services/data
  pyproject.toml
  src/replaylab_data/
    roots.py            valid roots, micro mapping, continuous symbol
    store.py            Parquet read/write/merge, info, data dir
    spend.py            spend.json ledger and cap check
    databento_ingest.py estimate, cap guard, download, conversion to Bar shape
    csv_import.py       flexible CSV parser with per row errors
    api.py              FastAPI app
    cli.py              replaylab-data command
  tests/
```
