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

    def to_dict(self) -> dict:
        """序列化为字典（用于保存到工程文件）"""
        return {
            'top_module': self.top_module,
            'files': [str(f) for f in self.files],
            'missing_modules': list(self.missing_modules),
            'module_map': {k: str(v) for k, v in self.module_map.items()},
            'dep_graph': dict(self.dep_graph),
            'topo_file_order': [str(f) for f in self._topo_file_order],
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'DependencyResult':
        """从字典反序列化"""
        return cls(
            top_module=data.get('top_module', ''),
            files=[Path(f) for f in data.get('files', [])],
            missing_modules=list(data.get('missing_modules', [])),
            module_map={k: Path(v) for k, v in data.get('module_map', {}).items()},
            dep_graph={k: list(v) for k, v in data.get('dep_graph', {}).items()},
            _topo_file_order=[Path(f) for f in data.get('topo_file_order', [])],
        )
