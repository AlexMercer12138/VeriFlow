# -*- coding: utf-8 -*-
from pathlib import Path

import pytest

from src.application.coordinator import ApplicationCoordinator
from src.domain.models.simulation import SimulationResult
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


def test_application_simulates_uart_fixture_with_pure_python_runner(
    uart_project_dir: Path,
    isolated_global_config: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSimRunner:
        last_compile_cmd = 'iverilog -o "uart_tb.out" "uart_rx.v" "uart_tx.v" "uart_tb.v"'
        last_run_cmd = 'vvp "uart_tb.out"'

        def __init__(self) -> None:
            self.files = []
            self.output = None
            self.cwd = None
            self.top_module = ""
            self.simulator = None

        def compile_and_run(
            self,
            files,
            output,
            simulator,
            cwd=None,
            top_module="",
        ) -> SimulationResult:
            self.files = list(files)
            self.output = output
            self.simulator = simulator
            self.cwd = cwd
            self.top_module = top_module
            return SimulationResult(success=True, exit_code=0, stdout="TEST PASS")

    app = ApplicationCoordinator()
    project = app.open_project(str(uart_project_dir / "uart_sim.json"))
    project.simulator = "iverilog"
    fake_runner = FakeSimRunner()
    monkeypatch.setattr(app, "_sim_runner", fake_runner)

    result = app.simulate(project)

    assert result.success
    assert result.exit_code == 0
    assert "TEST PASS" in result.stdout
    assert "[CMD] Compile:" in result.stdout
    assert "[CMD] Run:" in result.stdout
    assert [path.name for path in fake_runner.files] == [
        "uart_rx.v",
        "uart_tx.v",
        "uart_tb.v",
    ]
    assert fake_runner.output == uart_project_dir / "uart_tb.out"
    assert fake_runner.cwd == uart_project_dir
    assert fake_runner.top_module == "uart_tb"
    assert fake_runner.simulator.name == "iverilog"


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
