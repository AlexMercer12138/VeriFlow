# -*- coding: utf-8 -*-
"""
端口相关领域模型
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class Port:
    """端口数据类"""
    name: str
    direction: str
    width: Optional[str] = None
    width_msb: Optional[int] = None
    width_lsb: Optional[int] = None

    def __post_init__(self):
        valid_directions = {'input', 'output', 'inout'}
        if self.direction not in valid_directions:
            raise ValueError(f"Invalid direction: {self.direction}. Must be one of {valid_directions}")

    def get_width_str(self) -> str:
        if self.width_msb is not None and self.width_lsb is not None:
            if self.width_msb == self.width_lsb == 0:
                return ""
            return f"[{self.width_msb}:{self.width_lsb}]"
        return self.width or ""

    def is_bus(self) -> bool:
        if self.width_msb is not None and self.width_lsb is not None:
            return self.width_msb != self.width_lsb
        return False


@dataclass
class Parameter:
    """参数数据类"""
    name: str
    value: str
    dtype: str = "integer"

    def __post_init__(self):
        self.value = self.value.strip()


@dataclass
class ModuleInfo:
    """模块信息类（扩展版，支持依赖分析）"""
    name: str
    parameters: List[Parameter] = field(default_factory=list)
    ports: List[Port] = field(default_factory=list)
    filename: str = ""
    filepath: Optional[Path] = None
    dependencies: List[str] = field(default_factory=list)
    includes: List[str] = field(default_factory=list)
    is_tb: bool = False

    def __post_init__(self):
        if self.filepath is None and self.filename:
            self.filepath = Path(self.filename)

    @property
    def source_path(self) -> Optional[Path]:
        return self.filepath

    def get_input_ports(self) -> List[Port]:
        return [p for p in self.ports if p.direction == 'input']

    def get_output_ports(self) -> List[Port]:
        return [p for p in self.ports if p.direction == 'output']

    def get_inout_ports(self) -> List[Port]:
        return [p for p in self.ports if p.direction == 'inout']

    def has_parameters(self) -> bool:
        return len(self.parameters) > 0

    def get_port_by_name(self, name: str) -> Optional[Port]:
        for port in self.ports:
            if port.name == name:
                return port
        return None
