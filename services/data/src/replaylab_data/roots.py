"""Valid roots and the micro to full size root mapping (SPEC section 2).

Bars are stored per full size root. Micros reuse their full size root's bars: same price,
different tick value. That halves the data cost.
"""

from __future__ import annotations

# Roots we store bars for.
ROOTS: tuple[str, ...] = ("NQ", "ES", "YM", "RTY", "CL", "GC")

# Micro symbol -> the full size root whose bars it uses.
MICRO_TO_ROOT: dict[str, str] = {
    "MNQ": "NQ",
    "MES": "ES",
    "MYM": "YM",
    "M2K": "RTY",
    "MCL": "CL",
    "MGC": "GC",
}

ROOT_NAMES: dict[str, str] = {
    "NQ": "E-mini Nasdaq-100",
    "ES": "E-mini S&P 500",
    "YM": "E-mini Dow",
    "RTY": "E-mini Russell 2000",
    "CL": "Crude Oil",
    "GC": "Gold",
}

DATASET = "GLBX.MDP3"
SCHEMA = "ohlcv-1m"
STYPE_IN = "continuous"


class RootError(ValueError):
    """Raised for an unknown root or a micro symbol used where a root is required."""


def continuous_symbol(root: str) -> str:
    """Databento continuous symbol, front month rolled by volume (SPEC section 2)."""
    return f"{root}.v.0"


def validate_root(symbol: str) -> str:
    """Return the canonical root for `symbol` or raise RootError.

    Micros are rejected with a message pointing at the full size root.
    """
    root = symbol.strip().upper()
    if root in ROOTS:
        return root
    if root in MICRO_TO_ROOT:
        full = MICRO_TO_ROOT[root]
        raise RootError(
            f"{root} is a micro contract. Micros use their full size root's bars: "
            f"use {full} ({root} trades on {full} bars, same price, different tick value)."
        )
    raise RootError(f"Unknown root {symbol!r}. Valid roots: {', '.join(ROOTS)}.")
