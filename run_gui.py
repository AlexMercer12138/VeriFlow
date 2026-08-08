# -*- coding: utf-8 -*-
"""
VeriFlow GUI 单文件入口 (供 PyInstaller 打包使用)
"""

import sys
import os
from pathlib import Path


def main():
    if getattr(sys, 'frozen', False):
        base_dir = Path(sys._MEIPASS)
    else:
        base_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(base_dir))

    from PySide6.QtWidgets import QApplication
    from PySide6.QtGui import QIcon
    from src.presentation.gui.main_window import MainWindow
    from src.presentation.deprecation import warn_python_product

    warn_python_product("GUI")

    app = QApplication(sys.argv)
    app.setApplicationName("VeriFlow")
    app.setOrganizationName("VeriFlow")

    icon_path = base_dir / 'src' / 'presentation' / 'gui' / 'resources' / 'icon.ico'
    if not icon_path.exists():
        icon_path = base_dir / 'resources' / 'icon.ico'
    if icon_path.exists():
        app.setWindowIcon(QIcon(str(icon_path)))

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
