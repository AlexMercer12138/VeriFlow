# -*- coding: utf-8 -*-
import shutil
from pathlib import Path

import pytest

from src.application.coordinator import ApplicationCoordinator
from src.domain.services.sim_runner_service import SimRunnerService
from src.presentation.cli import main as cli_main


def test_cli_analyze_reports_uart_compile_order(
    uart_project_dir: Path,
    isolated_global_config: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        "sys.argv",
        ["veriflow", "analyze", "-p", str(uart_project_dir / "uart_sim.json")],
    )

    assert cli_main() == 0
    out = capsys.readouterr().out
    assert "Top module: uart_tb" in out
    assert "uart_rx.v" in out
    assert "uart_tx.v" in out
    assert "uart_tb.v" in out
    assert "Analysis: OK" in out


def test_application_simulates_uart_fixture_when_iverilog_is_available(
    uart_project_dir: Path,
    isolated_global_config: Path,
) -> None:
    if not shutil.which("iverilog") or not shutil.which("vvp"):
        pytest.skip("iverilog/vvp not available")

    app = ApplicationCoordinator()
    project = app.open_project(str(uart_project_dir / "uart_sim.json"))

    result = app.simulate(project)

    assert result.success, result.stderr
    assert result.exit_code == 0
    assert (uart_project_dir / "uart_tb.out").exists()
    assert (uart_project_dir / "uart_tb.vcd").exists()
    assert "TEST PASS" in result.stdout
    assert "[CMD] Compile:" in result.stdout
    assert "[CMD] Run:" in result.stdout


def test_simulation_runner_keeps_external_files_absolute(
    uart_project_dir: Path,
    tmp_path: Path,
) -> None:
    external = tmp_path / "external_lib" / "helper.v"
    external.parent.mkdir()
    external.write_text("module helper; endmodule\n", encoding="utf-8")

    resolved = SimRunnerService()._resolve_file_paths(
        [uart_project_dir / "uart_tb.v", external],
        uart_project_dir,
    )

    assert resolved[0] == "uart_tb.v"
    assert Path(resolved[1]) == external
