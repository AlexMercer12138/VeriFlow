# -*- coding: utf-8 -*-
"""
文件目录视图 — 项目目录结构展示 + 搜索过滤
"""

from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QTreeView, QHeaderView, QFileSystemModel,
    QLineEdit, QHBoxLayout,
)
from PySide6.QtCore import QDir, Signal, Qt, QSortFilterProxyModel
from src.presentation.gui.i18n import tr


class FileTreePanel(QWidget):

    file_double_clicked = Signal(str)

    VERILOG_FILTERS = ['*.v', '*.sv', '*.vh', '*.svh']

    def __init__(self, parent=None):
        super().__init__(parent)
        self._model = None
        self._proxy = None
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        self._search_edit = QLineEdit()
        self._search_edit.setPlaceholderText(tr("file_tree.filter"))
        self._search_edit.textChanged.connect(self._apply_filter)
        layout.addWidget(self._search_edit)

        self._tree = QTreeView()
        self._tree.setHeaderHidden(True)
        self._tree.setAlternatingRowColors(True)
        self._tree.doubleClicked.connect(self._on_double_click)
        layout.addWidget(self._tree, 1)

    def _apply_filter(self):
        if self._proxy:
            text = self._search_edit.text().strip()
            self._proxy.setFilterFixedString(text)

    def set_root(self, root_path: str):
        if not root_path:
            self._tree.setModel(None)
            self._model = None
            self._proxy = None
            return

        self._model = QFileSystemModel()
        self._model.setRootPath(root_path)
        self._model.setNameFilters(self.VERILOG_FILTERS)
        self._model.setNameFilterDisables(False)

        self._proxy = QSortFilterProxyModel()
        self._proxy.setSourceModel(self._model)
        self._proxy.setFilterCaseSensitivity(Qt.CaseInsensitive)
        self._proxy.setFilterKeyColumn(0)

        self._tree.setModel(self._proxy)
        self._tree.setRootIndex(self._proxy.mapFromSource(self._model.index(root_path)))
        self._tree.setColumnHidden(1, True)
        self._tree.setColumnHidden(2, True)
        self._tree.setColumnHidden(3, True)
        self._tree.header().setStretchLastSection(False)
        self._tree.header().setSectionResizeMode(0, QHeaderView.Stretch)

    def _on_double_click(self, index):
        if self._proxy and self._model:
            src_idx = self._proxy.mapToSource(index)
            if not self._model.isDir(src_idx):
                filepath = self._model.filePath(src_idx)
                if filepath:
                    self.file_double_clicked.emit(filepath)
