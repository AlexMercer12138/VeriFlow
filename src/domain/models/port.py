# -*- coding: utf-8 -*-
"""
端口相关领域模型
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional
import re


import math


def _eval_expr(expr: str, param_map: dict) -> int:
    """使用参数值计算表达式结果
    
    支持的运算符: +, -, *, /, **, <<, >>
    支持的函数: $clog2()
    """
    if not expr:
        return 1
    expr = expr.strip()
    # 直接是数字
    if expr.isdigit():
        return int(expr)
    # 替换参数引用
    for pname, pval in sorted(param_map.items(), key=lambda x: -len(x[0])):
        expr = re.sub(r'\b' + re.escape(pname) + r'\b', str(pval), expr)
    # 处理 $clog2() 函数
    expr = _replace_clog2(expr)
    # 尝试计算
    try:
        return int(eval(expr, {"__builtins__": {}}, {}))
    except Exception:
        return 1


def _replace_clog2(expr: str) -> str:
    """将 $clog2(x) 替换为 math.ceil(math.log2(x))"""
    pattern = re.compile(r'\$clog2\s*\(\s*([^)]+)\s*\)')

    def replacer(m):
        inner = m.group(1).strip()
        try:
            val = int(inner)
            if val <= 0:
                return '0'
            return str(math.ceil(math.log2(val)))
        except ValueError:
            return m.group(0)

    return pattern.sub(replacer, expr)


def resolve_port_width(port_width_str: str, param_values: dict) -> str:
    """
    将包含参数的位宽表达式解析为具体数值。
    例如: [DATA_WIDTH-1:0] + {DATA_WIDTH=32} -> [31:0]
    """
    if not port_width_str:
        return ""
    m = re.match(r'\[(.+?):(.+?)\]', port_width_str.strip())
    if not m:
        return port_width_str
    msb_expr = m.group(1).strip()
    lsb_expr = m.group(2).strip()
    msb_val = _eval_expr(msb_expr, param_values)
    lsb_val = _eval_expr(lsb_expr, param_values)
    if msb_val == lsb_val == 0:
        return ""
    return f"[{msb_val}:{lsb_val}]"


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

    def get_width_str(self, param_values: Optional[dict] = None) -> str:
        if param_values and self.width:
            resolved = resolve_port_width(self.width, param_values)
            if resolved:
                return resolved
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
