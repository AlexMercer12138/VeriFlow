import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest


VLIB_PATH = Path(__file__).resolve().parents[1] / "scripts" / "vlib.py"


@pytest.fixture
def vlib(tmp_path, monkeypatch):
    if not VLIB_PATH.exists():
        return None

    spec = importlib.util.spec_from_file_location("vlib_under_test", VLIB_PATH)
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    monkeypatch.setattr(module, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(module, "INDEX_FILE", tmp_path / ".verilog_module_index.json")
    return module


def write_source(repository, relative_path, text):
    path = repository / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_find_modules_parses_multiline_qualified_declarations(vlib):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    source = """
module automatic
  alpha;
endmodule

module
  static
  beta;
endmodule
"""

    assert vlib.find_modules(source) == ["alpha", "beta"]


def test_index_scans_verilog_sources_and_writes_json(vlib, tmp_path):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    pair_source_bytes = b"""
// module ignored_line_comment;
module automatic alpha;
  string marker = "/* quoted text is not a comment */";
endmodule

/* module ignored_block_comment; */
module static beta;
endmodule
"""
    pair_path = tmp_path / "rtl" / "pair.v"
    pair_path.parent.mkdir(parents=True)
    pair_path.write_bytes(pair_source_bytes)
    write_source(tmp_path, "ip/gamma.sv", "module gamma;\nendmodule\n")
    write_source(tmp_path, "notes.txt", "module ignored_text_file;\nendmodule\n")

    assert vlib.main(["index"]) == 0

    index = json.loads(vlib.INDEX_FILE.read_text(encoding="utf-8"))
    assert index["schema_version"] == 1
    assert index["repository_root"] == tmp_path.resolve().as_posix()
    assert index["modules"] == {
        "alpha": "rtl/pair.v",
        "beta": "rtl/pair.v",
        "gamma": "ip/gamma.sv",
    }
    assert set(index["files"]) == {"rtl/pair.v", "ip/gamma.sv"}
    assert index["files"]["rtl/pair.v"]["modules"] == ["alpha", "beta"]
    assert index["files"]["rtl/pair.v"]["sha256"] == hashlib.sha256(
        pair_source_bytes
    ).hexdigest()


def test_duplicate_module_leaves_existing_index_unchanged(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(tmp_path, "rtl/original.v", "module shared;\nendmodule\n")
    assert vlib.main(["index"]) == 0
    old_index = vlib.INDEX_FILE.read_bytes()
    capsys.readouterr()

    write_source(tmp_path, "ip/duplicate.sv", "module shared;\nendmodule\n")

    assert vlib.main(["index"]) == 1
    assert vlib.INDEX_FILE.read_bytes() == old_index
    stderr = capsys.readouterr().err
    assert "Duplicate module 'shared'" in stderr
    assert "rtl/original.v" in stderr
    assert "ip/duplicate.sv" in stderr


def test_duplicate_modules_report_all_sorted_conflicting_paths(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/original.v",
        "module paired;\nendmodule\nmodule shared;\nendmodule\n",
    )
    assert vlib.main(["index"]) == 0
    old_index = vlib.INDEX_FILE.read_bytes()
    capsys.readouterr()

    write_source(
        tmp_path,
        "ip/duplicate.sv",
        "module shared;\nendmodule\nmodule paired;\nendmodule\n",
    )
    write_source(tmp_path, "vendor/third.v", "module shared;\nendmodule\n")

    assert vlib.main(["index"]) == 1
    assert vlib.INDEX_FILE.read_bytes() == old_index
    assert capsys.readouterr().err == (
        "Error: Duplicate modules found:\n"
        "Duplicate module 'paired': ip/duplicate.sv, rtl/original.v\n"
        "Duplicate module 'shared': ip/duplicate.sv, rtl/original.v, "
        "vendor/third.v\n"
    )


def test_build_index_uses_one_snapshot_for_modules_and_hash(
    vlib, tmp_path, monkeypatch
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    original_bytes = b"module original;\nendmodule\n"
    changed_bytes = b"module changed;\nendmodule\n"
    source_path = tmp_path / "rtl" / "changing.v"
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(original_bytes)

    original_open = Path.open
    source_open_count = 0

    def open_with_change_before_second_read(path, *args, **kwargs):
        nonlocal source_open_count
        if path == source_path:
            source_open_count += 1
            if source_open_count == 2:
                with original_open(source_path, "wb") as changed_source:
                    changed_source.write(changed_bytes)
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", open_with_change_before_second_read)

    index = vlib.build_index(tmp_path)

    assert index["modules"] == {"original": "rtl/changing.v"}
    assert index["files"]["rtl/changing.v"]["sha256"] == hashlib.sha256(
        original_bytes
    ).hexdigest()
    assert source_open_count == 1


def test_show_selected_module_parameters_and_ansi_ports(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/multiple.sv",
        """
module ignored(input logic ignored_i);
endmodule

module selected #(
  parameter int WIDTH = $clog2(DEPTH),
  parameter string MODE = "fast,still-one-value"
) (
  input logic signed [WIDTH-1:0] a_i, b_i,
  output var logic ready_o,
  inout wire pad_io
);
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["show", "selected"]) == 0

    stdout = capsys.readouterr().out
    assert "Parameters:" in stdout
    assert 'WIDTH | int | $clog2(DEPTH)' in stdout
    assert 'MODE | string | "fast,still-one-value"' in stdout
    assert "Ports:" in stdout
    assert "input | [WIDTH-1:0] | a_i" in stdout
    assert "input | [WIDTH-1:0] | b_i" in stdout
    assert "output | - | ready_o" in stdout
    assert "inout | - | pad_io" in stdout
    assert "ignored_i" not in stdout


def test_show_non_ansi_module_ports(vlib, tmp_path, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/legacy.v",
        """module legacy(clk, rst_n, data_o);
input wire clk;
input rst_n;
output reg [3:0] data_o;
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["show", "legacy"]) == 0

    stdout = capsys.readouterr().out
    assert "input | - | clk" in stdout
    assert "input | - | rst_n" in stdout
    assert "output | [3:0] | data_o" in stdout


def test_show_ignores_endmodule_keyword_inside_string(vlib, tmp_path, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/string_marker.sv",
        """module string_marker(value_i);
string marker = "endmodule";
input logic value_i;
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["show", "string_marker"]) == 0

    assert "input | - | value_i" in capsys.readouterr().out


def test_show_reports_non_utf8_index_as_an_error(vlib, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    vlib.INDEX_FILE.write_bytes(b"\xff")

    assert vlib.main(["show", "missing"]) == 1

    assert "Invalid module index JSON" in capsys.readouterr().err


def test_show_rejects_boolean_schema_version(vlib, tmp_path, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    vlib.INDEX_FILE.write_text(
        json.dumps(
            {
                "schema_version": True,
                "repository_root": tmp_path.resolve().as_posix(),
                "files": {},
                "modules": {},
            }
        ),
        encoding="utf-8",
    )

    assert vlib.main(["show", "missing"]) == 1

    assert "Unsupported module index schema" in capsys.readouterr().err


def test_show_parses_endmodule_at_end_of_file(vlib, tmp_path, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/eof.sv",
        "module m(input wire value_i); endmodule",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["show", "m"]) == 0

    assert "input | - | value_i" in capsys.readouterr().out


def test_explicit_untyped_parameter_resets_inherited_type(vlib):
    assert vlib is not None, "scripts/vlib.py is not implemented"

    parameters = vlib.parse_parameters(
        "parameter int A=1, B=2, parameter C=3, localparam D=4"
    )

    assert parameters == (
        vlib.Parameter("A", "int", "1"),
        vlib.Parameter("B", "int", "2"),
        vlib.Parameter("C", "integer", "3"),
        vlib.Parameter("D", "integer", "4"),
    )


def test_deps_reports_transitive_dependencies_missing_modules_and_cycles(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/top.sv",
        """module top(input logic value);
generate
  if (1) begin : generated_child
    child u_child();
  end
endgenerate

always @(*) begin
  helper(value);
end

missing_ip u_missing();
endmodule
""",
    )
    write_source(
        tmp_path,
        "rtl/child.v",
        """module child;
leaf #(
  .WIDTH(8)
) u_leaf();
endmodule
""",
    )
    write_source(
        tmp_path,
        "rtl/leaf.v",
        """module leaf;
child u_cycle();
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 1

    stdout = capsys.readouterr().out
    assert stdout.count("  child -> rtl/child.v\n") == 1
    assert stdout.count("  leaf -> rtl/leaf.v\n") == 1
    assert "  missing_ip -> MISSING\n" in stdout
    assert "top ->" not in stdout
    assert "helper ->" not in stdout


def test_list_prints_modules_in_case_sensitive_lexical_order(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/modules.v",
        """module alpha;
endmodule
module Zoo;
endmodule
module Beta;
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["list"]) == 0

    assert capsys.readouterr().out.splitlines() == ["Beta", "Zoo", "alpha"]


def test_dependencies_stop_masking_after_dpi_function_declaration(vlib):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    block = vlib.parse_module_blocks(
        """module top;
import "DPI-C" function int helper(input int value);
child u_child();
endmodule
"""
    )[0]

    assert vlib.extract_dependencies(block) == ["child"]


def test_deps_preserves_instances_after_declaration_only_class_prototypes(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/top.sv",
        """module top;
virtual class abstract_worker;
  extern function int calculate(input int value);
  pure virtual task run(input int value);
endclass
child u_child();
endmodule
""",
    )
    write_source(
        tmp_path,
        "rtl/child.v",
        """module child;
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 0

    assert capsys.readouterr().out == (
        "Dependencies for top:\n"
        "  child -> rtl/child.v\n"
    )


def test_deps_unions_partial_instances_from_conditional_branches(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/top.sv",
        """module top;
`ifdef USE_A
  child_a
`else
  child_b
`endif
  u_child();
endmodule
""",
    )
    write_source(
        tmp_path,
        "rtl/child_a.v",
        """module child_a;
endmodule
""",
    )
    write_source(
        tmp_path,
        "rtl/child_b.v",
        """module child_b;
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 0

    assert capsys.readouterr().out == (
        "Dependencies for top:\n"
        "  child_a -> rtl/child_a.v\n"
        "  child_b -> rtl/child_b.v\n"
    )


def test_deps_prunes_incompatible_repeated_macro_branches(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/top.sv",
        """module top;
  typedef logic some_type;
`ifdef USE_CHILD
  child
`else
  some_type
`endif
`ifdef USE_CHILD
  u();
`else
  value;
`endif
endmodule
""",
    )
    write_source(
        tmp_path,
        "rtl/child.v",
        """module child;
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 0

    assert capsys.readouterr().out == (
        "Dependencies for top:\n"
        "  child -> rtl/child.v\n"
    )


def test_deps_streams_many_independent_conditional_statements(
    vlib, tmp_path, capsys, monkeypatch
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    assert not hasattr(vlib, "expand_conditional_variants"), (
        "dependency analysis must not materialize whole-body variants"
    )
    original_deduplicate = vlib._deduplicate_dependency_states
    maximum_state_count = 0

    def track_state_count(states):
        nonlocal maximum_state_count
        maximum_state_count = max(maximum_state_count, len(states))
        return original_deduplicate(states)

    monkeypatch.setattr(
        vlib, "_deduplicate_dependency_states", track_state_count
    )

    source_lines = ["module top;"]
    for index in range(18):
        source_lines.extend(
            [
                "`ifdef OPTION_{}".format(index),
                "logic value_{};".format(index),
                "`else",
                "wire value_{};".format(index),
                "`endif",
            ]
        )
    source_lines.extend(["child u_child();", "endmodule", ""])
    write_source(tmp_path, "rtl/top.sv", "\n".join(source_lines))
    write_source(
        tmp_path,
        "rtl/child.v",
        """module child;
endmodule
""",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 0

    assert capsys.readouterr().out == (
        "Dependencies for top:\n"
        "  child -> rtl/child.v\n"
    )
    assert maximum_state_count <= 2


def test_deps_correlates_repeated_ifndef_elsif_chains(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/top.sv",
        """module top;
typedef logic some_type;
`ifndef USE_TYPE
  child
`elsif USE_OTHER
  other_child
`else
  some_type
`endif
`ifndef USE_TYPE
  u_child();
`elsif USE_OTHER
  u_other();
`else
  value;
`endif
endmodule
""",
    )
    write_source(tmp_path, "rtl/child.v", "module child; endmodule\n")
    write_source(
        tmp_path,
        "rtl/other_child.v",
        "module other_child; endmodule\n",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 0

    assert capsys.readouterr().out == (
        "Dependencies for top:\n"
        "  child -> rtl/child.v\n"
        "  other_child -> rtl/other_child.v\n"
    )


def test_deps_discards_complete_conditional_procedural_regions(
    vlib, tmp_path, capsys, monkeypatch
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    original_deduplicate = vlib._deduplicate_dependency_states
    maximum_state_count = 0

    def track_state_count(states):
        nonlocal maximum_state_count
        maximum_state_count = max(maximum_state_count, len(states))
        return original_deduplicate(states)

    monkeypatch.setattr(
        vlib, "_deduplicate_dependency_states", track_state_count
    )
    source_lines = ["module top;"]
    for index in range(12):
        source_lines.extend(
            [
                "`ifdef PROCEDURAL_{}".format(index),
                "always @* begin",
                "  helper_{}(value);".format(index),
                "end",
                "`else",
                "always @* begin",
                "  alternate_{}(value);".format(index),
                "end",
                "`endif",
            ]
        )
    source_lines.extend(["endmodule", ""])
    write_source(tmp_path, "rtl/top.sv", "\n".join(source_lines))
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 0

    assert capsys.readouterr().out == (
        "Dependencies for top:\n"
        "  (none)\n"
    )
    assert maximum_state_count <= 2


def test_deps_discards_labeled_conditional_subprogram_regions(
    vlib, tmp_path, capsys, monkeypatch
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    original_deduplicate = vlib._deduplicate_dependency_states
    maximum_state_count = 0

    def track_state_count(states):
        nonlocal maximum_state_count
        maximum_state_count = max(maximum_state_count, len(states))
        return original_deduplicate(states)

    monkeypatch.setattr(
        vlib, "_deduplicate_dependency_states", track_state_count
    )
    source_lines = ["module top;"]
    for index in range(12):
        source_lines.extend(
            [
                "`ifdef LABELED_{}".format(index),
                "function automatic int function_{};".format(index),
                "  function_{} = {};".format(index, index),
                "endfunction : function_{}".format(index),
                "`else",
                "task automatic \\task_{} ;".format(index),
                "endtask : \\task_{}".format(index),
                "`endif",
            ]
        )
    source_lines.extend(["endmodule", ""])
    write_source(tmp_path, "rtl/top.sv", "\n".join(source_lines))
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert vlib.main(["deps", "top"]) == 0

    assert capsys.readouterr().out == (
        "Dependencies for top:\n"
        "  (none)\n"
    )
    assert maximum_state_count <= 2
