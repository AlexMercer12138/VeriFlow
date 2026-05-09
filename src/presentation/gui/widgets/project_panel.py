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
from src.presentation.gui.i18n import tr


class ClickableLabel(QLabel):
    double_clicked = Signal()

    def mouseDoubleClickEvent(self, event: QMouseEvent):
        self.double_clicked.emit()
        super().mouseDoubleClickEvent(event)


class ProjectPanel(QWidget):

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
        self._proj_grp = QGroupBox("?")
        lo = QVBoxLayout(self._proj_grp)

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
        self._btn_new = QPushButton("?")
        self._btn_new.clicked.connect(self._on_new)
        self._btn_open = QPushButton("?")
        self._btn_open.clicked.connect(self._on_open)
        row_file.addWidget(self._btn_new)
        row_file.addWidget(self._btn_open)
        lo.addLayout(row_file)

        return self._proj_grp

    def _create_top_module_group(self):
        self._top_grp = QGroupBox("?")
        lo = QVBoxLayout(self._top_grp)

        self._top_combo = QComboBox()
        self._top_combo.setEditable(True)
        self._top_combo.setInsertPolicy(QComboBox.NoInsert)
        self._top_combo.setPlaceholderText("?")
        self._top_combo.lineEdit().textChanged.connect(self._mark_dirty)
        lo.addWidget(self._top_combo)

        return self._top_grp

    def _create_file_tree(self):
        self._file_grp = QGroupBox("?")
        lo = QVBoxLayout(self._file_grp)
        lo.setContentsMargins(0, 0, 0, 0)

        self._file_tree = FileTreePanel()
        lo.addWidget(self._file_tree)

        return self._file_grp

    def _create_action_buttons(self):
        w = QWidget()
        lo = QVBoxLayout(w)
        lo.setContentsMargins(0, 0, 0, 0)

        self._btn_analyze = QPushButton("?")
        self._btn_analyze.setMinimumHeight(36)
        self._btn_analyze.clicked.connect(self.analyze_requested.emit)
        lo.addWidget(self._btn_analyze)

        self._btn_simulate = QPushButton("?")
        self._btn_simulate.setMinimumHeight(36)
        self._btn_simulate.clicked.connect(self.simulate_requested.emit)
        lo.addWidget(self._btn_simulate)

        self._btn_wave = QPushButton("?")
        self._btn_wave.setMinimumHeight(36)
        self._btn_wave.clicked.connect(self.wave_requested.emit)
        lo.addWidget(self._btn_wave)

        return w

    def retranslate(self):
        self._proj_grp.setTitle(tr("project.group"))
        self._top_grp.setTitle(tr("top_module.group"))
        self._file_grp.setTitle(tr("file_tree.group"))
        self._top_combo.setPlaceholderText(tr("top_module.placeholder"))
        self._btn_new.setText(tr("project.new"))
        self._btn_open.setText(tr("project.open"))
        self._btn_analyze.setText(tr("action.analyze"))
        self._btn_simulate.setText(tr("action.simulate"))
        self._btn_wave.setText(tr("action.open_wave"))

        current = self._name_label.text()
        is_no_proj = current.startswith("\U0001f4c1 ")
        if is_no_proj:
            name = current[2:]
            if name != tr("project.no_project"):
                pass
        else:
            self._name_label.setToolTip(tr("project.dbl_rename"))

    def on_new(self):
        filepath, _ = QFileDialog.getSaveFileName(
            self, tr("dialog.new_project_title"), "new_project.json",
            tr("dialog.json_filter")
        )
        if filepath:
            self.project_new_requested.emit(filepath)

    def on_open(self):
        filepath, _ = QFileDialog.getOpenFileName(
            self, tr("dialog.open_project_title"), "",
            tr("dialog.json_filter")
        )
        if filepath:
            self.project_open_requested.emit(filepath)

    def _on_new(self):
        self.on_new()

    def _on_open(self):
        self.on_open()

    def _on_rename(self):
        current = self._name_label.text()
        if current.startswith("\U0001f4c1 "):
            current = current[2:]
        name, ok = QInputDialog.getText(
            self, tr("dialog.rename_title"), tr("dialog.rename_prompt"), text=current
        )
        if ok and name.strip():
            self.project_rename_requested.emit(name.strip())

    def _mark_dirty(self):
        pass

    @property
    def file_tree(self) -> FileTreePanel:
        return self._file_tree

    def set_project_info(self, name: str, root: str):
        display_name = tr("project.no_project") if name == "No project opened" else name
        text = f"\U0001f4c1 {display_name}"
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
