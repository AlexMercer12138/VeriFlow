# -*- coding: utf-8 -*-
"""
工程侧边栏面板 — Project + File Tree + Action Buttons
"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QGroupBox, QLabel,
    QPushButton, QComboBox, QFileDialog, QInputDialog,
)
from PySide6.QtCore import Signal, Qt
from PySide6.QtGui import QMouseEvent
from .file_tree_panel import FileTreePanel


class ClickableLabel(QLabel):
    """可双击的标签"""
    double_clicked = Signal()

    def mouseDoubleClickEvent(self, event: QMouseEvent):
        self.double_clicked.emit()
        super().mouseDoubleClickEvent(event)


class ProjectPanel(QWidget):
    """左侧侧边栏面板"""

    analyze_requested = Signal()
    simulate_requested = Signal()
    wave_requested = Signal()
    project_new_requested = Signal(str)
    project_open_requested = Signal(str)
    project_rename_requested = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        layout.addWidget(self._create_project_group())
        layout.addWidget(self._create_top_module_group())
        layout.addWidget(self._create_file_tree())
        layout.addWidget(self._create_action_buttons())

    def _create_project_group(self):
        grp = QGroupBox("Project")
        lo = QVBoxLayout(grp)

        self._name_label = ClickableLabel("No project opened")
        self._name_label.setStyleSheet("color: #d4d4d4; font-weight: bold;")
        self._name_label.setCursor(Qt.PointingHandCursor)
        self._name_label.setToolTip("Double-click to rename project")
        self._name_label.double_clicked.connect(self._on_rename)
        lo.addWidget(self._name_label)

        self._root_label = QLabel("")
        self._root_label.setStyleSheet("color: #888; font-size: 11px;")
        lo.addWidget(self._root_label)

        row_file = QHBoxLayout()
        btn_new = QPushButton("New")
        btn_new.clicked.connect(self._on_new)
        btn_open = QPushButton("Open")
        btn_open.clicked.connect(self._on_open)
        row_file.addWidget(btn_new)
        row_file.addWidget(btn_open)
        lo.addLayout(row_file)

        return grp

    def _create_top_module_group(self):
        grp = QGroupBox("Top Module")
        lo = QVBoxLayout(grp)

        self._top_combo = QComboBox()
        self._top_combo.setEditable(True)
        self._top_combo.setInsertPolicy(QComboBox.NoInsert)
        self._top_combo.setPlaceholderText("Select or type top module...")
        self._top_combo.lineEdit().textChanged.connect(self._mark_dirty)
        lo.addWidget(self._top_combo)

        return grp

    def _create_file_tree(self):
        grp = QGroupBox("File Tree")
        lo = QVBoxLayout(grp)
        lo.setContentsMargins(0, 0, 0, 0)

        self._file_tree = FileTreePanel()
        lo.addWidget(self._file_tree)

        return grp

    def _create_action_buttons(self):
        w = QWidget()
        lo = QVBoxLayout(w)
        lo.setContentsMargins(0, 0, 0, 0)

        self._btn_analyze = QPushButton("Analyze Dependencies")
        self._btn_analyze.setMinimumHeight(36)
        self._btn_analyze.clicked.connect(self.analyze_requested.emit)
        lo.addWidget(self._btn_analyze)

        self._btn_simulate = QPushButton("Compile && Simulate")
        self._btn_simulate.setMinimumHeight(36)
        self._btn_simulate.clicked.connect(self.simulate_requested.emit)
        lo.addWidget(self._btn_simulate)

        self._btn_wave = QPushButton("Open Waveform")
        self._btn_wave.setMinimumHeight(36)
        self._btn_wave.clicked.connect(self.wave_requested.emit)
        lo.addWidget(self._btn_wave)

        return w

    def _on_new(self):
        filepath, _ = QFileDialog.getSaveFileName(
            self, "Create New Project JSON", "new_project.json",
            "JSON Files (*.json);;All Files (*)"
        )
        if filepath:
            self.project_new_requested.emit(filepath)

    def _on_open(self):
        filepath, _ = QFileDialog.getOpenFileName(
            self, "Open Project JSON", "",
            "JSON Files (*.json);;All Files (*)"
        )
        if filepath:
            self.project_open_requested.emit(filepath)

    def _on_rename(self):
        current = self._name_label.text()
        if current.startswith("\U0001f4c1 "):
            current = current[2:]
        name, ok = QInputDialog.getText(
            self, "Rename Project", "Project name:", text=current
        )
        if ok and name.strip():
            self.project_rename_requested.emit(name.strip())

    def _mark_dirty(self):
        pass

    @property
    def file_tree(self) -> FileTreePanel:
        return self._file_tree

    def set_project_info(self, name: str, root: str):
        text = f"\U0001f4c1 {name}" if name != "No project opened" else "No project opened"
        self._name_label.setText(text)
        self._root_label.setText(root)

    @property
    def top_module(self) -> str:
        return self._top_combo.currentText().strip()

    @top_module.setter
    def top_module(self, value: str):
        idx = self._top_combo.findText(value)
        if idx >= 0:
            self._top_combo.setCurrentIndex(idx)
        else:
            self._top_combo.setCurrentText(value)

    def populate_modules(self, module_names: list):
        current = self._top_combo.currentText()
        self._top_combo.blockSignals(True)
        self._top_combo.clear()
        self._top_combo.addItems(sorted(module_names))
        if current:
            idx = self._top_combo.findText(current)
            if idx >= 0:
                self._top_combo.setCurrentIndex(idx)
            else:
                self._top_combo.setCurrentText(current)
        self._top_combo.blockSignals(False)

    def set_buttons_enabled(self, analyze: bool, simulate: bool, wave: bool):
        self._btn_analyze.setEnabled(analyze)
        self._btn_simulate.setEnabled(simulate)
        self._btn_wave.setEnabled(wave)
