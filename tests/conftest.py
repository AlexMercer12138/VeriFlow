# -*- coding: utf-8 -*-
import shutil
import json
from pathlib import Path

import pytest


PROJECT_FIXTURE = Path(__file__).parent / "project_test"


@pytest.fixture()
def uart_project_dir(tmp_path: Path) -> Path:
    """Copy the UART fixture so tests can write outputs without touching source data."""
    project_dir = tmp_path / "uart_project"
    shutil.copytree(
        PROJECT_FIXTURE,
        project_dir,
        ignore=shutil.ignore_patterns("*.out", "*.vcd", "__pycache__"),
    )
    return project_dir


@pytest.fixture(scope="session")
def golden_uart() -> dict:
    return json.loads((Path(__file__).parent / "golden_uart.json").read_text(encoding="utf-8"))


@pytest.fixture()
def isolated_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Keep global VeriFlow config out of the developer machine and CI home."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    return home


@pytest.fixture()
def isolated_global_config(monkeypatch: pytest.MonkeyPatch, isolated_home: Path) -> Path:
    """Force ApplicationCoordinator to use a test-local global config file."""
    config_path = isolated_home / ".veriflow_config.json"
    import src.infrastructure.global_config_service as global_config_service

    monkeypatch.setattr(global_config_service, "GLOBAL_CONFIG_PATH", config_path)
    return config_path
