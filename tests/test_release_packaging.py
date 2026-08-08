import json
import tomllib
from pathlib import Path
from typing import List, Tuple

import yaml

from scripts import run_release


ROOT = Path(__file__).resolve().parents[1]
VSCODE_PACKAGE = ROOT / "veriflow-vscode" / "package.json"
ROOT_VSCODE_BUILD = ROOT / "scripts" / "build-vscode.mjs"
README = ROOT / "README.md"
CLI_MAIN = ROOT / "packages" / "cli" / "src" / "main.ts"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
CHANGELOG = ROOT / "veriflow-vscode" / "CHANGELOG.md"
PUBLISHABLE_WORKSPACES = {
    "packages/flow-core/package.json",
    "packages/hdl-core/package.json",
    "packages/hdl-runtime/package.json",
    "packages/waveform-runtime/package.json",
    "packages/waveform-desktop/package.json",
    "packages/cli/package.json",
}


def test_package_release_uses_root_workspace_boundary(monkeypatch) -> None:
    calls: List[Tuple[List[str], Path]] = []

    monkeypatch.setattr(run_release, "ensure_versions_match", lambda: "1.3.2")

    def record_run(
        command: List[str],
        cwd: Path = run_release.ROOT,
        suppress_crlf_warnings: bool = False,
    ) -> None:
        assert not suppress_crlf_warnings
        calls.append((command, cwd))

    monkeypatch.setattr(run_release, "run", record_run)

    run_release.package_release()

    assert calls == [
        (["npm", "run", "pack:node"], ROOT),
        (["pyinstaller", "VeriFlow.spec", "--noconfirm"], ROOT),
        (["pyinstaller", "VeriFlow-cli.spec", "--noconfirm"], ROOT),
        (
            ["npm", "run", "package", "--workspace", "veriflow-vscode"],
            ROOT,
        ),
    ]


def test_release_check_covers_all_products(monkeypatch) -> None:
    calls: List[Tuple[List[str], Path]] = []
    monkeypatch.setattr(run_release, "ensure_versions_match", lambda: "1.3.2")
    monkeypatch.setattr(run_release, "ensure_changelog_has_version", lambda _version: None)

    def record_run(
        command: List[str],
        cwd: Path = run_release.ROOT,
        suppress_crlf_warnings: bool = False,
    ) -> None:
        calls.append((command, cwd))

    monkeypatch.setattr(run_release, "run", record_run)

    run_release.release_check()

    assert calls == [
        ([run_release.sys.executable, "-m", "pytest"], ROOT),
        (["npm", "run", "typecheck:shared"], ROOT),
        (["npm", "run", "test:shared"], ROOT),
        (["npm", "test", "--workspace", "@veriflow/cli"], ROOT),
        (["npm", "test", "--workspace", "@veriflow/waveform-desktop"], ROOT),
        (["npm", "test", "--workspace", "veriflow-vscode"], ROOT),
        (["npm", "run", "test:release"], ROOT),
        (["npm", "run", "verify:generated"], ROOT),
        (["git", "diff", "--check"], ROOT),
        (["git", "status", "--short", "--branch"], ROOT),
    ]


def test_shared_typecheck_builds_dependency_outputs_first() -> None:
    root_manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    assert root_manifest["scripts"]["typecheck:shared"].startswith(
        "npm run build:shared && "
    )


def test_shared_package_consumers_build_dependency_outputs_first() -> None:
    root_manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    scripts = root_manifest["scripts"]

    assert scripts["build:vscode"].startswith("npm run build:shared && ")
    assert scripts["build:desktop"].startswith("npm run build:shared && ")


def test_parser_sea_accepts_the_published_node_engine_range() -> None:
    root_manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    build_source = (ROOT / "scripts" / "build-parser-probe.mjs").read_text(
        encoding="utf-8"
    )

    assert root_manifest["engines"]["node"] == ">=24.14.1"
    assert (
        "workspaceMetadata.engines?.node !== "
        "`>=${expectedNodeVersion.slice(1)}`"
    ) in build_source


def test_release_versions_cover_root_and_all_workspaces() -> None:
    versions = run_release.read_versions()

    assert "package.json" in versions
    assert "src/version.py" in versions
    assert "pyproject.toml" in versions
    assert "veriflow-vscode/package.json" in versions
    assert PUBLISHABLE_WORKSPACES <= versions.keys()
    assert set(versions.values()) == {"1.3.2"}


def test_node_cli_version_comes_from_its_package_manifest() -> None:
    source = CLI_MAIN.read_text(encoding="utf-8")

    assert "require('@veriflow/cli/package.json')" in source
    assert "const VERSION = '" not in source


def test_python_console_scripts_use_deprecated_entrypoints() -> None:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["scripts"] == {
        "veriflow": "src.presentation.cli:deprecated_main",
        "veriflow-gui": "src.presentation.gui.__main__:deprecated_main",
    }


def test_python_cli_deprecation_wrapper_preserves_exit_code(monkeypatch, capsys) -> None:
    from src.presentation import cli

    monkeypatch.setattr(cli, "main", lambda: 7)

    assert cli.deprecated_main() == 7
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Python CLI is deprecated" in captured.err
    assert "@veriflow/cli" in captured.err


def test_ci_builds_and_smokes_release_artifacts() -> None:
    workflow_source = CI_WORKFLOW.read_text(encoding="utf-8")
    workflow = yaml.safe_load(workflow_source)
    install_smoke = workflow["jobs"]["node-install-smoke"]
    smoke_commands = [
        step["run"]
        for step in install_smoke["steps"]
        if "run" in step
    ]

    assert install_smoke["runs-on"] == "${{ matrix.os }}"
    assert set(install_smoke["strategy"]["matrix"]["os"]) == {
        "ubuntu-latest",
        "windows-latest",
        "macos-latest",
    }
    assert "npm ci" in smoke_commands
    assert "npm run test:release" in smoke_commands

    assert "node-release:" in workflow_source
    assert "npm run typecheck:shared" in workflow_source
    assert "npm run test:shared" in workflow_source
    assert "npm test --workspace @veriflow/cli" in workflow_source
    assert "xvfb-run -a npm test --workspace @veriflow/waveform-desktop" in workflow_source
    assert "npm run test:release" in workflow_source
    assert "npm run pack:node" in workflow_source
    assert "npm run package --workspace veriflow-vscode" in workflow_source
    assert "dist/npm/*.tgz" in workflow_source
    assert "veriflow-vscode/*.vsix" in workflow_source


def test_publishable_node_packages_declare_supported_engine() -> None:
    root_manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert root_manifest["engines"] == {"node": ">=24.14.1"}

    for relative_manifest in PUBLISHABLE_WORKSPACES:
        manifest = json.loads((ROOT / relative_manifest).read_text(encoding="utf-8"))
        assert manifest["engines"] == root_manifest["engines"], relative_manifest


def test_readme_makes_node_cli_the_default_and_marks_python_deprecated() -> None:
    readme = README.read_text(encoding="utf-8")

    assert "npm install --global @veriflow/cli" in readme
    assert "Node.js 24.14.1+" in readme
    assert "Node CLI 和 VS Code 扩展是持续维护的产品形态" in readme
    assert "Python GUI/CLI 已弃用" in readme
    assert "dist/npm/*.tgz" in readme


def test_deprecation_release_is_recorded_without_retiring_python_early() -> None:
    changelog = CHANGELOG.read_text(encoding="utf-8")
    gui_spec = (ROOT / "VeriFlow.spec").read_text(encoding="utf-8")
    cli_spec = (ROOT / "VeriFlow-cli.spec").read_text(encoding="utf-8")

    assert "## [Unreleased]" in changelog
    assert "Node CLI" in changelog
    assert "Python GUI/CLI" in changelog
    assert "retirement gate" in gui_spec
    assert "retirement gate" in cli_spec


def test_vscode_packaging_lifecycle_uses_root_web_asset_orchestration() -> None:
    package = json.loads(VSCODE_PACKAGE.read_text(encoding="utf-8"))
    scripts = package["scripts"]

    assert scripts["vscode:prepublish"] == (
        "npm run compile:ts && node ../scripts/build-vscode.mjs"
    )
    assert scripts["bundle"] == "node ./scripts/build.mjs"
    assert scripts["package"] == "vsce package --no-dependencies"
    assert scripts["publish"] == "vsce publish --no-dependencies"

    root_build_source = ROOT_VSCODE_BUILD.read_text(encoding="utf-8")
    assert "veriflow-vscode" in root_build_source
    assert "scripts/build.mjs" in root_build_source
    assert "vscode:prepublish" not in root_build_source
    assert "npm run package" not in root_build_source


def test_readme_uses_root_single_lock_vsix_workflow() -> None:
    readme = README.read_text(encoding="utf-8")
    section = readme.split("### 打包为 VSIX", 1)[1].split("\n---", 1)[0]

    assert section.index("npm ci") < section.index(
        "npm run package --workspace veriflow-vscode"
    )
    assert "cd veriflow-vscode" not in section
    assert "npm install" not in section
    assert "npm run compile" not in section
    assert "`vscode:prepublish`" in section
    assert "`scripts/build-vscode.mjs`" in section
    assert "`media`" in section
