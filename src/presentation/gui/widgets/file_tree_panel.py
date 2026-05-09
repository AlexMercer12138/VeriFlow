# -*- coding: utf-8 -*-
"""
文件树视图 — 项目目录结构展示
"""

from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QTreeView, QHeaderView, QFileSystemModel,
    QLineEdit, QHBoxLayout, QLabel,
)
from PySide6.QtCore import QDir, Signal, Qt


class FileTreePanel(QWidget):
    """项目文件树面板"""

    file_double_clicked = Signal(str)

    VERILOG_FILTERS = ['*.v', '*.sv', '*.vh', '*.svh']

    def __init__(self, parent=None):
        super().__init__(parent)
        self._init_ui()
        self._model = None

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        header = QHBoxLayout()
        header.addWidget(QLabel("File Tree"))
        header.addStretch()
        layout.addLayout(header)

        self._tree = QTreeView()
        self._tree.setHeaderHidden(False)
        self._tree.setAlternatingRowColors(True)
        self._tree.doubleClicked.connect(self._on_double_click)
        layout.addWidget(self._tree, 1)

    def set_root(self, root_path: str):
        if not root_path:
            self._tree.setModel(None)
            self._model = None
            return

        self._model = QFileSystemModel()
        self._model.setRootPath(root_path)
        self._model.setNameFilters(self.VERILOG_FILTERS)
        self._model.setNameFilterDisables(False)

        self._tree.setModel(self._model)
        self._tree.setRootIndex(self._model.index(root_path))
        self._tree.setColumnHidden(1, True)
        self._tree.setColumnHidden(2, True)
        self._tree.setColumnHidden(3, True)
        self._tree.header().setStretchLastSection(False)
        self._tree.header().setSectionResizeMode(0, QHeaderView.Stretch)

    def _on_double_click(self, index):
        if self._model and not self._model.isDir(index):
            filepath = self._model.filePath(index)
            if filepath:
                self.file_double_clicked.emit(filepath)
