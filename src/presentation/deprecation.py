# -*- coding: utf-8 -*-
"""Deprecation notices for the retiring Python products."""

import sys


def python_product_deprecation_message(product: str) -> str:
    replacement = (
        "install the Node CLI with 'npm install --global @veriflow/cli'"
        if product == "CLI"
        else "use the Node CLI or VeriFlow VS Code extension"
    )
    return (
        f"VeriFlow Python {product} is deprecated and will be removed "
        f"after the deprecation release; {replacement}."
    )


def warn_python_product(product: str) -> None:
    print(
        f"Warning: {python_product_deprecation_message(product)}",
        file=sys.stderr,
    )


def show_python_gui_deprecation(parent) -> None:
    from PySide6.QtWidgets import QMessageBox

    QMessageBox.warning(
        parent,
        "VeriFlow Python GUI deprecated",
        python_product_deprecation_message("GUI"),
    )
