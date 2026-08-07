# Python HDL Cutover and Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove shared-parser parity, switch every Python HDL consumer to the installed worker, delete legacy regex parsing and comparison code, and enforce the complete Windows release pipeline without Node/npm at Python runtime.

**Architecture:** A test-only comparator first normalizes legacy and shared results over a broad fixture matrix and classifies every difference. Existing Python interfaces remain stable but become facades over `SharedHdlService`; coordinator scans, dependency analysis, Testbench generation, CLI/JSON bridge, and native Qt consumers share the one process-wide client. After consumer cutover, all regex parsing/preprocessing and comparison code is deleted, release tooling builds and installs the exact-version worker wheel before Python tests/PyInstaller, and clean-runtime smoke tests remove Node/npm from `PATH`.

**Tech Stack:** Python 3.11, pytest, dataclasses, installed `veriflow-hdl-worker` wheel, Node SEA build pipeline, PyInstaller, VS Code vsce, GitHub Actions Windows runners, Playwright/Qt smoke tests from prior plans.

---

## File Structure

```text
tests/fixtures/hdl-comparison/        ANSI/non-ANSI/includes/defines/generate/duplicates/errors
tests/support/legacy_hdl.py           test-only frozen legacy implementation, deleted before finish
tests/support/hdl_compare.py          structural normalizer/comparator, deleted before finish
tests/test_hdl_shadow_comparison.py   difference classification gate, deleted before finish
src/domain/services/port_parser_service.py    stable facade over SharedHdlService
src/domain/services/dep_analyzer_service.py    stable facade over SharedHdlService
src/application/coordinator.py                shared workspace scan/dependency consumers
src/presentation/json_bridge.py               shared scan/analyze bridge
src/presentation/gui/worker_threads.py        background HDL workflows
src/presentation/gui/main_window.py           service injection and shutdown
src/presentation/gui/widgets/testbench_panel.py native Testbench consumer
scripts/run_release.py                        fixed build/test/package order
scripts/smoke_clean_python_runtime.py          Node-free installed/PyInstaller smoke
tests/test_release_pipeline.py                 versions/order/artifact policy
```

No production fallback is introduced. Legacy code exists only under `tests/support` while shadow comparison is active and is deleted in Task 7.

### Task 1: Freeze a test-only legacy comparator and classify the fixture matrix

**Files:**
- Create: `tests/support/__init__.py`
- Create: `tests/support/legacy_hdl.py`
- Create: `tests/support/hdl_compare.py`
- Create: `tests/fixtures/hdl-comparison/ansi.sv`
- Create: `tests/fixtures/hdl-comparison/non_ansi.v`
- Create: `tests/fixtures/hdl-comparison/includes/top.sv`
- Create: `tests/fixtures/hdl-comparison/includes/ports.svh`
- Create: `tests/fixtures/hdl-comparison/defines.sv`
- Create: `tests/fixtures/hdl-comparison/generate.sv`
- Create: `tests/fixtures/hdl-comparison/multi_module.sv`
- Create: `tests/fixtures/hdl-comparison/duplicate_a.sv`
- Create: `tests/fixtures/hdl-comparison/duplicate_b.sv`
- Create: `tests/fixtures/hdl-comparison/malformed.sv`
- Create: `tests/fixtures/hdl-comparison/expectations.json`
- Create: `tests/test_hdl_shadow_comparison.py`
- Modify: `tests/conftest.py`

- [ ] **Step 1: Add the failing opt-in comparison test**

```python
import pytest

from tests.support.hdl_compare import compare_fixture_matrix


@pytest.mark.hdl_compare
def test_shared_parser_differences_are_fully_classified(
    request: pytest.FixtureRequest,
) -> None:
    if not request.config.getoption("--hdl-compare-legacy"):
        pytest.skip("legacy comparison is test-only and opt-in")
    report = compare_fixture_matrix()
    assert report.unclassified == []
    assert report.new_runtime_defects == []
```

- [ ] **Step 2: Run the opt-in test to verify it fails**

Run: `python -m pytest tests/test_hdl_shadow_comparison.py --hdl-compare-legacy -v`

Expected: FAIL because comparison support is absent.

- [ ] **Step 3: Freeze current regex behavior under tests only**

Copy the current parsing/preprocessing/dependency logic from `port_parser_service.py`, `dep_analyzer_service.py`, and `verilog_utils.py` into `tests/support/legacy_hdl.py`. Rename public classes to `LegacyPortParser` and `LegacyDependencyAnalyzer`; remove imports from production service modules; mark the module header:

```python
"""Frozen migration oracle. Test-only; delete after shared parser cutover."""
```

Do not fix legacy behavior in this copy.

- [ ] **Step 4: Define normalized comparison records**

```python
@dataclass(frozen=True)
class NormalizedModule:
    name: str
    parameters: Tuple[Tuple[str, str], ...]
    ports: Tuple[Tuple[str, str, Optional[str]], ...]
    instances: Tuple[str, ...]
    includes: Tuple[str, ...]


@dataclass(frozen=True)
class ComparisonReport:
    matching: Tuple[str, ...]
    legacy_defect_corrections: Tuple[dict, ...]
    intentional_model_changes: Tuple[dict, ...]
    new_runtime_defects: Tuple[dict, ...]
    unclassified: Tuple[dict, ...]
```

Normalize paths to fixture-relative POSIX strings, preserve parameter/port order, sort dependency sets and diagnostics by stable keys, and compare module definitions path-qualifiably.

- [ ] **Step 5: Populate explicit expectations**

`expectations.json` has one entry per fixture and difference path:

```json
{
  "schemaVersion": 1,
  "differences": {
    "generate.sv:modules.top.instances": {
      "classification": "legacy-defect-correction",
      "reason": "Tree-sitter retains module instances inside generate blocks."
    },
    "malformed.sv:diagnostics": {
      "classification": "intentional-model-change",
      "reason": "The shared parser returns structured syntax diagnostics instead of a generic parse failure."
    }
  }
}
```

Every observed difference must have an exact key and reason; unused expectation keys fail the test.

- [ ] **Step 6: Register the pytest option and run comparison**

```python
def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--hdl-compare-legacy",
        action="store_true",
        default=False,
        help="run the test-only legacy/shared HDL comparison",
    )
```

Run: `python -m pytest tests/test_hdl_shadow_comparison.py --hdl-compare-legacy -v`

Expected: PASS with zero unclassified differences and zero new-runtime defects. Fix new-runtime defects in shared TypeScript packages before continuing; never classify them away.

- [ ] **Step 7: Commit the migration oracle**

```bash
git add tests/support tests/fixtures/hdl-comparison tests/test_hdl_shadow_comparison.py tests/conftest.py
git commit -m "test: compare shared and legacy HDL parsing"
```

### Task 2: Cut `PortParserService` over while preserving its interface

**Files:**
- Modify: `src/domain/services/port_parser_service.py`
- Modify: `src/domain/services/shared_hdl_service.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_core_services.py`
- Create: `tests/test_port_parser_cutover.py`

- [ ] **Step 1: Write failing facade and no-regex tests**

```python
from pathlib import Path

from src.domain.services.port_parser_service import PortParserService
from src.infrastructure.file_service import FileService


def test_port_parser_facade_uses_shared_service(fake_shared_hdl_service) -> None:
    parser = PortParserService(FileService(), hdl_service=fake_shared_hdl_service)
    result = parser.parse_content("module dut(input clk); endmodule", "dut.sv")
    assert result.name == "dut"
    assert fake_shared_hdl_service.parse_content_calls == [
        ("module dut(input clk); endmodule", "dut.sv", None)
    ]


def test_port_parser_production_source_contains_no_regex_parser() -> None:
    source = Path("src/domain/services/port_parser_service.py").read_text(encoding="utf-8")
    assert "import re" not in source
    assert "_parse_module_header" not in source
    assert "preprocess_verilog" not in source
```

- [ ] **Step 2: Run cutover tests to verify they fail**

Run: `python -m pytest tests/test_port_parser_cutover.py -v`

Expected: FAIL because production service still contains regex parsing.

- [ ] **Step 3: Add `parse_content` to the shared service**

```python
def parse_content(
    self,
    content: str,
    filename: str = "module",
    module_name: Optional[str] = None,
) -> ModuleInfo:
    suffix = Path(filename).suffix.lower()
    uri = Path(filename).resolve().as_uri() if suffix in {".v", ".sv"} else f"memory:///{filename}"
    payload = self._client.request("parseDocument", {
        "uri": uri,
        "version": 1,
        "text": content,
        "priority": "interactive",
        "options": {"defines": {}, "cacheMode": "ephemeral"},
    })
    return self._module_info(payload["document"], module_name=module_name, filename=filename)
```

Use strict UTF-8 text already supplied by callers; do not write temporary source files.
Import `Optional` from `typing`; every new production Python module retains
the repository's Python 3.8-compatible annotation style.

Add a reusable `fake_shared_hdl_service` fixture to `tests/conftest.py`. Its
methods append exact argument tuples to `parse_content_calls`,
`parse_file_calls`, and `index_calls`, then return explicitly configured
`ModuleInfo`, `DependencyResult`, or workspace snapshot values. Later cutover
tests extend this one fake instead of creating inconsistent service doubles.

- [ ] **Step 4: Replace parser internals with a thin facade**

```python
class PortParserService(IPortParser):
    def __init__(self, file_service: IFileService, hdl_service: Optional[SharedHdlService] = None):
        self._file_service = file_service
        self._hdl_service = hdl_service or SharedHdlService()

    def parse_file(self, filepath: str) -> ModuleInfo:
        return self._hdl_service.parse_file(Path(filepath))

    def parse_content(self, content: str, filename: str = "module") -> ModuleInfo:
        return self._hdl_service.parse_content(content, filename)
```

No catch invokes the legacy implementation. Worker errors propagate as typed runtime/request errors; missing module declarations map to the existing `ValueError` contract.

- [ ] **Step 5: Run port, Testbench, and comparison regressions**

Run: `python -m pytest tests/test_port_parser_cutover.py tests/test_core_services.py tests/test_testbench_generation.py -v`

Run: `python -m pytest tests/test_hdl_shadow_comparison.py --hdl-compare-legacy -v`

Expected: PASS.

- [ ] **Step 6: Commit port parser cutover**

```bash
git add src/domain/services/port_parser_service.py src/domain/services/shared_hdl_service.py tests/test_core_services.py tests/test_port_parser_cutover.py
git commit -m "refactor: use shared HDL port parsing"
```

### Task 3: Cut dependency analysis over while preserving compile-order contracts

**Files:**
- Modify: `src/domain/services/dep_analyzer_service.py`
- Modify: `src/domain/services/shared_hdl_service.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_core_services.py`
- Create: `tests/test_dependency_cutover.py`

- [ ] **Step 1: Write failing interface and deterministic-order tests**

```python
def test_dependency_facade_preserves_all_public_methods(fake_shared_hdl_service) -> None:
    service = DependencyAnalyzerService(FileService(), hdl_service=fake_shared_hdl_service)
    index, file_modules = service.build_index([Path("rtl")])
    assert index == {"top": Path("rtl/top.sv")}
    assert file_modules == {Path("rtl/top.sv"): ["top"]}
    assert service.extract_dependencies(Path("rtl/top.sv")) == ["child"]
    assert service.extract_includes(Path("rtl/top.sv")) == ["defs.svh"]


def test_dependency_facade_uses_worker_compile_order(uart_project_dir: Path) -> None:
    result = DependencyAnalyzerService(FileService()).resolve("uart_tb", [uart_project_dir])
    assert [path.name for path in result.get_compile_order()] == [
        "uart_rx.v", "uart_tx.v", "uart_tb.v"
    ]
```

- [ ] **Step 2: Run dependency tests to verify they fail**

Run: `python -m pytest tests/test_dependency_cutover.py -v`

Expected: FAIL because the service still parses dependencies with regex.

- [ ] **Step 3: Expose one indexed-workspace snapshot in `SharedHdlService`**

```python
@dataclass(frozen=True)
class WorkspaceSnapshot:
    definitions: Tuple[dict, ...]
    files: Tuple[dict, ...]
    duplicate_groups: Tuple[dict, ...]

    def module_paths(self) -> Dict[str, List[Path]]:
        result: Dict[str, List[Path]] = {}
        for definition in self.definitions:
            if definition.get("kind") == "module":
                result.setdefault(definition["name"], []).append(
                    _file_uri_to_path(definition["uri"])
                )
        return result

    def file_modules(self) -> Dict[Path, List[str]]:
        result: Dict[Path, List[str]] = {}
        for name, paths in self.module_paths().items():
            for path in paths:
                result.setdefault(path, []).append(name)
        return {path: sorted(names) for path, names in result.items()}
```

Import `Dict`, `List`, `Optional`, `Tuple` from `typing`. Implement
`_file_uri_to_path` once in `shared_hdl_service.py` with `urlparse`,
`unquote`, and Windows drive normalization; every domain mapping reuses it.

Cache only by normalized roots/include/library/defines fingerprint and worker generation. Invalidate after worker restart. `analyze_dependencies` reuses the initialized/indexed snapshot and maps compile-order file URIs exactly once.

- [ ] **Step 4: Replace dependency implementation with shared-service mapping**

Keep `IDependencyAnalyzer` methods and return types. `build_index` maps snapshot definitions; for duplicates, preserve the current first-path return while duplicate-aware coordinator APIs consume all paths. `extract_dependencies` and `extract_includes` parse the requested file through the worker and return stable unique values. `resolve` delegates to sidecar dependency analysis.

- [ ] **Step 5: Run dependency, CLI, simulation, and shadow regressions**

Run: `python -m pytest tests/test_dependency_cutover.py tests/test_core_services.py tests/test_cli_and_simulation.py tests/test_project_config.py -v`

Run: `python -m pytest tests/test_hdl_shadow_comparison.py --hdl-compare-legacy -v`

Expected: PASS for missing modules, conditional defines, generate instances, include order, duplicates, and deterministic compile order.

- [ ] **Step 6: Commit dependency cutover**

```bash
git add src/domain/services/dep_analyzer_service.py src/domain/services/shared_hdl_service.py tests/test_core_services.py tests/test_dependency_cutover.py
git commit -m "refactor: use shared HDL dependency analysis"
```

### Task 4: Replace coordinator and JSON bridge regex module scans

**Files:**
- Modify: `src/application/coordinator.py`
- Modify: `src/presentation/json_bridge.py`
- Modify: `src/presentation/gui/widgets/unified_module_panel.py`
- Modify: `src/presentation/gui/worker_threads.py`
- Create: `tests/test_module_scan_cutover.py`
- Modify: `tests/test_cli_and_simulation.py`
- Modify: `tests/conftest.py`

- [ ] **Step 1: Write failing scan/duplicate/source tests**

```python
def test_coordinator_scans_once_and_derives_all_views(fake_shared_hdl_service, project) -> None:
    app = ApplicationCoordinator(hdl_service=fake_shared_hdl_service)
    categorized = app.scan_modules_categorized(project)
    duplicates = app.get_duplicate_modules(project)
    detailed = app.get_duplicate_modules_with_lines(project)
    root_modules = app.get_project_root_modules(project)
    assert fake_shared_hdl_service.index_calls == 1
    assert categorized["Project Root"]["top"].name == "top.sv"
    assert list(duplicates) == ["duplicate"]
    assert detailed["duplicate"][0]["line"] == 1
    assert "top" in root_modules


def test_scan_consumers_have_no_verilog_regex() -> None:
    for path in [
        Path("src/application/coordinator.py"),
        Path("src/presentation/json_bridge.py"),
        Path("src/presentation/gui/widgets/unified_module_panel.py"),
    ]:
        source = path.read_text(encoding="utf-8")
        assert "preprocess_verilog" not in source
        assert "re.finditer(r'\\bmodule" not in source
```

- [ ] **Step 2: Run scan tests to verify they fail**

Run: `python -m pytest tests/test_module_scan_cutover.py -v`

Expected: FAIL because all three consumers still scan source with regex.

- [ ] **Step 3: Inject and reuse `SharedHdlService` in the coordinator**

`ApplicationCoordinator.__init__(hdl_service=None)` stores one service, passes it to dependency/port facades, and caches one `WorkspaceSnapshot` per project configuration. All four scan APIs derive categorized modules, project-root modules, duplicates, and source lines from definition summaries rather than rescanning files.

- [ ] **Step 4: Make background workers use the process-wide client without repeated scans**

`ModuleScanWorker` calls one new coordinator method:

```python
snapshot = app.scan_project_modules(self._project)
self.finished.emit(
    snapshot.categorized,
    snapshot.duplicates,
    snapshot.duplicates_with_lines,
    snapshot.project_modules,
)
```

The worker runs off the Qt UI thread as today. Multiple `ApplicationCoordinator` objects still resolve to the one process-wide client registry.

- [ ] **Step 5: Replace JSON bridge and native module panel scanning**

`cmd_scan` calls `SharedHdlService.index_workspace` through the coordinator and serializes the same current JSON keys. `unified_module_panel.py` consumes coordinator results; it does not read/preprocess HDL itself.

- [ ] **Step 6: Run scan, CLI bridge, and GUI worker tests**

Run: `python -m pytest tests/test_module_scan_cutover.py tests/test_cli_and_simulation.py tests/test_core_services.py -v`

Expected: PASS, including path-qualified duplicates and one index call per scan workflow.

- [ ] **Step 7: Commit module scan cutover**

```bash
git add src/application/coordinator.py src/presentation/json_bridge.py src/presentation/gui/widgets/unified_module_panel.py src/presentation/gui/worker_threads.py tests/test_module_scan_cutover.py tests/test_cli_and_simulation.py
git commit -m "refactor: use shared HDL workspace scans"
```

### Task 5: Switch Testbench and native Qt consumers without swallowing worker errors

**Files:**
- Modify: `src/domain/services/testbench_generator.py`
- Modify: `src/presentation/gui/widgets/testbench_panel.py`
- Modify: `src/presentation/gui/main_window.py`
- Modify: `src/presentation/gui/i18n.py`
- Modify: `tests/test_testbench_generation.py`
- Create: `tests/test_gui_hdl_cutover.py`
- Modify: `tests/conftest.py`

- [ ] **Step 1: Write failing injected-service and error-propagation tests**

```python
def test_testbench_generator_uses_injected_shared_service(fake_shared_hdl_service, tmp_path) -> None:
    generator = TestbenchGenerator(hdl_service=fake_shared_hdl_service)
    generator.generate(
        name="tb",
        modules=[{"filepath": "dut.sv", "module_name": "dut"}],
        clocks=[],
        output_dir=tmp_path,
    )
    assert fake_shared_hdl_service.parse_file_calls == [(Path("dut.sv"), "dut")]


def test_testbench_panel_surfaces_worker_failure(qtbot, failing_shared_hdl_service) -> None:
    panel = TestbenchPanel(hdl_service=failing_shared_hdl_service)
    with pytest.raises(HdlWorkerRuntimeError):
        panel._parse_module_ports(ModuleEntry("dut", "dut.sv"), "dut.sv")
```

- [ ] **Step 2: Run consumer tests to verify they fail**

Run: `python -m pytest tests/test_gui_hdl_cutover.py tests/test_testbench_generation.py -v`

Expected: FAIL because consumers instantiate parser facades internally and suppress failures.

- [ ] **Step 3: Inject shared service into Testbench generation and panel**

`TestbenchGenerator.__init__(hdl_service=None)` and
`TestbenchPanel.__init__(parent=None, hdl_service=None)` receive the
coordinator-owned service. `_parse_module` and `_parse_module_ports` call
`parse_file(path, module_name=requested_module_name)` directly. Remove
`except Exception: return [], []` and `except Exception: pass` around parser
calls.

- [ ] **Step 4: Surface typed worker errors at the UI boundary**

The panel emits or displays a translated error containing operation, worker version, and bounded message. Add i18n keys for worker unavailable, protocol mismatch, parse request failure, and worker restart exhausted. HDL source text and stderr beyond the bounded diagnostic tail are not displayed.

- [ ] **Step 5: Reuse the service from `MainWindow`**

Construct Testbench generator/panel with `self._coordinator.hdl_service`. GUI analysis/module scan/Testbench workflows therefore share runtime initialization and index cache while remaining on existing background worker paths.

- [ ] **Step 6: Run Testbench and GUI cutover tests**

Run: `python -m pytest tests/test_testbench_generation.py tests/test_gui_hdl_cutover.py tests/test_core_services.py -v`

Expected: PASS for normal generation and explicit worker error states.

- [ ] **Step 7: Commit native consumer cutover**

```bash
git add src/domain/services/testbench_generator.py src/presentation/gui/widgets/testbench_panel.py src/presentation/gui/main_window.py src/presentation/gui/i18n.py tests/test_testbench_generation.py tests/test_gui_hdl_cutover.py
git commit -m "refactor: use shared HDL service in Testbench workflows"
```

### Task 6: Prove lifecycle cleanup across CLI and GUI workflows

**Files:**
- Modify: `src/presentation/cli.py`
- Modify: `src/presentation/json_bridge.py`
- Modify: `src/presentation/gui/__main__.py`
- Modify: `src/presentation/gui/main_window.py`
- Create: `tests/test_hdl_process_cleanup.py`

- [ ] **Step 1: Write failing subprocess cleanup tests**

```python
@pytest.mark.windows
def test_cli_analysis_leaves_no_worker_process(installed_runtime, uart_project_dir) -> None:
    before = worker_pids()
    completed = subprocess.run(
        [sys.executable, "-m", "src.presentation.cli", "analyze", "-t", "uart_tb", "-r", str(uart_project_dir)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    assert wait_for_worker_pids() == before


def test_shutdown_is_idempotent_after_worker_crash(real_client) -> None:
    real_client.initialize(test_config())
    terminate_worker(real_client.pid)
    shutdown_hdl_worker()
    shutdown_hdl_worker()
    assert real_client.reader_thread_alive is False
```

- [ ] **Step 2: Run cleanup tests to verify they fail**

Run: `python -m pytest tests/test_hdl_process_cleanup.py -v`

Expected: FAIL on at least one process/thread cleanup path.

- [ ] **Step 3: Add explicit command-scope shutdown**

CLI and JSON bridge `main()` functions wrap dispatch in `try/finally: shutdown_hdl_worker()`. GUI connects `aboutToQuit`, calls shutdown after background workers stop, and bounds graceful dispose/terminate/kill waits. Client reader/stderr threads are non-daemon and joined; process pipe handles are always closed.

- [ ] **Step 4: Handle Ctrl+C and abnormal process exit**

The client translates `KeyboardInterrupt` during a blocking request into cancellation, then re-raises after cleanup. Worker EOF closes pending futures. GUI close during initialization aborts the request and does not wait on the UI thread beyond the fixed shutdown bound.

- [ ] **Step 5: Run cleanup matrix**

Run: `python -m pytest tests/test_hdl_process_cleanup.py tests/test_hdl_worker_client.py tests/test_hdl_worker_runtime.py -v`

Expected: PASS for normal CLI, request error, worker crash, timeout, Ctrl+C simulation, GUI close, repeated shutdown, and no remaining worker/threads/handles.

- [ ] **Step 6: Commit lifecycle cleanup**

```bash
git add src/presentation/cli.py src/presentation/json_bridge.py src/presentation/gui/__main__.py src/presentation/gui/main_window.py tests/test_hdl_process_cleanup.py
git commit -m "fix: clean up HDL worker lifecycle"
```

### Task 7: Delete the regex parser and the migration-only comparison switch

**Files:**
- Delete: `src/domain/services/verilog_utils.py`
- Modify: `src/domain/services/port_parser_service.py`
- Modify: `src/domain/services/dep_analyzer_service.py`
- Modify: all remaining Python imports
- Delete: `tests/support/legacy_hdl.py`
- Delete: `tests/support/hdl_compare.py`
- Delete: `tests/test_hdl_shadow_comparison.py`
- Modify: `tests/conftest.py`
- Create: `tests/test_no_legacy_hdl_parser.py`

- [ ] **Step 1: Add a failing repository-wide legacy scan**

```python
from pathlib import Path


def test_no_legacy_hdl_parser_or_comparison_switch_remains() -> None:
    root = Path(__file__).resolve().parents[1]
    forbidden_files = [
        root / "src/domain/services/verilog_utils.py",
        root / "tests/support/legacy_hdl.py",
        root / "tests/support/hdl_compare.py",
        root / "tests/test_hdl_shadow_comparison.py",
    ]
    assert all(not path.exists() for path in forbidden_files)
    production = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (root / "src").rglob("*.py")
    )
    for marker in (
        "preprocess_verilog",
        "_parse_module_header",
        "_remove_procedural_blocks",
        "VERIFLOW_HDL_COMPARE",
        "hdl_compare_legacy",
    ):
        assert marker not in production
```

- [ ] **Step 2: Run the scan to verify it fails**

Run: `python -m pytest tests/test_no_legacy_hdl_parser.py -v`

Expected: FAIL because migration oracle and legacy utilities still exist.

- [ ] **Step 3: Run the final shadow comparison before deletion**

Run: `python -m pytest tests/test_hdl_shadow_comparison.py --hdl-compare-legacy -v`

Expected: PASS with no unexplained differences. Save the test output in the implementation record or PR description; do not retain executable legacy code solely for history.

- [ ] **Step 4: Delete legacy implementation and switch**

Use `git rm` on the four migration files and `verilog_utils.py`. Remove `pytest_addoption`/marker registration. Remove unused `re` imports and any dead helper methods from production facades. Keep public interface files/classes because current callers depend on them, but their bodies remain shared-service delegation only.

- [ ] **Step 5: Run no-legacy and complete Python tests**

Run: `python -m pytest tests/test_no_legacy_hdl_parser.py -v`

Run: `python -m pytest`

Expected: PASS without opt-in switches and without any regex HDL parsing code.

- [ ] **Step 6: Commit legacy removal**

```bash
git add -A src/domain/services tests/support tests/test_hdl_shadow_comparison.py tests/conftest.py tests/test_no_legacy_hdl_parser.py
git commit -m "refactor: remove legacy Python HDL parser"
```

### Task 8: Lock all package versions and release order

**Files:**
- Modify: `scripts/run_release.py`
- Modify: `src/version.py`
- Modify: `pyproject.toml`
- Modify: `package.json`
- Modify: `packages/hdl-core/package.json`
- Modify: `packages/hdl-runtime/package.json`
- Modify: `packages/hdl-protocol/package.json`
- Modify: `packages/webview-runtime/package.json`
- Modify: `packages/waveform-webview/package.json`
- Modify: `packages/schematic-webview/package.json`
- Modify: `packages/testbench-webview/package.json`
- Modify: `packages/parser-worker/package.json`
- Modify: `python-packages/veriflow-hdl-worker/pyproject.toml`
- Modify: `veriflow-vscode/package.json`
- Create: `tests/test_release_pipeline.py`
- Modify: `README.md`

- [ ] **Step 1: Write failing version and order tests**

```python
def test_every_runtime_package_has_exact_release_version() -> None:
    versions = read_all_release_versions(ROOT)
    assert len(set(versions.values())) == 1, versions
    expected = next(iter(versions.values()))
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert f'veriflow-hdl-worker=={expected}' in pyproject


def test_release_pipeline_builds_and_installs_worker_before_python_tests() -> None:
    source = (ROOT / "scripts/run_release.py").read_text(encoding="utf-8")
    steps = [
        source.index('"npm", "ci"'),
        source.index('"npm", "run", "build:parser"'),
        source.index("build_parser_worker_wheel.py"),
        source.index('"pip", "install"'),
        source.index('"-m", "pytest"'),
        source.index('"pyinstaller"'),
        source.index('"npm", "run", "package"'),
    ]
    assert steps == sorted(steps)
```

- [ ] **Step 2: Run release tests to verify they fail**

Run: `python -m pytest tests/test_release_pipeline.py -v`

Expected: FAIL because wheel/package versions and order are incomplete.

- [ ] **Step 3: Extend version reading/updating atomically**

`read_versions()` includes root/package workspace versions and worker wheel version. `update_version()` edits all manifests, runs `npm install --package-lock-only`, and rechecks exact equality. If any edit or lock refresh fails, restore original file contents before returning an error.

- [ ] **Step 4: Implement the fixed check/package sequence**

`release_check()` runs:

```text
npm ci
npm run build:web
npm run verify:generated
npm test --workspaces --if-present
npm run test:webview
npm run build:parser
node scripts/smoke-parser-worker.mjs
python scripts/build_parser_worker_wheel.py
python -m pip install --force-reinstall <exact built wheel>
python -m pytest
```

`package_release()` then builds both PyInstaller specs, runs installed artifact smokes, packages the VSIX, and inspects artifact contents. Do not build or install the worker after Python tests.

- [ ] **Step 5: Update documentation and test release helpers**

README states that normal Python installation obtains the exact worker wheel and needs no Node/npm; Node is required only for parser/front-end development and releases. Document Windows x64 as the only supported sidecar release target.

Run: `python -m pytest tests/test_release_pipeline.py -v`

Expected: PASS.

- [ ] **Step 6: Commit release order/version locking**

```bash
git add scripts/run_release.py src/version.py pyproject.toml package.json package-lock.json packages python-packages/veriflow-hdl-worker/pyproject.toml veriflow-vscode/package.json tests/test_release_pipeline.py README.md
git commit -m "build: lock unified runtime release versions"
```

### Task 9: Harden PyInstaller, VSIX, licenses, and clean-runtime smoke tests

**Files:**
- Modify: `VeriFlow.spec`
- Modify: `VeriFlow-cli.spec`
- Modify: `veriflow-vscode/.vscodeignore`
- Modify: `veriflow-vscode/THIRD_PARTY_NOTICES.md`
- Create: `scripts/smoke_clean_python_runtime.py`
- Create: `scripts/inspect_release_artifacts.py`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/test_release_pipeline.py`

- [ ] **Step 1: Write failing artifact policy tests**

```python
def test_repository_and_vsix_do_not_ship_worker_executable() -> None:
    tracked = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
    assert not any(path.endswith("parser-worker.exe") for path in tracked)
    vscodeignore = (ROOT / "veriflow-vscode/.vscodeignore").read_text(encoding="utf-8")
    assert "python-packages/**" in vscodeignore


def test_pyinstaller_specs_collect_web_dist_and_installed_worker() -> None:
    gui = (ROOT / "VeriFlow.spec").read_text(encoding="utf-8")
    cli = (ROOT / "VeriFlow-cli.spec").read_text(encoding="utf-8")
    assert "('web-dist/waveform', 'web-dist/waveform')" in gui
    assert "collect_data_files('veriflow_hdl_worker')" in gui
    assert "collect_data_files('veriflow_hdl_worker')" in cli
```

- [ ] **Step 2: Run artifact tests to verify they fail**

Run: `python -m pytest tests/test_release_pipeline.py -v`

Expected: FAIL on any missing packaging policy.

- [ ] **Step 3: Inspect actual artifact contents**

`inspect_release_artifacts.py` opens the built wheel and VSIX as ZIP files and inspects PyInstaller output trees. Assert:

- worker wheel contains one EXE, both WASM files, manifest, runtime helper, and licenses;
- VSIX contains all three generated Web apps and parser WASM assets but no Python worker EXE/wheel;
- GUI/CLI artifacts contain the worker distribution from the installed wheel;
- no artifact contains npm cache, TypeScript source, test fixtures, SEA blob, or loose Node executable.

- [ ] **Step 4: Add the clean Python runtime smoke workflow**

`smoke_clean_python_runtime.py` creates a child environment whose `PATH` contains only the installed Python environment and Windows system directories, asserts `node`/`npm` are not found, then:

1. runs CLI HDL indexing/dependency analysis on UART fixtures;
2. starts the packaged GUI with a test hook, opens a VCD, requests Testbench generation, and closes;
3. asserts generated outputs and screenshot are nonblank;
4. waits up to 5 seconds and asserts no worker process remains.

Use test hooks already present for Qt/GUI automation; do not add visible user-facing debug controls.

- [ ] **Step 5: Collect third-party licenses deterministically**

Include Node runtime/SEA redistribution notice, web-tree-sitter, tree-sitter-systemverilog, X6, Dagre, Lucide, and bundled frontend transitive packages. `verify:generated` also verifies notice drift. The worker wheel includes the licenses relevant to its binary/assets.

- [ ] **Step 6: Update Windows CI release-artifact job**

Use the fixed release sequence, run `inspect_release_artifacts.py`, then run the clean-runtime smoke with Node directories removed from `PATH`. Keep the VS Code build/test job separate but consume the root lock and generated assets.

- [ ] **Step 7: Run artifact and clean-runtime tests**

Run: `python scripts/run_release.py --check`

Run: `python scripts/run_release.py --package`

Run: `python scripts/inspect_release_artifacts.py`

Run: `python scripts/smoke_clean_python_runtime.py`

Expected: every command exits 0 and no parser process remains.

- [ ] **Step 8: Commit release hardening**

```bash
git add VeriFlow.spec VeriFlow-cli.spec veriflow-vscode/.vscodeignore veriflow-vscode/THIRD_PARTY_NOTICES.md scripts/smoke_clean_python_runtime.py scripts/inspect_release_artifacts.py .github/workflows/ci.yml tests/test_release_pipeline.py
git commit -m "build: harden unified runtime artifacts"
```

### Task 10: Enforce final correctness, performance, and repository completion criteria

**Files:**
- Create: `scripts/benchmark_shared_hdl_runtime.py`
- Create: `tests/test_unified_runtime_completion.py`
- Modify: `README.md`
- Modify: `docs/architecture/hdl-runtime-feasibility.md`

- [ ] **Step 1: Write a failing completion-criteria test**

```python
def test_unified_runtime_completion_criteria() -> None:
    root = Path(__file__).resolve().parents[1]
    assert not (root / "src/domain/services/verilog_utils.py").exists()
    assert not list(root.rglob("parser-worker.exe"))
    assert (root / "web-dist/waveform/index.js").is_file()
    assert (root / "web-dist/schematic/index.js").is_file()
    assert (root / "web-dist/testbench/index.js").is_file()
    assert "veriflow-vscode/media/waveform" not in (
        root / "src/presentation/gui/widgets/waveform_html.py"
    ).read_text(encoding="utf-8")
    assert ".replace(" not in (
        root / "src/presentation/gui/widgets/waveform_html.py"
    ).read_text(encoding="utf-8")
```

- [ ] **Step 2: Run completion test to identify any remaining gap**

Run: `python -m pytest tests/test_unified_runtime_completion.py -v`

Expected before cleanup: FAIL on every residual artifact/reference; fix only the reported migration residue.

- [ ] **Step 3: Add the shared runtime benchmark**

Use the exact manifest from `tests/benchmarks/hdl-fixtures.json`. Record worker cold start separately, warm parse median, warm workspace index median, peak working set, handle count before/after 500 repeated parses, and process count after dispose. Compare warm medians to the phase-0 baseline report captured on the same machine; fail if regression exceeds 25% outside measured variance. Fail any monotonically unbounded memory/handle growth.

- [ ] **Step 4: Run complete source and installed verification**

Run: `npm ci`

Run: `npm run build:web && npm run verify:generated`

Run: `npm test --workspaces --if-present`

Run: `npm run test:webview`

Run: `npm run build:parser && node scripts/smoke-parser-worker.mjs`

Run: `python scripts/build_parser_worker_wheel.py`

Run: `python -m pip install --force-reinstall (Get-ChildItem python-packages/veriflow-hdl-worker/dist/*.whl)`

Run: `python -m pytest`

Run: `python scripts/benchmark_shared_hdl_runtime.py --baseline docs/performance/2026-08-07-hdl-regex-baseline.json`

Run: `python tests/waveform_viewer_smoke.py`

Run: `python scripts/run_release.py --package`

Run: `python scripts/inspect_release_artifacts.py`

Run: `python scripts/smoke_clean_python_runtime.py`

Expected: all commands pass, performance/handle gates pass, screenshots are nonblank, and no worker remains.

- [ ] **Step 5: Verify source-policy searches**

Run: `rg -n "preprocess_verilog|_parse_module_header|_remove_procedural_blocks|VERIFLOW_HDL_COMPARE|hdl_compare_legacy" src tests`

Expected: no matches.

Run: `rg -n "acquireVsCodeApi|QWebChannel" packages/*-webview/src packages/webview-runtime/src`

Expected: host globals appear only in shared runtime adapter files.

Run: `git ls-files "*parser-worker.exe" "*.whl" ".artifacts/*"`

Expected: no output.

- [ ] **Step 6: Update architecture record and README with verified outcome**

Record the actual worker/core/protocol versions, checksums, clean-runtime command, and benchmark report location. Keep Linux/macOS worker builds and schematic layout/routing improvement explicitly outside completed scope.

- [ ] **Step 7: Run fresh final tests and commit completion evidence**

Run: `python -m pytest tests/test_unified_runtime_completion.py tests/test_release_pipeline.py -v`

Run: `git diff --check`

Expected: PASS and no whitespace errors.

```bash
git add scripts/benchmark_shared_hdl_runtime.py tests/test_unified_runtime_completion.py README.md docs/architecture/hdl-runtime-feasibility.md
git commit -m "test: verify unified Web and HDL runtime"
```

## Plan Completion Gate

The architecture migration is complete only when all commands in Task 10 pass from fresh installs, `git status --short` is empty, the no-legacy/source-policy searches have the expected results, and the clean Windows runtime succeeds with Node/npm absent. Any unexplained parser difference, second worker crash, generated asset drift, blank Canvas/SVG, leaked worker process, missing license, or performance regression beyond the approved gate blocks completion.
