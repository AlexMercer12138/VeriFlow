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
from src.domain.services.verilog_utils import remove_comments, preprocess_verilog


class PortParserService(IPortParser):
    """端口解析服务实现"""

    def __init__(self, file_service: IFileService):
        self._file_service = file_service

        self._param_decl_pattern = re.compile(r'\b(parameter|localparam)\b\s*(.*)', re.DOTALL)
        self._ansi_port_pattern = re.compile(r'\b(input|output|inout)\b\s*(.*)', re.DOTALL)

    def parse_file(self, filepath: str) -> ModuleInfo:
        content = self._file_service.read_text(filepath)
        return self.parse_content(content, self._file_service.get_filename(filepath))

    def parse_content(self, content: str, filename: str = "module") -> ModuleInfo:
        content = preprocess_verilog(remove_comments(content))
        parsed = self._parse_module_header(content)
        if not parsed:
            raise ValueError("Could not parse module declaration")

        module_name, params_str, ports_str, body_start = parsed
        body = content[body_start:self._find_matching_endmodule(content, body_start)]
        parameters = self._parse_parameters(params_str)
        ports = self._parse_ports(ports_str, body)

        return ModuleInfo(
            name=module_name,
            parameters=parameters,
            ports=ports,
            filename=filename
        )

    def _parse_module_header(self, content: str):
        match = re.search(r'\bmodule\s+(\w+)\b', content)
        if not match:
            return None

        module_name = match.group(1)
        i = match.end()
        length = len(content)
        while i < length and content[i].isspace():
            i += 1

        params_str = ""
        if i < length and content[i] == '#':
            i += 1
            while i < length and content[i].isspace():
                i += 1
            if i >= length or content[i] != '(':
                return None
            end = self._find_matching_paren(content, i)
            if end == -1:
                return None
            params_str = content[i + 1:end]
            i = end + 1
            while i < length and content[i].isspace():
                i += 1

        ports_str = ""
        if i < length and content[i] == '(':
            end = self._find_matching_paren(content, i)
            if end == -1:
                return None
            ports_str = content[i + 1:end]
            i = end + 1

        semi = content.find(';', i)
        if semi == -1:
            return None
        return module_name, params_str, ports_str, semi + 1

    def _find_matching_paren(self, text: str, open_idx: int) -> int:
        depth = 0
        in_string = False
        i = open_idx
        while i < len(text):
            ch = text[i]
            if ch == '"' and (i == 0 or text[i - 1] != '\\'):
                in_string = not in_string
            elif not in_string:
                if ch == '(':
                    depth += 1
                elif ch == ')':
                    depth -= 1
                    if depth == 0:
                        return i
            i += 1
        return -1

    def _find_matching_endmodule(self, content: str, start: int) -> int:
        match = re.search(r'\bendmodule\b', content[start:])
        return start + match.start() if match else len(content)

    def _parse_parameters(self, params_str: str) -> List[Parameter]:
        parameters = []
        for item in self._split_ports(params_str):
            text = item.strip()
            if not text:
                continue
            match = self._param_decl_pattern.match(text)
            if match:
                text = match.group(2).strip()
            eq_idx = self._find_top_level_char(text, '=')
            if eq_idx == -1:
                continue
            left = text[:eq_idx].strip()
            value = text[eq_idx + 1:].strip()
            name_match = re.search(r'([A-Za-z_]\w*)\s*$', re.sub(r'\[[^\]]+\]', ' ', left))
            if not name_match:
                continue
            parameters.append(Parameter(name=name_match.group(1), value=value))
        return parameters

    def _parse_ports(self, ports_str: str, body: str = "") -> List[Port]:
        ports_str = re.sub(r'\(\*[^*]*\*\)', '', ports_str)

        ports = []
        port_strs = self._split_ports(ports_str)
        header_names = []
        declarations = {}
        last_direction = None
        last_width = None

        for port_str in port_strs:
            port_str = port_str.strip()
            if not port_str:
                continue

            match = self._ansi_port_pattern.match(port_str)
            if match:
                direction = match.group(1)
                parsed_ports = self._parse_port_decl_tail(direction, match.group(2))
                ports.extend(parsed_ports)
                if parsed_ports:
                    last_direction = direction
                    last_width = parsed_ports[-1].width
            elif last_direction and ports:
                name = self._clean_port_name(port_str)
                if name:
                    width_msb, width_lsb = self._parse_numeric_width(last_width)
                    ports.append(Port(
                        name=name,
                        direction=last_direction,
                        width=last_width,
                        width_msb=width_msb,
                        width_lsb=width_lsb,
                    ))
            else:
                name = self._clean_port_name(port_str)
                if name:
                    header_names.append(name)

        if ports:
            return self._dedupe_ports(ports)

        for declaration in self._body_port_declarations(body):
            match = self._ansi_port_pattern.match(declaration.strip())
            if not match:
                continue
            for port in self._parse_port_decl_tail(match.group(1), match.group(2)):
                declarations[port.name] = port

        for name in header_names:
            port = declarations.get(name)
            if port:
                ports.append(port)

        return ports

    def _parse_port_decl_tail(self, direction: str, tail: str) -> List[Port]:
        tail = re.sub(r'\s+', ' ', tail.strip().rstrip(',;'))
        tail = re.sub(r'\b(wire|reg|logic|signed|unsigned|var|tri|bit)\b', ' ', tail)
        width_match = re.search(r'\[[^\]]+\]', tail)
        width_str = width_match.group(0).strip() if width_match else None
        if width_match:
            tail = tail[:width_match.start()] + ' ' + tail[width_match.end():]

        ports = []
        for name_part in self._split_ports(tail):
            name = self._clean_port_name(name_part)
            if not name:
                continue
            width_msb, width_lsb = self._parse_numeric_width(width_str)
            ports.append(Port(
                name=name,
                direction=direction,
                width=width_str,
                width_msb=width_msb,
                width_lsb=width_lsb,
            ))
        return ports

    def _body_port_declarations(self, body: str) -> List[str]:
        declarations = []
        for stmt in self._split_statements(body):
            if re.match(r'\s*(input|output|inout)\b', stmt):
                declarations.append(stmt)
        return declarations

    def _split_statements(self, text: str) -> List[str]:
        result = []
        current = []
        paren_depth = bracket_depth = brace_depth = 0
        in_string = False
        for i, char in enumerate(text):
            if char == '"' and (i == 0 or text[i - 1] != '\\'):
                in_string = not in_string
            elif not in_string:
                if char == '(':
                    paren_depth += 1
                elif char == ')':
                    paren_depth -= 1
                elif char == '[':
                    bracket_depth += 1
                elif char == ']':
                    bracket_depth -= 1
                elif char == '{':
                    brace_depth += 1
                elif char == '}':
                    brace_depth -= 1
                elif char == ';' and paren_depth == 0 and bracket_depth == 0 and brace_depth == 0:
                    result.append(''.join(current).strip())
                    current = []
                    continue
            current.append(char)
        if current:
            result.append(''.join(current).strip())
        return result

    def _clean_port_name(self, text: str) -> str:
        text = text.strip().rstrip(',;')
        text = re.sub(r'=.*$', '', text).strip()
        text = re.sub(r'\[[^\]]+\]\s*$', '', text).strip()
        match = re.search(r'\\\S+|[A-Za-z_]\w*$', text)
        if not match:
            return ""
        name = match.group(0)
        return name[1:] if name.startswith('\\') else name

    def _parse_numeric_width(self, width_str: Optional[str]):
        if not width_str:
            return None, None
        width_match = re.match(r'\[(\d+)\s*:\s*(\d+)\]', width_str)
        if not width_match:
            return None, None
        return int(width_match.group(1)), int(width_match.group(2))

    def _dedupe_ports(self, ports: List[Port]) -> List[Port]:
        result = []
        seen = set()
        for port in ports:
            if port.name in seen:
                continue
            seen.add(port.name)
            result.append(port)
        return result

    def _find_top_level_char(self, text: str, target: str) -> int:
        paren_depth = bracket_depth = brace_depth = 0
        in_string = False
        for i, char in enumerate(text):
            if char == '"' and (i == 0 or text[i - 1] != '\\'):
                in_string = not in_string
            elif not in_string:
                if char == '(':
                    paren_depth += 1
                elif char == ')':
                    paren_depth -= 1
                elif char == '[':
                    bracket_depth += 1
                elif char == ']':
                    bracket_depth -= 1
                elif char == '{':
                    brace_depth += 1
                elif char == '}':
                    brace_depth -= 1
                elif (
                    char == target
                    and paren_depth == 0
                    and bracket_depth == 0
                    and brace_depth == 0
                ):
                    return i
        return -1

    def _split_ports(self, ports_str: str) -> List[str]:
        ports = []
        current = []
        depth = 0
        paren_depth = 0
        bracket_depth = 0
        in_string = False

        for i, char in enumerate(ports_str):
            if char == '"' and (i == 0 or ports_str[i - 1] != '\\'):
                in_string = not in_string
            elif in_string:
                pass
            elif char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
            elif char == '(':
                paren_depth += 1
            elif char == ')':
                paren_depth -= 1
            elif char == '[':
                bracket_depth += 1
            elif char == ']':
                bracket_depth -= 1
            elif char == ',' and depth == 0 and paren_depth == 0 and bracket_depth == 0:
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
