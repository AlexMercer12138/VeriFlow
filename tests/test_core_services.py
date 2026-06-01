# -*- coding: utf-8 -*-
from pathlib import Path

from src.application.coordinator import ApplicationCoordinator
from src.domain.services.dep_analyzer_service import DependencyAnalyzerService
from src.domain.services.log_parser_service import LogParserService
from src.domain.services.port_parser_service import PortParserService
from src.infrastructure.file_service import FileService
from src.infrastructure.template_engine import TemplateEngine


def test_uart_dependency_resolution_uses_fixture_compile_order(
    uart_project_dir: Path,
) -> None:
    result = DependencyAnalyzerService(FileService()).resolve(
        "uart_tb",
        [uart_project_dir],
    )

    assert result.success
    assert result.missing_modules == []
    assert result.dep_graph == {
        "uart_tb": ["uart_rx", "uart_tx"],
        "uart_rx": [],
        "uart_tx": [],
    }
    assert [p.name for p in result.files] == [
        "uart_tb.v",
        "uart_rx.v",
        "uart_tx.v",
    ]
    assert [p.name for p in result.get_compile_order()] == [
        "uart_rx.v",
        "uart_tx.v",
        "uart_tb.v",
    ]


def test_missing_top_module_is_reported(uart_project_dir: Path) -> None:
    result = DependencyAnalyzerService(FileService()).resolve(
        "missing_top",
        [uart_project_dir],
    )

    assert not result.success
    assert result.missing_modules == ["missing_top"]
    assert result.files == []


def test_port_parser_extracts_uart_parameters_and_ports(
    uart_project_dir: Path,
) -> None:
    info = PortParserService(FileService()).parse_file(
        str(uart_project_dir / "uart_tx.v")
    )

    assert info.name == "uart_tx"
    assert [p.name for p in info.parameters] == [
        "SYS_CLK_FREQ",
        "BAUD_RATE",
        "STOP_BIT_CNT",
        "PARITY_TYPE",
    ]
    assert [(p.direction, p.name, p.width) for p in info.ports] == [
        ("input", "clk", None),
        ("input", "rst_n", None),
        ("input", "tx_valid", None),
        ("output", "tx_ready", None),
        ("input", "tx_data", "[7:0]"),
        ("output", "uart_tx", None),
    ]


def test_module_scan_and_duplicate_details(
    uart_project_dir: Path,
    tmp_path: Path,
    isolated_global_config: Path,
) -> None:
    duplicate_dir = tmp_path / "lib"
    duplicate_dir.mkdir()
    (duplicate_dir / "uart_rx_dup.v").write_text(
        "module uart_rx(input clk); endmodule\n",
        encoding="utf-8",
    )

    app = ApplicationCoordinator()
    project = app.create_project("uart", str(uart_project_dir))
    project.lib_dirs = [duplicate_dir]

    modules = app.scan_all_modules(project)
    assert set(["uart_tb", "uart_rx", "uart_tx"]).issubset(modules)

    categorized = app.scan_modules_categorized(project)
    assert set(categorized["Project Root"]) == {"uart_rx", "uart_tb", "uart_tx"}

    duplicates = app.get_duplicate_modules_with_lines(project)
    assert "uart_rx" in duplicates
    assert any(
        entry["file"].name == "uart_rx.v" and entry["line"] > 1
        for entry in duplicates["uart_rx"]
    )
    assert any(
        entry["file"].name == "uart_rx_dup.v" and entry["line"] == 1
        for entry in duplicates["uart_rx"]
    )


def test_log_parser_and_template_rendering() -> None:
    entries = LogParserService().parse(
        "uart_tx.v:12: error: syntax error\n"
        "uart_rx.v:20: warning: unused signal\n"
        "TEST PASS\n"
    )

    assert [e.level for e in entries] == ["ERROR", "WARNING", "INFO"]
    assert entries[0].file_ref == "uart_tx.v"
    assert entries[0].line_no == 12

    cmd = TemplateEngine.render_compile(
        'iverilog -o "{output}" {files}',
        "uart_tb.out",
        ["uart_rx.v", "uart_tx.v", "uart_tb.v"],
        top_module="uart_tb",
    )
    assert cmd == (
        'iverilog -o "uart_tb.out" '
        '"uart_rx.v" "uart_tx.v" "uart_tb.v"'
    )
