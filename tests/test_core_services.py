# -*- coding: utf-8 -*-
import json
from pathlib import Path

import pytest

from src.application.coordinator import ApplicationCoordinator
from src.domain.services.dep_analyzer_service import DependencyAnalyzerService
from src.domain.services.log_parser_service import LogParserService
from src.domain.services.port_parser_service import PortParserService
from src.domain.services.vcd_parser_service import VcdParserService
from src.infrastructure.config_service import ConfigService
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


def test_file_and_config_services_handle_project_files(tmp_path: Path) -> None:
    root = tmp_path / "rtl"
    nested = root / "nested"
    nested.mkdir(parents=True)

    fs = FileService()
    a_file = root / "a.v"
    b_file = nested / "b.sv"
    fs.write_text(str(a_file), "module a; endmodule\n")
    fs.write_text(str(b_file), "module b; endmodule\n")
    (root / "notes.txt").write_text("ignore me\n", encoding="utf-8")

    assert fs.read_text(str(a_file)) == "module a; endmodule\n"
    assert fs.file_exists(str(a_file))
    assert fs.get_filename(str(a_file)) == "a.v"
    assert fs.read_binary(str(a_file)).startswith(b"module a")
    assert [path.name for path in fs.list_files(str(root))] == ["a.v", "b.sv"]
    assert fs.find_file("b.sv", [str(root)]) == b_file

    config_file = tmp_path / "configs" / "project.json"
    ConfigService.save(config_file, {"project_name": "demo", "answer": 42})
    assert ConfigService.load(config_file)["answer"] == 42
    assert ConfigService.load_optional(tmp_path / "missing.json") is None


def test_application_coordinator_analyzes_project_dependencies(
    tmp_path: Path,
    isolated_global_config: Path,
) -> None:
    (tmp_path / "child.v").write_text("module child; endmodule\n", encoding="utf-8")
    (tmp_path / "top.v").write_text(
        "module top; child u_child(); endmodule\n",
        encoding="utf-8",
    )

    app = ApplicationCoordinator()
    project = app.create_project("demo", str(tmp_path))
    assert project.name == "demo"

    result = app.analyze_dependencies("top", str(tmp_path))
    missing = app.analyze_dependencies("missing", str(tmp_path))

    assert result.success
    assert [path.name for path in result.get_compile_order()] == ["child.v", "top.v"]
    assert not missing.success
    assert missing.missing_modules == ["missing"]


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


def test_dependency_analyzer_handles_generate_for_if_instances(tmp_path: Path) -> None:
    for module_name in (
        "for_child",
        "if_false_child",
        "if_true_child",
        "foo_generate_child",
    ):
        (tmp_path / f"{module_name}.v").write_text(
            f"module {module_name}; endmodule\n",
            encoding="utf-8",
        )
    (tmp_path / "top.v").write_text(
        """
module top;
genvar i;
foo_generate_child u_name_contains_generate();
generate
  for (i = 0; i < 4; i = i + 1) begin : g_for
    for_child #(.INDEX(i)) u_for();
  end

  if (USE_TRUE) begin : g_if_true
    if_true_child u_true();
  end else begin : g_if_false
    if_false_child u_false();
  end
endgenerate
endmodule
""",
        encoding="utf-8",
    )

    result = DependencyAnalyzerService(FileService()).resolve("top", [tmp_path])

    assert result.missing_modules == []
    assert result.dep_graph["top"] == [
        "foo_generate_child",
        "for_child",
        "if_false_child",
        "if_true_child",
    ]


def test_dependency_analyzer_keeps_instances_after_procedural_statements(tmp_path: Path) -> None:
    for module_name in (
        "child_after",
        "child_before",
    ):
        (tmp_path / f"{module_name}.v").write_text(
            f"module {module_name}; endmodule\n",
            encoding="utf-8",
        )
    (tmp_path / "top.v").write_text(
        """
module top;
  reg x;
  reg begin_count;
  reg end2;
  reg join_flag;

  child_before u_before();

  always @(*) x = begin_count | end2 | join_flag;
  always @(*) begin
    begin_count = 1'b0;
    if (x) begin
      end2 = 1'b1;
    end else begin
      join_flag = 1'b1;
    end
  end

  child_after u_after();
endmodule
""",
        encoding="utf-8",
    )

    result = DependencyAnalyzerService(FileService()).resolve("top", [tmp_path])

    assert result.missing_modules == []
    assert result.dep_graph["top"] == ["child_after", "child_before"]


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


def test_vcd_parser_extracts_signals_and_changes() -> None:
    data = VcdParserService().parse(
        """
$date today $end
$version test $end
$comment generated by test $end
$timescale 1ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 8 " data [7:0] $end
$upscope $end
$enddefinitions $end
#0
0!
b00000000 "
#5
1!
b10101010 "
#10
x!
bzzzzzzzz "
"""
    )

    assert data.timescale == "1ns"
    assert data.end_time == 10
    assert data.warnings == []
    assert [signal.reference for signal in data.signals] == ["clk", "data [7:0]"]
    clk = next(signal for signal in data.signals if signal.reference == "clk")
    bus = next(signal for signal in data.signals if signal.reference == "data [7:0]")
    assert clk.full_name == "top.clk"
    assert [change.value for change in clk.changes] == ["0", "1", "x"]
    assert bus.width == 8
    assert bus.changes[1].value == "10101010"
    assert bus.changes[2].value == "zzzzzzzz"


def test_vcd_parser_multiline_metadata_aliases_and_final_time() -> None:
    data = VcdParserService().parse(
        """
$date
  Tue May 19 10:01:22 2026
$end
$version
  Icarus Verilog
$end
$timescale
  1ns
$end
$scope module top $end
$var wire 1 ! a $end
$var wire 1 ! alias_a $end
$var wire 1 # idle $end
$upscope $end
$enddefinitions $end
$dumpvars
0!
$end
#10
1!
#100
"""
    )

    assert data.date == "Tue May 19 10:01:22 2026"
    assert data.version == "Icarus Verilog"
    assert data.timescale == "1ns"
    assert data.end_time == 100
    assert [signal.full_name for signal in data.signals] == [
        "top.a",
        "top.alias_a",
        "top.idle",
    ]
    for signal in data.signals[:2]:
        assert [change.value for change in signal.changes] == ["0", "1"]
    idle = data.signals[2]
    assert idle.changes[0].time == 0
    assert idle.changes[0].value == "x"


def test_vscode_waveform_provider_persists_layout_and_loads_core() -> None:
    provider = (
        Path(__file__).resolve().parents[1]
        / "veriflow-vscode"
        / "src"
        / "waveformEditorProvider.ts"
    ).read_text(encoding="utf-8")

    assert "WaveformLayoutStore" in provider
    assert "message.type === 'saveLayout'" in provider
    assert "WaveformWorkerClient" in provider
    assert "workspace.fs.readFile" not in provider
    assert "viewer-core.js" in provider


def test_python_waveform_viewer_builds_shared_html() -> None:
    from src.presentation.gui.widgets.waveform_html import _build_waveform_html

    data = VcdParserService().parse(
        """
$timescale 1ns $end
$scope module top $end
$var wire 1 ! clk $end
$upscope $end
$enddefinitions $end
#0
0!
#10
1!
"""
    )

    html = _build_waveform_html("top.vcd", data)

    assert "waveCanvas" in html
    assert "top.clk" in html
    assert "VeriflowWaveCore" in html
    assert 'id="cursorA"' in html
    assert 'id="cursorB"' in html
    assert 'id="changeSearchMode"' in html
    assert 'id="changeSearchValue"' in html
    assert 'id="cursorMeasureText"' in html
    assert "const vscode = acquireVsCodeApi();" not in html
    assert "window.postMessage" in html


def test_python_waveform_viewer_builds_empty_html() -> None:
    from src.presentation.gui.widgets.waveform_html import _build_empty_waveform_html

    html = _build_empty_waveform_html()

    assert "waveCanvas" in html
    assert "No waveform loaded" in html
    assert '"type": "empty"' in html
    assert "const vscode = acquireVsCodeApi();" not in html
    assert "qrc:///qtwebchannel/qwebchannel.js" in html
    assert "waveformTransport" in html


def test_python_waveform_bridge_orders_messages_and_cancels_requests() -> None:
    from src.presentation.gui.widgets.waveform_bridge import (
        WaveformBridge,
        WaveformIndexWorker,
    )

    class FakeCache:
        def __init__(self) -> None:
            self.released: list[Path] = []

        def get_or_build(self, source, **callbacks):
            callbacks["on_metadata"](
                {
                    "version": "test",
                    "date": "",
                    "timescale": "1ns",
                    "startTime": 0,
                    "endTime": 10,
                    "scopes": [],
                    "signals": [{"reference": "clk", "width": 1, "stream": 0}],
                    "warnings": [],
                }
            )
            callbacks["on_progress"](
                {"phase": "scan", "completed": 1, "total": 2, "percent": 50}
            )
            callbacks["on_progress"](
                {"phase": "complete", "completed": 2, "total": 2, "percent": 100}
            )
            return Path(f"index-{Path(source).stem}")

        def release(self, index_dir: Path) -> None:
            self.released.append(index_dir)

    class FakeReader:
        def __init__(self, index_dir: Path) -> None:
            self.index_dir = index_dir

        def query_window_for_reference(self, reference, start, end, **options):
            if options["cancelled"]():
                raise AssertionError("cancelled query should not reach the reader")
            return {
                "kind": "raw",
                "width": 1,
                "times": [0, 10],
                "values": "QA==",
                "valueStride": 1,
            }

        def values_at(self, references, timestamp):
            return {reference: "1" for reference in references}

        def search(self, reference, cursor_time, direction, mode, query, **options):
            return {
                "reference": reference,
                "time": 10,
                "value": "1",
                "fullValue": "1",
                "bitIndex": options.get("bit_index"),
            }

    cache = FakeCache()
    worker = WaveformIndexWorker(cache=cache, reader_factory=FakeReader)
    bridge = WaveformBridge(worker=worker, start_thread=False)
    messages: list[dict] = []
    bridge.message.connect(lambda payload: messages.append(json.loads(payload)))

    generation = bridge.open_file(Path("first.vcd"))
    assert generation == 1
    assert [message["type"] for message in messages[:3]] == [
        "waveformMetadata",
        "indexProgress",
        "indexProgress",
    ]
    assert messages[3]["type"] == "indexReady"
    assert all(message["generation"] == 1 for message in messages[:4])

    bridge.send(
        json.dumps(
            {
                "type": "windowRequest",
                "generation": 1,
                "requestId": "window-1",
                "references": ["clk"],
                "start": 0,
                "end": 10,
                "pixelWidth": 64,
            }
        )
    )
    assert messages[-1]["type"] == "windowData"
    assert messages[-1]["series"][0]["reference"] == "clk"

    bridge.send(
        json.dumps(
            {
                "type": "cancelRequest",
                "generation": 1,
                "requestId": "window-cancelled",
            }
        )
    )
    before_cancelled_query = len(messages)
    bridge.send(
        json.dumps(
            {
                "type": "windowRequest",
                "generation": 1,
                "requestId": "window-cancelled",
                "references": ["clk"],
                "start": 0,
                "end": 10,
                "pixelWidth": 64,
            }
        )
    )
    assert not any(
        message.get("type") == "windowData"
        for message in messages[before_cancelled_query:]
    )

    assert bridge.open_file(Path("second.vcd")) == 2
    bridge.send("[]")
    assert messages[-1]["type"] == "bridgeError"
    bridge.close()
    assert cache.released[-1] == Path("index-second")


def test_python_waveform_viewer_prefers_bundled_assets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.presentation.gui.widgets import waveform_html

    bundled = tmp_path / "veriflow-vscode" / "media" / "waveform"
    bundled.mkdir(parents=True)
    monkeypatch.setattr(waveform_html.sys, "_MEIPASS", str(tmp_path), raising=False)

    assert waveform_html._waveform_assets_dir() == bundled


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
    assert TemplateEngine.render("hello {name}", {"name": "world"}) == "hello world"
    assert TemplateEngine.render_run('vvp "{output}"', "build/sim.out") == (
        'vvp "build/sim.out"'
    )
    assert TemplateEngine.render_wave('gtkwave "{wave_file}"', "dump.vcd") == (
        'gtkwave "dump.vcd"'
    )
