# -*- coding: utf-8 -*-
"""
VeriFlow GUI 启动入口
Usage: python -m src.presentation.gui
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from PySide6.QtWidgets import QApplication
from src.presentation.gui.main_window import MainWindow


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("VeriFlow")
    app.setOrganizationName("VeriFlow")

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
