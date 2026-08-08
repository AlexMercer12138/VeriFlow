# -*- coding: utf-8 -*-
"""
VeriFlow GUI 启动入口
Usage: python -m src.presentation.gui
"""

import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from PySide6.QtWidgets import QApplication
from src.presentation.gui.main_window import MainWindow
from src.presentation.deprecation import warn_python_product


def _configure_qt_webengine() -> None:
    flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
    required = [
        "--disable-gpu",
        "--disable-gpu-compositing",
        "--enable-webgl-software-rendering",
    ]
    missing = [flag for flag in required if flag not in flags]
    if missing:
        os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = " ".join(
            [part for part in [flags, " ".join(missing)] if part]
        )


def main():
    _configure_qt_webengine()
    app = QApplication(sys.argv)
    app.setApplicationName("VeriFlow")
    app.setOrganizationName("VeriFlow")

    window = MainWindow()
    window.show()

    return app.exec()


def deprecated_main():
    warn_python_product("GUI")
    return main()


if __name__ == "__main__":
    sys.exit(deprecated_main())
