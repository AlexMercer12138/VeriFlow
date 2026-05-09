# -*- coding: utf-8 -*-
"""
依赖分析器接口
"""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import List, Dict, Tuple

from ..models.dependency import DependencyResult


class IDependencyAnalyzer(ABC):
    """依赖分析器接口"""

    @abstractmethod
    def build_index(self, search_dirs: List[Path]) -> Tuple[Dict[str, Path], Dict[Path, List[str]]]:
        """
        扫描所有 .v/.sv 文件，构建 module_name → file_path 映射 + file → module_names 映射

        Args:
            search_dirs: 搜索目录列表

        Returns:
            ({module_name: file_path}, {filepath: [module_names]})
        """
        pass

    @abstractmethod
    def extract_dependencies(self, filepath: Path) -> List[str]:
        """
        提取单个文件中的模块实例化列表

        Args:
            filepath: Verilog 源文件路径

        Returns:
            被例化的模块名列表
        """
        pass

    @abstractmethod
    def extract_includes(self, filepath: Path) -> List[str]:
        """
        提取单个文件中的 `include 文件列表

        Args:
            filepath: Verilog 源文件路径

        Returns:
            include 文件名列表
        """
        pass

    @abstractmethod
    def resolve(
        self,
        top_module: str,
        search_dirs: List[Path]
    ) -> DependencyResult:
        """
        从顶层模块开始，递归解析所有依赖

        Args:
            top_module: 顶层模块名
            search_dirs: 搜索目录列表

        Returns:
            DependencyResult 包含完整文件列表和缺失模块
        """
        pass
