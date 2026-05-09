# -*- coding: utf-8 -*-
"""
日志面板 — 带颜色标记的日志输出，支持错误行单击跳转
"""

from PySide6.QtWidgets import QTextBrowser, QWidget, QVBoxLayout, QHBoxLayout, QPushButton
from PySide6.QtGui import QTextCursor, QColor, QTextCharFormat, QFont, QDesktopServices
from PySide6.QtCore import Signal, QUrl


class LogPanel(QWidget):
    """日志输出面板"""

    entry_clicked = Signal(str, int)

    COLOR_ERROR = QColor(220, 50, 50)
    COLOR_WARNING = QColor(220, 160, 20)
    COLOR_INFO = QColor(200, 200, 200)
    COLOR_SUCCESS = QColor(80, 200, 80)
    COLOR_TIMESTAMP = QColor(120, 120, 120)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        toolbar = QHBoxLayout()
        btn_clear = QPushButton("Clear")
        btn_clear.clicked.connect(self.clear)
        toolbar.addStretch()
        toolbar.addWidget(btn_clear)
        layout.addLayout(toolbar)

        self._text = QTextBrowser()
        self._text.setOpenExternalLinks(False)
        font = QFont("Consolas", 10)
        self._text.setFont(font)
        self._text.setStyleSheet(
            "QTextBrowser { background-color: #1e1e1e; color: #d4d4d4; border: 1px solid #3c3c3c; }"
        )
        self._text.setLineWrapMode(QTextBrowser.NoWrap)
        layout.addWidget(self._text, 1)

    def clear(self):
        self._text.clear()

    def append_info(self, msg: str):
        self._append_colored(msg, self.COLOR_INFO)

    def append_success(self, msg: str):
        self._append_colored(msg, self.COLOR_SUCCESS)

    def append_warning(self, msg: str):
        self._append_colored(msg, self.COLOR_WARNING)

    def append_error(self, msg: str, file_ref: str = None, line_no: int = None):
        self._append_colored(msg, self.COLOR_ERROR)

    def append_error_entry(self, level: str, message: str, file_ref: str = None, line_no: int = None):
        cursor = self._text.textCursor()
        cursor.movePosition(QTextCursor.End)

        fmt = QTextCharFormat()
        fmt.setForeground(self.COLOR_TIMESTAMP)
        cursor.insertText("[", fmt)

        level_color = self.COLOR_ERROR if level.upper() == "ERROR" else self.COLOR_WARNING
        fmt.setForeground(level_color)
        cursor.insertText(level.upper(), fmt)

        fmt.setForeground(self.COLOR_TIMESTAMP)
        cursor.insertText("] ", fmt)

        if file_ref and line_no:
            fmt = QTextCharFormat()
            fmt.setForeground(self.COLOR_INFO)
            fmt.setAnchor(True)
            fmt.setAnchorHref(f"file://{file_ref}:{line_no}")
            fmt.setToolTip(f"Click to open {file_ref}:{line_no}")
            fmt.setUnderlineStyle(QTextCharFormat.SingleUnderline)
            cursor.insertText(f"{file_ref}:{line_no}: ", fmt)
        elif file_ref:
            fmt = QTextCharFormat()
            fmt.setForeground(self.COLOR_INFO)
            fmt.setAnchor(True)
            fmt.setAnchorHref(f"file://{file_ref}")
            fmt.setToolTip(f"Click to open {file_ref}")
            fmt.setUnderlineStyle(QTextCharFormat.SingleUnderline)
            cursor.insertText(f"{file_ref}: ", fmt)

        fmt = QTextCharFormat()
        fmt.setForeground(level_color)
        cursor.insertText(message, fmt)

        fmt = QTextCharFormat()
        cursor.insertText("\n", fmt)

        self._text.setTextCursor(cursor)
        self._text.ensureCursorVisible()

    def append_sim_result(self, success: bool, stdout: str, stderr: str, elapsed: float):
        for line in stdout.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            lower = stripped.lower()
            if 'error' in lower:
                self._append_colored(stripped, self.COLOR_ERROR)
            elif 'warning' in lower:
                self._append_colored(stripped, self.COLOR_WARNING)
            else:
                self._append_colored(stripped, self.COLOR_INFO)

        for line in stderr.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            self._append_colored(stripped, self.COLOR_ERROR)

        status = "SUCCESS" if success else "FAILED"
        color = self.COLOR_SUCCESS if success else self.COLOR_ERROR
        self._append_colored(f"[{status}] Elapsed: {elapsed:.2f}s", color)

    def _append_colored(self, msg: str, color: QColor):
        cursor = self._text.textCursor()
        cursor.movePosition(QTextCursor.End)
        fmt = QTextCharFormat()
        fmt.setForeground(color)
        cursor.insertText(msg + "\n", fmt)
        self._text.setTextCursor(cursor)
        self._text.ensureCursorVisible()

    def set_anchor_click_handler(self, handler):
        self._text.anchorClicked.connect(handler)
