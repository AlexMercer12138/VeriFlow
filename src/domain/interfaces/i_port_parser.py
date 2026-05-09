# -*- coding: utf-8 -*-
"""
端口解析器和模板生成器接口
"""

from abc import ABC, abstractmethod
from typing import List, Optional

from ..models.port import Port, Parameter, ModuleInfo


class IPortParser(ABC):
    """端口解析器接口"""

    @abstractmethod
    def parse_file(self, filepath: str) -> ModuleInfo:
        """
        解析文件

        Args:
            filepath: Verilog/SystemVerilog 文件路径

        Returns:
            模块信息

        Raises:
            FileNotFoundError: 文件不存在
            ValueError: 解析失败
        """
        pass

    @abstractmethod
    def parse_content(self, content: str, filename: str = "module") -> ModuleInfo:
        """
        解析文本内容

        Args:
            content: Verilog/SystemVerilog 代码内容
            filename: 文件名（用于错误信息）

        Returns:
            模块信息

        Raises:
            ValueError: 解析失败
        """
        pass


class ITemplateGenerator(ABC):
    """模板生成器接口"""

    @abstractmethod
    def generate_instantiation(
        self,
        module_info: ModuleInfo,
        selected_ports: Optional[List[Port]] = None,
        selected_params: Optional[List[Parameter]] = None,
        instance_name: Optional[str] = None
    ) -> str:
        pass

    @abstractmethod
    def generate_wire_declarations(
        self,
        module_info: ModuleInfo,
        selected_ports: Optional[List[Port]] = None
    ) -> str:
        pass

    @abstractmethod
    def generate_full_template(
        self,
        module_info: ModuleInfo,
        selected_ports: Optional[List[Port]] = None,
        selected_params: Optional[List[Parameter]] = None,
        instance_name: Optional[str] = None
    ) -> str:
        pass
