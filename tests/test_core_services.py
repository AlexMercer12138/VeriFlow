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
    golden_uart: dict,
) -> None:
    result = DependencyAnalyzerService(FileService()).resolve(
        golden_uart["top_module"],
        [uart_project_dir],
    )

    assert result.success
    assert result.missing_modules == []
    assert result.dep_graph == golden_uart["dependency_graph"]
    assert [p.name for p in result.files] == golden_uart["discovery_order"]
    assert [p.name for p in result.get_compile_order()] == golden_uart["compile_order"]


def test_missing_top_module_is_reported(uart_project_dir: Path) -> None:
    result = DependencyAnalyzerService(FileService()).resolve(
        "missing_top",
        [uart_project_dir],
    )

    assert not result.success
    assert result.missing_modules == ["missing_top"]
    assert result.files == []


def test_dependency_analyzer_respects_conditional_compilation(tmp_path: Path) -> None:
    for module_name in ("active_child", "inactive_child", "fallback_child"):
        (tmp_path / f"{module_name}.v").write_text(
            f"module {module_name}; endmodule\n",
            encoding="utf-8",
        )
    (tmp_path / "top.v").write_text(
        """
module top;
`define USE_ACTIVE
`ifdef USE_ACTIVE
    active_child u_active();
`else
    inactive_child u_inactive();
`endif
`ifndef SKIP_FALLBACK
    fallback_child u_fallback();
`endif
endmodule
""",
        encoding="utf-8",
    )

    result = DependencyAnalyzerService(FileService()).resolve("top", [tmp_path])

    assert result.missing_modules == []
    assert result.dep_graph["top"] == ["active_child", "fallback_child"]


def test_port_parser_extracts_uart_parameters_and_ports(
    uart_project_dir: Path,
    golden_uart: dict,
) -> None:
    info = PortParserService(FileService()).parse_file(
        str(uart_project_dir / "uart_tx.v")
    )

    assert info.name == "uart_tx"
    assert [(p.name, p.value) for p in info.parameters] == [
        tuple(item) for item in golden_uart["uart_tx"]["parameters"]
    ]
    assert [(p.direction, p.name, p.width) for p in info.ports] == [
        tuple(item) for item in golden_uart["uart_tx"]["ports"]
    ]


def test_port_parser_respects_conditional_compilation() -> None:
    content = """
`define USE_WIDE
module cond_ports (
    input clk,
`ifdef USE_WIDE
    input [15:0] data_i,
`else
    input [7:0] data_i,
    input unused_else_i,
`endif
`ifndef DISABLE_READY
    output ready_o,
`endif
    output done_o
);
endmodule
"""

    info = PortParserService(FileService()).parse_content(content, "cond_ports.v")

    assert [(p.direction, p.name, p.width) for p in info.ports] == [
        ("input", "clk", None),
        ("input", "data_i", "[15:0]"),
        ("output", "ready_o", None),
        ("output", "done_o", None),
    ]


def test_port_parser_supports_systemverilog_and_non_ansi_ports() -> None:
    sv_content = """
module sv_mod #(
    parameter int WIDTH = $clog2(DEPTH),
    parameter string MODE = "fast,still-one-value"
) (
    input logic signed [WIDTH-1:0] a_i, b_i,
    output var logic ready_o,
    inout wire pad_io
);
endmodule
"""
    non_ansi_content = """
module legacy_mod (clk, rst_n, data_o);
    input wire clk;
    input rst_n;
    output reg [3:0] data_o;
endmodule
"""

    parser = PortParserService(FileService())
    sv_info = parser.parse_content(sv_content, "sv_mod.sv")
    legacy_info = parser.parse_content(non_ansi_content, "legacy_mod.v")

    assert [(p.name, p.value) for p in sv_info.parameters] == [
        ("WIDTH", "$clog2(DEPTH)"),
        ("MODE", '"fast,still-one-value"'),
    ]
    assert [(p.direction, p.name, p.width) for p in sv_info.ports] == [
        ("input", "a_i", "[WIDTH-1:0]"),
        ("input", "b_i", "[WIDTH-1:0]"),
        ("output", "ready_o", None),
        ("inout", "pad_io", None),
    ]
    assert [(p.direction, p.name, p.width) for p in legacy_info.ports] == [
        ("input", "clk", None),
        ("input", "rst_n", None),
        ("output", "data_o", "[3:0]"),
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


def test_log_parser_and_template_rendering(golden_uart: dict) -> None:
    entries = LogParserService().parse(golden_uart["log_sample"]["text"])

    assert [e.level for e in entries] == golden_uart["log_sample"]["levels"]
    assert entries[0].file_ref == golden_uart["log_sample"]["first_file"]
    assert entries[0].line_no == golden_uart["log_sample"]["first_line"]

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
