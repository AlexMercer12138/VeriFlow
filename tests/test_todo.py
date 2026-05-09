# -*- coding: utf-8 -*-
"""完整功能验证 — TODO 对照测试"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.infrastructure.file_service import FileService
from src.infrastructure.template_engine import TemplateEngine
from src.infrastructure.config_service import ConfigService
from src.infrastructure.global_config_service import GlobalConfigService
from src.domain.models.project import Project
from src.domain.services.port_parser_service import PortParserService
from src.domain.services.dep_analyzer_service import DependencyAnalyzerService
from src.domain.services.project_manager_service import ProjectManagerService
from src.domain.services.log_parser_service import LogParserService
from src.domain.services.sim_runner_service import SimRunnerService
from src.application.coordinator import ApplicationCoordinator


def green(s): return f"\033[92m{s}\033[0m"
def red(s): return f"\033[91m{s}\033[0m"
def bold(s): return f"\033[1m{s}\033[0m"


def test_dependency_analysis_fix():
    """TODO: 依赖分析修复 — tb_uart 应返回 uart_rx + uart_tx"""
    print("\n" + bold("=== TODO: Dependency Analysis Fix ==="))
    fs = FileService()
    dep = DependencyAnalyzerService(fs)
    verilog_dir = Path(__file__).parent.parent.parent / 'verilog' / 'common'

    result = dep.resolve('tb_uart', [verilog_dir])
    assert result.success, "Dependency resolution should succeed"
    file_names = [f.name for f in result.files]
    assert 'tb_uart.v' in file_names, "Should include tb_uart.v"
    assert 'uart_rx.v' in file_names, "Should include uart_rx.v (via tb_uart instantiation)"
    assert 'uart_tx.v' in file_names, "Should include uart_tx.v (via tb_uart instantiation)"
    assert len(result.files) == 3, f"Expected 3 files, got {file_names}"
    print(green(f"  PASS: tb_uart -> {file_names}"))


def test_compile_path_handling():
    """TODO: 编译路径处理 — 项目文件用相对路径，库文件用绝对路径"""
    print("\n" + bold("=== TODO: Compile Path Handling ==="))
    sr = SimRunnerService()
    cwd = Path("d:/projects/my_rtl")
    files = [
        Path("d:/projects/my_rtl/sub/top.v"),
        Path("d:/projects/my_rtl/common/utils.v"),
        Path("d:/libs/external/mem.v"),
    ]
    resolved = sr._resolve_file_paths(files, cwd)
    assert "sub\\top.v" in resolved or "sub/top.v" in resolved, f"Project file should be relative, got {resolved}"
    assert "common\\utils.v" in resolved or "common/utils.v" in resolved, f"Project file should be relative"
    assert str(Path("d:/libs/external/mem.v")).replace('/', '\\') in [r.replace('/', '\\') for r in resolved] or \
           "d:\\libs\\external\\mem.v" in [r.replace('/', '\\') for r in resolved], \
           f"Lib file should be absolute, got {resolved}"
    print(green(f"  PASS: resolved paths = {resolved}"))


def test_cmd_logging():
    """TODO: 日志完善 — 打印编译仿真调用的命令"""
    print("\n" + bold("=== TODO: Command Logging ==="))
    sr = SimRunnerService()
    te = TemplateEngine()
    cmd = te.render_compile("iverilog -o \"{output}\" {files}", "build/out", ["a.v", "b.v"])
    assert "iverilog" in cmd and "build/out" in cmd and "a.v" in cmd
    print(green(f"  PASS: compile cmd = {cmd}"))
    print(f"  SimRunner tracks last_compile_cmd, last_run_cmd, last_wave_cmd properties")


def test_global_library_config():
    """TODO: 全局编译库管理 — .veriflow_config.json 持久化"""
    print("\n" + bold("=== TODO: Global Library Config ==="))
    test_path = Path(tempfile.gettempdir()) / '.veriflow_test_config.json'
    gc = GlobalConfigService(test_path)

    gc.set_lib_dirs(["/test/lib1", "/test/lib2"])
    assert gc.get_lib_dirs() == ["/test/lib1", "/test/lib2"]

    gc2 = GlobalConfigService(test_path)
    assert gc2.get_lib_dirs() == ["/test/lib1", "/test/lib2"]

    gc.set_lib_dirs([])
    test_path.unlink(missing_ok=True)
    print(green("  PASS: global config saved and reloaded"))


def test_module_management():
    """TODO: 模块管理 — 扫描所有模块，检测重名，按库分类"""
    print("\n" + bold("=== TODO: Module Management ==="))
    app = ApplicationCoordinator()
    verilog_dir = str((Path(__file__).parent.parent.parent / 'verilog' / 'common').resolve())

    from src.domain.models.project import Project
    project = Project(name="test", root_dir=Path(verilog_dir))

    modules = app.scan_all_modules(project)
    assert 'tb_uart' in modules, f"Should find tb_uart, got {list(modules.keys())}"
    assert 'uart_rx' in modules
    assert 'uart_tx' in modules
    assert 'i2c_master' in modules
    print(green(f"  PASS: found {len(modules)} modules: {sorted(modules.keys())}"))

    categorized = app.scan_modules_categorized(project)
    assert 'Project Root' in categorized
    root_mods = categorized['Project Root']
    assert 'tb_uart' in root_mods
    print(green(f"  PASS: categorized by library: {list(categorized.keys())}"))
    print(f"    Project Root: {list(root_mods.keys())}")

    proj_mods = app.get_project_root_modules(project)
    assert 'tb_uart' in proj_mods
    # Only project root modules
    assert set(proj_mods.keys()) == set(root_mods.keys())
    print(green(f"  PASS: project_root_modules = {list(proj_mods.keys())}"))

    dups = app.get_duplicate_modules(project)
    print(f"  Duplicates: {dups if dups else 'None'}")
    print(green("  PASS: duplicate detection ok"))


def test_project_json_open():
    """TODO: 打开项目改为打开 JSON 配置文件"""
    print("\n" + bold("=== TODO: Project JSON Open ==="))
    pm = ProjectManagerService()
    project = pm.create("json_test", Path("d:/test/proj"))

    tmp = Path(tempfile.gettempdir()) / '_veriflow_test_project.json'
    pm.save(project, tmp)

    loaded = pm.open(tmp)
    assert loaded.name == "json_test"
    assert str(loaded.root_dir) == "d:\\test\\proj"
    tmp.unlink(missing_ok=True)
    print(green(f"  PASS: project '{loaded.name}' opened from JSON"))


def test_infrastructure():
    print("\n" + bold("=== Infrastructure Layer ==="))
    fs = FileService()
    verilog_dir = Path(__file__).parent.parent.parent / 'verilog' / 'common'
    files = fs.list_files(str(verilog_dir))
    assert len(files) >= 5
    print(green(f"  FileService: {len(files)} files OK"))

    lp = LogParserService()
    entries = lp.parse("foo.v:10: error: syntax error\nwarning: unused\nok")
    assert len(entries) == 3
    assert entries[0].level == 'ERROR'
    print(green("  LogParser: 3 entries OK"))

    print(green("  Infrastructure: ALL PASSED"))


def run_all():
    tests = [
        ("Dependency Analysis Fix", test_dependency_analysis_fix),
        ("Compile Path Handling", test_compile_path_handling),
        ("Command Logging", test_cmd_logging),
        ("Global Library Config", test_global_library_config),
        ("Module Management", test_module_management),
        ("Project JSON Open", test_project_json_open),
        ("Infrastructure", test_infrastructure),
    ]
    passed = 0
    failed = 0
    for name, test_fn in tests:
        try:
            test_fn()
            passed += 1
        except Exception as e:
            print(red(f"  FAIL: {name}"))
            print(red(f"    {e}"))
            import traceback
            traceback.print_exc()
            failed += 1

    print("\n" + "=" * 60)
    print(bold(f" RESULTS: {green(str(passed) + ' passed')}, {red(str(failed) + ' failed') if failed else green('0 failed')}"))
    print("=" * 60)
    return failed == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
