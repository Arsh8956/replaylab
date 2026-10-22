# ReplayLab

Bar by bar replay backtesting for CME futures (NQ, MNQ, ES, MES and more), with a TradingView style workspace, simulated orders, a trade journal, and stats.

- What we're building: `docs/SPEC.md`
- Team rules every agent reads: `CLAUDE.md`
- Agents: `.claude/agents/` (6 workers, 4 motherheads)
- Research: `docs/research/`

## 1. Setup (once)

1. Free installs: Git, Node.js 22+ (`node -v`), Python 3.11+ (`python3 --version`), VS Code (optional). Claude Code comes with a Claude Pro or Max subscription.
2. `git clone https://github.com/Arsh8956/replaylab && cd replaylab`
3. Run `claude` in that folder, then `/agents`. All 10 agents should be listed.

## 2. How the team runs

Your main Claude Code session is the orchestrator. Subagents can't call other subagents, so the main session runs each step and hands reports to the next one. `/feature <task>` runs one task through the whole pipeline (worker → qa-tester → pod motherhead → chief motherhead → commit).

## 3. M0 build order

| Step | Who | What | Gate |
|---|---|---|---|
| 1 | engine-builder + data-builder (parallel) | `packages/engine` (SPEC §2 to §6) and `services/data` (§8) | tests green |
| 2 | qa-tester | attack the engine and data service | failing tests listed |
| 3 | core-motherhead | review, fix or bounce | PASS |
| 4 | recon-analyst → research-motherhead | confirm the *verify* hotkeys in SPEC §7.2 | chief updates §7.2 |
| 5 | ui-builder | `apps/web` (SPEC §7), workspace shell first | builds + smoke test |
| 6 | product-motherhead | review against §7 and TradingView parity | PASS |
| 7 | chief-motherhead | full repo review | SHIP |
| 8 | any builder via `/feature` | GitHub Actions CI: engine tests + typecheck, web build, pytest | green on push |

First prompt to paste in Claude Code:

> Read CLAUDE.md, docs/SPEC.md, and README.md. You're the orchestrator for M0. Follow the build order in README.md section 3. Run each step with the named subagents, pass each worker's report to the next reviewer, and don't move past a gate until it passes. Run straight through without waiting on me; only stop and ask if a motherhead fails something 3 rounds in a row. Commit after each passed gate and push to origin once the chief says SHIP. After each step, tell me in under 10 lines what happened.

## 4. What needs you

- Approve tool permissions when Claude Code asks.
- Hotkey check (step 4): if recon asks, confirm the shortcut in your TradingView.
- Real data (M1, optional): either export 1m bars to CSV from a platform you already use, or use Databento's free credits. Databento asks for a card at signup but only bills past the $125.00 credits (which expire 6 months after signup). If you use it: set the Team monthly limit on its Billing page, put the key in `.env` as `DATABENTO_API_KEY` (gitignored), and let the CLI's spend cap (default $100.00 total) block anything bigger.
- Don't use an FX Replay account for this project (see `docs/research/public-landscape.md`).

## 5. Cost: $0

Everything here is free or open source: Git, GitHub private repo, Node.js, Python, VS Code, React, Vite, TypeScript, Lightweight Charts, Lucide icons, FastAPI, SQLite. The app runs on your laptop, so there's no hosting bill. Synthetic data is free and is the default. The only thing that touches money is optional Databento, capped as above.

## 6. Keep usage low

Claude Code shares the same usage limits as your Claude chats, and 10 agents burn through them fast.
- Workers run on Sonnet. Motherheads use whatever model your main session runs (`model: inherit`).
- One milestone at a time, `/clear` between milestones, short reports.
