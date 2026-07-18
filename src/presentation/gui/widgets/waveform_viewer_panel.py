# -*- coding: utf-8 -*-
from pathlib import Path

from PySide6.QtGui import QColor
from PySide6.QtWidgets import QLabel, QStackedLayout, QVBoxLayout, QWidget
from PySide6.QtCore import QFileSystemWatcher, QTimer, Qt, QUrl
from PySide6.QtWebChannel import QWebChannel

from src.presentation.gui.widgets.waveform_bridge import WaveformBridge
from src.presentation.gui.widgets.waveform_html import _build_empty_waveform_html

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
except Exception:  # pragma: no cover - depends on optional QtWebEngine install
    QWebEngineView = None


class WaveformViewerPanel(QWidget):
    def __init__(self, parent=None, *, bridge=None):
        super().__init__(parent)
        self._view = None
        self._bridge = bridge
        self._channel = None
        self._page_loaded = False
        self._pending_file = None
        self._watch_path = None
        self._stable_snapshot = None
        self._last_known_snapshot = None
        self._file_watcher = QFileSystemWatcher(self)
        self._file_watcher.fileChanged.connect(self._on_source_changed)
        self._file_watcher.directoryChanged.connect(self._on_source_directory_changed)
        self._stability_timer = QTimer(self)
        self._stability_timer.setSingleShot(True)
        self._stability_timer.setInterval(750)
        self._stability_timer.timeout.connect(self._observe_stable_file)
        self._confirmation_timer = QTimer(self)
        self._confirmation_timer.setSingleShot(True)
        self._confirmation_timer.setInterval(100)
        self._confirmation_timer.timeout.connect(self._confirm_stable_file)
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
            if self._bridge is None:
                self._bridge = WaveformBridge(self)
            elif self._bridge.parent() is None:
                self._bridge.setParent(self)
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
        self._watch_file(wave_file)
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

    @staticmethod
    def _file_snapshot(path: Path):
        stat = path.stat()
        return stat.st_size, stat.st_mtime_ns

    def _ensure_file_watch(self) -> None:
        if self._watch_path is None or not self._watch_path.exists():
            return
        watched = {Path(item) for item in self._file_watcher.files()}
        if self._watch_path not in watched:
            self._file_watcher.addPath(str(self._watch_path))

    def _watch_file(self, path: Path) -> None:
        if self._watch_path == path:
            self._ensure_file_watch()
            return
        watched_files = self._file_watcher.files()
        watched_directories = self._file_watcher.directories()
        if watched_files:
            self._file_watcher.removePaths(watched_files)
        if watched_directories:
            self._file_watcher.removePaths(watched_directories)
        self._watch_path = path
        self._stable_snapshot = None
        try:
            self._last_known_snapshot = self._file_snapshot(path)
        except OSError:
            self._last_known_snapshot = None
        self._file_watcher.addPath(str(path.parent))
        self._ensure_file_watch()

    def _on_source_changed(self, _changed_path: str = "") -> None:
        if self._watch_path is None:
            return
        if self._bridge is not None:
            self._bridge.cancel_loading()
        self._stable_snapshot = None
        self._confirmation_timer.stop()
        self._stability_timer.start()
        self._ensure_file_watch()

    def _on_source_directory_changed(self, _directory: str) -> None:
        if self._watch_path is None:
            return
        self._ensure_file_watch()
        try:
            snapshot = self._file_snapshot(self._watch_path)
        except OSError:
            snapshot = None
        if snapshot != self._last_known_snapshot:
            self._on_source_changed(str(self._watch_path))

    def _observe_stable_file(self) -> None:
        if self._watch_path is None:
            return
        try:
            self._stable_snapshot = self._file_snapshot(self._watch_path)
        except OSError as error:
            self._stable_snapshot = None
            if self._bridge is not None:
                self._bridge.post_message(
                    {
                        "type": "reloadFailed",
                        "generation": self._bridge.generation,
                        "message": str(error),
                    }
                )
            return
        self._confirmation_timer.start()

    def _confirm_stable_file(self) -> None:
        if self._watch_path is None or self._stable_snapshot is None:
            return
        try:
            confirmed = self._file_snapshot(self._watch_path)
        except OSError:
            self._stability_timer.start()
            return
        if confirmed != self._stable_snapshot:
            self._stable_snapshot = None
            self._stability_timer.start()
            return
        self._ensure_file_watch()
        if confirmed == self._last_known_snapshot:
            return
        self._last_known_snapshot = confirmed
        self._stable_snapshot = None
        if self._bridge is not None:
            self._bridge.open_file(self._watch_path)

    def closeEvent(self, event) -> None:
        self._stability_timer.stop()
        self._confirmation_timer.stop()
        if self._bridge is not None:
            self._bridge.close()
        super().closeEvent(event)

