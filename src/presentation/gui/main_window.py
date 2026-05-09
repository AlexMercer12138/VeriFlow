# -*- coding: utf-8 -*-
"""
主窗口 — 左侧侧边栏(Project+FileTree+按钮) | 右侧标签页(Config/Modules/Log)
支持语言切换（中/英）和主题切换（暗/亮）
"""

import os
from pathlib import Path

from PySide6.QtWidgets import (
    QMainWindow, QSplitter, QTabWidget,
    QStatusBar, QFileDialog, QMessageBox, QApplication, QMenu,
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
from src.presentation.gui.i18n import tr, set_language, get_language
from src.presentation.gui import theme

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
        self._global_config = GlobalConfigService()
        self._init_language_theme()
        self._init_ui()
        self._connect_signals()
        self._apply_theme()
        self._load_global_config()
        self._initializing = False
        self._retranslate_ui()
        self._welcome()

    def _init_language_theme(self):
        saved_lang = self._global_config.get_language()
        set_language(saved_lang)
        saved_theme = self._global_config.get_theme()
        theme.set_theme(saved_theme)

    def _init_ui(self):
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

        self._module_panel = UnifiedModulePanel()
        self._module_panel.file_double_clicked.connect(self._open_file_editor)

        self._log_panel = LogPanel()
        self._log_panel.set_anchor_click_handler(self._on_log_anchor_clicked)

        self._tab_widget.addTab(self._config_panel, "?")
        self._tab_widget.addTab(self._module_panel, "?")
        self._tab_widget.addTab(self._log_panel, "?")

        h_splitter.addWidget(self._project_panel)
        h_splitter.addWidget(self._tab_widget)
        h_splitter.setSizes([360, 920])

        self.setCentralWidget(h_splitter)

    def _retranslate_ui(self):
        self.setWindowTitle(tr("window.title"))
        self._tab_widget.setTabText(0, tr("tab.config"))
        self._tab_widget.setTabText(1, tr("tab.modules"))
        self._tab_widget.setTabText(2, tr("tab.log"))
        self._project_panel.retranslate()
        self._config_panel.retranslate()
        self._module_panel.retranslate()
        self._log_panel.retranslate()
        self._retranslate_menu()
        if not self._initializing:
            self._status_bar.showMessage(tr("status.ready"))

    def _retranslate_menu(self):
        pass

    def _welcome(self):
        self._log_panel.append_success(tr("welcome.title"))
        self._log_panel.append_info(tr("welcome.hint"))

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

        self._file_menu = mb.addMenu(tr("menu.file"))
        self._file_menu.aboutToShow.connect(lambda: self._rebuild_file_menu())

        self._view_menu = mb.addMenu(tr("menu.view"))
        self._rebuild_view_menu()

    def _rebuild_file_menu(self):
        self._file_menu.clear()

        act_new = QAction(tr("menu.file.new_project"), self)
        act_new.setShortcut("Ctrl+N")
        act_new.triggered.connect(self._on_project_new_triggered)
        self._file_menu.addAction(act_new)

        act_open = QAction(tr("menu.file.open_project"), self)
        act_open.setShortcut("Ctrl+O")
        act_open.triggered.connect(self._on_project_open_triggered)
        self._file_menu.addAction(act_open)

        act_save_as = QAction(tr("menu.file.save_as"), self)
        act_save_as.triggered.connect(self._on_project_save_as)
        self._file_menu.addAction(act_save_as)

        self._file_menu.addSeparator()
        act_exit = QAction(tr("menu.file.exit"), self)
        act_exit.setShortcut("Alt+F4")
        act_exit.triggered.connect(self.close)
        self._file_menu.addAction(act_exit)

    def _rebuild_view_menu(self):
        self._view_menu.clear()

        lang_menu = QMenu(tr("menu.view.language"), self)
        lang_zh = QAction(tr("menu.view.lang_zh"), self)
        lang_zh.setCheckable(True)
        lang_zh.setChecked(get_language() == "zh")
        lang_zh.triggered.connect(lambda: self._switch_language("zh"))
        lang_menu.addAction(lang_zh)

        lang_en = QAction(tr("menu.view.lang_en"), self)
        lang_en.setCheckable(True)
        lang_en.setChecked(get_language() == "en")
        lang_en.triggered.connect(lambda: self._switch_language("en"))
        lang_menu.addAction(lang_en)
        self._view_menu.addMenu(lang_menu)

        theme_menu = QMenu(tr("menu.view.theme"), self)
        theme_dark = QAction(tr("menu.view.theme_dark"), self)
        theme_dark.setCheckable(True)
        theme_dark.setChecked(theme.get_theme() == "dark")
        theme_dark.triggered.connect(lambda: self._switch_theme("dark"))
        theme_menu.addAction(theme_dark)

        theme_light = QAction(tr("menu.view.theme_light"), self)
        theme_light.setCheckable(True)
        theme_light.setChecked(theme.get_theme() == "light")
        theme_light.triggered.connect(lambda: self._switch_theme("light"))
        theme_menu.addAction(theme_light)
        self._view_menu.addMenu(theme_menu)

    def _switch_language(self, lang: str):
        set_language(lang)
        self._global_config.set_language(lang)
        self._retranslate_ui()
        self._rebuild_view_menu()

    def _switch_theme(self, t: str):
        theme.set_theme(t)
        self._global_config.set_theme(t)
        self._apply_theme()
        self._log_panel.update_theme(theme.get_theme())
        self._rebuild_view_menu()

    def _on_project_new_triggered(self):
        self._project_panel.on_new()

    def _on_project_open_triggered(self):
        self._project_panel.on_open()

    def _create_status_bar(self):
        self._status_bar = QStatusBar()
        self.setStatusBar(self._status_bar)
        self._status_bar.showMessage(tr("status.ready"))

    def _apply_theme(self):
        app = QApplication.instance()
        if app:
            app.setStyleSheet(theme.get_stylesheet())
        t = theme.get_theme()
        if t == "dark":
            self._log_panel.update_theme("dark")
        else:
            self._log_panel.update_theme("light")

    def _status(self, msg: str):
        self._status_bar.showMessage(msg)

    def _load_global_config(self):
        dirs = self._global_config.get_lib_dirs()
        self._config_panel.global_lib_dirs = dirs
        if dirs:
            self._log_panel.append_info(tr("log.loaded_global_libs", n=len(dirs)))

    def _save_global_config(self):
        self._global_config.set_lib_dirs(self._config_panel.global_lib_dirs)

    def _on_config_changed(self):
        if self._initializing:
            return
        self._auto_save()
        if self._project:
            self._refresh_modules()

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
        config_dir = str(Path(filepath).parent.resolve())
        project_name = Path(filepath).stem
        self._project = self._coordinator.create_project(project_name, config_dir)
        self._project_filepath = filepath
        self._coordinator.save_project(self._project, filepath)
        self._project = self._coordinator.open_project(filepath)
        self._reset_state()
        self._sync_ui_from_project()
        self._refresh_modules()
        self._log_panel.append_success(tr("log.new_project", path=filepath))
        self._status(tr("log.created", path=filepath))

    def _on_project_open(self, filepath: str):
        try:
            self._project = self._coordinator.open_project(filepath)
            self._project_filepath = filepath
            self._reset_state()
            self._sync_ui_from_project()
            self._refresh_modules()
            self._log_panel.append_success(tr("log.open_project", path=filepath))
            self._status(tr("log.opened", path=filepath))
        except Exception as e:
            self._log_panel.append_error(tr("log.open_project_failed", err=e))
            QMessageBox.critical(self, tr("msgbox.error"),
                                 tr("log.open_project_failed", err=e))

    def _on_project_save_as(self):
        if not self._project:
            self._log_panel.append_warning(tr("log.no_project"))
            return
        filepath, _ = QFileDialog.getSaveFileName(
            self, tr("msgbox.save_as_title"), f"{self._project.name}.json",
            tr("dialog.json_filter")
        )
        if not filepath:
            return
        self._sync_project_from_ui()
        self._save_global_config()
        self._project_filepath = filepath
        self._coordinator.save_project(self._project, filepath)
        self._project_panel.set_project_info(self._project.name, str(self._project.root_dir))
        self._log_panel.append_success(tr("log.project_saved", path=filepath))
        self._status(tr("log.saved", path=filepath))

    def _on_project_rename(self, new_name: str):
        if not self._project:
            return
        self._project.name = new_name
        self._project_panel.set_project_info(new_name, str(self._project.root_dir))
        self._auto_save()
        self._log_panel.append_info(tr("log.project_renamed", name=new_name))

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
                tr("log.duplicate_modules", modules=', '.join(dup_names))
            )
        total = sum(len(v) for v in categorized.values())
        self._status(tr("status.modules_count", count=total))

    def _on_analyze(self):
        if not self._project:
            QMessageBox.warning(self, tr("msgbox.missing"), tr("msgbox.no_project"))
            return

        top = self._project_panel.top_module
        if not top:
            QMessageBox.warning(self, tr("msgbox.missing"), tr("msgbox.no_top_module"))
            return

        self._auto_save()
        root = str(self._project.root_dir)

        self._log_panel.clear()
        self._log_panel.append_info(tr("log.analyzing", top=top, root=root))
        self._status(tr("status.analyzing"))
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
                tr("log.analysis_done", n=len(result.files))
            )
            for f in result.files:
                self._log_panel.append_info(f"  {f}")
            self._project_panel.set_buttons_enabled(True, True, True)
            self._status(tr("status.done", count=len(result.files)))
        else:
            self._log_panel.append_error(
                tr("log.missing_modules", modules=', '.join(result.missing_modules))
            )
            self._project_panel.set_buttons_enabled(True, False, False)
            self._status(tr("status.failed_missing"))

        self._module_panel.set_data(
            dep_result=result,
            categorized=self._categorized_cache if hasattr(self, '_categorized_cache') else {}
        )
        self._tab_widget.setCurrentWidget(self._module_panel)
        self._refresh_modules()

    def _on_simulate(self):
        if not self._project:
            QMessageBox.warning(self, tr("msgbox.missing"), tr("msgbox.no_project"))
            return

        top = self._project_panel.top_module
        if not top:
            QMessageBox.warning(self, tr("msgbox.missing"), tr("msgbox.no_top_module"))
            return

        self._auto_save()

        self._log_panel.clear()
        self._log_panel.append_info(
            tr("log.simulating", top=top, root=str(self._project.root_dir))
        )
        self._status(tr("status.simulating"))
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
            self._log_panel.append_success(tr("log.sim_done"))
            self._status(tr("status.sim_ok", time=f"{result.elapsed_time:.2f}"))
        else:
            self._log_panel.append_error(
                tr("log.sim_failed", code=result.exit_code)
            )
            for entry in result.get_errors():
                self._log_panel.append_error_entry(
                    entry.level, entry.message,
                    entry.file_ref, entry.line_no,
                )
            self._status(tr("status.sim_failed"))

        self._tab_widget.setCurrentWidget(self._log_panel)

    def _on_open_wave(self):
        if not self._project:
            self._log_panel.append_warning(tr("log.no_project"))
            return

        self._auto_save()
        wave_file = self._project.resolve_wave_file()

        if wave_file.exists():
            self._tab_widget.setCurrentWidget(self._log_panel)
            self._do_open_wave(wave_file)
            return

        self._log_panel.clear()
        self._log_panel.append_info(
            tr("log.wave_not_found", file=str(wave_file))
        )
        self._log_panel.append_info(tr("log.wave_running_sim"))
        self._status(tr("status.wave_sim_running"))
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
            self._log_panel.append_error(tr("log.wave_sim_failed"))
            self._status(tr("status.wave_failed"))
            self._tab_widget.setCurrentWidget(self._log_panel)
            return

        wave_file = self._project.resolve_wave_file()
        if wave_file.exists():
            self._do_open_wave(wave_file)
        else:
            self._log_panel.append_error(
                tr("log.wave_check_dumpfile", file=str(wave_file))
            )
            self._status(tr("status.wave_not_found"))
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
                self._log_panel.append_success(
                    tr("log.wave_open_ok", viewer=viewer_name, file=str(wave_file))
                )
                self._status(tr("status.wave_opened", file=str(wave_file)))
            except Exception as e:
                self._log_panel.append_error(
                    tr("log.wave_open_failed", viewer=viewer_name, err=e)
                )
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
                self._log_panel.append_error(tr("log.file_open_failed", err=e))

    def _on_log_anchor_clicked(self, url: QUrl):
        href = url.toString()
        if href.startswith("file://"):
            path_part = href[7:]
            filepath, _, lineno = path_part.partition(":")
            self._open_file_external(filepath)

    def closeEvent(self, event):
        self._auto_save()
        super().closeEvent(event)
