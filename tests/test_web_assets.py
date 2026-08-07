from pathlib import Path

from src.presentation.gui.widgets.waveform_html import _waveform_assets_dir


def test_source_waveform_assets_use_canonical_web_dist() -> None:
    root = Path(__file__).resolve().parents[1]
    assert _waveform_assets_dir() == root / "web-dist" / "waveform"


def test_pyinstaller_collects_canonical_waveform_assets() -> None:
    root = Path(__file__).resolve().parents[1]
    spec = (root / "VeriFlow.spec").read_text(encoding="utf-8")
    assert "('web-dist/waveform', 'web-dist/waveform')" in spec
    assert "veriflow-vscode/media/waveform" not in spec


def test_ci_builds_generated_vscode_media_before_extension_tests() -> None:
    root = Path(__file__).resolve().parents[1]
    workflow = (root / ".github" / "workflows" / "ci.yml").read_text(
        encoding="utf-8"
    )
    build_command = "npm run build:vscode"
    test_command = "npm test --workspace veriflow-vscode"

    assert build_command in workflow
    assert workflow.index(build_command) < workflow.index(test_command)
