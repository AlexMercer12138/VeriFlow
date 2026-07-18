import hashlib
import importlib.util
import json
import os
import subprocess
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


def create_directory_alias(alias, target):
    try:
        alias.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        if os.name != "nt":
            raise

    command_processor = os.environ.get("COMSPEC", "cmd.exe")
    completed = subprocess.run(
        [
            command_processor,
            "/d",
            "/c",
            "mklink",
            "/J",
            str(alias),
            str(target),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if completed.returncode != 0:
        pytest.skip("directory aliases are unavailable")


def remove_directory_alias(alias):
    if alias.is_symlink():
        alias.unlink()
    elif alias.exists():
        os.rmdir(str(alias))


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


def test_repository_snapshot_hashes_sources_once_in_sorted_path_order(
    vlib, tmp_path, monkeypatch
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    first_bytes = b"module first;\r\nendmodule\r\n"
    second_bytes = b"module second;\nendmodule\n"
    first_path = tmp_path / "a" / "first.v"
    second_path = tmp_path / "z" / "second.sv"
    first_path.parent.mkdir(parents=True)
    second_path.parent.mkdir(parents=True)
    first_path.write_bytes(first_bytes)
    second_path.write_bytes(second_bytes)
    open_counts = {first_path: 0, second_path: 0}
    original_open = Path.open

    def count_source_opens(path, *args, **kwargs):
        if path in open_counts:
            open_counts[path] += 1
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", count_source_opens)

    snapshot = vlib.repository_snapshot(tmp_path)

    assert list(snapshot) == ["a/first.v", "z/second.sv"]
    assert snapshot == {
        "a/first.v": hashlib.sha256(first_bytes).hexdigest(),
        "z/second.sv": hashlib.sha256(second_bytes).hexdigest(),
    }
    assert open_counts == {first_path: 1, second_path: 1}


def test_status_reports_current_index_without_mutating_it(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(tmp_path, "top.v", "module top;\nendmodule\n")
    assert vlib.main(["index"]) == 0
    capsys.readouterr()
    index_bytes = vlib.INDEX_FILE.read_bytes()
    source_bytes = (tmp_path / "top.v").read_bytes()

    assert vlib.main(["status"]) == 0

    assert capsys.readouterr().out == (
        "Repository: {}\n"
        "Modules: 1\n"
        "Source files: 1\n"
        "Index: CURRENT\n".format(tmp_path.resolve())
    )
    assert vlib.INDEX_FILE.read_bytes() == index_bytes
    assert (tmp_path / "top.v").read_bytes() == source_bytes


@pytest.mark.parametrize(
    ("change", "expected_line"),
    [
        ("added", "Added: new.sv"),
        ("modified", "Modified: top.v"),
        ("deleted", "Deleted: top.v"),
    ],
)
def test_status_reports_stale_source_changes(
    vlib, tmp_path, capsys, change, expected_line
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    top_path = tmp_path / "top.v"
    top_path.write_bytes(b"module top;\nendmodule\n")
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    if change == "added":
        (tmp_path / "new.sv").write_bytes(b"module new_module;\nendmodule\n")
    elif change == "modified":
        top_path.write_bytes(b"module top;\n  wire changed;\nendmodule\n")
    else:
        top_path.unlink()

    assert vlib.main(["status"]) == 1

    assert capsys.readouterr().out == (
        "Repository: {}\n"
        "Modules: 1\n"
        "Source files: 1\n"
        "Index: STALE\n"
        "{}\n".format(tmp_path.resolve(), expected_line)
    )


def test_status_sorts_stale_paths_by_category(vlib, tmp_path, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(tmp_path, "z_delete.v", "module z_delete; endmodule\n")
    write_source(tmp_path, "a_delete.v", "module a_delete; endmodule\n")
    write_source(tmp_path, "z_modify.v", "module z_modify; endmodule\n")
    write_source(tmp_path, "a_modify.v", "module a_modify; endmodule\n")
    assert vlib.main(["index"]) == 0
    capsys.readouterr()
    (tmp_path / "z_delete.v").unlink()
    (tmp_path / "a_delete.v").unlink()
    write_source(
        tmp_path, "z_modify.v", "module z_modify; wire changed; endmodule\n"
    )
    write_source(
        tmp_path, "a_modify.v", "module a_modify; wire changed; endmodule\n"
    )
    write_source(tmp_path, "z_add.sv", "module z_add; endmodule\n")
    write_source(tmp_path, "a_add.sv", "module a_add; endmodule\n")

    assert vlib.main(["status"]) == 1

    assert capsys.readouterr().out.splitlines()[-7:] == [
        "Index: STALE",
        "Added: a_add.sv",
        "Added: z_add.sv",
        "Modified: a_modify.v",
        "Modified: z_modify.v",
        "Deleted: a_delete.v",
        "Deleted: z_delete.v",
    ]


def test_status_reports_missing_index(vlib, tmp_path, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"

    assert vlib.main(["status"]) == 1

    assert capsys.readouterr().out == (
        "Repository: {}\nIndex: MISSING\n".format(tmp_path.resolve())
    )


def test_status_reports_incompatible_schema(vlib, tmp_path, capsys):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    vlib.INDEX_FILE.write_text(
        json.dumps(
            {
                "schema_version": 99,
                "repository_root": tmp_path.resolve().as_posix(),
                "files": {},
                "modules": {},
            }
        ),
        encoding="utf-8",
    )

    assert vlib.main(["status"]) == 1

    stdout = capsys.readouterr().out
    assert "Index: INCOMPATIBLE" in stdout
    assert "Unsupported module index schema 99; expected 1." in stdout


@pytest.mark.parametrize(
    "index_bytes",
    [
        b"{not-json",
        json.dumps(
            {
                "schema_version": 1,
                "repository_root": ".",
                "files": {"top.v": {"modules": ["top"]}},
                "modules": {"top": "top.v"},
            }
        ).encode("utf-8"),
    ],
)
def test_status_reports_malformed_index_as_incompatible(
    vlib, capsys, index_bytes
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    vlib.INDEX_FILE.write_bytes(index_bytes)

    assert vlib.main(["status"]) == 1

    assert "Index: INCOMPATIBLE" in capsys.readouterr().out


@pytest.mark.parametrize("repository_kind", ["missing", "file"])
def test_status_reports_unavailable_repository(
    vlib, tmp_path, capsys, monkeypatch, repository_kind
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    repository = tmp_path / repository_kind
    if repository_kind == "file":
        repository.write_text("not a repository", encoding="utf-8")
    monkeypatch.setattr(vlib, "REPOSITORY_ROOT", repository)

    assert vlib.main(["status"]) == 1

    stdout = capsys.readouterr().out
    assert stdout.startswith("Repository: INVALID (")
    assert "Index: UNAVAILABLE\n" in stdout
    assert "Traceback" not in stdout


def test_status_reports_index_for_a_different_repository(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    stored_root = (tmp_path / "other-repository").resolve().as_posix()
    vlib.INDEX_FILE.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "repository_root": stored_root,
                "files": {},
                "modules": {},
            }
        ),
        encoding="utf-8",
    )

    assert vlib.main(["status"]) == 1

    assert capsys.readouterr().out == (
        "Repository: {}\n"
        "Index: WRONG_REPOSITORY ({})\n".format(
            tmp_path.resolve(), stored_root
        )
    )


def test_parser_documents_status_and_preserves_invalid_argument_exit_two(
    vlib, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    help_text = vlib.build_parser().format_help()
    for command in ("index", "show", "deps", "copy", "list", "status"):
        assert command in help_text

    with pytest.raises(SystemExit) as error:
        vlib.main(["copy", "top"])

    assert error.value.code == 2
    assert "the following arguments are required: destination" in (
        capsys.readouterr().err
    )


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


def test_copy_without_deps_copies_only_top_source_byte_for_byte(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    top_source = b"module top;\r\n  child u_child();\r\nendmodule\r\n"
    top_path = tmp_path / "rtl" / "top.v"
    top_path.parent.mkdir(parents=True)
    top_path.write_bytes(top_source)
    write_source(
        tmp_path,
        "ip/child.v",
        "module child;\nendmodule\n",
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()
    destination = tmp_path / "copied"

    assert vlib.main(["copy", "top", str(destination)]) == 0

    assert (destination / "rtl" / "top.v").read_bytes() == top_source
    assert not (destination / "ip" / "child.v").exists()
    captured = capsys.readouterr()
    assert captured.out == "Copied: rtl/top.v\n"
    assert captured.err == ""


def test_copy_with_deps_copies_modules_and_recursive_includes_before_errors(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    sources = {
        "rtl/top.v": (
            '`include "include/defs.vh"\n'
            "module top;\n"
            "  child u_child();\n"
            "  missing u_missing();\n"
            "endmodule\n"
        ),
        "ip/child.v": "module child;\nendmodule\n",
        "include/defs.vh": '`include "nested/more.svh"\n`define WIDTH 8\n',
        "include/nested/more.svh": "`define RESET_VALUE 0\n",
    }
    for relative_path, source in sources.items():
        write_source(tmp_path, relative_path, source)
    assert vlib.main(["index"]) == 0
    capsys.readouterr()
    destination = tmp_path / "copied"

    assert (
        vlib.main(["copy", "top", str(destination), "--with-deps"])
        == 1
    )

    for relative_path, source in sources.items():
        copied_source = (destination / relative_path).read_text(
            encoding="utf-8"
        )
        assert copied_source == source
    captured = capsys.readouterr()
    assert captured.out.splitlines() == [
        "Copied: include/defs.vh",
        "Copied: include/nested/more.svh",
        "Copied: ip/child.v",
        "Copied: rtl/top.v",
    ]
    assert captured.err == "Missing module: missing\n"


def test_copy_with_deps_handles_angle_includes_cycles_comments_and_escape(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    outside_include = tmp_path.parent / "outside-vlib-copy.vh"
    outside_include.write_text("`define OUTSIDE 1\n", encoding="utf-8")
    write_source(
        tmp_path,
        "rtl/top.v",
        """// `include \"ignored-line.vh\"
/* `include \"ignored-block.vh\" */
`include <../include/shared.vh>
`include \"../../outside-vlib-copy.vh\"
module top;
endmodule
""",
    )
    write_source(
        tmp_path,
        "include/shared.vh",
        '`include "../rtl/top.v"\n`define SHARED 1\n',
    )
    assert vlib.main(["index"]) == 0
    capsys.readouterr()
    destination = tmp_path / "copied"

    assert (
        vlib.main(["copy", "top", str(destination), "--with-deps"])
        == 1
    )

    assert (destination / "rtl" / "top.v").is_file()
    assert (destination / "include" / "shared.vh").is_file()
    assert not (destination / "ignored-line.vh").exists()
    assert not (destination / "ignored-block.vh").exists()
    assert not (destination / "outside-vlib-copy.vh").exists()
    captured = capsys.readouterr()
    assert captured.out.splitlines() == [
        "Copied: include/shared.vh",
        "Copied: rtl/top.v",
    ]
    assert captured.err == (
        "Missing include: ../../outside-vlib-copy.vh from rtl/top.v\n"
    )


def test_copy_preserves_logical_alias_paths_for_modules_and_includes(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "storage/top.v",
        '`include "headers/defs.vh"\nmodule top;\nendmodule\n',
    )
    write_source(
        tmp_path,
        "storage/headers/defs.vh",
        '`include "nested/more.vh"\n`define WIDTH 8\n',
    )
    write_source(
        tmp_path,
        "storage/headers/nested/more.vh",
        "`define RESET_VALUE 0\n",
    )
    alias = tmp_path / "rtl"
    create_directory_alias(alias, tmp_path / "storage")
    try:
        vlib.INDEX_FILE.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "repository_root": tmp_path.resolve().as_posix(),
                    "files": {"rtl/top.v": {"modules": ["top"]}},
                    "modules": {"top": "rtl/top.v"},
                }
            ),
            encoding="utf-8",
        )
        destination = tmp_path / "copied"
        assert (
            vlib.main(["copy", "top", str(destination), "--with-deps"])
            == 0
        )

        assert (destination / "rtl" / "top.v").is_file()
        assert (destination / "rtl" / "headers" / "defs.vh").is_file()
        assert (
            destination / "rtl" / "headers" / "nested" / "more.vh"
        ).is_file()
        assert not (destination / "storage").exists()
        captured = capsys.readouterr()
        assert captured.out.splitlines() == [
            "Copied: rtl/headers/defs.vh",
            "Copied: rtl/headers/nested/more.vh",
            "Copied: rtl/top.v",
        ]
        assert captured.err == ""
    finally:
        remove_directory_alias(alias)


def test_copy_rejects_destination_that_overlaps_a_later_source(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    top_source = b"module top;\r\n  child u_child();\r\nendmodule\r\n"
    child_source = b"module child;\r\nendmodule\r\n"
    top_path = tmp_path / "a.v"
    child_path = tmp_path / "z" / "a.v"
    top_path.write_bytes(top_source)
    child_path.parent.mkdir()
    child_path.write_bytes(child_source)
    assert vlib.main(["index"]) == 0
    capsys.readouterr()

    assert (
        vlib.main(
            ["copy", "top", str(tmp_path / "z"), "--with-deps"]
        )
        == 1
    )

    assert top_path.read_bytes() == top_source
    assert child_path.read_bytes() == child_source
    assert not (tmp_path / "z" / "z" / "a.v").exists()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "Error: Copy conflict: target 'z/a.v' for 'a.v' aliases "
        "source 'z/a.v'.\n"
    )


def test_copy_expands_recursive_includes_for_each_logical_alias_route(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    write_source(
        tmp_path,
        "rtl/top.v",
        """`include "a/common.vh"
`include "b/common.vh"
module top;
endmodule
""",
    )
    write_source(
        tmp_path,
        "shared/common.vh",
        '`include "nested/defs.vh"\n`define COMMON 1\n',
    )
    write_source(
        tmp_path,
        "shared/nested/defs.vh",
        "`define WIDTH 8\n",
    )
    aliases = [tmp_path / "a", tmp_path / "b"]
    created_aliases = []
    try:
        for alias in aliases:
            create_directory_alias(alias, tmp_path / "shared")
            created_aliases.append(alias)
        assert vlib.main(["index"]) == 0
        capsys.readouterr()
        destination = tmp_path / "copied"

        assert (
            vlib.main(["copy", "top", str(destination), "--with-deps"])
            == 0
        )

        for relative_path in (
            "a/common.vh",
            "a/nested/defs.vh",
            "b/common.vh",
            "b/nested/defs.vh",
            "rtl/top.v",
        ):
            assert (destination / relative_path).is_file()
        captured = capsys.readouterr()
        assert captured.out.splitlines() == [
            "Copied: a/common.vh",
            "Copied: a/nested/defs.vh",
            "Copied: b/common.vh",
            "Copied: b/nested/defs.vh",
            "Copied: rtl/top.v",
        ]
        assert captured.err == ""
    finally:
        for alias in reversed(created_aliases):
            remove_directory_alias(alias)


def test_copy_treats_own_source_hard_link_as_a_safe_no_op(
    vlib, tmp_path, capsys
):
    assert vlib is not None, "scripts/vlib.py is not implemented"
    source_bytes = b"module top;\r\nendmodule\r\n"
    source_path = tmp_path / "rtl" / "top.v"
    source_path.parent.mkdir()
    source_path.write_bytes(source_bytes)
    assert vlib.main(["index"]) == 0
    capsys.readouterr()
    destination = tmp_path / "copied"
    target_path = destination / "rtl" / "top.v"
    target_path.parent.mkdir(parents=True)
    try:
        os.link(str(source_path), str(target_path))
    except OSError as error:
        pytest.skip("hard links are unavailable: {}".format(error))
    assert os.path.samefile(str(source_path), str(target_path))

    assert vlib.main(["copy", "top", str(destination)]) == 0

    assert source_path.read_bytes() == source_bytes
    assert target_path.read_bytes() == source_bytes
    captured = capsys.readouterr()
    assert captured.out == "Copied: rtl/top.v\n"
    assert captured.err == ""
