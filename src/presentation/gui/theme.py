# -*- coding: utf-8 -*-
"""
主题模块 — 暗色 / 亮色
"""

DARK_STYLESHEET = """
    QMainWindow { background-color: #2b2b2b; color: #d4d4d4; }
    QGroupBox { font-weight: bold; border: 1px solid #4a4a4a; border-radius: 4px;
        margin-top: 12px; padding-top: 12px; color: #e0e0e0; }
    QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #569cd6; }
    QLineEdit { background-color: #3c3c3c; color: #d4d4d4; border: 1px solid #555;
        border-radius: 3px; padding: 4px; }
    QComboBox { background-color: #3c3c3c; color: #d4d4d4; border: 1px solid #555;
        border-radius: 3px; padding: 4px; }
    QComboBox QAbstractItemView { background-color: #333; color: #d4d4d4;
        selection-background-color: #264f78; }
    QPushButton { background-color: #0e639c; color: #ffffff; border: none;
        border-radius: 3px; padding: 6px 14px; }
    QPushButton:hover { background-color: #1177bb; }
    QPushButton:pressed { background-color: #094771; }
    QPushButton:disabled { background-color: #3c3c3c; color: #888; }
    QListWidget { background-color: #252525; color: #d4d4d4; border: 1px solid #3c3c3c;
        alternate-background-color: #2a2a2a; }
    QListWidget::item:selected { background-color: #264f78; }
    QTabWidget::pane { border: 1px solid #3c3c3c; background-color: #252525; }
    QTabBar::tab { background-color: #2d2d2d; color: #d4d4d4; border: 1px solid #3c3c3c;
        padding: 6px 16px; margin-right: 2px; }
    QTabBar::tab:selected { background-color: #252525; border-bottom-color: #252525; }
    QTreeWidget { background-color: #252525; color: #d4d4d4; border: 1px solid #3c3c3c;
        alternate-background-color: #2a2a2a; }
    QTreeWidget::item:selected { background-color: #264f78; }
    QTreeView { background-color: #252525; color: #d4d4d4; border: 1px solid #3c3c3c;
        alternate-background-color: #2a2a2a; }
    QTreeView::item:selected { background-color: #264f78; }
    QMenuBar { background-color: #333; color: #d4d4d4; }
    QMenuBar::item:selected { background-color: #094771; }
    QMenu { background-color: #333; color: #d4d4d4; border: 1px solid #555; }
    QMenu::item:selected { background-color: #094771; }
    QStatusBar { background-color: #007acc; color: #ffffff; }
    QSplitter::handle { background-color: #3c3c3c; }
    QTextBrowser { background-color: #1e1e1e; color: #d4d4d4; border: 1px solid #3c3c3c; }
    QLabel { color: #d4d4d4; }
    QHeaderView::section { background-color: #2d2d2d; color: #d4d4d4; border: 1px solid #3c3c3c; padding: 4px; }
"""

LIGHT_STYLESHEET = """
    QMainWindow { background-color: #f5f5f5; color: #333333; }
    QGroupBox { font-weight: bold; border: 1px solid #cccccc; border-radius: 4px;
        margin-top: 12px; padding-top: 12px; color: #333333; }
    QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #0066b8; }
    QLineEdit { background-color: #ffffff; color: #333333; border: 1px solid #cccccc;
        border-radius: 3px; padding: 4px; }
    QComboBox { background-color: #ffffff; color: #333333; border: 1px solid #cccccc;
        border-radius: 3px; padding: 4px; }
    QComboBox QAbstractItemView { background-color: #ffffff; color: #333333;
        selection-background-color: #cce5ff; }
    QPushButton { background-color: #0078d4; color: #ffffff; border: none;
        border-radius: 3px; padding: 6px 14px; }
    QPushButton:hover { background-color: #1a8ae8; }
    QPushButton:pressed { background-color: #005a9e; }
    QPushButton:disabled { background-color: #e0e0e0; color: #999999; }
    QListWidget { background-color: #ffffff; color: #333333; border: 1px solid #dddddd;
        alternate-background-color: #f9f9f9; }
    QListWidget::item:selected { background-color: #cce5ff; color: #333333; }
    QTabWidget::pane { border: 1px solid #dddddd; background-color: #ffffff; }
    QTabBar::tab { background-color: #eeeeee; color: #333333; border: 1px solid #dddddd;
        padding: 6px 16px; margin-right: 2px; }
    QTabBar::tab:selected { background-color: #ffffff; border-bottom-color: #ffffff; }
    QTreeWidget { background-color: #ffffff; color: #333333; border: 1px solid #dddddd;
        alternate-background-color: #f9f9f9; }
    QTreeWidget::item:selected { background-color: #cce5ff; color: #333333; }
    QTreeView { background-color: #ffffff; color: #333333; border: 1px solid #dddddd;
        alternate-background-color: #f9f9f9; }
    QTreeView::item:selected { background-color: #cce5ff; color: #333333; }
    QMenuBar { background-color: #eeeeee; color: #333333; border-bottom: 1px solid #dddddd; }
    QMenuBar::item:selected { background-color: #cce5ff; }
    QMenu { background-color: #ffffff; color: #333333; border: 1px solid #cccccc; }
    QMenu::item:selected { background-color: #cce5ff; }
    QStatusBar { background-color: #0078d4; color: #ffffff; }
    QSplitter::handle { background-color: #cccccc; }
    QTextBrowser { background-color: #ffffff; color: #333333; border: 1px solid #dddddd; }
    QLabel { color: #333333; }
    QHeaderView::section { background-color: #eeeeee; color: #333333; border: 1px solid #dddddd; padding: 4px; }
"""

_current_theme = "dark"


def set_theme(theme: str):
    global _current_theme
    _current_theme = theme if theme in ("dark", "light") else "dark"


def get_theme() -> str:
    return _current_theme


def get_stylesheet() -> str:
    return DARK_STYLESHEET if _current_theme == "dark" else LIGHT_STYLESHEET
