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
from src.domain.services.verilog_utils import preprocess_verilog, remove_comments


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

    # 模块例化正则：模块名 [参数覆盖] 实例名 (端口连接列表)
    # 在 extract_dependencies 中会先去除注释和过程块，所以这里只需基本匹配
    _inst_pattern = re.compile(
        r'\b(?!module\b)(?!endmodule\b)(\w+)\s+(?:#\s*\([^)]*\)\s*)?(\w+)\s*\(',
    )

    _inst_pattern_no_space = re.compile(
        r'\b(?!module\b)(?!endmodule\b)(\w+)\s*\)\s*(\w+)\s*\(',
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
                    content = preprocess_verilog(remove_comments(content))
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
            content = preprocess_verilog(remove_comments(content))

        # 去除过程块（initial/always/task/function 等），这些块内部不可能有模块例化
        content = self._remove_procedural_blocks(content)
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

        for match in self._inst_pattern_no_space.finditer(content):
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
        in_degree: Dict[Path, int] = defaultdict(int)
        adj: Dict[Path, Set[Path]] = defaultdict(set)

        for module_name, children in result.dep_graph.items():
            parent_file = result.module_map.get(module_name)
            if not parent_file:
                continue
            for child in children:
                child_file = result.module_map.get(child)
                if not child_file:
                    continue
                if parent_file != child_file and child_file not in adj[parent_file]:
                    adj[child_file].add(parent_file)
                    in_degree[parent_file] += 1

        queue = deque()
        for filepath in result.files:
            if in_degree.get(filepath, 0) == 0:
                queue.append(filepath)

        ordered: List[Path] = []
        while queue:
            current = queue.popleft()
            ordered.append(current)
            for neighbor in adj.get(current, set()):
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        for filepath in result.files:
            if filepath not in ordered:
                ordered.append(filepath)

        return ordered

    def _expand_generate_ifdef(self, content: str) -> str:
        content = self._strip_standalone_keywords(
            content,
            ('generate', 'endgenerate'),
        )
        return self._strip_conditional_directive_lines(content)

    def _strip_standalone_keywords(self, content: str, keywords: Tuple[str, ...]) -> str:
        result = []
        i = 0
        length = len(content)
        while i < length:
            if content[i] == '"':
                j = i + 1
                while j < length:
                    if content[j] == '"' and not self._is_escaped(content, j):
                        j += 1
                        break
                    j += 1
                result.append(content[i:j])
                i = j
                continue

            if content[i] == '\\':
                j = i + 1
                while j < length and not content[j].isspace():
                    j += 1
                result.append(content[i:j])
                i = j
                continue

            matched = next(
                (
                    keyword
                    for keyword in keywords
                    if self._matches_standalone_keyword(content, i, keyword)
                ),
                None,
            )
            if matched:
                if result and not result[-1][-1].isspace():
                    result.append(' ')
                i += len(matched)
                if i < length and not content[i].isspace():
                    result.append(' ')
                continue

            result.append(content[i])
            i += 1
        return ''.join(result)

    def _strip_conditional_directive_lines(self, content: str) -> str:
        result = []
        directive_pattern = re.compile(r'^\s*`(?:ifdef|ifndef|elsif|else|endif)\b')
        for line in content.splitlines(keepends=True):
            if directive_pattern.match(line):
                if line.endswith('\r\n'):
                    result.append('\r\n')
                elif line.endswith('\n'):
                    result.append('\n')
                continue
            result.append(line)
        return ''.join(result)

    @staticmethod
    def _matches_standalone_keyword(content: str, index: int, keyword: str) -> bool:
        if not content.startswith(keyword, index):
            return False
        before = content[index - 1] if index > 0 else ''
        after_index = index + len(keyword)
        after = content[after_index] if after_index < len(content) else ''
        return (
            not DependencyAnalyzerService._is_identifier_char(before)
            and not DependencyAnalyzerService._is_identifier_char(after)
        )

    @staticmethod
    def _is_identifier_char(ch: str) -> bool:
        return bool(ch) and (ch.isalnum() or ch in '_$')

    @staticmethod
    def _is_escaped(content: str, index: int) -> bool:
        backslash_count = 0
        i = index - 1
        while i >= 0 and content[i] == '\\':
            backslash_count += 1
            i -= 1
        return backslash_count % 2 == 1

    def _remove_procedural_blocks(self, content: str) -> str:
        """Remove procedural regions before scanning module-level instances."""
        result = []
        i = 0
        proc_keywords = (
            'always_comb', 'always_ff', 'always_latch',
            'initial', 'always', 'task', 'function', 'specify', 'fork', 'final',
        )

        while i < len(content):
            if content[i] == '"':
                j = self._skip_string(content, i)
                result.append(content[i:j])
                i = j
                continue
            if content[i] == '\\':
                j = self._skip_escaped_identifier(content, i)
                result.append(content[i:j])
                i = j
                continue

            keyword = self._match_standalone_keyword(content, i, proc_keywords)
            if keyword:
                i = self._skip_procedural_region(content, i, keyword)
                result.append(' ')
                continue

            result.append(content[i])
            i += 1

        return ''.join(result)

    def _skip_procedural_region(self, content: str, index: int, keyword: str) -> int:
        start = index + len(keyword)
        if keyword == 'task':
            return self._skip_until_keyword(content, start, ('endtask',))
        if keyword == 'function':
            return self._skip_until_keyword(content, start, ('endfunction',))
        if keyword == 'specify':
            return self._skip_until_keyword(content, start, ('endspecify',))
        if keyword == 'fork':
            return self._skip_fork_block(content, index)
        body_start = self._skip_procedural_prefix(content, start)
        return self._skip_statement(content, body_start)

    def _skip_procedural_prefix(self, content: str, index: int) -> int:
        i = index
        while i < len(content):
            i = self._skip_whitespace(content, i)
            if i >= len(content):
                return i
            if content[i] == '@':
                i += 1
                i = self._skip_whitespace(content, i)
                if i < len(content) and content[i] == '(':
                    i = self._skip_balanced(content, i, '(', ')')
                elif i < len(content) and content[i] == '*':
                    i += 1
                else:
                    while i < len(content) and not content[i].isspace():
                        i += 1
                continue
            if content[i] == '#':
                i += 1
                i = self._skip_whitespace(content, i)
                if i < len(content) and content[i] == '(':
                    i = self._skip_balanced(content, i, '(', ')')
                else:
                    while i < len(content) and not content[i].isspace() and content[i] != ';':
                        i += 1
                continue
            return i
        return i

    def _skip_statement(self, content: str, index: int) -> int:
        i = self._skip_whitespace(content, index)
        if i >= len(content):
            return i

        keyword = self._match_standalone_keyword(
            content,
            i,
            ('begin', 'fork', 'casez', 'casex', 'case', 'if', 'for', 'while', 'repeat', 'forever'),
        )
        if keyword == 'begin':
            return self._skip_begin_block(content, i)
        if keyword == 'fork':
            return self._skip_fork_block(content, i)
        if keyword in ('case', 'casex', 'casez'):
            return self._skip_case_block(content, i)
        if keyword == 'if':
            return self._skip_if_statement(content, i)
        if keyword in ('for', 'while', 'repeat'):
            j = i + len(keyword)
            j = self._skip_whitespace(content, j)
            if j < len(content) and content[j] == '(':
                j = self._skip_balanced(content, j, '(', ')')
            return self._skip_statement(content, j)
        if keyword == 'forever':
            return self._skip_statement(content, i + len(keyword))

        return self._skip_until_semicolon(content, i)

    def _skip_if_statement(self, content: str, index: int) -> int:
        i = index + 2
        i = self._skip_whitespace(content, i)
        if i < len(content) and content[i] == '(':
            i = self._skip_balanced(content, i, '(', ')')
        i = self._skip_statement(content, i)
        j = self._skip_whitespace(content, i)
        if self._matches_standalone_keyword(content, j, 'else'):
            return self._skip_statement(content, j + 4)
        return i

    def _skip_begin_block(self, content: str, index: int) -> int:
        depth = 1
        i = index + 5
        while i < len(content):
            if content[i] == '"':
                i = self._skip_string(content, i)
                continue
            if content[i] == '\\':
                i = self._skip_escaped_identifier(content, i)
                continue
            keyword = self._match_standalone_keyword(
                content,
                i,
                ('begin', 'end', 'casez', 'casex', 'case', 'fork'),
            )
            if keyword == 'begin':
                depth += 1
                i += 5
                continue
            if keyword == 'end':
                depth -= 1
                i += 3
                if depth == 0:
                    return i
                continue
            if keyword in ('case', 'casex', 'casez'):
                i = self._skip_case_block(content, i)
                continue
            if keyword == 'fork':
                i = self._skip_fork_block(content, i)
                continue
            i += 1
        return len(content)

    def _skip_case_block(self, content: str, index: int) -> int:
        keyword = self._match_standalone_keyword(content, index, ('casez', 'casex', 'case')) or 'case'
        depth = 1
        i = index + len(keyword)
        while i < len(content):
            if content[i] == '"':
                i = self._skip_string(content, i)
                continue
            if content[i] == '\\':
                i = self._skip_escaped_identifier(content, i)
                continue
            keyword = self._match_standalone_keyword(
                content,
                i,
                ('casez', 'casex', 'case', 'endcase'),
            )
            if keyword in ('case', 'casex', 'casez'):
                depth += 1
                i += len(keyword)
                continue
            if keyword == 'endcase':
                depth -= 1
                i += 7
                if depth == 0:
                    return i
                continue
            i += 1
        return len(content)

    def _skip_fork_block(self, content: str, index: int) -> int:
        depth = 1
        i = index + 4
        while i < len(content):
            if content[i] == '"':
                i = self._skip_string(content, i)
                continue
            if content[i] == '\\':
                i = self._skip_escaped_identifier(content, i)
                continue
            keyword = self._match_standalone_keyword(
                content,
                i,
                ('join_none', 'join_any', 'join', 'fork'),
            )
            if keyword == 'fork':
                depth += 1
                i += 4
                continue
            if keyword in ('join', 'join_any', 'join_none'):
                depth -= 1
                i += len(keyword)
                if depth == 0:
                    return i
                continue
            i += 1
        return len(content)

    def _skip_until_keyword(self, content: str, index: int, keywords: Tuple[str, ...]) -> int:
        i = index
        while i < len(content):
            if content[i] == '"':
                i = self._skip_string(content, i)
                continue
            if content[i] == '\\':
                i = self._skip_escaped_identifier(content, i)
                continue
            keyword = self._match_standalone_keyword(content, i, keywords)
            if keyword:
                return i + len(keyword)
            i += 1
        return len(content)

    def _skip_until_semicolon(self, content: str, index: int) -> int:
        paren_depth = bracket_depth = brace_depth = 0
        i = index
        while i < len(content):
            ch = content[i]
            if ch == '"':
                i = self._skip_string(content, i)
                continue
            if ch == '\\':
                i = self._skip_escaped_identifier(content, i)
                continue
            if ch == '(':
                paren_depth += 1
            elif ch == ')' and paren_depth > 0:
                paren_depth -= 1
            elif ch == '[':
                bracket_depth += 1
            elif ch == ']' and bracket_depth > 0:
                bracket_depth -= 1
            elif ch == '{':
                brace_depth += 1
            elif ch == '}' and brace_depth > 0:
                brace_depth -= 1
            elif (
                ch == ';'
                and paren_depth == 0
                and bracket_depth == 0
                and brace_depth == 0
            ):
                return i + 1
            i += 1
        return len(content)

    def _skip_balanced(self, content: str, index: int, open_ch: str, close_ch: str) -> int:
        depth = 0
        i = index
        while i < len(content):
            ch = content[i]
            if ch == '"':
                i = self._skip_string(content, i)
                continue
            if ch == '\\':
                i = self._skip_escaped_identifier(content, i)
                continue
            if ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        return len(content)

    @staticmethod
    def _skip_whitespace(content: str, index: int) -> int:
        while index < len(content) and content[index].isspace():
            index += 1
        return index

    def _skip_string(self, content: str, index: int) -> int:
        i = index + 1
        while i < len(content):
            if content[i] == '"' and not self._is_escaped(content, i):
                return i + 1
            i += 1
        return len(content)

    @staticmethod
    def _skip_escaped_identifier(content: str, index: int) -> int:
        i = index + 1
        while i < len(content) and not content[i].isspace():
            i += 1
        return i

    def _match_standalone_keyword(self, content: str, index: int, keywords: Tuple[str, ...]) -> str:
        for keyword in keywords:
            if self._matches_standalone_keyword(content, index, keyword):
                return keyword
        return ''

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
                result.append(' ')
            else:
                result.append(content[i])
                i += 1
        return ''.join(result)
