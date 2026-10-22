# TradingView hotkeys: SPEC §7.2 verification

Researched 2026-10-22 by recon-analyst. Public pages only, read through search and fetch. No browser, no login, no network capture, nothing from FX Replay. All text below is paraphrased; only key combinations are facts taken from the sources.

Source tiers used in this file:
- **A**: published by TradingView (help center, blog, or posts from the official TradingView account).
- **B**: on a TradingView domain but written by a community user.
- **C**: third party site.

A hotkey counts as CONFIRMED when at least one tier A source states it. CORROBORATED means no tier A source I could read, but several B and C sources agree (whether they copied each other was not checked). CORROBORATED is still unconfirmed.

## 1. Question being answered

Which of the hotkeys in SPEC §7.2 marked *verify* (trend line, horizontal line, rectangle, measure, reset chart view) match TradingView's defaults? Also check undo/redo, the type-to-change-symbol and type-a-number-to-change-interval behaviors, and the Bar Replay hotkeys, and give Mac equivalents where a source states them.

## 2. Findings

### 2.0 Summary

| Action | SPEC §7.2 says | Verdict | Windows / Linux | Mac | Best source |
|---|---|---|---|---|---|
| Trend line | Alt+T | CONFIRMED | Alt+T | Option+T | S1 (A) |
| Horizontal line | Alt+H | CONFIRMED | Alt+H | Option+H | S1 (A) |
| Rectangle | Alt+Shift+R | CONFIRMED | Alt+Shift+R | Option+Shift+R | S2 (A) |
| Measure | Shift+click | CONFIRMED | hold Shift, click start point, click end point | not stated | S3, S4 (A) |
| Reset chart view | Alt+R | CORROBORATED, not tier A | Alt+R | Option+R (C only) | B1, C1, C2, C3, C4 |
| Undo / redo | Ctrl+Z / Ctrl+Y | CONFIRMED | Ctrl+Z / Ctrl+Y | not stated by TradingView | S5 (A) |
| Change symbol | type letters on chart | CONFIRMED | just start typing, a search box opens | same (B source says works on Mac) | S6 (A) |
| Change interval | type a number on chart | CONFIRMED, with detail differences | type digits, press Enter | not stated (inferred same) | S7, S8 (A) |
| Replay play / pause | Shift+Down | CONFIRMED | Shift+Down arrow | not stated | S9, S10 (A) |
| Replay step forward | Shift+Right | CONFIRMED | Shift+Right arrow | not stated | S9, S10 (A) |
| Replay step back | not in SPEC | no hotkey and no button found | none | none | S9, S10 (A) |
| Replay select start bar | not in SPEC | no hotkey found | none | none | S10, S13 (A) |

No tier A source contradicts any §7.2 hotkey. Alt+R still has no tier A source, and no Mac key except the Option and Cmd+/ ones above is stated by TradingView. Other differences from the spec are refinements (details in §4).

### 2.1 Trend line (Alt+T) and horizontal line (Alt+H): CONFIRMED

- TradingView's official account published a shortcuts post (17 Oct 2020) listing Alt+T for trend line and Alt+H for horizontal line, and a matching Mac list that uses Option in place of Alt (Option+T, Option+H). The same post lists Alt+V vertical line, Alt+C cross line, Alt+F Fib retracement, Alt+A add alert, Alt+S screenshot, Alt+I invert chart, Alt+P percent chart, Alt+L log chart. Source S1.
- Independent agreement: community post (24 Aug 2021) B2, OANDA Japan C1, FYERS C3, tradamaker C4.

### 2.2 Rectangle (Alt+Shift+R): CONFIRMED

- TradingView blog post of 13 Dec 2023 (modified 28 Feb 2024) says Alt+Shift+R on Windows and Option+Shift+R on Mac selects the Rectangle tool in the toolbar, ready to place. Source S2.
- Same post: Ctrl+/ (Windows) or Cmd+/ (Mac) opens the list of all hotkeys, also reachable from "Keyboard shortcuts" in the chart's main menu. Source S2.
- C1 and C3 add that holding Shift while drawing a rectangle makes a square. Tier C only.

### 2.3 Measure (Shift+click): CONFIRMED

- Help center article: click the start point, then the end point, while holding Shift. Source S3 (A).
- TradingView's official account post (3 Jan 2020) says the same: hold Shift and click the chart where measuring should begin. It does not mention a Mac variant. Source S4 (A).
- Agreement: B2, C3, C4.
- No source states how the measurement is dismissed afterwards (see Unknowns).

### 2.4 Reset chart view (Alt+R): CORROBORATED, official text not readable

- Community post on a TradingView domain (15 Jun 2020, user TaherJalili) lists Alt+R as the reset chart shortcut. Source B1.
- OANDA Japan's TradingView shortcut guide lists Alt+R for reset chart view and says the full list is behind the "?" button at the bottom right of the chart. Source C1.
- FYERS support page (a broker built on TradingView charts) says Alt+R resets zoom, double click on the time axis resets bar spacing, double click on the price axis resets the price scale. Source C3.
- Financial Tech Wiz says Alt+R on Windows, Option+R on Mac. Source C2 (no TradingView citation on that page).
- tradamaker lists Alt+R and Option+R. Source C4.
- I could not read TradingView's own shortcuts dialog or the page at https://www.tradingview.com/support/shortcuts/ (the tables are drawn by script and did not come through), and the Advanced Charts docs page S15 returned an empty table. So there is no tier A quote.

### 2.5 Undo / redo (Ctrl+Z / Ctrl+Y): CONFIRMED on Windows

- TradingView's "Masterclass: How To Use The Top Toolbar" post (signed Team TradingView, 7 Nov 2023) heads the section with "Ctrl + Z / Ctrl + Y" and says drawings and indicator changes can be undone or redone with them. Source S5 (A).
- OANDA Japan lists Ctrl+Z / Ctrl+Y in the chart shortcuts. Source C1.
- Mac: TradingView's pages do not state a Mac key. A third party article names Cmd+Z for undo only (C5). The Advanced Charts docs say that on macOS you can use Cmd, Option, Shift in place of Ctrl, Alt, Shift (S15). That is about the library, so treat it as support for the inference in §3, not a confirmation.
- Ctrl+Shift+Z as an alternative redo: no source found.

### 2.6 Type to change symbol: CONFIRMED

- Help center: to change the symbol, type the asset name straight on the keyboard with the chart focused; a search box appears and you pick a result. Source S6 (A).
- Community education post (6 Apr 2025, user Mr_Chartist_) adds: no click needed, works on Windows and Mac, arrow keys move through results, Enter selects. Source B3.
- OANDA Japan lists the same behavior. Source C1.

### 2.7 Type a number to change interval: CONFIRMED, with detail

- Help center: just start typing the number on the keyboard. Example in the article: typing 125 and pressing Enter sets a 125 minute interval. Letter suffixes: 2 is 2 minutes, 12D is 12 days, 1W is 1 week, 3M is 3 months. Source S7 (A).
- Official account education post (27 May 2020): type a number and press Enter; add D, W or M for days, weeks, months (1D, 5D, 1W, 1M). Source S8 (A).
- Not stated by any tier A source: that 60 or 1H means one hour, that a bare D works, that a comma key opens the interval box. OANDA Japan (C1) lists "5, or 1H, 1D, 1W, 1M" and a comma, FYERS (C3) says press comma then type 1, 5, 30, D, W or 4H, tradamaker (C4) lists "number or comma". Tier C only.

### 2.8 Bar Replay hotkeys: CONFIRMED, only two exist in public docs

- Shift+Down arrow starts or stops playback. Shift+Right arrow moves forward one step. Blog post "Hotkeys for the Bar Replay" (11 Sep 2020). Source S9 (A).
- The Bar Replay help center article repeats both and states no step back hotkey and no select start hotkey. Source S10 (A).
- The blog posts on replay intervals (10 Feb 2025) and selecting the start point (22 Apr 2024) and the help article on turning replay on mention no hotkeys. Sources S12, S13, S14 (A).
- Public docs describe "Select bar" (click a bar), "Select date", first available day and random bar as panel options, with no keys. Sources S10, S13.
- No Mac note anywhere.

### 2.9 Other tier A hotkeys found along the way

| Action | Windows | Mac | Source |
|---|---|---|---|
| Hide / show all drawings | Ctrl+Alt+H | Cmd+Option+H | S11 (A) |
| Delete drawing or indicator | middle mouse click on it | same | S11 (A) |
| Open the shortcuts list | Ctrl+/ | Cmd+/ | S2 (A) |
| Previous chart in a multi chart window | Shift+Tab | not stated | S11 (A) |
| Open indicator search | / | not stated | S1 (A) |
| Vertical line, cross line, Fib, alert, screenshot, invert, percent, log | Alt+V, Alt+C, Alt+F, Alt+A, Alt+S, Alt+I, Alt+P, Alt+L | Option in place of Alt | S1 (A) |

Tier C only, not usable as fact: Alt+G go to date, Alt+N add text note, Shift+B and Shift+S for market buy and sell from the chart (OANDA Japan C1).

### 2.10 Source read and rejected

- supa.is "TradingView Keyboard Shortcuts" (3 Jul 2026, URL not recorded): describes itself as rebuilt from official docs plus community agreement rather than from TradingView's list, and contradicts tier A on trend line, horizontal line, replay play/pause and replay step (plain T, H, Space, arrow keys, Ctrl+B). Not used for anything.

## 3. Inference (labeled, not sourced fact)

1. **Mac mapping.** Alt maps to Option for every Alt combination, and Ctrl+Z / Ctrl+Y map to Cmd+Z / Cmd+Y, because S1 and S2 show Option for Alt and the library docs (S15) state the general rule. Not stated for Shift+Down / Shift+Right, where nothing changes anyway.
2. **Bare number is minutes.** The help article's 125 example and "2 is 2 minutes" imply 60 is 60 minutes, which is one hour. So the SPEC's `60` is consistent with TradingView. `1h` and a bare `D` are accepted by TradingView according to tier C sources only. Accepting them in ReplayLab is harmless.
3. **Alt+R is probably right.** Five sources (one tier B, four tier C) agree and none I read disagree, but their independence is not established. It stays UNCONFIRMED until a check against TradingView's own dialog (Unknowns) closes it.
4. **Implementation.** On a Mac, Option+letter types a special character, so `event.key` is wrong there; match on `event.code` (KeyT, KeyH, KeyR). Call `preventDefault` on all of these. Hotkeys stay ignored while an input has focus (already in §7.2).
5. **No step back.** TradingView has none in public docs, and our no lookahead rule gains nothing from adding one. Don't invent a replay rewind key.

## 4. What it means for us: proposed SPEC changes

1. Replace the "TradingView, verify" labels in §7.2 with the verdicts below, and add a Mac column.
2. Add the Mac mapping rule: Alt becomes Option, Ctrl becomes Cmd for undo and redo. Match Alt combos by key code.
3. Measure: spell out the behavior. Hold Shift, click the start point, click the end point.
4. Interval box (§7.1 text): a bare number is minutes (`5`, `60`, `125`), suffix D, W, M for days, weeks, months. Keep `1h` and `D` as accepted extras, labeled unconfirmed (only tier C says TradingView accepts them). Comma opening the interval box is tier C only, so mark it optional.
5. Shortcuts dialog: open with Ctrl+/ (Cmd+/ on Mac), which TradingView uses, as well as `?` (ours).
6. Optional adds from tier A, all small and mapped to controls the spec already has: Ctrl+Alt+H hide all drawings (our "hide all" button), Alt+L log scale and Alt+P percent scale (our footer toggles), Alt+V vertical line and Alt+C cross line for M2 drawing tools.
7. Bar Replay: keep Shift+Down and Shift+Right as written. Don't add step back or select start hotkeys.
8. For research-motherhead and chief to decide: tier C says TradingView uses Shift+B and Shift+S for market buy and sell. Our Alt+Shift+B / S / X are "ours". CLAUDE.md hard rule 9 says follow TradingView conventions, but the only evidence is one third party page, so leave ours as is until Arsh confirms in his own TradingView.

### Proposed SPEC §7.2 table

Mac keys marked * are not stated by TradingView; they are inferred and UNCONFIRMED.

| Action | Windows / Linux | Mac | Status |
|---|---|---|---|
| Replay play / pause | Shift+↓ | Shift+↓ * | TradingView, confirmed (S9, S10) |
| Replay step forward | Shift+→ | Shift+→ * | TradingView, confirmed (S9, S10) |
| Change symbol | start typing on the chart | same * | TradingView, confirmed (S6); Mac per one tier B post (B3) |
| Change interval | type a number on the chart, Enter (`5`, `60`, `1D`, `1W`; bare number = minutes) | same * | TradingView, confirmed (S7, S8); `1h` and bare `D` also accepted, UNCONFIRMED (tier C only) |
| Trend line | Alt+T | Option+T | TradingView, confirmed (S1) |
| Horizontal line | Alt+H | Option+H | TradingView, confirmed (S1) |
| Rectangle | Alt+Shift+R | Option+Shift+R | TradingView, confirmed (S2) |
| Measure | hold Shift, click start, click end | same * | TradingView, confirmed (S3, S4) |
| Reset chart view | Alt+R | Option+R | UNCONFIRMED: tier B and C only (B1, C1 to C4); Arsh checks TradingView's Ctrl+/ list |
| Undo / redo | Ctrl+Z / Ctrl+Y | Cmd+Z / Cmd+Y * | Windows confirmed (S5)
| Hide / show all drawings (optional) | Ctrl+Alt+H | Cmd+Option+H | TradingView, confirmed (S11) |
| Log / percent scale (optional) | Alt+L / Alt+P | Option+L / Option+P | TradingView, confirmed (S1) |
| Shortcuts dialog | Ctrl+/ and ? | Cmd+/ and ? | Ctrl+/ TradingView (S2); `?` ours |
| Buy market / Sell market / Flatten | Alt+Shift+B / Alt+Shift+S / Alt+Shift+X | Option+Shift+B / S / X | ours, configurable |
| Cancel working order, exit tool, close dialog | Esc | Esc | ours |

## 5. Unknowns

1. **Alt+R from tier A.** Needs one look at TradingView's own list: Arsh presses Ctrl+/ (Cmd+/ on Mac) in his normal TradingView and checks "Reset chart" and "Undo / Redo". Anyone with a normal browser can also open the Advanced Charts shortcuts page (S15) where the table is filled in by script.
2. **Mac keys for undo and redo, measure, and the replay keys.** TradingView's pages state none. Same Ctrl+/ check on a Mac.
3. **Ctrl+Shift+Z as redo**, and whether Cmd+Shift+Z is redo on Mac. No source.
4. **Measure dismissal.** How Shift+click measuring ends (Esc, a third click, next click) is not documented in what I read. Arsh's notes would settle it.
5. **Interval box details.** Whether 60 shows as 1h and whether bare D and the comma key work today. Only tier C says yes.
6. **Shift+B / Shift+S market order keys** and Alt+G go to date: tier C only.
7. **Whether Esc cancels a drawing tool in TradingView.** No source read. The SPEC lists Esc as ours, which is fine.
8. **Date of the official shortcut list.** The tier A posts range from 2020 to 2023. TradingView may have changed defaults since; the in-app dialog is the only current source.

## Sources

Tier A, published by TradingView:
- S1 Official account post, "Keyboard shortcuts! Analyze, create, and study charts faster", 17 Oct 2020: https://es.tradingview.com/chart/DXY/j9Ua6Ks4-Keyboard-shortcuts-Analyze-create-and-study-charts-faster
- S2 Blog, "New shortcuts to access Rectangle and shortcuts list", 13 Dec 2023: https://www.tradingview.com/blog/en/new-shortcuts-rectangle-shortcuts-list-42318
- S3 Help center, "How to use Measure Tool quickly?": https://www.tradingview.com/support/solutions/43000537228-how-to-use-measure-tool-quickly/
- S4 Official account post, "Quickly Measure Time & Change (Hold Shift + Click the Chart)", 3 Jan 2020: https://id.tradingview.com/chart/CL1%21/p9BePUhq-Quickly-Measure-Time-Change-Hold-Shift-Click-the-Chart
- S5 Team TradingView post, "TradingView Masterclass: How To Use The Top Toolbar", 7 Nov 2023: https://fr.tradingview.com/chart/CNXSMALLCAP/80Uafk49-TradingView-Masterclass-How-To-Use-The-Top-Toolbar
- S6 Help center, "How do you change the symbol or ticker on a chart?": https://www.tradingview.com/support/solutions/43000543012/
- S7 Help center, "How to change the time frame quickly": https://www.tradingview.com/support/solutions/43000762824/
- S8 Official account post, "Change Your Chart's Timeframe in Lightning Speed", 27 May 2020: https://it.tradingview.com/chart/MSFT/pDaxSUaE-Change-Your-Chart-s-Timeframe-in-Lightning-Speed
- S9 Blog, "Hotkeys for the Bar Replay", 11 Sep 2020: https://www.tradingview.com/blog/en/hotkeys-for-the-bar-replay-20594
- S10 Help center, "Bar Replay: how and why to test a strategy in the past": https://www.tradingview.com/support/solutions/43000712747-bar-replay-how-and-why-to-test-a-strategy-in-the-past/
- S11 Blog, "Faster and more convenient hotkeys for working with charts", 23 Sep 2020: https://www.tradingview.com/blog/en/faster-and-more-convenient-hotkeys-for-working-with-charts-20914
- S12 Blog, "Select replay intervals in Bar Replay", 10 Feb 2025 (no hotkeys): https://www.tradingview.com/blog/en/intervals-in-bar-replay-50381
- S13 Blog, "Selecting Bar Replay starting point", 22 Apr 2024 (no hotkeys): https://www.tradingview.com/blog/en/selecting-bar-replay-starting-point-44104/
- S14 Help center, "How do I turn Bar Replay on?" (no hotkeys): https://in.tradingview.com/support/solutions/43000474024
- S15 Advanced Charts docs, "Keyboard shortcuts" (Mac modifier rule; table empty in my read): https://www.tradingview.com/charting-library-docs/v29/getting_started/Shortcuts

Tier B, community posts on TradingView domains:
- B1 TaherJalili, "Setting the zoom level of chart for best fit in one view", 15 Jun 2020: https://in.tradingview.com/chart/BTCUSDT/DR3DZYoL-Setting-the-zoom-level-of-chart-for-best-fit-in-one-view
- B2 VaidoVeek, "TradingView Hotkeys That I Use The Most", 24 Aug 2021: https://kr.tradingview.com/chart/BTCUSD/ZQopiG0R-TradingView-Hotkeys-That-I-Use-The-Most
- B3 Mr_Chartist_, "How to Use the TradingView Search Bar Efficiently", 6 Apr 2025: https://fr.tradingview.com/chart/RELIANCE/myIBlQDk-How-to-Use-the-TradingView-Search-Bar-Efficiently

Tier C, third party:
- C1 OANDA Japan, TradingView shortcut guide: https://www.oanda.jp/lab-education/?p=5856
- C2 Financial Tech Wiz, "How to zoom out on TradingView": https://www.financialtechwiz.com/post/how-to-zoom-out-on-tradingview/
- C3 FYERS support, hotkeys for FYERS Web: https://support.fyers.in/portal/en/kb/articles/what-are-the-hotkeys-shortcut-keys-for-fyers-web-to-simplify-the-charting-experience
- C4 tradamaker, "TradingView Hotkeys": https://tradamaker.com/tradingview-hotkeys/
- C5 How2Shout, "How to Delete Multiple Drawings on TradingView": https://www.how2shout.com/?p=81133

Not fetched or not readable: TradingView's /support/shortcuts/ page (tables did not render), Scribd copies (script wall), the Wayback Machine (blocked), friendofthetrend.com (robots disallow, not retrieved).

## Review (research-motherhead, 2026-10-22)

PASS after edits. Edits: Mac keys TradingView doesn't state are now marked inferred / UNCONFIRMED in §2.0 and the proposed table; Alt+R and `1h` / bare `D` relabeled UNCONFIRMED instead of "corroborated" or "ours"; "no hotkey is wrong" narrowed to "no tier A source contradicts"; the "independent sources" claim softened; one verbatim third party quote in §2.10 paraphrased. Nothing was cut for source or clean room reasons. No patent issue (no session window marking proposed). Alt+V / Alt+C are not approved for §7.2: vertical and cross line tools aren't in the SPEC's v1 or M2 tool lists.
