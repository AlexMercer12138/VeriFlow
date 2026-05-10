# -*- coding: utf-8 -*-
"""
Testbench 生成面板 — 多模块 + 端口参数编辑器
"""

from typing import List, Dict

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QGroupBox, QLabel,
    QLineEdit, QPushButton, QComboBox, QScrollArea,
    QListWidget, QListWidgetItem,
    QSplitter, QStackedWidget, QFormLayout, QSizePolicy,
)
from PySide6.QtCore import Signal, Qt
from src.presentation.gui.i18n import tr

FREQ_W = 64
BTN_W = 24


def _make_mini_btn(text: str) -> QPushButton:
    b = QPushButton(text)
    b.setFixedSize(BTN_W, BTN_W)
    b.setStyleSheet("font-size: 13px; padding: 0px;")
    return b


class ModuleEntry:
    def __init__(self, module_name: str, filepath: str = ""):
        self.module_name = module_name
        self.verilog_module_name = module_name
        self.filepath = filepath
        self.instance_name = f"u_{module_name}"
        self.ports: list = []
        self.params: list = []
        self._port_signal_overrides: Dict[str, str] = {}
        self._param_value_overrides: Dict[str, str] = {}

    def port_signal_name(self, port_name: str) -> str:
        return self._port_signal_overrides.get(port_name, f"{port_name}")

    def set_port_signal_name(self, port_name: str, signal: str):
        self._port_signal_overrides[port_name] = signal

    def param_value(self, param_name: str, default_val: str) -> str:
        return self._param_value_overrides.get(param_name, default_val)

    def set_param_value(self, param_name: str, value: str):
        self._param_value_overrides[param_name] = value


class TestbenchPanel(QWidget):

    def __init__(self, parent=None):
        super().__init__(parent)
        self._module_all: Dict[str, str] = {}
        self._module_entries: List[ModuleEntry] = []
        self._init_ui()
        self._add_clock()

    def _init_ui(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setContentsMargins(8, 8, 8, 8)

        layout.addWidget(self._create_name_section())
        layout.addWidget(self._create_clock_section())
        layout.addWidget(self._create_reset_section())
        layout.addWidget(self._create_module_section(), 1)
        layout.addWidget(self._create_wave_section())
        layout.addWidget(self._create_timeout_section())
        layout.addWidget(self._create_generate_button())

        scroll.setWidget(container)
        outer.addWidget(scroll)

    def _create_name_section(self):
        self._name_grp = QGroupBox(tr("tb.props"))
        lo = QVBoxLayout(self._name_grp)
        row = QHBoxLayout()
        self._name_label_w = QLabel(tr("tb.name_label"))
        row.addWidget(self._name_label_w)
        self._name_edit = QLineEdit()
        self._name_edit.setPlaceholderText(tr("tb.name_ph"))
        row.addWidget(self._name_edit, 1)
        self._time_unit_label = QLabel(tr("tb.time_unit"))
        row.addWidget(self._time_unit_label)
        self._time_unit_edit = QLineEdit("1ns")
        self._time_unit_edit.setFixedWidth(64)
        row.addWidget(self._time_unit_edit)
        self._time_prec_label = QLabel(tr("tb.time_prec"))
        row.addWidget(self._time_prec_label)
        self._time_prec_edit = QLineEdit("1ps")
        self._time_prec_edit.setFixedWidth(64)
        row.addWidget(self._time_prec_edit)
        lo.addLayout(row)
        return self._name_grp

    def _create_clock_section(self):
        self._clock_grp = QGroupBox(tr("tb.clock"))
        self._clock_layout = QHBoxLayout(self._clock_grp)

        self._clock_flow = QWidget()
        self._clock_flow.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        flow_lo = QHBoxLayout(self._clock_flow)
        flow_lo.setContentsMargins(0, 0, 0, 0)
        flow_lo.setSpacing(6)
        self._clock_layout.addWidget(self._clock_flow)

        self._clock_layout.addStretch()

        self._clock_mhz_label = QLabel(tr("tb.clock_mhz"))
        self._clock_mhz_label.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        self._clock_mhz_label.setStyleSheet("color: #888;")
        self._clock_layout.addWidget(self._clock_mhz_label)

        self._btn_add_clock = _make_mini_btn("+")
        self._btn_add_clock.clicked.connect(self._add_clock)
        self._clock_layout.addWidget(self._btn_add_clock)

        self._btn_remove_clock = _make_mini_btn("-")
        self._btn_remove_clock.clicked.connect(self._remove_last_clock)
        self._clock_layout.addWidget(self._btn_remove_clock)

        return self._clock_grp

    def _create_reset_section(self):
        self._reset_grp = QGroupBox(tr("tb.reset"))
        lo = QHBoxLayout(self._reset_grp)
        self._reset_polarity_label = QLabel(tr("tb.reset_polarity"))
        lo.addWidget(self._reset_polarity_label)
        self._reset_pol_combo = QComboBox()
        self._reset_pol_combo.addItems([tr("tb.reset_active_high"), tr("tb.reset_active_low")])
        lo.addWidget(self._reset_pol_combo, 1)
        self._reset_pol_combo.setCurrentIndex(1)  # Active Low
        self._reset_dur_label = QLabel(tr("tb.reset_duration"))
        lo.addWidget(self._reset_dur_label)
        self._reset_dur_edit = QLineEdit("100")
        self._reset_dur_edit.setPlaceholderText(tr("tb.reset_duration_ph"))
        lo.addWidget(self._reset_dur_edit, 1)
        return self._reset_grp

    def _create_module_section(self):
        self._mod_grp = QGroupBox(tr("tb.module"))
        lo = QVBoxLayout(self._mod_grp)

        add_row = QHBoxLayout()
        self._mod_add_label = QLabel(tr("tb.module_add"))
        add_row.addWidget(self._mod_add_label)
        self._module_add_combo = QComboBox()
        self._module_add_combo.setSizeAdjustPolicy(QComboBox.AdjustToContents)
        add_row.addWidget(self._module_add_combo, 1)
        self._btn_add_module = _make_mini_btn("+")
        self._btn_add_module.clicked.connect(self._add_module)
        add_row.addWidget(self._btn_add_module)
        self._btn_remove_module = _make_mini_btn("-")
        self._btn_remove_module.clicked.connect(self._remove_module)
        add_row.addWidget(self._btn_remove_module)
        lo.addLayout(add_row)

        splitter = QSplitter(Qt.Horizontal)

        self._mod_list = QListWidget()
        self._mod_list.currentRowChanged.connect(self._on_module_selected)
        self._mod_list.setMaximumWidth(200)
        splitter.addWidget(self._mod_list)

        right_pane = QWidget()
        right_lo = QVBoxLayout(right_pane)
        right_lo.setContentsMargins(4, 0, 0, 0)

        self._mod_placeholder = QLabel(tr("tb.module_placeholder"))
        self._mod_placeholder.setAlignment(Qt.AlignTop)
        self._mod_placeholder.setStyleSheet("color: #888; padding: 6px;")
        right_lo.addWidget(self._mod_placeholder)

        self._mod_detail_stack = QStackedWidget()
        self._mod_port_scrolls: dict = {}
        right_lo.addWidget(self._mod_detail_stack, 1)

        splitter.addWidget(right_pane)
        lo.addWidget(splitter, 1)

        return self._mod_grp

    def _build_module_editor(self, entry: ModuleEntry):
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        w = QWidget()
        form = QFormLayout(w)
        form.setContentsMargins(4, 4, 4, 4)

        form.addRow(QLabel(tr("tb.module_inst")), None)
        inst_edit = QLineEdit(entry.instance_name)
        inst_edit.textChanged.connect(lambda t, e=entry: self._on_inst_changed(e, t))
        form.addRow(inst_edit)

        if entry.params:
            form.addRow(QLabel(tr("tb.module_params")), None)
            for param in entry.params:
                pname = param.name
                pval = entry.param_value(pname, param.value)
                pe = QLineEdit(pval)
                pe.textChanged.connect(lambda t, e=entry, pn=pname: e.set_param_value(pn, t))
                form.addRow(QLabel(f"  {pname}:"), pe)

        form.addRow(QLabel(tr("tb.module_ports")), None)
        for port in entry.ports:
            pname = port.name
            direction = port.direction
            width_str = port.get_width_str()
            hint = f"{direction} {width_str}".strip()
            sig_name = entry.port_signal_name(pname)
            pe = QLineEdit(sig_name)
            pe.textChanged.connect(lambda t, e=entry, pn=pname: e.set_port_signal_name(pn, t))
            lbl = QLabel(f"  {pname} ({hint}):")
            form.addRow(lbl, pe)

        scroll.setWidget(w)
        self._mod_port_scrolls[entry.module_name] = scroll
        self._mod_detail_stack.addWidget(scroll)

    def _on_inst_changed(self, entry: ModuleEntry, text: str):
        entry.instance_name = text.strip()
        self._refresh_module_list_labels()

    def _refresh_module_list_labels(self):
        for i, entry in enumerate(self._module_entries):
            item = self._mod_list.item(i)
            if item:
                item.setText(f"{entry.module_name} ({entry.instance_name})")

    def _add_module(self):
        if len(self._module_entries) >= 20:
            return
        base_name = self._module_add_combo.currentText()
        if not base_name:
            return

        same_count = sum(1 for e in self._module_entries if e.verilog_module_name == base_name)
        display_name = f"{base_name}_{same_count}" if same_count > 0 else base_name

        filepath = self._module_all.get(base_name, "")
        entry = ModuleEntry(display_name, filepath)
        entry.verilog_module_name = base_name

        if filepath:
            try:
                self._parse_module_ports(entry, filepath)
            except Exception:
                pass

        self._module_entries.append(entry)
        self._build_module_editor(entry)

        item = QListWidgetItem(f"{display_name} ({entry.instance_name})")
        self._mod_list.addItem(item)
        self._mod_list.setCurrentRow(len(self._module_entries) - 1)
        self._update_mod_placeholder()

    def _parse_module_ports(self, entry: ModuleEntry, filepath: str):
        from src.infrastructure.file_service import FileService
        from src.domain.services.port_parser_service import PortParserService
        fs = FileService()
        parser = PortParserService(fs)
        info = parser.parse_file(filepath)
        entry.ports = list(info.ports)
        entry.params = list(info.parameters)

    def _remove_module(self):
        row = self._mod_list.currentRow()
        if row < 0:
            return
        entry = self._module_entries.pop(row)
        self._mod_list.takeItem(row)
        if entry.module_name in self._mod_port_scrolls:
            w = self._mod_port_scrolls.pop(entry.module_name)
            self._mod_detail_stack.removeWidget(w)
            w.deleteLater()
        self._update_mod_placeholder()

    def _update_mod_placeholder(self):
        self._mod_placeholder.setVisible(len(self._module_entries) == 0)

    def _on_module_selected(self, index: int):
        if index < 0 or index >= len(self._module_entries):
            return
        entry = self._module_entries[index]
        if entry.module_name in self._mod_port_scrolls:
            self._mod_detail_stack.setCurrentWidget(self._mod_port_scrolls[entry.module_name])

    def _add_clock(self):
        if len(self._add_clock_rows()) >= 6:
            return
        row = QWidget()
        row.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        lo = QHBoxLayout(row)
        lo.setContentsMargins(0, 2, 0, 2)
        idx = len(self._add_clock_rows())
        label = QLabel(f"Clk{idx + 1}:")
        label.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        lo.addWidget(label)
        freq_edit = QLineEdit("100")
        freq_edit.setPlaceholderText("100")
        freq_edit.setFixedWidth(FREQ_W)
        lo.addWidget(freq_edit)
        row.setProperty("freq_edit", freq_edit)
        flow_lo = self._clock_flow.layout()
        flow_lo.insertWidget(flow_lo.count(), row)
        self._update_clock_buttons()

    def _remove_last_clock(self):
        rows = self._add_clock_rows()
        if len(rows) <= 1:
            return
        last = rows[-1]
        self._clock_flow.layout().removeWidget(last)
        last.deleteLater()
        self._update_clock_buttons()

    def _add_clock_rows(self) -> list:
        lo = self._clock_flow.layout()
        result = []
        for i in range(lo.count()):
            item = lo.itemAt(i)
            if item and item.widget():
                result.append(item.widget())
        return result

    def _update_clock_buttons(self):
        n = len(self._add_clock_rows())
        self._btn_add_clock.setEnabled(n < 6)
        self._btn_remove_clock.setEnabled(n > 1)

    def set_module_map(self, module_map: dict):
        self._module_all = dict(module_map)
        current = self._module_add_combo.currentText()
        self._module_add_combo.blockSignals(True)
        self._module_add_combo.clear()
        self._module_add_combo.addItems(sorted(self._module_all.keys()))
        if current and current in self._module_all:
            self._module_add_combo.setCurrentText(current)
        self._module_add_combo.blockSignals(False)

    def retranslate(self):
        self._name_grp.setTitle(tr("tb.props"))
        self._name_label_w.setText(tr("tb.name_label"))
        self._name_edit.setPlaceholderText(tr("tb.name_ph"))
        self._time_unit_label.setText(tr("tb.time_unit"))
        self._time_prec_label.setText(tr("tb.time_prec"))
        self._clock_grp.setTitle(tr("tb.clock"))
        self._clock_mhz_label.setText(tr("tb.clock_mhz"))
        self._reset_grp.setTitle(tr("tb.reset"))
        self._reset_polarity_label.setText(tr("tb.reset_polarity"))
        self._reset_dur_label.setText(tr("tb.reset_duration"))
        self._reset_dur_edit.setPlaceholderText(tr("tb.reset_duration_ph"))
        idx = self._reset_pol_combo.currentIndex()
        self._reset_pol_combo.clear()
        self._reset_pol_combo.addItems([tr("tb.reset_active_high"), tr("tb.reset_active_low")])
        self._reset_pol_combo.setCurrentIndex(idx)
        self._mod_grp.setTitle(tr("tb.module"))
        self._mod_add_label.setText(tr("tb.module_add"))
        self._mod_placeholder.setText(tr("tb.module_placeholder"))
        self._wave_grp.setTitle(tr("tb.wave"))
        self._wave_file_label.setText(tr("tb.wave_file"))
        self._wave_edit.setPlaceholderText(tr("tb.wave_ph"))
        self._timeout_grp.setTitle(tr("tb.timeout"))
        self._timeout_max_label.setText(tr("tb.timeout_max"))
        self._timeout_edit.setPlaceholderText(tr("tb.timeout_ph"))
        self._btn_generate.setText(tr("tb.generate"))

    def get_name(self) -> str:
        return self._name_edit.text().strip()

    def get_config(self) -> dict:
        clks = []
        for row in self._add_clock_rows():
            e = row.property("freq_edit")
            if e:
                f = e.text().strip()
                if f:
                    clks.append(f)
        tb_name = self._name_edit.text().strip()
        wave_file = self._wave_edit.text().strip()
        if not wave_file:
            wave_file = f"{tb_name}.vcd" if tb_name else "tb_top.vcd"

        modules_config = []
        for entry in self._module_entries:
            port_signals = {}
            for p in entry.ports:
                port_signals[p.name] = entry.port_signal_name(p.name)
            param_values = {}
            for p in entry.params:
                param_values[p.name] = entry.param_value(p.name, p.value)
            modules_config.append({
                'module_name': entry.verilog_module_name,
                'instance_name': entry.instance_name,
                'filepath': entry.filepath,
                'port_signals': port_signals,
                'param_values': param_values,
            })

        return {
            'name': tb_name,
            'time_unit': self._time_unit_edit.text().strip() or '1ns',
            'time_precision': self._time_prec_edit.text().strip() or '1ps',
            'clocks_mhz': clks,
            'reset_active_high': self._reset_pol_combo.currentIndex() == 0,
            'reset_duration': self._reset_dur_edit.text().strip(),
            'modules': modules_config,
            'wave_file': wave_file,
            'timeout': self._timeout_edit.text().strip(),
        }

    def _create_wave_section(self):
        self._wave_grp = QGroupBox(tr("tb.wave"))
        lo = QVBoxLayout(self._wave_grp)
        row = QHBoxLayout()
        self._wave_file_label = QLabel(tr("tb.wave_file"))
        row.addWidget(self._wave_file_label)
        self._wave_edit = QLineEdit()
        self._wave_edit.setPlaceholderText(tr("tb.wave_ph"))
        row.addWidget(self._wave_edit, 1)
        lo.addLayout(row)
        return self._wave_grp

    def _create_timeout_section(self):
        self._timeout_grp = QGroupBox(tr("tb.timeout"))
        lo = QVBoxLayout(self._timeout_grp)
        row = QHBoxLayout()
        self._timeout_max_label = QLabel(tr("tb.timeout_max"))
        row.addWidget(self._timeout_max_label)
        self._timeout_edit = QLineEdit("1000000")
        self._timeout_edit.setPlaceholderText(tr("tb.timeout_ph"))
        row.addWidget(self._timeout_edit, 1)
        lo.addLayout(row)
        return self._timeout_grp

    def _create_generate_button(self):
        self._btn_generate = QPushButton(tr("tb.generate"))
        self._btn_generate.setMinimumHeight(42)
        return self._btn_generate

    @property
    def generate_clicked(self) -> Signal:
        return self._btn_generate.clicked
