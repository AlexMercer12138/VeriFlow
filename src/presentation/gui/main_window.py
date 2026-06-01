# -*- coding: utf-8 -*-
"""
主窗口 — 左侧侧边栏(Project+FileTree+按钮) | 右侧标签页(Config/Modules/Log)
支持语言切换（中/英）和主题切换（暗/亮）
支持按钮状态颜色与自动状态流转
"""

import os
import hashlib
import time
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
from src.presentation.gui.widgets.testbench_panel import TestbenchPanel
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
        self._module_worker = None
        self._analyze_worker = None
        self._sim_worker = None
        self._pending_workers = []
        self._global_config = GlobalConfigService()
        # 用于检测目录/文件变动的快照
        self._last_project_root = None
        self._last_lib_dirs = []
        self._last_dep_files = []
        self._last_dep_file_hashes = {}  # filepath -> content hash
        self._last_focus_check_time = 0  # 上次焦点检测时间戳
        self._focus_debounce_ms = 2000   # 去抖间隔 2秒
        self._init_language_theme()
        self._init_ui()
        self._connect_signals()
        self._apply_theme()
        self._load_global_config()
        self._initializing = False
        self._retranslate_ui()
        self._welcome()
        self._install_focus_detection()

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

        self._tb_panel = TestbenchPanel()
        self._tb_panel.generate_clicked.connect(self._on_generate_tb)
        self._tb_panel.config_changed.connect(self._on_tb_config_changed)

        self._tab_widget.addTab(self._config_panel, "?")
        self._tab_widget.addTab(self._module_panel, "?")
        self._tab_widget.addTab(self._tb_panel, "?")
        self._tab_widget.addTab(self._log_panel, "?")
        self._tab_widget.currentChanged.connect(self._on_tab_changed)

        h_splitter.addWidget(self._project_panel)
        h_splitter.addWidget(self._tab_widget)
        h_splitter.setSizes([360, 920])

        self.setCentralWidget(h_splitter)

    def _retranslate_ui(self):
        self.setWindowTitle(tr("window.title"))
        self._tab_widget.setTabText(0, tr("tab.config"))
        self._tab_widget.setTabText(1, tr("tab.modules"))
        self._tab_widget.setTabText(2, tr("tab.tb"))
        self._tab_widget.setTabText(3, tr("tab.log"))
        self._project_panel.retranslate()
        self._config_panel.retranslate()
        self._module_panel.retranslate()
        self._tb_panel.retranslate()
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
        self._project_panel.set_theme(t)

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
            self._check_config_change_for_status()

    def _on_tb_config_changed(self):
        if self._initializing:
            return
        self._auto_save()

    def _on_tab_changed(self, index: int):
        if self._initializing or not self._project:
            return
        if index in (1, 2):
            self._refresh_modules()

    def _check_config_change_for_status(self):
        """库目录或工程目录变动时，分析依赖标记为已过时"""
        if not self._project:
            return
        current_root = str(self._project.root_dir)
        current_libs = [str(d) for d in self._project.lib_dirs]
        if self._last_project_root is not None:
            if current_root != self._last_project_root or current_libs != self._last_lib_dirs:
                self._set_analyze_status('outdated')
        self._last_project_root = current_root
        self._last_lib_dirs = current_libs

    def _sync_project_from_ui(self):
        if not self._project:
            return
        p = self._project
        p.top_module = self._project_panel.top_module
        p.lib_dirs = [Path(d) for d in self._config_panel.project_lib_dirs]
        p.simulator = self._config_panel.simulator
        p.wave_viewer = self._config_panel.wave_viewer
        p.wave_file_template = self._config_panel.wave_file_template
        p.testbench_output_dir = self._tb_panel.output_dir

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
        self._tb_panel.output_dir = p.testbench_output_dir

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

    def _set_analyze_status(self, status: str):
        if self._project:
            self._project.analyze_status = status
        self._project_panel.set_button_status(analyze_status=status)
        # 当分析依赖变为已过时/出错/未开始时，编译仿真也必然需要重新进行
        if status in ('outdated', 'error', 'idle'):
            self._set_simulate_status(status)
        self._auto_save()

    def _set_simulate_status(self, status: str):
        if self._project:
            self._project.simulate_status = status
        self._project_panel.set_button_status(simulate_status=status)
        self._auto_save()

    def _reset_state(self):
        self._dep_result = None
        self._sim_result = None
        self._categorized_cache = {}
        self._module_panel.set_data(categorized={})
        self._last_project_root = None
        self._last_lib_dirs = []
        self._last_dep_files = []
        self._last_dep_file_hashes = {}
        self._last_focus_check_time = 0
        self._project_panel.set_button_status(analyze_status='idle', simulate_status='idle')

    def _load_dependency_result(self):
        """从工程文件加载依赖分析结果"""
        if not self._project or not self._project.dependency_result:
            return
        try:
            self._dep_result = DependencyResult.from_dict(self._project.dependency_result)
            self._last_dep_files = [str(f) for f in self._dep_result.files]
            self._last_dep_file_hashes = self._compute_dep_hashes()
            # 恢复按钮状态
            a_status = self._project.analyze_status or 'idle'
            s_status = self._project.simulate_status or 'idle'
            self._project_panel.set_button_status(analyze_status=a_status, simulate_status=s_status)
            # 更新模块面板
            self._module_panel.set_data(
                dep_result=self._dep_result,
                categorized=self._categorized_cache if hasattr(self, '_categorized_cache') else {}
            )
        except Exception as e:
            self._log_panel.append_error(f"Failed to load dependency result: {e}")
            self._dep_result = None

    def _save_dependency_result(self):
        """保存依赖分析结果到工程"""
        if self._project and self._dep_result:
            self._project.dependency_result = self._dep_result.to_dict()
            self._last_dep_files = [str(f) for f in self._dep_result.files]
            self._last_dep_file_hashes = self._compute_dep_hashes()
            self._auto_save()

    def _file_hash(self, filepath: str) -> str:
        """计算文件内容的MD5哈希，文件不存在返回空字符串"""
        try:
            with open(filepath, 'rb') as f:
                return hashlib.md5(f.read()).hexdigest()
        except Exception:
            return ''

    def _compute_dep_hashes(self) -> dict:
        """计算当前所有依赖文件的内容哈希"""
        if not self._dep_result:
            return {}
        return {str(f): self._file_hash(str(f)) for f in self._dep_result.files}

    def _check_dep_files_changed(self):
        """检查依赖文件列表或内容是否发生变动，若变动则标记编译仿真为已过时"""
        if not self._dep_result:
            return
        current_files = [str(f) for f in self._dep_result.files]
        current_hashes = self._compute_dep_hashes()

        changed = False
        # 检查文件列表是否变化（新增/删除/补齐）
        if set(current_files) != set(self._last_dep_files):
            changed = True
        else:
            # 检查每个文件的内容哈希是否变化
            for f in current_files:
                old_hash = self._last_dep_file_hashes.get(f, '')
                new_hash = current_hashes.get(f, '')
                if old_hash != new_hash:
                    changed = True
                    break

        if changed and self._project and self._project.simulate_status == 'completed':
            self._set_simulate_status('outdated')

        self._last_dep_files = current_files
        self._last_dep_file_hashes = current_hashes

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
            # 加载保存的依赖分析结果和状态
            self._last_project_root = str(self._project.root_dir)
            self._last_lib_dirs = [str(d) for d in self._project.lib_dirs]
            self._load_dependency_result()
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

    def _on_generate_tb(self):
        if not self._project:
            self._log_panel.append_warning(tr("tb.no_project"))
            self._tab_widget.setCurrentWidget(self._log_panel)
            return
        config = self._tb_panel.get_config()
        name = config.get('name', '').strip()
        if not name:
            self._log_panel.append_warning(tr("tb.name_empty"))
            self._tab_widget.setCurrentWidget(self._log_panel)
            return
        from src.domain.services.testbench_generator import TestbenchGenerator
        gen = TestbenchGenerator()
        self._project.testbench_output_dir = config.get('output_dir', '.') or '.'
        output_dir = self._project.resolve_testbench_output_dir()
        filepath = gen.generate(config, output_dir)
        self._auto_save()
        self._refresh_modules()
        self._log_panel.append_success(tr("tb.generated", path=filepath))
        self._status(tr("status.tb_generated", path=filepath))
        self._tab_widget.setCurrentWidget(self._log_panel)

    def _safe_stop_worker(self, worker):
        if worker and worker.isRunning():
            worker.wait(5000)
            if worker.isRunning():
                self._pending_workers.append(worker)

    def _refresh_modules(self):
        self._safe_stop_worker(self._module_worker)
        self._module_worker = ModuleScanWorker(self._project)
        self._module_worker.finished.connect(self._on_modules_scanned)
        self._module_worker.error_occurred.connect(
            lambda e: self._log_panel.append_error(e)
        )
        self._module_worker.start()

    def _on_modules_scanned(self, categorized: dict, duplicates: dict, duplicates_with_lines: dict, project_modules: dict):
        self._categorized_cache = categorized
        self._project_panel.populate_modules(list(project_modules.keys()))
        self._module_panel.set_data(dep_result=self._dep_result, categorized=categorized)
        self._tb_panel.set_module_map(project_modules)
        if duplicates_with_lines:
            for mod_name, entries in duplicates_with_lines.items():
                for entry in entries:
                    self._log_panel.append_warning(
                        tr("log.duplicate_module_detail",
                           module=mod_name,
                           file=str(entry["file"]),
                           line=entry["line"])
                    )
        total = sum(len(v) for v in categorized.values())
        self._status(tr("status.modules_count", count=total))
        # 模块扫描后检查依赖文件是否有变动
        self._check_dep_files_changed()

    def _on_analyze(self):
        if not self._project:
            self._log_panel.append_warning(tr("log.no_project"))
            self._tab_widget.setCurrentWidget(self._log_panel)
            return

        top = self._project_panel.top_module
        if not top:
            self._log_panel.append_warning(tr("msgbox.no_top_module"))
            self._tab_widget.setCurrentWidget(self._log_panel)
            return

        # 分析前先检查文件是否有变动
        self._check_dep_files_changed()

        self._auto_save()
        root = str(self._project.root_dir)

        self._log_panel.clear()
        self._log_panel.append_info(tr("log.analyzing", top=top, root=root))
        self._status(tr("status.analyzing"))
        self._project_panel.set_buttons_enabled(False, False, False)
        self._tab_widget.setCurrentWidget(self._module_panel)

        libs = [str(d) for d in self._project.lib_dirs]
        self._safe_stop_worker(self._analyze_worker)
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
            self._set_analyze_status('completed')
            self._check_dep_files_changed()
        else:
            self._log_panel.append_error(
                tr("log.missing_modules", modules=', '.join(result.missing_modules))
            )
            self._project_panel.set_buttons_enabled(True, False, False)
            self._status(tr("status.failed_missing"))
            self._set_analyze_status('error')

        self._save_dependency_result()
        self._module_panel.set_data(
            dep_result=result,
            categorized=self._categorized_cache if hasattr(self, '_categorized_cache') else {}
        )
        self._tab_widget.setCurrentWidget(self._module_panel)
        self._refresh_modules()

        # 如果有挂起的波形查看请求，分析成功后继续执行编译仿真
        if getattr(self, '_pending_wave_after_analyze', False):
            if result.success:
                self._pending_wave_after_analyze = False
                self._pending_wave_after_simulate = True
                self._on_simulate()
            else:
                self._pending_wave_after_analyze = False

    def _on_simulate(self):
        if not self._project:
            self._log_panel.append_warning(tr("log.no_project"))
            self._tab_widget.setCurrentWidget(self._log_panel)
            return

        top = self._project_panel.top_module
        if not top:
            self._log_panel.append_warning(tr("msgbox.no_top_module"))
            self._tab_widget.setCurrentWidget(self._log_panel)
            return

        # 编译仿真前先检查文件是否有变动
        self._check_dep_files_changed()

        # 检查依赖分析状态，如果不是已完成，先执行依赖分析
        analyze_status = self._project.analyze_status if self._project else 'idle'
        if analyze_status != 'completed':
            self._log_panel.append_info(
                tr("log.analyze_first", status=analyze_status)
                if False else "依赖分析状态不是已完成，先执行依赖分析..."
            )
            self._pending_simulate_after_analyze = True
            self._on_analyze()
            return

        self._auto_save()

        self._log_panel.clear()
        self._log_panel.append_info(
            tr("log.simulating", top=top, root=str(self._project.root_dir))
        )
        self._status(tr("status.simulating"))
        self._project_panel.set_buttons_enabled(False, False, False)
        self._tab_widget.setCurrentWidget(self._log_panel)

        self._safe_stop_worker(self._sim_worker)
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
            self._set_simulate_status('completed')
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
            self._set_simulate_status('error')

        self._tab_widget.setCurrentWidget(self._log_panel)

        # 如果之前有挂起的仿真请求（因为需要先分析依赖），继续处理
        if getattr(self, '_pending_simulate_after_analyze', False):
            self._pending_simulate_after_analyze = False
            if result.success:
                self._on_simulate()
            return

        # 如果之前有挂起的波形查看请求（因为需要先编译仿真），继续打开波形
        if getattr(self, '_pending_wave_after_simulate', False):
            if result.success:
                self._pending_wave_after_simulate = False
                wave_file = self._project.resolve_wave_file()
                if wave_file.exists():
                    self._do_open_wave(wave_file)
                else:
                    self._log_panel.append_error(
                        tr("log.wave_check_dumpfile", file=str(wave_file))
                    )
                    self._status(tr("status.wave_not_found"))
            else:
                self._pending_wave_after_simulate = False

    def _on_open_wave(self):
        if not self._project:
            self._log_panel.append_warning(tr("log.no_project"))
            return

        # 打开波形前先检查文件是否有变动
        self._check_dep_files_changed()

        self._auto_save()
        wave_file = self._project.resolve_wave_file()

        # 检查依赖分析状态
        analyze_status = self._project.analyze_status if self._project else 'idle'
        if analyze_status != 'completed':
            self._log_panel.append_info("依赖分析未完成，先执行依赖分析 -> 编译仿真 -> 打开波形...")
            self._pending_wave_after_analyze = True
            self._on_analyze()
            return

        # 检查编译仿真状态
        simulate_status = self._project.simulate_status if self._project else 'idle'
        if simulate_status != 'completed':
            self._log_panel.append_info("编译仿真未完成，先执行编译仿真 -> 打开波形...")
            self._pending_wave_after_simulate = True
            self._on_simulate()
            return

        # 分析依赖和编译仿真都已完成
        if wave_file.exists():
            self._tab_widget.setCurrentWidget(self._log_panel)
            self._do_open_wave(wave_file)
            return

        # 波形文件不存在，需要重新运行仿真生成
        self._log_panel.clear()
        self._log_panel.append_info(
            tr("log.wave_not_found", file=str(wave_file))
        )
        self._log_panel.append_info(tr("log.wave_running_sim"))
        self._status(tr("status.wave_sim_running"))
        self._project_panel.set_buttons_enabled(False, False, False)

        self._safe_stop_worker(self._sim_worker)
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
            self._set_simulate_status('error')
            return

        self._set_simulate_status('completed')
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

    def _install_focus_detection(self):
        """安装应用焦点检测：失焦时保存文件哈希快照，获焦时检测变动"""
        app = QApplication.instance()
        if app:
            app.applicationStateChanged.connect(self._on_app_state_changed)

    def _on_app_state_changed(self, state):
        """应用状态变化回调（带2秒去抖）"""
        if state == Qt.ApplicationActive:
            # 应用获得焦点：检查文件是否有变动（去抖）
            now = int(time.time() * 1000)
            if now - self._last_focus_check_time < self._focus_debounce_ms:
                return
            self._last_focus_check_time = now
            if self._project and self._dep_result:
                self._check_dep_files_changed()
        elif state == Qt.ApplicationInactive:
            # 应用失去焦点：保存当前文件哈希快照
            if self._project and self._dep_result:
                self._last_dep_files = [str(f) for f in self._dep_result.files]
                self._last_dep_file_hashes = self._compute_dep_hashes()

    def closeEvent(self, event):
        for worker in self._pending_workers:
            self._safe_stop_worker(worker)
        self._auto_save()
        for w in [self._module_worker, self._analyze_worker, self._sim_worker]:
            if w and w.isRunning():
                w.wait(3000)
        for w in self._pending_workers:
            if w.isRunning():
                w.wait(3000)
        super().closeEvent(event)
