# -*- coding: utf-8 -*-
"""
工程配置服务 — JSON 文件读写
"""

import json
from pathlib import Path
from typing import Optional


class ConfigService:
    """JSON 工程文件读写服务"""

    @staticmethod
    def load(filepath: Path) -> dict:
        if not filepath.exists():
            raise FileNotFoundError(f"Project file not found: {filepath}")
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)

    @staticmethod
    def save(filepath: Path, data: dict, indent: int = 2) -> None:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=indent, ensure_ascii=False)

    @staticmethod
    def load_optional(filepath: Path) -> Optional[dict]:
        try:
            return ConfigService.load(filepath)
        except (FileNotFoundError, json.JSONDecodeError):
            return None
