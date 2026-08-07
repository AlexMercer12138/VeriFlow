import ast
import ctypes
import csv
import hashlib
import importlib
import importlib.metadata
import importlib.util
import io
import json
import os
import shlex
import struct
import subprocess
import sys
import sysconfig
import time
import zipfile
from copy import deepcopy
from ctypes import wintypes
from pathlib import Path
from types import ModuleType
from typing import List, Tuple

import pytest
import yaml

from scripts import build_parser_probe_wheel as wheel_builder
from scripts.worker_wheel_provenance import (
    verify_installed_worker_provenance_from_env,
)


pytestmark = pytest.mark.skipif(
    sys.platform != "win32",
    reason="Parser worker packaging and Windows process checks require Windows",
)


ROOT = Path(__file__).resolve().parents[1]
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
README_SOURCE = ROOT / "README.md"
PYPROJECT_SOURCE = ROOT / "pyproject.toml"
FEASIBILITY_DOC = ROOT / "docs" / "architecture" / "hdl-runtime-feasibility.md"
PARSER_SOURCE_TEST = ROOT / "packages" / "parser-worker" / "src" / "probe.test.ts"
SEA_SMOKE_SOURCE = ROOT / "scripts" / "smoke-parser-probe.mjs"
PACKAGE_ROOT = ROOT / "python-packages" / "veriflow-hdl-worker"
RUNTIME_SOURCE = PACKAGE_ROOT / "src" / "veriflow_hdl_worker" / "runtime.py"
ENTRY_SOURCE = ROOT / "scripts" / "parser_probe_entry.py"
PROVENANCE_SOURCE = ROOT / "scripts" / "worker_wheel_provenance.py"
PYINSTALLER_SPEC = ROOT / "ParserProbe.spec"
REQUIRE_WORKER_ENV = "VERIFLOW_REQUIRE_INSTALLED_WORKER"


def test_windows_ci_runs_real_worker_before_python_tests() -> None:
    workflow = yaml.safe_load(CI_WORKFLOW.read_text(encoding="utf-8"))
    wheel_install_command = (
        "python -m pip install --force-reinstall --no-deps $wheelPath"
    )
    packaging_tool_pins = (
        "build==1.5.0",
        "setuptools==82.0.1",
        "wheel==0.46.3",
        "pyinstaller==6.19.0",
        "pytest==9.0.3",
        "PyYAML==6.0.3",
    )

    def named_steps(job: dict) -> Tuple[List[dict], List[str], dict]:
        steps = job["steps"]
        assert all(isinstance(step, dict) and "name" in step for step in steps)
        step_names = [step["name"] for step in steps]
        step_by_name = {step["name"]: step for step in steps}
        assert len(step_by_name) == len(steps)
        return steps, step_names, step_by_name

    def run_lines(step: dict) -> List[str]:
        run = step["run"]
        assert isinstance(run, str)
        return [line.strip() for line in run.splitlines() if line.strip()]

    def assert_contract(document: dict) -> None:
        jobs = document["jobs"]
        assert jobs["python"]["runs-on"] == "ubuntu-latest"
        windows_job = jobs["hdl-runtime-feasibility"]
        steps, step_names, step_by_name = named_steps(windows_job)

        assert windows_job["runs-on"] == "windows-latest"
        assert step_by_name["Set up Node"]["uses"] == "actions/setup-node@v4"
        assert step_by_name["Set up Node"]["with"]["node-version"] == "24.14.1"
        assert step_by_name["Set up Python"]["uses"] == "actions/setup-python@v5"
        assert step_by_name["Set up Python"]["with"]["python-version"] == "3.11"
        assert step_by_name["Install workspace dependencies"]["run"] == "npm ci"
        assert (
            step_by_name["Test parser worker source"]["run"]
            == "npm test --workspace @veriflow/parser-worker"
        )
        assert step_by_name["Build parser SEA probe"]["run"] == "npm run build:parser"
        assert (
            step_by_name["Smoke real parser SEA probe"]["run"]
            == "node scripts/smoke-parser-probe.mjs"
        )

        worker_wheel_step = step_by_name["Build and install worker wheel"]
        worker_wheel_source = worker_wheel_step["run"]
        worker_wheel_commands = run_lines(worker_wheel_step)
        assert ["python", "-m", "pip", "install", *packaging_tool_pins] in [
            shlex.split(command)
            for command in worker_wheel_commands
            if command.startswith("python -m pip install")
        ]
        assert "python scripts/build_parser_probe_wheel.py" in worker_wheel_commands
        assert wheel_install_command in worker_wheel_commands
        worker_wheel_sequence = (
            "python scripts/build_parser_probe_wheel.py",
            'Resolve-Path "python-packages/veriflow-hdl-worker/dist"',
            "$wheelPath = [System.IO.Path]::GetFullPath($wheels[0].FullName)",
            "$wheelSha256 = (Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256)",
            '"VERIFLOW_HDL_WORKER_WHEEL_PATH=$wheelPath" | Out-File',
            '"VERIFLOW_HDL_WORKER_WHEEL_SHA256=$wheelSha256" | Out-File',
            '"VERIFLOW_REQUIRE_INSTALLED_WORKER=1" | Out-File',
            wheel_install_command,
        )
        assert all(command in worker_wheel_source for command in worker_wheel_sequence)
        assert [
            worker_wheel_source.index(command) for command in worker_wheel_sequence
        ] == sorted(
            worker_wheel_source.index(command) for command in worker_wheel_sequence
        )
        assert (
            "python -m pytest tests/test_parser_probe_package.py "
            "tests/test_worker_wheel_provenance.py -v"
            in run_lines(step_by_name["Run worker package tests"])
        )

        required_order = [
            "Install workspace dependencies",
            "Test parser worker source",
            "Build parser SEA probe",
            "Smoke real parser SEA probe",
            "Build and install worker wheel",
            "Run worker package tests",
            "Verify PyInstaller collection",
        ]
        assert [step_names.index(name) for name in required_order] == sorted(
            step_names.index(name) for name in required_order
        )

        pyinstaller_commands = run_lines(step_by_name["Verify PyInstaller collection"])
        assert step_names[-1] == "Verify PyInstaller collection"
        assert "python -m PyInstaller --clean --noconfirm ParserProbe.spec" in (
            pyinstaller_commands
        )
        assert '$probePath = (Resolve-Path "dist/parser-probe.exe").Path' in (
            pyinstaller_commands
        )
        assert "& $probePath" in pyinstaller_commands

        _vscode_steps, vscode_names, _vscode_by_name = named_steps(jobs["vscode"])
        assert vscode_names.index(
            "Install workspace dependencies"
        ) < vscode_names.index("Build generated extension assets")
        assert vscode_names.index("Build generated extension assets") < vscode_names.index(
            "Test extension core"
        )

    assert_contract(workflow)

    smoke_reordered = deepcopy(workflow)
    smoke_steps = smoke_reordered["jobs"]["hdl-runtime-feasibility"]["steps"]
    smoke_names = [step["name"] for step in smoke_steps]
    build_index = smoke_names.index("Build parser SEA probe")
    smoke_index = smoke_names.index("Smoke real parser SEA probe")
    smoke_steps[build_index], smoke_steps[smoke_index] = (
        smoke_steps[smoke_index],
        smoke_steps[build_index],
    )
    with pytest.raises(AssertionError):
        assert_contract(smoke_reordered)

    pyinstaller_removed = deepcopy(workflow)
    pyinstaller_step = next(
        step
        for step in pyinstaller_removed["jobs"]["hdl-runtime-feasibility"]["steps"]
        if step["name"] == "Verify PyInstaller collection"
    )
    pyinstaller_step["run"] = pyinstaller_step["run"].replace(
        "python -m PyInstaller --clean --noconfirm ParserProbe.spec",
        "python -m removed-pyinstaller-command",
    )
    with pytest.raises(AssertionError):
        assert_contract(pyinstaller_removed)

    wheel_install_removed = deepcopy(workflow)
    wheel_step = next(
        step
        for step in wheel_install_removed["jobs"]["hdl-runtime-feasibility"]["steps"]
        if step["name"] == "Build and install worker wheel"
    )
    wheel_step["run"] = wheel_step["run"].replace(wheel_install_command, "")
    with pytest.raises(AssertionError):
        assert_contract(wheel_install_removed)

    source_test_removed = deepcopy(workflow)
    source_test_step = next(
        step
        for step in source_test_removed["jobs"]["hdl-runtime-feasibility"]["steps"]
        if step["name"] == "Test parser worker source"
    )
    source_test_step["run"] = "npm run removed-parser-worker-source-test"
    with pytest.raises(AssertionError):
        assert_contract(source_test_removed)


def test_feasibility_docs_match_pinned_ci_gate() -> None:
    pyproject_source = PYPROJECT_SOURCE.read_text(encoding="utf-8")
    readme_source = README_SOURCE.read_text(encoding="utf-8")
    feasibility_source = FEASIBILITY_DOC.read_text(encoding="utf-8")
    developer_source = readme_source.split("## Developer build commands", 1)[1]

    assert '"PyYAML==6.0.3"' in pyproject_source

    packaging_prerequisites = (
        "python -m pip install build==1.5.0 setuptools==82.0.1 wheel==0.46.3 "
        "pyinstaller==6.19.0 pytest==9.0.3 PyYAML==6.0.3"
    )
    readme_sequence = (
        "npm ci",
        "npm test --workspace @veriflow/parser-worker",
        "npm run build:parser",
        "node scripts/smoke-parser-probe.mjs",
        packaging_prerequisites,
        "python scripts/build_parser_probe_wheel.py",
    )
    assert all(command in developer_source for command in readme_sequence)
    assert [developer_source.index(command) for command in readme_sequence] == sorted(
        developer_source.index(command) for command in readme_sequence
    )
    assert "Windows x64" in developer_source
    assert "feasibility" in developer_source

    documented_gate_order = (
        "npm ci",
        "npm test --workspace @veriflow/parser-worker",
        "npm run build:parser",
        "node scripts/smoke-parser-probe.mjs",
    )
    assert all(command in feasibility_source for command in documented_gate_order)
    assert [
        feasibility_source.index(command) for command in documented_gate_order
    ] == sorted(feasibility_source.index(command) for command in documented_gate_order)
    assert "PyInstaller` | 6.19.0" in feasibility_source


def test_feasibility_probes_use_canonical_packaged_module() -> None:
    canonical_source = "module packaged; endmodule"
    javascript_source = f"source: '{canonical_source}'"

    assert javascript_source in PARSER_SOURCE_TEST.read_text(encoding="utf-8")
    assert javascript_source in SEA_SMOKE_SOURCE.read_text(encoding="utf-8")

    def function_strings(path: Path, function_name: str) -> List[str]:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        function = next(
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == function_name
        )
        return [
            node.value
            for node in ast.walk(function)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        ]

    assert canonical_source in function_strings(
        Path(wheel_builder.__file__), "_smoke_packaged_worker"
    )
    assert canonical_source in function_strings(
        Path(__file__), "test_real_worker_starts_without_a_visible_window"
    )

    entry_tree = ast.parse(ENTRY_SOURCE.read_text(encoding="utf-8"))
    entry_strings = [
        node.value
        for node in ast.walk(entry_tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    ]
    assert canonical_source in entry_strings


@pytest.fixture()
def installed_worker() -> Tuple[ModuleType, ModuleType]:
    if os.environ.get(REQUIRE_WORKER_ENV) == "1":
        try:
            verify_installed_worker_provenance_from_env()
        except (OSError, RuntimeError, ValueError) as error:
            pytest.fail(f"Dedicated packaging lane provenance failed: {error}")
    try:
        package = importlib.import_module("veriflow_hdl_worker")
        runtime = importlib.import_module("veriflow_hdl_worker.runtime")
    except ModuleNotFoundError as error:
        if error.name != "veriflow_hdl_worker":
            raise
        if os.environ.get(REQUIRE_WORKER_ENV) == "1":
            pytest.fail(f"Dedicated packaging lane requires the installed worker: {error}")
        pytest.skip("veriflow-hdl-worker is not installed in the default source test lane")
    return package, runtime


def _load_source_module(
    monkeypatch: pytest.MonkeyPatch, path: Path, name: str
) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module


def test_runtime_paths_resolve_packaged_assets(
    installed_worker: Tuple[ModuleType, ModuleType],
) -> None:
    package, runtime = installed_worker
    paths = runtime.runtime_paths()
    package_root = Path(package.__file__).resolve().parent

    assert package_root.parent == Path(sysconfig.get_path("purelib")).resolve()
    assert paths.executable.is_file()
    assert paths.web_tree_sitter_wasm.is_file()
    assert paths.system_verilog_wasm.is_file()
    assert paths.manifest.is_file()
    for runtime_path in (
        paths.executable,
        paths.web_tree_sitter_wasm,
        paths.system_verilog_wasm,
        paths.manifest,
    ):
        assert runtime_path.resolve().parent == package_root / "bin"

    manifest = json.loads(paths.manifest.read_text(encoding="utf-8"))
    assert manifest["protocolVersion"] == 1


def test_startup_info_hides_the_worker_window(
    installed_worker: Tuple[ModuleType, ModuleType],
) -> None:
    _package, runtime = installed_worker
    assert runtime.startup_info()["creationflags"] & subprocess.CREATE_NO_WINDOW


def test_runtime_source_uses_the_resource_backport_on_python_38(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runtime = _load_source_module(monkeypatch, RUNTIME_SOURCE, "_runtime_source_contract")
    package_root = tmp_path / "installed-package"
    fake_backport = ModuleType("importlib_resources")
    fake_backport.files = lambda package: package_root
    monkeypatch.setitem(sys.modules, "importlib_resources", fake_backport)
    monkeypatch.delattr(runtime.importlib.resources, "files", raising=False)

    paths = runtime.runtime_paths()

    assert paths.executable == package_root / "bin" / "parser-worker.exe"


def test_python_38_resource_backport_is_declared_in_source() -> None:
    pyproject = (PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert "importlib-resources>=5.10; python_version < '3.9'" in pyproject


def test_installed_wheel_declares_python_38_backport(
    installed_worker: Tuple[ModuleType, ModuleType],
) -> None:
    _package, _runtime = installed_worker
    requirements = importlib.metadata.requires("veriflow-hdl-worker") or []
    assert 'importlib-resources>=5.10; python_version < "3.9"' in requirements


def _create_junction(link: Path, target: Path) -> None:
    result = os.system(f'cmd.exe /d /c mklink /J "{link}" "{target}" >NUL 2>NUL')
    assert result == 0


def test_package_bin_junction_is_refused_without_touching_target(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    package_root = tmp_path / "package"
    package_bin = package_root / "src" / "veriflow_hdl_worker" / "bin"
    package_bin.parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    _create_junction(package_bin, outside)
    monkeypatch.setattr(wheel_builder, "PACKAGE_ROOT", package_root)
    monkeypatch.setattr(wheel_builder, "PACKAGE_BIN", package_bin)

    refusal = None
    try:
        try:
            wheel_builder._clean_outputs()
        except ValueError as error:
            refusal = error
    finally:
        if os.path.lexists(package_bin):
            os.rmdir(package_bin)

    assert sentinel.is_file()
    assert refusal is not None
    assert "reparse" in str(refusal).lower() or "junction" in str(refusal).lower()


def test_safe_remove_refuses_directory_replaced_at_operation_boundary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    package_root = tmp_path / "package"
    package_root.mkdir()
    build_root = package_root / "build"
    build_root.mkdir()
    payload = build_root / "payload.txt"
    payload.write_text("package build", encoding="utf-8")
    original_build = package_root / "build-before-swap"
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel.txt"
    sentinel.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(wheel_builder, "PACKAGE_ROOT", package_root)
    original_is_reparse = wheel_builder._is_reparse_point
    build_checks = 0

    def swap_after_final_preflight(path: Path) -> bool:
        nonlocal build_checks
        result = original_is_reparse(path)
        if Path(path) == build_root:
            build_checks += 1
            if build_checks == 2:
                build_root.rename(original_build)
                _create_junction(build_root, outside)
        return result

    monkeypatch.setattr(wheel_builder, "_is_reparse_point", swap_after_final_preflight)
    refusal = None
    try:
        try:
            wheel_builder._safe_remove_path(build_root)
        except ValueError as error:
            refusal = error
    finally:
        if os.path.lexists(build_root):
            os.rmdir(build_root)

    assert sentinel.is_file()
    assert (original_build / "payload.txt").is_file()
    assert refusal is not None
    assert "reparse" in str(refusal).lower() or "junction" in str(refusal).lower()


def test_safe_remove_retries_transient_windows_rename_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    package_root = tmp_path / "package"
    package_root.mkdir()
    build_root = package_root / "build"
    build_root.mkdir()
    (build_root / "payload.txt").write_text("remove", encoding="utf-8")
    monkeypatch.setattr(wheel_builder, "PACKAGE_ROOT", package_root)
    original_replace = wheel_builder.os.replace
    attempts = 0

    def transient_replace(source: Path, destination: Path) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise PermissionError("simulated Windows sharing violation")
        original_replace(source, destination)

    monkeypatch.setattr(wheel_builder.os, "replace", transient_replace)

    wheel_builder._safe_remove_path(build_root)

    assert attempts == 2
    assert not build_root.exists()


def _write_test_pe(path: Path, machine: int = 0x8664, magic: int = 0x20B) -> None:
    image = bytearray(512)
    image[0:2] = b"MZ"
    pe_offset = 0x80
    struct.pack_into("<I", image, 0x3C, pe_offset)
    image[pe_offset : pe_offset + 4] = b"PE\0\0"
    struct.pack_into(
        "<HHIIIHH",
        image,
        pe_offset + 4,
        machine,
        1,
        0,
        0,
        0,
        0xF0,
        0,
    )
    struct.pack_into("<H", image, pe_offset + 24, magic)
    path.write_bytes(image)


def test_pe_validation_rejects_truncated_mz_file(tmp_path: Path) -> None:
    executable = tmp_path / "fake.exe"
    executable.write_bytes(b"MZ")

    with pytest.raises(ValueError, match="DOS|header|truncated"):
        wheel_builder._validate_pe_executable(executable)


@pytest.mark.parametrize(
    ("machine", "magic", "message"),
    [
        (0x014C, 0x20B, "AMD64|8664|machine"),
        (0x8664, 0x10B, r"PE32\+|20b|optional"),
    ],
    ids=("x86-machine", "pe32-magic"),
)
def test_pe_validation_rejects_incompatible_windows_image(
    tmp_path: Path, machine: int, magic: int, message: str
) -> None:
    executable = tmp_path / "incompatible.exe"
    _write_test_pe(executable, machine=machine, magic=magic)

    with pytest.raises(ValueError, match=message):
        wheel_builder._validate_pe_executable(executable)


def test_pe_validation_accepts_amd64_pe32_plus(tmp_path: Path) -> None:
    executable = tmp_path / "amd64.exe"
    _write_test_pe(executable)

    assert wheel_builder._validate_pe_executable(executable) == 0x8664


def test_pe_validation_rejects_truncated_declared_section_table(tmp_path: Path) -> None:
    executable = tmp_path / "truncated-sections.exe"
    _write_test_pe(executable)
    optional_header_end = 0x80 + 24 + 0xF0
    executable.write_bytes(executable.read_bytes()[:optional_header_end])

    with pytest.raises(ValueError, match="section"):
        wheel_builder._validate_pe_executable(executable)


def test_build_tool_versions_and_epoch_are_pinned() -> None:
    pyproject = (PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'requires = ["setuptools==82.0.1", "wheel==0.46.3"]' in pyproject
    assert wheel_builder.EXPECTED_BUILD_TOOLS == {
        "build": "1.5.0",
        "setuptools": "82.0.1",
        "wheel": "0.46.3",
    }
    assert int(wheel_builder.REPRODUCIBLE_BUILD_EPOCH) >= 315532800


def test_strict_lane_and_pyinstaller_share_provenance_helper() -> None:
    assert PROVENANCE_SOURCE.is_file()
    test_source = Path(__file__).read_text(encoding="utf-8")
    spec_source = PYINSTALLER_SPEC.read_text(encoding="utf-8")
    helper_call = "verify_installed_worker_provenance_from_env"

    assert helper_call in test_source
    assert helper_call in spec_source


def test_pyinstaller_spec_resolves_helpers_from_specpath() -> None:
    spec_source = PYINSTALLER_SPEC.read_text(encoding="utf-8")
    helper_import = "from scripts.worker_wheel_provenance import"

    assert "SPECPATH" in spec_source
    assert "sys.path.insert" in spec_source
    assert spec_source.index("SPECPATH") < spec_source.index(helper_import)
    assert spec_source.index("sys.path.insert") < spec_source.index(helper_import)


def test_reproducibility_builds_use_independent_source_staging(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    package_root = tmp_path / "package"
    package_root.mkdir()
    stages = {
        label: package_root / "build" / f"{label}-source"
        for label in ("repro-first", "repro-second")
    }
    for stage in stages.values():
        stage.mkdir(parents=True)
    monkeypatch.setattr(wheel_builder, "PACKAGE_ROOT", package_root)
    monkeypatch.setattr(
        wheel_builder,
        "_stage_build_source",
        lambda label: stages[label],
        raising=False,
    )
    monkeypatch.setattr(wheel_builder, "_verify_wheel", lambda _path: None)
    build_cwds = []

    def fake_run(command, *, cwd: Path, env, check: bool) -> None:
        del env
        assert check is True
        cwd = Path(cwd)
        assert not (cwd / "build" / "cache-sentinel").exists()
        build_cwds.append(cwd)
        sentinel = cwd / "build" / "cache-sentinel"
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.touch()
        output_dir = Path(command[-1])
        (output_dir / wheel_builder.WHEEL_NAME).write_bytes(b"same wheel")

    monkeypatch.setattr(wheel_builder.subprocess, "run", fake_run)

    first_wheel = wheel_builder._build_once("repro-first")
    second_wheel = wheel_builder._build_once("repro-second")

    assert build_cwds == [stages["repro-first"], stages["repro-second"]]
    assert first_wheel.is_file()
    assert second_wheel.is_file()


def _write_synthetic_wheel(path: Path, dist_info: str) -> None:
    entries = {
        "veriflow_hdl_worker/__init__.py": b"source",
        "veriflow_hdl_worker/runtime.py": b"source",
        "veriflow_hdl_worker/bin/parser-worker.exe": b"runtime",
        "veriflow_hdl_worker/bin/web-tree-sitter.wasm": b"runtime",
        "veriflow_hdl_worker/bin/tree-sitter-systemverilog.wasm": b"runtime",
        "veriflow_hdl_worker/bin/manifest.json": b"runtime",
        dist_info + "METADATA": b"Name: veriflow-hdl-worker\nVersion: 1.3.2\n",
        dist_info + "WHEEL": (
            b"Wheel-Version: 1.0\nRoot-Is-Purelib: false\n"
            b"Tag: py3-none-win_amd64\n"
        ),
        dist_info + "top_level.txt": b"veriflow_hdl_worker\n",
    }
    record_name = dist_info + "RECORD"
    record_stream = io.StringIO(newline="")
    writer = csv.writer(record_stream, lineterminator="\n")
    for name, data in entries.items():
        writer.writerow([name, wheel_builder._record_digest(data), str(len(data))])
    writer.writerow([record_name, "", ""])
    entries[record_name] = record_stream.getvalue().encode("utf-8")

    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)


def test_wheel_verifier_rejects_wrong_dist_info_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    wheel = tmp_path / wheel_builder.WHEEL_NAME
    _write_synthetic_wheel(wheel, "other_name-9.9.dist-info/")
    runtime_hash = hashlib.sha256(b"runtime").hexdigest()
    monkeypatch.setattr(wheel_builder, "_sha256", lambda path: runtime_hash)

    with pytest.raises(ValueError, match="dist-info"):
        wheel_builder._verify_wheel(wheel)


def test_entry_source_has_no_top_level_worker_import() -> None:
    tree = ast.parse(ENTRY_SOURCE.read_text(encoding="utf-8"))
    worker_imports = [
        node
        for node in tree.body
        if isinstance(node, ast.ImportFrom)
        and node.module is not None
        and node.module.startswith("veriflow_hdl_worker")
    ]
    assert worker_imports == []


def test_entry_timeout_kills_reaps_and_preserves_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = _load_source_module(
        monkeypatch, ENTRY_SOURCE, "_parser_probe_entry_contract"
    )
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import sys,time; "
                "sys.stdout.write('ready\\n'); sys.stdout.flush(); "
                "sys.stdin.readline(); "
                "sys.stdout.write('partial stdout'); sys.stdout.flush(); "
                "sys.stderr.write('partial stderr'); sys.stderr.flush(); "
                "time.sleep(60)"
            ),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        assert child.stdout is not None
        assert child.stdout.readline() == "ready\n"
        with pytest.raises(RuntimeError, match="timed out") as failure:
            entry._communicate_with_timeout(
                child,
                "request\n",
                timeout=1,
                cleanup_timeout=5,
            )
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=5)

    assert "partial stdout" in str(failure.value)
    assert "partial stderr" in str(failure.value)
    assert child.poll() is not None
    assert child.stdout is not None and child.stdout.closed
    assert child.stderr is not None and child.stderr.closed


def _visible_windows_for_process(process_id: int) -> List[int]:
    visible_windows = []
    callback_type = ctypes.WINFUNCTYPE(
        wintypes.BOOL, wintypes.HWND, wintypes.LPARAM
    )
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    ]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD

    def collect_window(window: int, _parameter: int) -> bool:
        window_process_id = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(window_process_id))
        if window_process_id.value == process_id and user32.IsWindowVisible(window):
            visible_windows.append(window)
        return True

    callback = callback_type(collect_window)
    if not user32.EnumWindows(callback, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return visible_windows


def test_real_worker_starts_without_a_visible_window(
    installed_worker: Tuple[ModuleType, ModuleType],
) -> None:
    _package, runtime = installed_worker
    paths = runtime.runtime_paths()
    process = subprocess.Popen(
        [str(paths.executable)],
        cwd=paths.executable.parent,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        **runtime.startup_info(),
    )
    try:
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                pytest.fail(
                    f"Worker exited during window polling: stdout={stdout!r}, stderr={stderr!r}"
                )
            assert _visible_windows_for_process(process.pid) == []
            time.sleep(0.05)

        request = {
            "protocolVersion": 1,
            "requestId": "python-hidden-window",
            "type": "probe",
            "payload": {"source": "module packaged; endmodule"},
        }
        stdout, stderr = process.communicate(json.dumps(request) + "\n", timeout=10)

        assert process.returncode == 0
        assert stderr == ""
        lines = stdout.splitlines()
        assert len(lines) == 1
        response = json.loads(lines[0])
        assert response["protocolVersion"] == 1
        assert response["requestId"] == "python-hidden-window"
        assert response["type"] == "probe"
        assert response["ok"] is True
        assert response["payload"] == {
            "rootType": "source_file",
            "containsModule": True,
            "languageAbi": 15,
        }
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


def test_parser_probe_entry_uses_the_installed_worker(
    installed_worker: Tuple[ModuleType, ModuleType], tmp_path: Path
) -> None:
    _package, runtime = installed_worker
    result = subprocess.run(
        [sys.executable, "-I", str(ENTRY_SOURCE)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=15,
        **runtime.startup_info(),
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == ""
    assert result.stderr == ""
