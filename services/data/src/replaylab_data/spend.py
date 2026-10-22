"""Databento spend ledger and cap (SPEC section 8).

`<data dir>/spend.json` keeps a running total of what ingest has spent. A download is
refused when `total + estimate > cap`. Money is handled as Decimal with 6 places; estimates
round up so the ledger errs on the high side.

A missing ledger means $0 spent. A corrupt ledger is an error: we never guess zero.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

DEFAULT_CAP = Decimal("100.00")
FREE_CREDITS = Decimal("125.00")
_PLACES = Decimal("0.000001")
LEDGER_NAME = "spend.json"
LEDGER_VERSION = 1


class SpendError(RuntimeError):
    """Raised when the ledger cannot be read or written."""


def to_money(value: Any, *, round_up: bool = False) -> Decimal:
    """Decimal with 6 places from a float, int, str, or Decimal."""
    try:
        amount = Decimal(str(value))
    except InvalidOperation as exc:
        raise SpendError(f"not a dollar amount: {value!r}") from exc
    if not amount.is_finite():
        raise SpendError(f"not a dollar amount: {value!r}")
    return amount.quantize(_PLACES, rounding=ROUND_CEILING) if round_up else amount.quantize(_PLACES)


def fmt_usd(amount: Decimal) -> str:
    """Two decimals for display, rounding up (never understates a cost)."""
    return f"${amount.quantize(Decimal('0.01'), rounding=ROUND_CEILING):,.2f}"


def ledger_path(data_dir: Path) -> Path:
    return data_dir / LEDGER_NAME


@dataclass(frozen=True)
class CapCheck:
    total: Decimal
    estimate: Decimal
    cap: Decimal

    @property
    def projected(self) -> Decimal:
        return self.total + self.estimate

    @property
    def allowed(self) -> bool:
        return self.projected <= self.cap

    @property
    def remaining(self) -> Decimal:
        return self.cap - self.total


def check_cap(total: Decimal, estimate: Decimal, cap: Decimal) -> CapCheck:
    return CapCheck(total=total, estimate=estimate, cap=cap)


class SpendLedger:
    def __init__(self, data_dir: Path) -> None:
        self.path = ledger_path(data_dir)

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": LEDGER_VERSION, "total_usd": 0.0, "entries": []}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("entries", []), list):
                raise ValueError("unexpected structure")
            to_money(data.get("total_usd", 0))
        except (OSError, ValueError, SpendError) as exc:
            raise SpendError(
                f"cannot read {self.path} ({exc}). Fix or delete it by hand; "
                "refusing to assume $0 spent."
            ) from exc
        data.setdefault("version", LEDGER_VERSION)
        data.setdefault("entries", [])
        data.setdefault("total_usd", 0.0)
        return data

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)

    def total(self) -> Decimal:
        """Running total in USD. Edit `total_usd` by hand to account for spend made elsewhere."""
        return to_money(self._load()["total_usd"])

    def entries(self) -> list[dict[str, Any]]:
        return list(self._load()["entries"])

    def reserve(self, estimate: Decimal, details: dict[str, Any]) -> int:
        """Add `estimate` to the total and log a pending entry. Returns the entry index.

        Called before the download starts so a crash mid download still counts the spend.
        """
        data = self._load()
        entry = {
            "at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            **details,
            "cost_usd": float(estimate),
            "status": "pending",
        }
        data["entries"].append(entry)
        data["total_usd"] = float(to_money(data["total_usd"]) + estimate)
        self._save(data)
        return len(data["entries"]) - 1

    def finish(self, index: int, status: str = "complete") -> None:
        data = self._load()
        data["entries"][index]["status"] = status
        self._save(data)

    def release(self, index: int, status: str = "rejected") -> None:
        """Take a reservation back out of the total (the request was rejected before any data)."""
        data = self._load()
        entry = data["entries"][index]
        data["total_usd"] = float(max(Decimal(0), to_money(data["total_usd"]) - to_money(entry["cost_usd"])))
        entry["status"] = status
        self._save(data)
