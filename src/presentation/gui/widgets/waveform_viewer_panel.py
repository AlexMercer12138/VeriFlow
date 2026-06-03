# -*- coding: utf-8 -*-
import json
import sys
from pathlib import Path

from PySide6.QtGui import QColor
from PySide6.QtWidgets import QLabel, QStackedLayout, QVBoxLayout, QWidget
from PySide6.QtCore import Qt, QUrl

from src.domain.services.vcd_parser_service import VcdData, VcdParserService

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
except Exception:  # pragma: no cover - depends on optional QtWebEngine install
    QWebEngineView = None


class WaveformViewerPanel(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._parser = VcdParserService()
        self._view = None
        self._fallback = QLabel()
        self._fallback.setWordWrap(True)
        self._loading = QLabel("No waveform file opened.")
        self._loading.setWordWrap(True)
        self._loading.setAlignment(Qt.AlignCenter)
        self._loading.setStyleSheet(
            "background: #111318; color: #8b949e; padding: 24px;"
        )

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        if QWebEngineView is not None:
            self._view = QWebEngineView()
            self._view.setStyleSheet("background: #111318;")
            self._view.page().setBackgroundColor(QColor("#111318"))
            self._view.loadStarted.connect(self._on_load_started)
            self._view.loadFinished.connect(self._on_load_finished)

            self._stack = QStackedLayout()
            self._stack.addWidget(self._loading)
            self._stack.addWidget(self._view)
            layout.addLayout(self._stack, 1)
            self.show_empty()
        else:
            layout.addWidget(self._fallback, 1)
            self._fallback.setText(
                "Built-in waveform viewer requires PySide6 QtWebEngine. "
                "Install PySide6-WebEngine or use Surfer/GTKWave."
            )

    @property
    def available(self) -> bool:
        return self._view is not None

    def show_empty(self) -> None:
        if not self.available:
            return
        self._loading.setText("No waveform file opened.")
        self._stack.setCurrentWidget(self._loading)
        self._view.setHtml(
            _build_empty_waveform_html(),
            QUrl.fromLocalFile(str(Path.cwd())),
        )

    def open_vcd(self, wave_file: Path) -> None:
        if not self.available:
            self._fallback.setText(
                "Built-in waveform viewer requires PySide6 QtWebEngine. "
                f"Cannot preview: {wave_file}"
            )
            return

        content = wave_file.read_text(encoding="utf-8", errors="ignore")
        data = self._parser.parse(content)
        self._loading.setText(f"Loading waveform:\n{wave_file}")
        self._stack.setCurrentWidget(self._loading)
        self._view.setHtml(
            _build_waveform_html(str(wave_file), data),
            QUrl.fromLocalFile(str(wave_file.parent)),
        )

    def _on_load_started(self) -> None:
        if self.available:
            self._stack.setCurrentWidget(self._loading)

    def _on_load_finished(self, ok: bool) -> None:
        if not self.available:
            return
        if ok:
            self._stack.setCurrentWidget(self._view)
        else:
            self._loading.setText("Failed to load waveform preview.")
            self._stack.setCurrentWidget(self._loading)


def _to_web_data(data: VcdData) -> dict:
    return {
        "version": data.version,
        "date": data.date,
        "timescale": data.timescale,
        "startTime": data.start_time,
        "endTime": data.end_time,
        "scopes": [
            {
                "name": scope.name,
                "fullName": scope.full_name,
                "depth": scope.depth,
            }
            for scope in data.scopes
        ],
        "signals": [
            {
                "id": signal.id,
                "reference": signal.reference,
                "fullName": signal.full_name,
                "scope": signal.scope,
                "type": signal.type,
                "width": signal.width,
                "changes": [
                    {"time": change.time, "value": change.value}
                    for change in signal.changes
                ],
            }
            for signal in data.signals
        ],
        "warnings": [
            {"line": warning.line, "message": warning.message}
            for warning in data.warnings
        ],
    }



def _waveform_assets_dir() -> Path:
    if hasattr(sys, "_MEIPASS"):
        bundled = Path(sys._MEIPASS) / "veriflow-vscode" / "media" / "waveform"
        if bundled.exists():
            return bundled
    return Path(__file__).resolve().parents[4] / "veriflow-vscode" / "media" / "waveform"


def _read_asset(name: str) -> str:
    return (_waveform_assets_dir() / name).read_text(encoding="utf-8")


def _build_waveform_html(file_name: str, data: VcdData) -> str:
    payload = json.dumps(
        {"type": "vcd", "fileName": file_name, "data": _to_web_data(data)},
        ensure_ascii=False,
    )
    css = _read_asset("viewer.css")
    body = _read_asset("viewer.html")
    script = _read_asset("viewer.js").replace(
        "const vscode = acquireVsCodeApi();",
        "const vscode = { postMessage() {} };",
    ).replace(
        "vscode.postMessage({ type: 'ready' });",
        "",
    ).replace(
        "const bootstrap = ${stateJson};",
        "const bootstrap = {};",
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VeriFlow Waveform</title>
<style>
{css}
</style>
</head>
<body>
{body}
<script>
{script}
window.addEventListener('load', () => {{
    window.postMessage({payload}, '*');
}});
</script>
</body>
</html>"""


def _build_empty_waveform_html() -> str:
    css = _read_asset("viewer.css")
    body = _read_asset("viewer.html")
    script = _read_asset("viewer.js").replace(
        "const vscode = acquireVsCodeApi();",
        "const vscode = { postMessage() {} };",
    ).replace(
        "vscode.postMessage({ type: 'ready' });",
        "",
    ).replace(
        "const bootstrap = ${stateJson};",
        "const bootstrap = {};",
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VeriFlow Waveform</title>
<style>
{css}
</style>
</head>
<body>
{body}
<script>
{script}
window.addEventListener('load', () => {{
    window.postMessage({{"type": "empty"}}, '*');
}});
</script>
</body>
</html>"""
