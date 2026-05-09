# -*- coding: utf-8 -*-
"""
依赖分析相关数据模型
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Dict, Optional


@dataclass
class DependencyResult:
    """依赖解析结果"""
    top_module: str
    files: List[Path] = field(default_factory=list)
    missing_modules: List[str] = field(default_factory=list)
    module_map: Dict[str, Path] = field(default_factory=dict)
    dep_graph: Dict[str, List[str]] = field(default_factory=dict)
    _topo_file_order: List[Path] = field(default_factory=list)

    @property
    def success(self) -> bool:
        return len(self.missing_modules) == 0

    def get_compile_order(self) -> List[Path]:
        """拓扑排序：叶子模块（无依赖）在前，顶层模块在最后"""
        if self._topo_file_order:
            return list(self._topo_file_order)
        return list(self.files)
