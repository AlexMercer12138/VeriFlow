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
    write_source(
        tmp_path,
        "rtl/pair.v",
        """
// module ignored_line_comment;
module automatic alpha;
  string marker = "/* quoted text is not a comment */";
endmodule

/* module ignored_block_comment; */
module static beta;
endmodule
""",
    )
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
    assert len(index["files"]["rtl/pair.v"]["sha256"]) == 64


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
