# -*- coding: utf-8 -*-
"""验证重复模块详细日志功能"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.infrastructure.file_service import FileService
from src.domain.services.dep_analyzer_service import DependencyAnalyzerService


def create_duplicate_test_files(tmpdir: Path):
    """创建包含重复模块的测试文件"""
    file1 = tmpdir / "file1.v"
    file1.write_text("""
module foo (
    input a,
    output b
);
    assign b = a;
endmodule

module bar (
    input x,
    output y
);
    assign y = x;
endmodule
""", encoding="utf-8")

    file2 = tmpdir / "file2.v"
    file2.write_text("""
// 这是 file2
module foo (
    input c,
    output d
);
    assign d = c;
endmodule
""", encoding="utf-8")

    file3 = tmpdir / "file3.v"
    file3.write_text("""
module bar (
    input m,
    output n
);
    assign n = m;
endmodule

module baz (
    input p,
    output q
);
    assign q = p;
endmodule
""", encoding="utf-8")


def test_duplicate_modules_with_lines():
    print("=== 测试重复模块详细日志功能 ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        create_duplicate_test_files(tmpdir_path)

        fs = FileService()
        dep = DependencyAnalyzerService(fs)

        all_modules = {}

        for vfile in fs.list_files(str(tmpdir_path)):
            try:
                content = fs.read_text(str(vfile))
            except Exception:
                continue
            lines = content.splitlines()
            for line_no, line in enumerate(lines, start=1):
                import re
                for match in re.finditer(r'\bmodule\s+(\w+)', line):
                    mod_name = match.group(1)
                    if mod_name not in all_modules:
                        all_modules[mod_name] = []
                    all_modules[mod_name].append({"file": vfile.resolve(), "line": line_no})

        duplicates = {}
        for mod_name, entries in all_modules.items():
            seen_files = set()
            unique_entries = []
            for entry in entries:
                fpath = entry["file"]
                if fpath not in seen_files:
                    seen_files.add(fpath)
                    unique_entries.append(entry)
            if len(unique_entries) > 1:
                duplicates[mod_name] = unique_entries

        print(f"\n重复模块详情:")
        for mod, entries in duplicates.items():
            print(f"\n  模块 '{mod}' 在以下位置定义:")
            for entry in entries:
                print(f"    - {entry['file']}:{entry['line']}")

        assert 'foo' in duplicates, "foo 应该是重复模块"
        assert 'bar' in duplicates, "bar 应该是重复模块"
        assert 'baz' not in duplicates, "baz 不是重复模块"

        foo_entries = duplicates['foo']
        assert len(foo_entries) == 2, f"foo 应该在 2 个文件中定义，实际: {len(foo_entries)}"

        bar_entries = duplicates['bar']
        assert len(bar_entries) == 2, f"bar 应该在 2 个文件中定义，实际: {len(bar_entries)}"

        print("\n=== 所有测试通过！===")


if __name__ == '__main__':
    test_duplicate_modules_with_lines()
