#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VeriFlow CLI 入口（供用户调试使用）
"""

import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.presentation.cli import main

if __name__ == "__main__":
    sys.exit(main())
