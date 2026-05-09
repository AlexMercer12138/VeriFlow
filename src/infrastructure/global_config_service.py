# -*- coding: utf-8 -*-
"""
全局配置服务 — 管理全局编译库目录
配置保存于 ~/.veriflow_config.json，应用启动时自动加载
"""

import json
from pathlib import Path
from typing import List


GLOBAL_CONFIG_PATH = Path.home() / '.veriflow_config.json'


class GlobalConfigService:
    """全局编译库配置管理"""

    def __init__(self, config_path: Path = None):
        self._path = config_path or GLOBAL_CONFIG_PATH

    def load(self) -> dict:
        if not self._path.exists():
            return self._defaults()
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            return self._defaults()
        if 'lib_dirs' not in data:
            data['lib_dirs'] = []
        return data

    def save(self, data: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def get_lib_dirs(self) -> List[str]:
        return self.load().get('lib_dirs', [])

    def set_lib_dirs(self, dirs: List[str]) -> None:
        data = self.load()
        data['lib_dirs'] = dirs
        self.save(data)

    def add_lib_dir(self, directory: str) -> None:
        dirs = self.get_lib_dirs()
        if directory not in dirs:
            dirs.append(directory)
            self.set_lib_dirs(dirs)

    def remove_lib_dir(self, directory: str) -> None:
        dirs = self.get_lib_dirs()
        if directory in dirs:
            dirs.remove(directory)
            self.set_lib_dirs(dirs)

    @staticmethod
    def _defaults() -> dict:
        return {
            'version': '1.0',
            'lib_dirs': [],
            'language': 'zh',
            'theme': 'dark',
        }

    def get_language(self) -> str:
        return self.load().get('language', 'zh')

    def set_language(self, lang: str) -> None:
        data = self.load()
        data['language'] = lang
        self.save(data)

    def get_theme(self) -> str:
        return self.load().get('theme', 'dark')

    def set_theme(self, theme: str) -> None:
        data = self.load()
        data['theme'] = theme
        self.save(data)
