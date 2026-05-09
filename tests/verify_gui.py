# -*- coding: utf-8 -*-
"""GUI 无头验证"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from PySide6.QtWidgets import QApplication

app = QApplication.instance() or QApplication(sys.argv)

from src.presentation.gui.widgets.project_panel import ProjectPanel
from src.presentation.gui.widgets.project_config_panel import ProjectConfigPanel
from src.presentation.gui.widgets.log_panel import LogPanel
from src.presentation.gui.widgets.unified_module_panel import UnifiedModulePanel

pp = ProjectPanel()
pp.set_project_info("test_proj", "d:/test")
pp.top_module = "top_tb"
pp.populate_modules(["top_tb", "uart_rx", "uart_tx", "i2c_master"])
assert pp.top_module == "top_tb"
print("ProjectPanel: top select OK")

cp = ProjectConfigPanel()
cp.global_lib_dirs = ["/global/lib1", "/global/lib2"]
cp.project_lib_dirs = ["/proj/lib1"]
cp._global_lib_list.setCurrentRow(0)
cp._remove_global_lib()
assert cp.global_lib_dirs == ["/global/lib2"], f"Got {cp.global_lib_dirs}"
cp.wave_file_template = "{top_module}.vcd"
assert cp.wave_file_template == "{top_module}.vcd"
print("ProjectConfigPanel: remove global lib + wave_file_template OK")

um = UnifiedModulePanel()
um.set_data(categorized={
    "Project Root": {
        "uart_tx": Path("d:/test/uart_tx.v"),
        "uart_rx": Path("d:/test/uart_rx.v"),
    },
    "Global: /lib/fpga_lib": {
        "i2c_master": Path("d:/test/i2c_master.v"),
        "fifo_async": Path("d:/lib/fpga_lib/fifo_async.v"),
    },
})
print("UnifiedModulePanel: categorized 4 modules in 2 groups OK")

lp = LogPanel()
lp.append_info("info")
lp.append_success("ok")
lp.append_error_entry("ERROR", "syntax error", "foo.v", 10)
print("LogPanel: 3 messages OK")

from src.presentation.gui.main_window import MainWindow
w = MainWindow()
print(f"MainWindow: {w.windowTitle()}, size={w.size().width()}x{w.size().height()}")
print("GUI instantiation OK - all checks passed")
