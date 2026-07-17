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
