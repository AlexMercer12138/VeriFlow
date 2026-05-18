# -*- coding: utf-8 -*-
"""
统一模块面板 — 按库分组 + 依赖层级视图 + 搜索过滤
"""

import re
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
    QLabel, QLineEdit,
)
from PySide6.QtCore import Signal, Qt
from PySide6.QtGui import QColor, QFont
from src.presentation.gui.i18n import tr
from src.domain.services.verilog_utils import remove_comments


class UnifiedModulePanel(QWidget):

    file_double_clicked = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._dep_files = {}
        self._all_items = []
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        header = QHBoxLayout()
        self._count_label = QLabel("Modules: 0")
        header.addWidget(self._count_label)
        header.addStretch()
        layout.addLayout(header)

        self._search_edit = QLineEdit()
        self._search_edit.setPlaceholderText("?")
        self._search_edit.textChanged.connect(self._apply_filter)
        layout.addWidget(self._search_edit)

        self._tree = QTreeWidget()
        self._tree.setAlternatingRowColors(True)
        self._tree.setHeaderLabels(["? "])
        self._tree.setColumnCount(1)
        self._tree.setIndentation(16)
        self._tree.setRootIsDecorated(True)
        self._tree.itemDoubleClicked.connect(self._on_double_click)
        self._tree.header().setStretchLastSection(True)
        layout.addWidget(self._tree, 1)

    def retranslate(self):
        self._search_edit.setPlaceholderText(tr("module.filter_ph"))
        self._tree.setHeaderLabels([tr("tab.modules")])
        self._refresh_count_label()

    def _refresh_count_label(self):
        pass

    def set_data(self, dep_result=None, categorized: dict = None):
        self._tree.clear()
        self._all_items = []
        self._dep_files = {}
        cat = categorized or {}
        dep_mod_names = set()
        dep_graph = {}

        if dep_result and dep_result.files:
            dep_graph = getattr(dep_result, 'dep_graph', {}) or {}
            for f in dep_result.files:
                try:
                    content = f.read_text(encoding='utf-8', errors='ignore')
                except Exception:
                    content = ""
                content = remove_comments(content)
                for m in re.finditer(r'\bmodule\s+(\w+)', content):
                    mod_name = m.group(1)
                    self._dep_files[mod_name] = f
                    dep_mod_names.add(mod_name)

        dep_set = set()
        if dep_graph:
            for p, children in dep_graph.items():
                dep_set.add(p)
                dep_set.update(children)
        dep_set.update(dep_mod_names)

        dep_count = 0
        unused_count = 0

        if dep_graph:
            sec = self._add_section(tr("module.dep_section"))
            top_module = dep_result.top_module if dep_result else None
            visited = set()

            def build_tree(module_name, depth, parent):
                nonlocal dep_count
                if module_name in visited:
                    return
                visited.add(module_name)
                dep_count += 1
                filepath = self._dep_files.get(module_name)
                file_str = str(filepath) if filepath else "?"
                indent = "    " * depth
                item = QTreeWidgetItem([f"{indent}{module_name}  ({file_str})"])
                item.setData(0, Qt.UserRole, str(filepath) if filepath else "")
                item.setData(0, Qt.UserRole + 1, module_name)
                item.setData(0, Qt.UserRole + 2, "__DEP__")
                parent.addChild(item)
                self._all_items.append(item)
                for child_name in dep_graph.get(module_name, []):
                    build_tree(child_name, depth + 1, item)

            if top_module:
                build_tree(top_module, 0, sec)
            # 也显示 missing_modules（未声明的实例）
            missing = getattr(dep_result, 'missing_modules', []) or []
            for mname in missing:
                if mname not in visited:
                    visited.add(mname)
                    dep_count += 1
                    indent = "    "
                    item = QTreeWidgetItem([f"{indent}❓ {mname}  (未声明)"])
                    item.setData(0, Qt.UserRole, "")
                    item.setData(0, Qt.UserRole + 1, mname)
                    item.setData(0, Qt.UserRole + 2, "__MISSING__")
                    item.setForeground(0, QColor("#ff6b6b"))
                    font = item.font(0)
                    font.setBold(True)
                    item.setFont(0, font)
                    sec.addChild(item)
                    self._all_items.append(item)
            self._tree.addTopLevelItem(sec)
            sec.setExpanded(True)

        for lib_label in sorted(cat.keys()):
            mods = cat[lib_label]
            if not mods:
                continue
            lib_set = set(mods.keys())
            lib_unused = {m: fp for m, fp in mods.items() if m not in dep_set}
            if not lib_unused:
                continue
            sec = self._add_section(f"{lib_label} ({len(lib_unused)})")
            for mod_name in sorted(lib_unused.keys()):
                filepath = lib_unused[mod_name]
                item = QTreeWidgetItem([f"  {mod_name}  ({filepath})"])
                item.setData(0, Qt.UserRole, str(filepath))
                item.setData(0, Qt.UserRole + 1, mod_name)
                item.setData(0, Qt.UserRole + 2, lib_label)
                sec.addChild(item)
                self._all_items.append(item)
                unused_count += 1
            self._tree.addTopLevelItem(sec)
            sec.setExpanded(True)

        if dep_count == 0 and unused_count == 0:
            sec = self._add_section(tr("module.no_modules"))
            self._tree.addTopLevelItem(sec)

        self._count_label.setText(
            tr("module.count", total=dep_count + unused_count, dep=dep_count, unused=unused_count)
        )
        self._apply_filter()

    def _add_section(self, title: str):
        item = QTreeWidgetItem([title])
        font = item.font(0)
        font.setBold(True)
        item.setFont(0, font)
        item.setFlags(item.flags() & ~Qt.ItemIsSelectable)
        return item

    def _apply_filter(self):
        text = self._search_edit.text().strip().lower()
        for i in range(self._tree.topLevelItemCount()):
            section = self._tree.topLevelItem(i)
            self._apply_section_filter(section, text)

    def _apply_section_filter(self, section: QTreeWidgetItem, text: str):
        if not text:
            section.setHidden(False)
            for j in range(section.childCount()):
                section.child(j).setHidden(False)
            return
        any_visible = False
        for j in range(section.childCount()):
            child = section.child(j)
            mod_name = (child.data(0, Qt.UserRole + 1) or "").lower()
            visible = text in mod_name
            child.setHidden(not visible)
            if visible:
                any_visible = True
        section.setHidden(not any_visible)

    def _on_double_click(self, item):
        filepath = item.data(0, Qt.UserRole)
        if filepath:
            self.file_double_clicked.emit(filepath)
