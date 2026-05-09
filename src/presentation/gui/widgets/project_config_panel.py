# -*- coding: utf-8 -*-
"""
项目配置面板 — 全局库 / 项目库 / 工具选择 / 自定义仿真器 & 波形查看器
"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QGroupBox, QLabel,
    QComboBox, QListWidget, QPushButton, QFileDialog, QLineEdit,
)
from PySide6.QtCore import Signal

CUSTOM_SIM = "custom"
CUSTOM_WAVE = "custom"

from src.presentation.gui.i18n import tr


class ProjectConfigPanel(QWidget):

    config_changed = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)

        layout.addWidget(self._create_global_lib_group())
        layout.addWidget(self._create_project_lib_group())
        layout.addWidget(self._create_simulator_group())
        layout.addWidget(self._create_wave_viewer_group())
        layout.addStretch()

    def _create_global_lib_group(self):
        self._global_grp = QGroupBox("?")
        lo = QVBoxLayout(self._global_grp)

        self._global_lib_list = QListWidget()
        lo.addWidget(self._global_lib_list)

        row_btn = QHBoxLayout()
        self._btn_add_global = QPushButton("?")
        self._btn_add_global.clicked.connect(self._add_global_lib)
        self._btn_remove_global = QPushButton("?")
        self._btn_remove_global.clicked.connect(self._remove_global_lib)
        row_btn.addWidget(self._btn_add_global)
        row_btn.addWidget(self._btn_remove_global)
        row_btn.addStretch()
        lo.addLayout(row_btn)

        return self._global_grp

    def _create_project_lib_group(self):
        self._proj_lib_grp = QGroupBox("?")
        lo = QVBoxLayout(self._proj_lib_grp)

        self._project_lib_list = QListWidget()
        lo.addWidget(self._project_lib_list)

        row_btn = QHBoxLayout()
        self._btn_add_proj = QPushButton("?")
        self._btn_add_proj.clicked.connect(self._add_project_lib)
        self._btn_remove_proj = QPushButton("?")
        self._btn_remove_proj.clicked.connect(self._remove_project_lib)
        row_btn.addWidget(self._btn_add_proj)
        row_btn.addWidget(self._btn_remove_proj)
        row_btn.addStretch()
        lo.addLayout(row_btn)

        return self._proj_lib_grp

    def _create_simulator_group(self):
        self._sim_grp = QGroupBox("?")
        lo = QVBoxLayout(self._sim_grp)

        row1 = QHBoxLayout()
        self._sim_tool_label = QLabel("?")
        row1.addWidget(self._sim_tool_label)
        self._sim_combo = QComboBox()
        self._sim_combo.addItems(["iverilog", "vcs", "xsim", CUSTOM_SIM])
        self._sim_combo.currentTextChanged.connect(self._on_sim_changed)
        row1.addWidget(self._sim_combo, 1)
        lo.addLayout(row1)

        self._sim_custom_widget = QWidget()
        cl = QVBoxLayout(self._sim_custom_widget)
        cl.setContentsMargins(0, 4, 0, 0)

        self._sim_compile_label = QLabel("?")
        cl.addWidget(self._sim_compile_label)
        self._sim_compile_edit = QLineEdit()
        self._sim_compile_edit.setPlaceholderText("?")
        self._sim_compile_edit.textChanged.connect(lambda _: self._on_custom_sim_changed())
        cl.addWidget(self._sim_compile_edit)

        self._sim_run_label = QLabel("?")
        cl.addWidget(self._sim_run_label)
        self._sim_run_edit = QLineEdit()
        self._sim_run_edit.setPlaceholderText("?")
        self._sim_run_edit.textChanged.connect(lambda _: self._on_custom_sim_changed())
        cl.addWidget(self._sim_run_edit)

        lo.addWidget(self._sim_custom_widget)
        self._sim_custom_widget.setVisible(False)

        return self._sim_grp

    def _create_wave_viewer_group(self):
        self._wave_grp = QGroupBox("?")
        lo = QVBoxLayout(self._wave_grp)

        row1 = QHBoxLayout()
        self._wave_tool_label = QLabel("?")
        row1.addWidget(self._wave_tool_label)
        self._wave_combo = QComboBox()
        self._wave_combo.addItems(["surfer", "gtkwave", CUSTOM_WAVE])
        self._wave_combo.currentTextChanged.connect(self._on_wave_changed)
        row1.addWidget(self._wave_combo, 1)
        lo.addLayout(row1)

        self._wave_custom_widget = QWidget()
        cl = QVBoxLayout(self._wave_custom_widget)
        cl.setContentsMargins(0, 4, 0, 0)

        self._wave_launch_label = QLabel("?")
        cl.addWidget(self._wave_launch_label)
        self._wave_launch_edit = QLineEdit()
        self._wave_launch_edit.setPlaceholderText("?")
        self._wave_launch_edit.textChanged.connect(lambda _: self._on_custom_wave_changed())
        cl.addWidget(self._wave_launch_edit)

        lo.addWidget(self._wave_custom_widget)
        self._wave_custom_widget.setVisible(False)

        cl2 = QHBoxLayout()
        self._wave_path_label = QLabel("?")
        cl2.addWidget(self._wave_path_label)
        self._wave_path_edit = QLineEdit()
        self._wave_path_edit.setPlaceholderText("?")
        self._wave_path_edit.textChanged.connect(lambda _: self._on_custom_wave_changed())
        cl2.addWidget(self._wave_path_edit, 1)
        lo.addLayout(cl2)

        return self._wave_grp

    def retranslate(self):
        self._global_grp.setTitle(tr("config.global_lib"))
        self._proj_lib_grp.setTitle(tr("config.project_lib"))
        self._sim_grp.setTitle(tr("config.simulator"))
        self._wave_grp.setTitle(tr("config.wave_viewer"))

        self._btn_add_global.setText(tr("config.add_global"))
        self._btn_remove_global.setText(tr("config.remove"))
        self._btn_add_proj.setText(tr("config.add_project"))
        self._btn_remove_proj.setText(tr("config.remove"))

        self._sim_tool_label.setText(tr("config.sim_tool"))
        self._sim_compile_label.setText(tr("config.sim_compile"))
        self._sim_compile_edit.setPlaceholderText(tr("config.sim_compile_ph"))
        self._sim_run_label.setText(tr("config.sim_run"))
        self._sim_run_edit.setPlaceholderText(tr("config.sim_run_ph"))

        self._wave_tool_label.setText(tr("config.wave_tool"))
        self._wave_launch_label.setText(tr("config.wave_launch"))
        self._wave_launch_edit.setPlaceholderText(tr("config.wave_launch_ph"))
        self._wave_path_label.setText(tr("config.wave_path"))
        self._wave_path_edit.setPlaceholderText(tr("config.wave_path_ph"))

    def _on_sim_changed(self, text: str):
        self._sim_custom_widget.setVisible(text == CUSTOM_SIM)
        self.config_changed.emit()

    def _on_wave_changed(self, text: str):
        self._wave_custom_widget.setVisible(text == CUSTOM_WAVE)
        self.config_changed.emit()

    def _on_custom_sim_changed(self):
        if self._sim_combo.currentText() == CUSTOM_SIM:
            self.config_changed.emit()

    def _on_custom_wave_changed(self):
        if self._wave_combo.currentText() == CUSTOM_WAVE:
            self.config_changed.emit()

    def _add_global_lib(self):
        d = QFileDialog.getExistingDirectory(self, tr("config.dialog_global_lib"))
        if d:
            self._global_lib_list.addItem(d)
            self.config_changed.emit()

    def _remove_global_lib(self):
        row = self._global_lib_list.currentRow()
        if row >= 0:
            self._global_lib_list.takeItem(row)
            self.config_changed.emit()

    def _add_project_lib(self):
        d = QFileDialog.getExistingDirectory(self, tr("config.dialog_project_lib"))
        if d:
            self._project_lib_list.addItem(d)
            self.config_changed.emit()

    def _remove_project_lib(self):
        row = self._project_lib_list.currentRow()
        if row >= 0:
            self._project_lib_list.takeItem(row)
            self.config_changed.emit()

    @property
    def global_lib_dirs(self) -> list:
        result = []
        for i in range(self._global_lib_list.count()):
            result.append(self._global_lib_list.item(i).text())
        return result

    @global_lib_dirs.setter
    def global_lib_dirs(self, dirs: list):
        self._global_lib_list.clear()
        for d in dirs:
            self._global_lib_list.addItem(str(d))

    @property
    def project_lib_dirs(self) -> list:
        result = []
        for i in range(self._project_lib_list.count()):
            result.append(self._project_lib_list.item(i).text())
        return result

    @project_lib_dirs.setter
    def project_lib_dirs(self, dirs: list):
        self._project_lib_list.clear()
        for d in dirs:
            self._project_lib_list.addItem(str(d))

    @property
    def simulator(self) -> str:
        return self._sim_combo.currentText()

    @simulator.setter
    def simulator(self, value: str):
        idx = self._sim_combo.findText(value)
        if idx >= 0:
            self._sim_combo.setCurrentIndex(idx)
        else:
            self._sim_combo.setCurrentText(value)

    @property
    def wave_viewer(self) -> str:
        return self._wave_combo.currentText()

    @wave_viewer.setter
    def wave_viewer(self, value: str):
        idx = self._wave_combo.findText(value)
        if idx >= 0:
            self._wave_combo.setCurrentIndex(idx)
        else:
            self._wave_combo.setCurrentText(value)

    def get_custom_sim_config(self) -> dict:
        return {
            'compile_cmd': self._sim_compile_edit.text().strip(),
            'run_cmd': self._sim_run_edit.text().strip(),
        }

    def set_custom_sim_config(self, compile_cmd: str, run_cmd: str):
        self._sim_compile_edit.setText(compile_cmd)
        self._sim_run_edit.setText(run_cmd)

    def get_custom_wave_config(self) -> str:
        return self._wave_launch_edit.text().strip()

    def set_custom_wave_config(self, launch_cmd: str):
        self._wave_launch_edit.setText(launch_cmd)

    @property
    def wave_file_template(self) -> str:
        return self._wave_path_edit.text().strip() or '{top_module}.vcd'

    @wave_file_template.setter
    def wave_file_template(self, value: str):
        self._wave_path_edit.setText(value)
