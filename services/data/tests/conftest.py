"""Shared fixtures."""

from __future__ import annotations

from typing import Any

import databento
import pytest

from helpers import FakeHistorical


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory):
    """No key, no real data dir, and any attempt to build a real Historical client fails."""
    monkeypatch.delenv("DATABENTO_API_KEY", raising=False)
    monkeypatch.setenv("REPLAYLAB_DATA_DIR", str(tmp_path_factory.mktemp("data")))
    monkeypatch.delenv("REPLAYLAB_CORS_ORIGINS", raising=False)

    def _blocked(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("tests must never construct a real databento.Historical client")

    monkeypatch.setattr(databento, "Historical", _blocked)


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "data"


@pytest.fixture
def fake_client() -> FakeHistorical:
    return FakeHistorical()
