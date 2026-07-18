# -*- coding: utf-8 -*-
from pathlib import Path

from PySide6.QtGui import QColor
from PySide6.QtWidgets import QLabel, QStackedLayout, QVBoxLayout, QWidget
from PySide6.QtCore import Qt, QUrl
from PySide6.QtWebChannel import QWebChannel

from src.presentation.gui.widgets.waveform_bridge import WaveformBridge
from src.presentation.gui.widgets.waveform_html import _build_empty_waveform_html

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
except Exception:  # pragma: no cover - depends on optional QtWebEngine install
    QWebEngineView = None


class WaveformViewerPanel(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._view = None
        self._bridge = None
        self._channel = None
        self._page_loaded = False
        self._pending_file = None
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
            self._bridge = WaveformBridge(self)
            self._channel = QWebChannel(self._view.page())
            self._channel.registerObject("waveformBridge", self._bridge)
            self._view.page().setWebChannel(self._channel)
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
        if not self._page_loaded:
            self._stack.setCurrentWidget(self._loading)
            self._view.setHtml(
                _build_empty_waveform_html(),
                QUrl.fromLocalFile(str(Path.cwd())),
            )
        elif self._bridge is not None:
            self._bridge.post_message({"type": "empty", "generation": 0})

    def open_vcd(self, wave_file: Path) -> None:
        if not self.available:
            self._fallback.setText(
                "Built-in waveform viewer requires PySide6 QtWebEngine. "
                f"Cannot preview: {wave_file}"
            )
            return

        wave_file = Path(wave_file).resolve()
        self._pending_file = wave_file
        self._loading.setText(f"Loading waveform:\n{wave_file}")
        if not self._page_loaded:
            self._stack.setCurrentWidget(self._loading)
            return
        self._stack.setCurrentWidget(self._view)
        self._bridge.open_file(wave_file)
        self._pending_file = None

    def _on_load_started(self) -> None:
        if self.available:
            self._stack.setCurrentWidget(self._loading)

    def _on_load_finished(self, ok: bool) -> None:
        if not self.available:
            return
        if ok:
            self._page_loaded = True
            self._stack.setCurrentWidget(self._view)
            if self._pending_file is not None:
                wave_file = self._pending_file
                self._pending_file = None
                self._bridge.open_file(wave_file)
        else:
            self._loading.setText("Failed to load waveform preview.")
            self._stack.setCurrentWidget(self._loading)

    def closeEvent(self, event) -> None:
        if self._bridge is not None:
            self._bridge.close()
        super().closeEvent(event)

