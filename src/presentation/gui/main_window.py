# -*- coding: utf-8 -*-
"""
主窗口 — 新布局：左侧侧边栏(Project+FileTree+按钮) | 右侧标签页(Config/Modules/Log)
"""

import os
from pathlib import Path

from PySide6.QtWidgets import (
    QMainWindow, QSplitter, QTabWidget,
    QStatusBar, QFileDialog, QMessageBox,
)
from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QAction, QDesktopServices, QIcon

from src.application.coordinator import ApplicationCoordinator
from src.infrastructure.global_config_service import GlobalConfigService
from src.infrastructure.template_engine import TemplateEngine
from src.domain.models.dependency import DependencyResult
from src.domain.models.simulation import SimulationResult
from src.presentation.gui.widgets.project_panel import ProjectPanel
from src.presentation.gui.widgets.project_config_panel import ProjectConfigPanel
from src.presentation.gui.widgets.log_panel import LogPanel
from src.presentation.gui.widgets.unified_module_panel import UnifiedModulePanel
from src.presentation.gui.worker_threads import AnalyzeWorker, SimulateWorker, ModuleScanWorker

WINDOW_TITLE = "VeriFlow - Verilog Simulation Manager"
DEFAULT_WIDTH = 1300
DEFAULT_HEIGHT = 750


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self._initializing = True
        self._coordinator = ApplicationCoordinator()
        self._project = None
        self._project_filepath = None
        self._dep_result = None
        self._sim_result = None
        self._init_ui()
        self._connect_signals()
        self._apply_dark_theme()
        self._load_global_config()
        self._initializing = False

    def _init_ui(self):
        self.setWindowTitle(WINDOW_TITLE)
        self.resize(DEFAULT_WIDTH, DEFAULT_HEIGHT)

        icon_path = Path(__file__).parent / 'resources' / 'icon.ico'
        if icon_path.exists():
            self.setWindowIcon(QIcon(str(icon_path)))

        self._create_menu_bar()
        self._create_status_bar()

        h_splitter = QSplitter(Qt.Horizontal)
        h_splitter.setHandleWidth(1)

        self._project_panel = ProjectPanel()
        self._project_panel.setMinimumWidth(280)
        self._project_panel.setMaximumWidth(450)

        self._config_panel = ProjectConfigPanel()
        self._config_panel.config_changed.connect(self._on_config_changed)

        self._tab_widget = QTabWidget()
        self._tab_widget.addTab(self._config_panel, "Project Config")

        self._module_panel = UnifiedModulePanel()
        self._module_panel.file_double_clicked.connect(self._open_file_editor)
        self._tab_widget.addTab(self._module_panel, "Modules")

        self._log_panel = LogPanel()
        self._log_panel.set_anchor_click_handler(self._on_log_anchor_clicked)
        self._tab_widget.addTab(self._log_panel, "Log")

        h_splitter.addWidget(self._project_panel)
        h_splitter.addWidget(self._tab_widget)
        h_splitter.setSizes([360, 920])

        self.setCentralWidget(h_splitter)

        self._welcome()

    def _welcome(self):
        self._log_panel.append_success("Welcome to VeriFlow!")
        self._log_panel.append_info("Click New or Open to start.")

    def _connect_signals(self):
        pp = self._project_panel
        pp.analyze_requested.connect(self._on_analyze)
        pp.simulate_requested.connect(self._on_simulate)
        pp.wave_requested.connect(self._on_open_wave)
        pp.project_new_requested.connect(self._on_project_new)
        pp.project_open_requested.connect(self._on_project_open)
        pp.project_rename_requested.connect(self._on_project_rename)

        self._project_panel.file_tree.file_double_clicked.connect(self._open_file_editor)

    def _create_menu_bar(self):
        mb = self.menuBar()
        file_menu = mb.addMenu("&File")

        act_new = QAction("&New Project", self)
        act_new.setShortcut("Ctrl+N")
        act_new.triggered.connect(self._on_project_new_triggered)
        file_menu.addAction(act_new)

        act_open = QAction("&Open Project...", self)
        act_open.setShortcut("Ctrl+O")
        act_open.triggered.connect(self._on_project_open_triggered)
        file_menu.addAction(act_open)

        act_save_as = QAction("Save Project &As...", self)
        act_save_as.triggered.connect(self._on_project_save_as)
        file_menu.addAction(act_save_as)

        file_menu.addSeparator()
        act_exit = QAction("E&xit", self)
        act_exit.setShortcut("Alt+F4")
        act_exit.triggered.connect(self.close)
        file_menu.addAction(act_exit)

    def _on_project_new_triggered(self):
        self._project_panel._on_new()

    def _on_project_open_triggered(self):
        self._project_panel._on_open()

    def _create_status_bar(self):
        self._status_bar = QStatusBar()
        self.setStatusBar(self._status_bar)
        self._status_bar.showMessage("Ready")

    def _apply_dark_theme(self):
        self.setStyleSheet("""
            QMainWindow { background-color: #2b2b2b; color: #d4d4d4; }
            QGroupBox { font-weight: bold; border: 1px solid #4a4a4a; border-radius: 4px;
                margin-top: 12px; padding-top: 12px; color: #e0e0e0; }
            QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #569cd6; }
            QLineEdit { background-color: #3c3c3c; color: #d4d4d4; border: 1px solid #555;
                border-radius: 3px; padding: 4px; }
            QComboBox { background-color: #3c3c3c; color: #d4d4d4; border: 1px solid #555;
                border-radius: 3px; padding: 4px; }
            QComboBox QAbstractItemView { background-color: #333; color: #d4d4d4;
                selection-background-color: #264f78; }
            QPushButton { background-color: #0e639c; color: #ffffff; border: none;
                border-radius: 3px; padding: 6px 14px; }
            QPushButton:hover { background-color: #1177bb; }
            QPushButton:pressed { background-color: #094771; }
            QPushButton:disabled { background-color: #3c3c3c; color: #888; }
            QListWidget { background-color: #252525; color: #d4d4d4; border: 1px solid #3c3c3c;
                alternate-background-color: #2a2a2a; }
            QListWidget::item:selected { background-color: #264f78; }
            QTabWidget::pane { border: 1px solid #3c3c3c; background-color: #252525; }
            QTabBar::tab { background-color: #2d2d2d; color: #d4d4d4; border: 1px solid #3c3c3c;
                padding: 6px 16px; margin-right: 2px; }
            QTabBar::tab:selected { background-color: #252525; border-bottom-color: #252525; }
            QTreeWidget { background-color: #252525; color: #d4d4d4; border: 1px solid #3c3c3c;
                alternate-background-color: #2a2a2a; }
            QTreeWidget::item:selected { background-color: #264f78; }
            QTreeView { background-color: #252525; color: #d4d4d4; border: 1px solid #3c3c3c;
                alternate-background-color: #2a2a2a; }
            QTreeView::item:selected { background-color: #264f78; }
            QMenuBar { background-color: #333; color: #d4d4d4; }
            QMenuBar::item:selected { background-color: #094771; }
            QMenu { background-color: #333; color: #d4d4d4; border: 1px solid #555; }
            QMenu::item:selected { background-color: #094771; }
            QStatusBar { background-color: #007acc; color: #ffffff; }
            QSplitter::handle { background-color: #3c3c3c; }
        """)

    def _status(self, msg: str):
        self._status_bar.showMessage(msg)

    def _load_global_config(self):
        gc = GlobalConfigService()
        dirs = gc.get_lib_dirs()
        self._config_panel.global_lib_dirs = dirs
        if dirs:
            self._log_panel.append_info(f"Loaded {len(dirs)} global library directories")

    def _save_global_config(self):
        gc = GlobalConfigService()
        gc.set_lib_dirs(self._config_panel.global_lib_dirs)

    def _on_config_changed(self):
        if self._initializing:
            return
        self._auto_save()

    def _sync_project_from_ui(self):
        if not self._project:
            return
        p = self._project
        p.top_module = self._project_panel.top_module
        p.lib_dirs = [Path(d) for d in self._config_panel.project_lib_dirs]
        p.simulator = self._config_panel.simulator
        p.wave_viewer = self._config_panel.wave_viewer
        p.wave_file_template = self._config_panel.wave_file_template

        from src.domain.models.project import SimulatorConfig, WaveViewerConfig
        custom_sim = self._config_panel.get_custom_sim_config()
        p.simulators['custom'] = SimulatorConfig(
            name='custom',
            compile_cmd=custom_sim['compile_cmd'],
            run_cmd=custom_sim['run_cmd'],
        )
        custom_wave = self._config_panel.get_custom_wave_config()
        p.wave_viewers['custom'] = WaveViewerConfig(
            name='custom',
            launch_cmd=custom_wave,
        )

    def _sync_ui_from_project(self):
        if not self._project:
            return
        p = self._project
        self._project_panel.set_project_info(p.name, str(p.root_dir))
        self._project_panel.top_module = p.top_module
        self._project_panel.file_tree.set_root(str(p.root_dir))
        self._config_panel.project_lib_dirs = [str(d) for d in p.lib_dirs]
        self._config_panel.simulator = p.simulator
        self._config_panel.wave_viewer = p.wave_viewer
        self._config_panel.wave_file_template = p.wave_file_template

        custom_sim = p.simulators.get('custom')
        if custom_sim:
            self._config_panel.set_custom_sim_config(
                custom_sim.compile_cmd, custom_sim.run_cmd
            )
        custom_wave = p.wave_viewers.get('custom')
        if custom_wave:
            self._config_panel.set_custom_wave_config(custom_wave.launch_cmd)

    def _auto_save(self):
        if self._initializing:
            return
        self._sync_project_from_ui()
        self._save_global_config()
        if self._project and self._project_filepath:
            self._coordinator.save_project(self._project, self._project_filepath)

    def _reset_state(self):
        self._dep_result = None
        self._sim_result = None
        self._categorized_cache = {}
        self._module_panel.set_data(categorized={})

    def _on_project_new(self, filepath: str):
        project_name = Path(filepath).stem
        self._project = self._coordinator.create_project(project_name, ".")
        self._project_filepath = filepath
        self._coordinator.save_project(self._project, filepath)
        self._project = self._coordinator.open_project(filepath)
        self._reset_state()
        self._sync_ui_from_project()
        self._refresh_modules()
        self._log_panel.append_success(f"New project created: {filepath}")
        self._status(f"Created: {filepath}")

    def _on_project_open(self, filepath: str):
        try:
            self._project = self._coordinator.open_project(filepath)
            self._project_filepath = filepath
            self._reset_state()
            self._sync_ui_from_project()
            self._refresh_modules()
            self._log_panel.append_success(f"Project opened: {filepath}")
            self._status(f"Opened: {filepath}")
        except Exception as e:
            self._log_panel.append_error(f"Failed to open project: {e}")
            QMessageBox.critical(self, "Error", f"Failed to open project:\n{e}")

    def _on_project_save_as(self):
        if not self._project:
            self._log_panel.append_warning("No project opened.")
            return
        filepath, _ = QFileDialog.getSaveFileName(
            self, "Save Project As JSON", f"{self._project.name}.json",
            "JSON Files (*.json);;All Files (*)"
        )
        if not filepath:
            return
        self._sync_project_from_ui()
        self._save_global_config()
        self._project_filepath = filepath
        self._coordinator.save_project(self._project, filepath)
        self._project_panel.set_project_info(self._project.name, str(self._project.root_dir))
        self._log_panel.append_success(f"Project saved: {filepath}")
        self._status(f"Saved: {filepath}")

    def _on_project_rename(self, new_name: str):
        if not self._project:
            return
        self._project.name = new_name
        self._project_panel.set_project_info(new_name, str(self._project.root_dir))
        self._auto_save()
        self._log_panel.append_info(f"Project renamed to: {new_name}")

    def _refresh_modules(self):
        self._module_worker = ModuleScanWorker(self._project)
        self._module_worker.finished.connect(self._on_modules_scanned)
        self._module_worker.error_occurred.connect(
            lambda e: self._log_panel.append_error(e)
        )
        self._module_worker.start()

    def _on_modules_scanned(self, categorized: dict, duplicates: dict, project_modules: dict):
        self._categorized_cache = categorized
        self._project_panel.populate_modules(list(project_modules.keys()))
        self._module_panel.set_data(dep_result=self._dep_result, categorized=categorized)
        dup_names = list(duplicates.keys()) if duplicates else []
        if dup_names:
            self._log_panel.append_warning(
                f"Duplicate modules: {', '.join(dup_names)}"
            )
        total = sum(len(v) for v in categorized.values())
        self._status(f"Modules: {total}")

    def _on_analyze(self):
        if not self._project:
            QMessageBox.warning(self, "Missing", "No project opened. Use New or Open first.")
            return

        top = self._project_panel.top_module
        if not top:
            QMessageBox.warning(self, "Missing", "Please enter a top module name.")
            return

        self._auto_save()
        root = str(self._project.root_dir)

        self._log_panel.clear()
        self._log_panel.append_info(f"Analyzing: top='{top}', root={root}")
        self._status("Analyzing dependencies...")
        self._project_panel.set_buttons_enabled(False, False, False)
        self._tab_widget.setCurrentWidget(self._module_panel)

        libs = [str(d) for d in self._project.lib_dirs]
        self._analyze_worker = AnalyzeWorker(top, root, libs)
        self._analyze_worker.finished.connect(self._on_analyze_finished)
        self._analyze_worker.error_occurred.connect(
            lambda e: self._log_panel.append_error(e)
        )
        self._analyze_worker.start()

    def _on_analyze_finished(self, result: DependencyResult):
        self._dep_result = result

        if result.success:
            self._log_panel.append_success(
                f"Analysis complete: {len(result.files)} file(s)."
            )
            for f in result.files:
                self._log_panel.append_info(f"  {f}")
            self._project_panel.set_buttons_enabled(True, True, True)
            self._status(f"Analysis done: {len(result.files)} files")
        else:
            self._log_panel.append_error(
                f"Missing modules: {', '.join(result.missing_modules)}"
            )
            self._project_panel.set_buttons_enabled(True, False, False)
            self._status("Analysis failed: missing modules")

        self._module_panel.set_data(
            dep_result=result,
            categorized=self._categorized_cache if hasattr(self, '_categorized_cache') else {}
        )
        self._tab_widget.setCurrentWidget(self._module_panel)
        self._refresh_modules()

    def _on_simulate(self):
        if not self._project:
            QMessageBox.warning(self, "Missing", "No project opened.")
            return

        top = self._project_panel.top_module
        if not top:
            QMessageBox.warning(self, "Missing", "Please enter a top module name.")
            return

        self._auto_save()

        self._log_panel.clear()
        self._log_panel.append_info(f"Simulating {top} (cd {self._project.root_dir})")
        self._status("Simulation running...")
        self._project_panel.set_buttons_enabled(False, False, False)
        self._tab_widget.setCurrentWidget(self._log_panel)

        self._sim_worker = SimulateWorker(self._project)
        self._sim_worker.progress.connect(lambda msg: self._log_panel.append_info(msg))
        self._sim_worker.finished.connect(self._on_simulate_finished)
        self._sim_worker.error_occurred.connect(
            lambda e: self._log_panel.append_error(e)
        )
        self._sim_worker.start()

    def _on_simulate_finished(self, result: SimulationResult):
        self._sim_result = result
        self._log_panel.append_sim_result(
            result.success, result.stdout, result.stderr, result.elapsed_time
        )

        self._project_panel.set_buttons_enabled(True, True, True)

        if result.success:
            self._log_panel.append_success("Simulation completed!")
            self._status(f"Simulation OK ({result.elapsed_time:.2f}s)")
        else:
            self._log_panel.append_error(f"Simulation FAILED (exit={result.exit_code})")
            for entry in result.get_errors():
                self._log_panel.append_error_entry(
                    entry.level, entry.message,
                    entry.file_ref, entry.line_no,
                )
            self._status("Simulation failed")

        self._tab_widget.setCurrentWidget(self._log_panel)

    def _on_open_wave(self):
        if not self._project:
            self._log_panel.append_warning("No project opened.")
            return

        self._auto_save()
        wave_file = self._project.resolve_wave_file()

        if wave_file.exists():
            self._tab_widget.setCurrentWidget(self._log_panel)
            self._do_open_wave(wave_file)
            return

        self._log_panel.clear()
        self._log_panel.append_info(
            f"Wave file not found: {wave_file}"
        )
        self._log_panel.append_info("Running simulation to generate waveform...")
        self._status("Simulation running (for wave)...")
        self._project_panel.set_buttons_enabled(False, False, False)

        self._sim_worker = SimulateWorker(self._project)
        self._sim_worker.progress.connect(lambda msg: self._log_panel.append_info(msg))
        self._sim_worker.finished.connect(self._on_wave_simulate_finished)
        self._sim_worker.error_occurred.connect(
            lambda e: self._log_panel.append_error(e)
        )
        self._sim_worker.start()

    def _on_wave_simulate_finished(self, result: SimulationResult):
        self._sim_result = result

        self._log_panel.append_sim_result(
            result.success, result.stdout, result.stderr, result.elapsed_time
        )
        self._project_panel.set_buttons_enabled(True, True, True)

        if not result.success:
            self._log_panel.append_error("Simulation failed, cannot open waveform.")
            self._status("Wave open failed: simulation error")
            self._tab_widget.setCurrentWidget(self._log_panel)
            return

        wave_file = self._project.resolve_wave_file()
        if wave_file.exists():
            self._do_open_wave(wave_file)
        else:
            self._log_panel.append_error(
                f"Wave file not found: {wave_file}\n"
                "Check testbench $dumpfile setting or wave file path in Project Config."
            )
            self._status("Wave file not found")
            self._tab_widget.setCurrentWidget(self._log_panel)

    def _do_open_wave(self, wave_file: Path):
        viewer_name = self._config_panel.wave_viewer
        viewer_config = (
            self._project.wave_viewers.get(viewer_name)
            if self._project else None
        )
        if viewer_config:
            try:
                self._coordinator.sim_runner.open_wave(wave_file, viewer_config)
                cmd = TemplateEngine.render_wave(viewer_config.launch_cmd, str(wave_file))
                self._log_panel.append_info(f"[CMD] Wave: {cmd}")
                self._log_panel.append_success(f"Opened {viewer_name}: {wave_file}")
                self._status(f"Wave opened: {wave_file}")
            except Exception as e:
                self._log_panel.append_error(f"Failed to open {viewer_name}: {e}")
        else:
            self._open_file_external(str(wave_file))

        self._tab_widget.setCurrentWidget(self._log_panel)

    def _open_file_editor(self, filepath: str):
        self._open_file_external(filepath)

    def _open_file_external(self, filepath: str):
        try:
            QDesktopServices.openUrl(QUrl.fromLocalFile(filepath))
        except Exception:
            try:
                os.startfile(filepath)
            except Exception as e:
                self._log_panel.append_error(f"Failed to open file: {e}")

    def _on_log_anchor_clicked(self, url: QUrl):
        href = url.toString()
        if href.startswith("file://"):
            path_part = href[7:]
            filepath, _, lineno = path_part.partition(":")
            self._open_file_external(filepath)

    def closeEvent(self, event):
        self._auto_save()
        super().closeEvent(event)
