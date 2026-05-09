# -*- coding: utf-8 -*-
"""
工程管理器接口
"""

from abc import ABC, abstractmethod
from pathlib import Path

from ..models.project import Project


class IProjectManager(ABC):
    """工程管理器接口"""

    @abstractmethod
    def create(self, name: str, root_dir: Path) -> Project:
        pass

    @abstractmethod
    def open(self, project_file: Path) -> Project:
        pass

    @abstractmethod
    def save(self, project: Project, filepath: Path) -> None:
        pass

    @abstractmethod
    def update_config(self, project: Project, **kwargs) -> Project:
        pass
