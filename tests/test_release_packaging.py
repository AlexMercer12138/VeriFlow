import json
from pathlib import Path
from typing import List, Tuple

from scripts import run_release


ROOT = Path(__file__).resolve().parents[1]
VSCODE_PACKAGE = ROOT / "veriflow-vscode" / "package.json"
ROOT_VSCODE_BUILD = ROOT / "scripts" / "build-vscode.mjs"
README = ROOT / "README.md"


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
        (["pyinstaller", "VeriFlow.spec", "--noconfirm"], ROOT),
        (["pyinstaller", "VeriFlow-cli.spec", "--noconfirm"], ROOT),
        (
            ["npm", "run", "package", "--workspace", "veriflow-vscode"],
            ROOT,
        ),
    ]


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
