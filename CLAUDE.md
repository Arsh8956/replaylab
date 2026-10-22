# ReplayLab: team rules (read first)

FX Replay style backtesting for CME futures. Source of truth: `docs/SPEC.md`. If code and spec disagree, the spec wins until the chief motherhead changes the spec.

## Repo map
- `packages/engine`: TypeScript, zero runtime deps. Replay clock, timeframe aggregation, order fills, contract math, stats, CSV parsing, synthetic data. Vitest.
- `apps/web`: React + Vite + Lightweight Charts. Talks to the engine only through its public API.
- `services/data`: Python 3.11+. Databento ingest, CSV import, Parquet bar store, FastAPI bars endpoint. Pytest.

## Commands
- `npm install` (repo root)
- `npm test -w @replaylab/engine` and `npm run typecheck -w @replaylab/engine`
- `npm run build -w @replaylab/web`, `npm run build:single -w @replaylab/web` (one file HTML)
- `cd services/data && pip install -e ".[dev]" && pytest`

## The team
Workers build. Motherheads review. Nothing is done until its pod motherhead passes it, and nothing merges until the chief motherhead says SHIP.

| Pod | Workers | Motherhead |
|---|---|---|
| Research | recon-analyst (public sources + REA on our own app, writes docs/research) | research-motherhead |
| Core | engine-builder, data-builder, api-builder | core-motherhead |
| Product | ui-builder | product-motherhead |
| Quality | qa-tester (serves both pods, only writes tests) | |
| Whole repo | | chief-motherhead (final gate) |

Flow for a new or reworked feature: recon-analyst studies how existing tools do it → research-motherhead checks the evidence → chief approves SPEC changes → worker builds and tests → qa-tester attacks it (engine/data changes) → pod motherhead reviews, runs everything, fixes or bounces → chief motherhead integration review → merge.

## Research rules (see docs/research/public-landscape.md)
- TradingView's and FX Replay's terms both forbid reverse engineering, and FX Replay's forbid using its service or docs to build a competing product. So: no REA, decompiling, or network capture on either, and no FX Replay account use for this project.
- Research comes from third party reviews, articles, public videos, TradingView's public docs and open source code, and Arsh's normal TradingView use.
- REA (github.com/morluto/rea, MIT; `npx rea-agents setup --client claude_code`) is for our own app only.
- Nobody's code, CSS, text, icons, assets, or data comes into this repo.
- FX Replay holds US 12,614,322 (session/time window selection for backtesting). Don't build "mark a session window on the chart to auto backtest it". Patent attorney review before any launch.

Agent definitions live in `.claude/agents/`. Workers end with a short report: what was built, tests added, open questions. Motherheads end with PASS/FAIL (pods) or SHIP/HOLD (chief) plus the proof.

## Hard rules
1. No lookahead. Nothing on screen and no fill may use data after the cursor.
2. Money math: prices rounded to tick, P&L = ticks × tick value × qty, USD rounded to cents. Compare prices through the tick helper, not raw floats.
3. The engine is pure and deterministic: no `Date.now()`, no unseeded randomness, no DOM.
4. Changing the engine's public API (`packages/engine/src/index.ts`) needs the chief's approval and a SPEC update in the same change.
5. Every engine bug fix ships with a test that failed before the fix.
6. Never call the Databento API in tests or CI. Real pulls print the cost estimate first and need `--yes`.
7. No secrets in the repo. `DATABENTO_API_KEY` comes from the environment.
8. Keep the TradingView attribution logo on charts (Lightweight Charts license).
9. The UI follows TradingView's layout and hotkey conventions (SPEC §7) so a TradingView user needs no instructions. Our own name, icons (Lucide), and colors; never copy TradingView's logo, icons, or styling.
10. $0 budget. Free and open source tools and libraries only. No paid services, plans, APIs, or hosting. Databento only through the CLI spend cap (SPEC §8).
