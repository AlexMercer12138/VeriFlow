# -*- coding: utf-8 -*-
"""
后台工作线程 — 非阻塞执行 + 错误捕获
"""

import traceback

from PySide6.QtCore import QThread, Signal
from src.application.coordinator import ApplicationCoordinator


class AnalyzeWorker(QThread):
    """依赖分析工作线程"""
    finished = Signal(object)
    error_occurred = Signal(str)

    def __init__(self, top_module: str, project_root: str, lib_dirs: list):
        super().__init__()
        self._top = top_module
        self._root = project_root
        self._libs = lib_dirs

    def run(self):
        try:
            app = ApplicationCoordinator()
            result = app.analyze_dependencies(self._top, self._root, self._libs)
            self.finished.emit(result)
        except Exception as e:
            self.error_occurred.emit(f"Analysis error: {e}\n{traceback.format_exc()}")


class SimulateWorker(QThread):
    """仿真执行工作线程"""
    progress = Signal(str)
    finished = Signal(object)
    error_occurred = Signal(str)

    def __init__(self, project):
        super().__init__()
        self._project = project

    def run(self):
        try:
            self.progress.emit("Starting simulation...")
            app = ApplicationCoordinator()
            result = app.simulate(self._project)
            self.finished.emit(result)
        except Exception as e:
            self.error_occurred.emit(f"Simulation error: {e}\n{traceback.format_exc()}")


class ModuleScanWorker(QThread):
    """模块扫描工作线程 — 按库分类"""
    finished = Signal(dict, dict, dict, dict)
    error_occurred = Signal(str)

    def __init__(self, project=None):
        super().__init__()
        self._project = project

    def run(self):
        try:
            app = ApplicationCoordinator()
            categorized = app.scan_modules_categorized(self._project)
            duplicates = app.get_duplicate_modules(self._project)
            duplicates_with_lines = app.get_duplicate_modules_with_lines(self._project)
            project_modules = app.get_project_root_modules(self._project)
            self.finished.emit(categorized, duplicates, duplicates_with_lines, project_modules)
        except Exception as e:
            self.error_occurred.emit(f"Module scan error: {e}\n{traceback.format_exc()}")
            self.finished.emit({}, {}, {}, {})
