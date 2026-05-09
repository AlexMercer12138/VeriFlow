# -*- coding: utf-8 -*-
"""
日志面板 — 带颜色标记的日志输出，支持错误行单击跳转，支持主题切换
"""

from PySide6.QtWidgets import QTextBrowser, QWidget, QVBoxLayout, QHBoxLayout, QPushButton
from PySide6.QtGui import QTextCursor, QColor, QTextCharFormat, QFont, QDesktopServices
from PySide6.QtCore import Signal, QUrl
from src.presentation.gui.i18n import tr


class LogPanel(QWidget):

    entry_clicked = Signal(str, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._theme = "dark"
        self._init_ui()
        self._apply_theme_colors()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        toolbar = QHBoxLayout()
        self._btn_clear = QPushButton("?")
        self._btn_clear.clicked.connect(self.clear)
        toolbar.addStretch()
        toolbar.addWidget(self._btn_clear)
        layout.addLayout(toolbar)

        self._text = QTextBrowser()
        self._text.setOpenExternalLinks(False)
        font = QFont("Consolas", 10)
        self._text.setFont(font)
        self._text.setLineWrapMode(QTextBrowser.NoWrap)
        layout.addWidget(self._text, 1)

    def retranslate(self):
        self._btn_clear.setText(tr("log.clear"))

    def update_theme(self, theme_name: str):
        self._theme = theme_name
        self._apply_theme_colors()

    def _apply_theme_colors(self):
        if self._theme == "dark":
            self._text.setStyleSheet(
                "QTextBrowser { background-color: #1e1e1e; color: #d4d4d4; border: 1px solid #3c3c3c; }"
            )
            self._color_error = QColor(220, 50, 50)
            self._color_warning = QColor(220, 160, 20)
            self._color_info = QColor(200, 200, 200)
            self._color_success = QColor(80, 200, 80)
            self._color_timestamp = QColor(120, 120, 120)
        else:
            self._text.setStyleSheet(
                "QTextBrowser { background-color: #ffffff; color: #333333; border: 1px solid #dddddd; }"
            )
            self._color_error = QColor(200, 40, 40)
            self._color_warning = QColor(180, 130, 10)
            self._color_info = QColor(50, 50, 50)
            self._color_success = QColor(30, 150, 30)
            self._color_timestamp = QColor(140, 140, 140)

    def clear(self):
        self._text.clear()

    def append_info(self, msg: str):
        self._append_colored(msg, self._color_info)

    def append_success(self, msg: str):
        self._append_colored(msg, self._color_success)

    def append_warning(self, msg: str):
        self._append_colored(msg, self._color_warning)

    def append_error(self, msg: str, file_ref: str = None, line_no: int = None):
        self._append_colored(msg, self._color_error)

    def append_error_entry(self, level: str, message: str, file_ref: str = None, line_no: int = None):
        cursor = self._text.textCursor()
        cursor.movePosition(QTextCursor.End)

        fmt = QTextCharFormat()
        fmt.setForeground(self._color_timestamp)
        cursor.insertText("[", fmt)

        level_color = self._color_error if level.upper() == "ERROR" else self._color_warning
        fmt.setForeground(level_color)
        cursor.insertText(level.upper(), fmt)

        fmt.setForeground(self._color_timestamp)
        cursor.insertText("] ", fmt)

        if file_ref and line_no:
            fmt = QTextCharFormat()
            fmt.setForeground(self._color_info)
            fmt.setAnchor(True)
            fmt.setAnchorHref(f"file://{file_ref}:{line_no}")
            fmt.setToolTip(f"Click to open {file_ref}:{line_no}")
            fmt.setUnderlineStyle(QTextCharFormat.SingleUnderline)
            cursor.insertText(f"{file_ref}:{line_no}: ", fmt)
        elif file_ref:
            fmt = QTextCharFormat()
            fmt.setForeground(self._color_info)
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
                self._append_colored(stripped, self._color_error)
            elif 'warning' in lower:
                self._append_colored(stripped, self._color_warning)
            else:
                self._append_colored(stripped, self._color_info)

        for line in stderr.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            self._append_colored(stripped, self._color_error)

        status = "SUCCESS" if success else "FAILED"
        color = self._color_success if success else self._color_error
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
