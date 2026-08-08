# -*- coding: utf-8 -*-
"""Deprecation notices for the retiring Python products."""

import sys


def warn_python_product(product: str) -> None:
    replacement = (
        "install the Node CLI with 'npm install --global @veriflow/cli'"
        if product == "CLI"
        else "use the Node CLI or VeriFlow VS Code extension"
    )
    print(
        f"Warning: VeriFlow Python {product} is deprecated and will be removed "
        f"after the deprecation release; {replacement}.",
        file=sys.stderr,
    )
