# -*- coding: utf-8 -*-
"""
端口解析和模板生成服务
"""

import re
from typing import List, Optional
from pathlib import Path

from src.infrastructure.file_service import IFileService
from src.domain.interfaces.i_port_parser import IPortParser, ITemplateGenerator
from src.domain.models.port import Port, Parameter, ModuleInfo
from src.domain.services.verilog_utils import remove_comments


class PortParserService(IPortParser):
    """端口解析服务实现"""

    def __init__(self, file_service: IFileService):
        self._file_service = file_service

        self._module_pattern = re.compile(
            r'module\s+(\w+)\s*#\s*\((.*?)\)\s*\((.*?)\);',
            re.DOTALL
        )
        self._module_no_param_pattern = re.compile(
            r'module\s+(\w+)\s*\((.*?)\);',
            re.DOTALL
        )
        self._param_pattern = re.compile(
            r'parameter\s+(?:\[[^\]]+\]\s*)?(?:\w+\s+)?(\w+)\s*=\s*([^,;]+)'
        )
        self._port_pattern = re.compile(
            r'(input|output|inout)\s*(?:wire|reg|logic)?\s*(\[[^\]]+\])?\s*(\w+)'
        )

    def parse_file(self, filepath: str) -> ModuleInfo:
        content = self._file_service.read_text(filepath)
        return self.parse_content(content, self._file_service.get_filename(filepath))

    def parse_content(self, content: str, filename: str = "module") -> ModuleInfo:
        content = remove_comments(content)

        match = self._module_pattern.search(content)
        if match:
            module_name = match.group(1)
            params_str = match.group(2)
            ports_str = match.group(3)
            parameters = self._parse_parameters(params_str)
            ports = self._parse_ports(ports_str)
        else:
            match = self._module_no_param_pattern.search(content)
            if match:
                module_name = match.group(1)
                ports_str = match.group(2)
                parameters = []
                ports = self._parse_ports(ports_str)
            else:
                raise ValueError("Could not parse module declaration")

        return ModuleInfo(
            name=module_name,
            parameters=parameters,
            ports=ports,
            filename=filename
        )

    def _parse_parameters(self, params_str: str) -> List[Parameter]:
        parameters = []
        for match in self._param_pattern.finditer(params_str):
            param_name = match.group(1).strip()
            param_value = match.group(2).strip()
            parameters.append(Parameter(name=param_name, value=param_value))
        return parameters

    def _parse_ports(self, ports_str: str) -> List[Port]:
        ports_str = re.sub(r'\(\*[^*]*\*\)', '', ports_str)

        ports = []
        port_strs = self._split_ports(ports_str)

        for port_str in port_strs:
            port_str = port_str.strip()
            if not port_str:
                continue

            match = self._port_pattern.match(port_str)
            if match:
                direction = match.group(1)
                width_str = match.group(2)
                name = match.group(3)

                width_msb, width_lsb = None, None
                if width_str:
                    width_match = re.match(r'\[(\d+):(\d+)\]', width_str)
                    if width_match:
                        width_msb = int(width_match.group(1))
                        width_lsb = int(width_match.group(2))

                ports.append(Port(
                    name=name,
                    direction=direction,
                    width=width_str,
                    width_msb=width_msb,
                    width_lsb=width_lsb
                ))

        return ports

    def _split_ports(self, ports_str: str) -> List[str]:
        ports = []
        current = []
        depth = 0
        paren_depth = 0

        for char in ports_str:
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
            elif char == '(':
                paren_depth += 1
            elif char == ')':
                paren_depth -= 1
            elif char == ',' and depth == 0 and paren_depth == 0:
                ports.append(''.join(current).strip())
                current = []
                continue

            current.append(char)

        if current:
            ports.append(''.join(current).strip())

        return ports


class TemplateGeneratorService(ITemplateGenerator):
    """模板生成服务实现"""

    def __init__(self, indent: str = "    "):
        self._indent = indent

    def _format_param_value(self, value: str) -> str:
        return value.strip()

    def _get_port_comment(self, port: Port) -> str:
        direction_map = {
            "input": "input",
            "output": "output",
            "inout": "inout"
        }
        direction = direction_map.get(port.direction, port.direction)

        width_str = port.get_width_str()
        if width_str:
            return f"{direction} {width_str}"
        return direction

    def _calculate_column_widths(
        self,
        module_info: ModuleInfo,
        selected_ports: Optional[List[Port]] = None,
        selected_params: Optional[List[Parameter]] = None
    ) -> tuple:
        instance_name = f"{module_info.name}_inst"
        ports = selected_ports if selected_ports else module_info.ports
        params = selected_params if selected_params else module_info.parameters

        max_param_name_len = 0
        max_param_value_len = 0
        for param in params:
            max_param_name_len = max(max_param_name_len, len(param.name))
            formatted_value = self._format_param_value(param.value)
            max_param_value_len = max(max_param_value_len, len(formatted_value))

        max_port_name_len = 0
        max_signal_len = 0
        for port in ports:
            max_port_name_len = max(max_port_name_len, len(port.name))
            max_signal_len = max(max_signal_len, len(port.name))

        max_name_len = max(max_param_name_len, max_port_name_len, len(instance_name))
        max_value_len = max(max_param_value_len, max_signal_len)

        col0_width = max_name_len + 8
        col1_width = max_value_len + 4

        return col0_width, col1_width

    def generate_instantiation(
        self,
        module_info: ModuleInfo,
        selected_ports: Optional[List[Port]] = None,
        selected_params: Optional[List[Parameter]] = None,
        instance_name: Optional[str] = None
    ) -> str:
        inst_name = instance_name or f"{module_info.name}_inst"
        ports = selected_ports if selected_ports else module_info.ports
        params = selected_params if selected_params else module_info.parameters

        col0_width, col1_width = self._calculate_column_widths(
            module_info, selected_ports, selected_params
        )

        lines = []
        indent = "    "

        if params:
            module_line = f"{module_info.name:<{col0_width + 5}}#("
            lines.append(module_line)
            for i, param in enumerate(params):
                comma = ")," if i < len(params) - 1 else "))"
                formatted_value = self._format_param_value(param.value)
                value_with_paren = f"({formatted_value}"
                param_line = f"{indent}.{param.name:<{col0_width}}{value_with_paren:<{col1_width}}{comma}"
                lines.append(param_line)
            lines.append(f"{inst_name:<{col0_width + 5}}(")

        else:
            lines.append(f"{module_info.name:<{col0_width + 5}}{inst_name}(")

        for i, port in enumerate(ports):
            is_last = i == len(ports) - 1
            comma = ")," if not is_last else "));"
            comment = self._get_port_comment(port)
            comment_full = f" // {comment} {port.name}"
            signal_paren = f"({port.name}"
            port_line = f"{indent}.{port.name:<{col0_width}}{signal_paren:<{col1_width}}{comma}{comment_full}"
            lines.append(port_line)

        return "\n".join(lines)

    def generate_wire_declarations(
        self,
        module_info: ModuleInfo,
        selected_ports: Optional[List[Port]] = None
    ) -> str:
        ports = selected_ports if selected_ports else module_info.ports

        col0_width, col1_width = self._calculate_column_widths(module_info, selected_ports)

        lines = []
        indent = self._indent

        inputs = [p for p in ports if p.direction == "input"]
        outputs = [p for p in ports if p.direction == "output"]
        inouts = [p for p in ports if p.direction == "inout"]

        if inputs:
            lines.append(f"{indent}// Inputs")
            for port in inputs:
                width_str = port.get_width_str()
                wire_col = f"wire {width_str}" if width_str else "wire"
                signal_col = f"{port.name};"
                wire_line = f"{indent}{wire_col:<{col0_width}} {signal_col}"
                lines.append(wire_line)

        if outputs:
            if inputs:
                lines.append("")
            lines.append(f"{indent}// Outputs")
            for port in outputs:
                width_str = port.get_width_str()
                wire_col = f"wire {width_str}" if width_str else "wire"
                signal_col = f"{port.name};"
                wire_line = f"{indent}{wire_col:<{col0_width}} {signal_col}"
                lines.append(wire_line)

        if inouts:
            if inputs or outputs:
                lines.append("")
            lines.append(f"{indent}// Bidirectional")
            for port in inouts:
                width_str = port.get_width_str()
                wire_col = f"wire {width_str}" if width_str else "wire"
                signal_col = f"{port.name};"
                wire_line = f"{indent}{wire_col:<{col0_width}} {signal_col}"
                lines.append(wire_line)

        return "\n".join(lines)

    def generate_full_template(
        self,
        module_info: ModuleInfo,
        selected_ports: Optional[List[Port]] = None,
        selected_params: Optional[List[Parameter]] = None,
        instance_name: Optional[str] = None
    ) -> str:
        lines = []

        lines.append(f"// Generated by VHelper")
        lines.append(f"// Module: {module_info.name}")
        lines.append("")

        wire_decls = self.generate_wire_declarations(module_info, selected_ports)
        if wire_decls.strip():
            lines.append(wire_decls)
            lines.append("")

        instantiation = self.generate_instantiation(
            module_info, selected_ports, selected_params, instance_name
        )
        lines.append(instantiation)

        return "\n".join(lines)
