# How TradingView and FX Replay are built (public sources only)

Researched 2026-10-20. Every point comes from a public page listed at the bottom. Not legal advice.

## TradingView

**Stack (from their own job postings)**
- Front end: React + TypeScript.
- Back end: Python/Django, Go, Java, NodeJS.
- Infra: Docker + Kubernetes on AWS/Azure class clouds, "distributed, high-load systems", "100M+ users". CME Group is a named customer.

**Chart products they license**
| Product | License | Who can use it | What you get |
|---|---|---|---|
| Lightweight Charts | Apache 2.0, open source | anyone, personal projects included | ~35 KB canvas charts, bring your own data. No built in drawings or replay |
| Advanced Charts | proprietary, free | "only available to companies for use in public web projects"; not for "personal use, hobbies, studies, or testing" | 100+ indicators, 80+ drawing tools, bring your own datafeed, TradingView logo on the free version |
| Trading Platform | proprietary | same company only rule | Advanced Charts + trading from the chart, layouts, watchlists; needs a broker backend |

**Bar Replay hotkeys**: Shift+↓ play/pause, Shift+→ step one bar.

**Terms of Use**: no "translating, decompiling, disassembling or creating derivative works" without written consent, and no "creating products or services based on TradingView content".

**Takeaway**: we copy layout conventions (public UX), build on Lightweight Charts, and draw our own tools. Later option: once the team has a company and a public product, apply for Advanced Charts to get real TradingView drawings and indicators out of the box (M2+ decision).

## FX Replay

**What they say publicly**
- "high-resolution historical data" and "historical bid/ask data"; crypto "sourced via Kaiko"; tick level data is listed as future work.
- Stop orders fill based on bid/ask context; partial fills supported.
- Live tracking of balance, margin, and drawdown; post-trade analysis mode; custom journal fields; confidence and emotion ratings.
- "Trusted by 1M+ traders".

**From a third party review (Sept 2026)**
- "familiar TradingView-style charting" (charting engine not confirmed anywhere public).
- Futures only on Pro; Pro reaches 1 second futures bars; futures history from Jan 3, 2012.
- Multichart: Beginner none, Intermediate 2 charts, Pro unlimited.
- Prop firm simulator: profit target, max daily loss, max total loss; no rewind inside prop sessions.
- Separate backtesting journal and paid live journal; Mentor AI.
- Pricing: Beginner free, Intermediate $17.99/mo or $180/yr, Pro $35/mo or $350/yr.

**Terms of Service (updated Sept 17, 2025, Section 2)** forbid:
- copying or creating "a functional equivalent of the Services"
- reverse engineering, disassembling, or decompiling any part of the service
- any "robot, spider, or other automatic device" accessing it
- accessing the Services or Documentation "in order to build a similar or competitive website, product, or service"

**Patent**: US 12,614,322, "System and method for selection of backtesting time and region" (FX Replay Inc.). As publicly described: mark a market session or time window on the chart, the system pulls that window's data automatically, then reports how the strategy did under those conditions. Earlier publication: US 2026/0004486.

## What this changes for ReplayLab

1. **No REA on TradingView or FX Replay.** Both terms forbid it. FX Replay also forbids using its service at all to build a competitor, so an FX Replay account can't be our research tool either.
2. **Allowed recon sources**: third party reviews and articles, public videos, TradingView's public docs and open source code, and our own app. REA stays in the toolkit for our own app (debugging, comparing builds, checking what ships in the bundle).
3. **Patent check before launch**: our spec has session stats (Asia / London / NY AM / NY PM) and a pick start bar replay. We don't build a "draw a session window on the chart to auto backtest it" feature. Before selling anything, a patent attorney compares our features to the claims.
4. **Data**: FX Replay goes down to 1 second futures bars on Pro. Our 1m v1 is fine; Databento also sells `ohlcv-1s` for a later upgrade.

## Sources
- TradingView job posting, Backend Architect: https://tradingview.teamtailor.com/jobs/7534165-backend-architect
- TradingView job posting, Frontend Developer: https://tradingview.teamtailor.com/jobs/4693259-frontend-developer-react-typescript
- TradingView free charting libraries: https://www.tradingview.com/free-charting-libraries/
- TradingView Bar Replay hotkeys: https://www.tradingview.com/blog/en/hotkeys-for-the-bar-replay-20594
- TradingView policies: https://in.tradingview.com/policies
- FX Replay blog, real backtesting: https://www.fxreplay.com/blogs/why-fx-replay-is-built-for-real-backtesting-not-just-replays
- FX Replay llms.txt: https://fxreplay.com/llms.txt
- FX Replay Terms of Service: https://www.termsfeed.com/live/a8a67413-4a99-423b-bf82-6f312570972a
- FX Replay review (Traders Second Brain): https://traderssecondbrain.com/guides/fxreplay-review
- FX Replay patent (Swanson Reed, May 2026): https://www.swansonreed.com/patent-of-the-month/oklahoma/2026-05/
- FX Replay patent application (Swanson Reed, Feb 2026): https://www.swansonreed.com/patent-of-the-month/oklahoma/2026-02/
