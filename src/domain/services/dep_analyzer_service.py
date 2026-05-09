# -*- coding: utf-8 -*-
"""
依赖分析引擎 - BFS 递归解析 Verilog 模块依赖
支持：多模块单文件、generate/ifdef 内例化、拓扑排序编译顺序
"""

import re
from collections import deque, defaultdict
from pathlib import Path
from typing import List, Dict, Set, Tuple

from src.infrastructure.file_service import IFileService
from src.domain.models.dependency import DependencyResult
from src.domain.interfaces.i_dep_analyzer import IDependencyAnalyzer
from src.domain.services.port_parser_service import PortParserService
from src.domain.services.verilog_utils import remove_comments


VERILOG_KEYWORDS = {
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
    'assign', 'always', 'initial', 'begin', 'end', 'if', 'else', 'for', 'while',
    'case', 'endcase', 'posedge', 'negedge', 'or', 'and', 'generate', 'endgenerate',
    'function', 'endfunction', 'task', 'endtask', 'parameter', 'localparam',
    'integer', 'real', 'time', 'signed', 'unsigned', 'supply0', 'supply1',
    'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'wand', 'wor',
    'specify', 'endspecify', 'defparam', 'event', 'genvar', 'forever',
    'repeat', 'wait', 'disable', 'force', 'release', 'fork', 'join',
    'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1', 'nmos', 'pmos',
    'cmos', 'rnmos', 'rpmos', 'rcmos', 'pullup', 'pulldown', 'tran',
    'tranif0', 'tranif1', 'rtran', 'rtranif0', 'rtranif1',
    'typedef', 'enum', 'struct', 'union', 'class', 'endclass',
    'package', 'endpackage', 'import', 'export', 'virtual', 'interface',
    'endinterface', 'modport', 'covergroup', 'endgroup', 'property',
    'endproperty', 'sequence', 'endsequence', 'assert', 'assume', 'cover',
    'expect', 'rand', 'randc', 'constraint', 'new', 'this', 'super',
    'null', 'void', 'do', 'foreach', 'return', 'continue', 'break',
    'automatic', 'static', 'extern', 'pure', 'ref', 'cross', 'inside',
    'dist', 'solve', 'before', 'extends', 'implements', 'with', 'unique',
    'priority', 'tagged', 'matches', 'let', 'checker', 'endchecker',
    'config', 'endconfig', 'design', 'instance', 'cell', 'liblist',
    'use', 'library', 'include',
}


class DependencyAnalyzerService(IDependencyAnalyzer):
    """依赖分析服务实现 - BFS 依赖解析"""

    _inst_pattern = re.compile(
        r'\b(\w+)\s+(\w+)\s*\(',
    )

    _include_pattern = re.compile(
        r'`include\s+["<]([^">]+)[">]'
    )

    _module_decl_pattern = re.compile(
        r'\bmodule\s+(\w+)'
    )

    def __init__(self, file_service: IFileService):
        self._file_service = file_service
        self._port_parser = PortParserService(file_service)

    def build_index(self, search_dirs: List[Path]) -> Tuple[Dict[str, Path], Dict[Path, List[str]]]:
        index: Dict[str, Path] = {}
        file_modules: Dict[Path, List[str]] = defaultdict(list)
        for search_dir in search_dirs:
            if not search_dir.exists():
                continue
            for vfile in self._file_service.list_files(str(search_dir)):
                try:
                    content = self._file_service.read_text(str(vfile))
                    content = remove_comments(content)
                    for match in self._module_decl_pattern.finditer(content):
                        module_name = match.group(1)
                        file_modules[vfile].append(module_name)
                        if module_name not in index:
                            index[module_name] = vfile
                except Exception:
                    continue
        return index, dict(file_modules)

    def extract_dependencies(self, filepath: Path, skip_comments: bool = True) -> List[str]:
        try:
            content = self._file_service.read_text(str(filepath))
        except Exception:
            return []

        if skip_comments:
            content = remove_comments(content)

        content = self._flatten_param_blocks(content)
        content = self._expand_generate_ifdef(content)

        deps: Set[str] = set()
        mo_decl_names = set()
        for m in self._module_decl_pattern.finditer(content):
            mo_decl_names.add(m.group(1))

        for match in self._inst_pattern.finditer(content):
            inst_module = match.group(1)
            inst_name = match.group(2)
            if inst_module.lower() in VERILOG_KEYWORDS:
                continue
            if inst_name.lower() in VERILOG_KEYWORDS:
                continue
            if inst_module == inst_name:
                continue
            if inst_module in mo_decl_names:
                continue
            deps.add(inst_module)

        return sorted(deps)

    def extract_includes(self, filepath: Path) -> List[str]:
        try:
            content = self._file_service.read_text(str(filepath))
        except Exception:
            return []
        includes = []
        for match in self._include_pattern.finditer(content):
            includes.append(match.group(1))
        return includes

    def resolve(self, top_module: str, search_dirs: List[Path]) -> DependencyResult:
        index, file_modules = self.build_index(search_dirs)

        result = DependencyResult(
            top_module=top_module,
            module_map=index,
        )

        visited: Set[str] = set()
        queue = deque([top_module])

        while queue:
            module_name = queue.popleft()
            if module_name in visited:
                continue
            visited.add(module_name)

            filepath = index.get(module_name)
            if filepath is None:
                result.missing_modules.append(module_name)
                continue

            if filepath not in result.files:
                result.files.append(filepath)

            includes = self.extract_includes(filepath)
            for inc_name in includes:
                inc_path = self._file_service.find_file(
                    inc_name,
                    [str(d) for d in search_dirs]
                )
                if inc_path and inc_path not in result.files:
                    result.files.insert(
                        max(0, len(result.files) - 1),
                        inc_path
                    )

            deps = self.extract_dependencies(filepath)
            result.dep_graph[module_name] = deps
            for dep in deps:
                if dep not in visited:
                    queue.append(dep)

        result._topo_file_order = self._topological_sort(result)
        return result

    def _topological_sort(self, result: DependencyResult) -> List[Path]:
        leaf_files: List[Path] = []
        dep_files: Set[Path] = set()
        top_file = result.module_map.get(result.top_module)

        for module_name, children in result.dep_graph.items():
            for child in children:
                child_file = result.module_map.get(child)
                if child_file:
                    dep_files.add(child_file)

        for filepath in result.files:
            if filepath not in dep_files and filepath != top_file:
                leaf_files.append(filepath)

        middle = [f for f in result.files if f in dep_files and f != top_file]
        ordered = leaf_files + middle
        if top_file and top_file not in ordered:
            ordered.append(top_file)
        return ordered

    def _expand_generate_ifdef(self, content: str) -> str:
        content = self._strip_blocks(content, 'generate', 'endgenerate')
        content = self._strip_blocks(content, '`ifdef', '`endif')
        content = self._strip_blocks(content, '`ifndef', '`endif')
        return self._strip_blocks(content, 'generate if', 'end')

    def _strip_blocks(self, content: str, start_kw: str, end_kw: str) -> str:
        result = []
        i = 0
        length = len(content)
        while i < length:
            pos_start = content.find(start_kw, i)
            if pos_start == -1:
                result.append(content[i:])
                break
            result.append(content[i:pos_start])
            local_start = pos_start + len(start_kw)
            depth = 1
            j = local_start
            while j < length and depth > 0:
                if content.startswith(start_kw, j):
                    depth += 1
                    j += len(start_kw)
                elif content.startswith(end_kw, j):
                    depth -= 1
                    if depth == 0:
                        j += len(end_kw)
                        break
                    j += len(end_kw)
                elif content.startswith('end', j) and end_kw == 'end':
                    depth -= 1
                    if depth == 0:
                        j += 3
                        break
                    j += 3
                elif content.startswith('generate', j) and end_kw == 'end':
                    depth += 1
                    j += 8
                elif content.startswith('`ifdef', j) and end_kw == 'end':
                    depth += 1
                    j += 6
                elif content.startswith('`ifndef', j) and end_kw == 'end':
                    depth += 1
                    j += 7
                elif content.startswith('`else', j) and end_kw == 'end':
                    j += 5
                elif content.startswith('`elsif', j) and end_kw == 'end':
                    j += 6
                elif content.startswith('`endif', j) and end_kw == 'end':
                    depth -= 1
                    if depth == 0:
                        j += 6
                        break
                    j += 6
                else:
                    j += 1
            result.append(content[local_start:j - len(end_kw)])
            i = j
        return ''.join(result)

    def _flatten_param_blocks(self, content: str) -> str:
        result = []
        i = 0
        length = len(content)
        while i < length:
            if i + 1 < length and content[i] == '#' and content[i + 1] == '(':
                depth = 1
                j = i + 2
                while j < length and depth > 0:
                    if content[j] == '(':
                        depth += 1
                    elif content[j] == ')':
                        depth -= 1
                    j += 1
                i = j
            else:
                result.append(content[i])
                i += 1
        return ''.join(result)
