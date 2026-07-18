#!/usr/bin/env python3
"""Standalone Verilog library indexer."""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Dict, Iterator, List, Optional, Sequence, Set, Tuple


REPOSITORY_ROOT = Path(r"D:\Software\VeriFlow")
INDEX_FILE = REPOSITORY_ROOT / ".verilog_module_index.json"
SCHEMA_VERSION = 1

MODULE_DECLARATION = re.compile(
    r"^[ \t]*module\s+(?:(?:automatic|static)\s+)?"
    r"([A-Za-z_][A-Za-z0-9_$]*)\b",
    re.MULTILINE,
)
MODULE_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
DIRECTION = re.compile(r"^(input|output|inout)\b")
IDENTIFIER_AT_END = re.compile(
    r"([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\[[^\]]*\]\s*)*$"
)
VERILOG_TOKEN = re.compile(
    r'"(?:\\.|[^"\\])*"|\\[^\s]+|[A-Za-z_][A-Za-z0-9_$]*|'
    r"[0-9][A-Za-z0-9_.'?]*|\S",
    re.DOTALL,
)
INCLUDE_DIRECTIVE = re.compile(
    r'^[ \t]*`include[ \t]+(?:"([^"\r\n]+)"|<([^>\r\n]+)>)',
    re.MULTILINE,
)

VERILOG_KEYWORDS = {
    "accept_on", "alias", "always", "always_comb", "always_ff",
    "always_latch", "and", "assert", "assign", "assume", "automatic",
    "before", "begin", "bind", "bins", "binsof", "bit", "break",
    "buf", "bufif0", "bufif1", "byte", "case", "casex", "casez",
    "cell", "chandle", "checker", "class", "clocking", "cmos",
    "config", "const", "constraint", "context", "continue", "cover",
    "covergroup", "coverpoint", "cross", "deassign", "default",
    "defparam", "design", "disable", "dist", "do", "edge", "else",
    "end", "endcase", "endchecker", "endclass", "endclocking",
    "endconfig", "endfunction", "endgenerate", "endgroup", "endinterface",
    "endmodule", "endpackage", "endprimitive", "endprogram", "endproperty",
    "endspecify", "endsequence", "endtable", "endtask", "enum", "event",
    "eventually", "expect", "export", "extends", "extern", "final",
    "first_match", "for", "force", "foreach", "forever", "fork",
    "forkjoin", "function", "generate", "genvar", "global", "highz0",
    "highz1", "if", "iff", "ifnone", "ignore_bins", "illegal_bins",
    "implements", "implies", "import", "incdir", "include", "initial",
    "inout", "input", "inside", "instance", "int", "integer",
    "interconnect", "interface", "intersect", "join", "join_any",
    "join_none", "large", "let", "liblist", "library", "local",
    "localparam", "logic", "longint", "macromodule", "matches", "medium",
    "modport", "module", "nand", "negedge", "nettype", "new", "nexttime",
    "nmos", "nor", "noshowcancelled", "not", "notif0", "notif1", "null",
    "or", "output", "package", "packed", "parameter", "pmos", "posedge",
    "primitive", "priority", "program", "property", "protected", "pull0",
    "pull1", "pulldown", "pullup", "pulsestyle_ondetect",
    "pulsestyle_onevent", "pure", "rand", "randc", "randcase", "randsequence",
    "rcmos", "real", "realtime", "ref", "reg", "reject_on", "release",
    "repeat", "restrict", "return", "rnmos", "rpmos", "rtran", "rtranif0",
    "rtranif1", "s_always", "s_eventually", "s_nexttime", "s_until",
    "s_until_with", "scalared", "sequence", "shortint", "shortreal",
    "showcancelled", "signed", "small", "soft", "solve", "specify", "specparam",
    "static", "string", "strong", "strong0", "strong1", "struct", "super",
    "supply0", "supply1", "sync_accept_on", "sync_reject_on", "table",
    "tagged", "task", "this", "throughout", "time", "timeprecision",
    "timeunit", "tran", "tranif0", "tranif1", "tri", "tri0", "tri1",
    "triand", "trior", "trireg", "type", "typedef", "union", "unique",
    "unique0", "unsigned", "until", "until_with", "untyped", "use", "uwire",
    "var", "vectored", "virtual", "void", "wait", "wait_order", "wand",
    "weak", "weak0", "weak1", "while", "wildcard", "wire", "with",
    "within", "wor", "xnor", "xor",
}


class VlibError(Exception):
    """An expected command failure that can be shown directly to the user."""


@dataclass(frozen=True)
class Parameter:
    name: str
    type: str
    value: str


@dataclass(frozen=True)
class Port:
    direction: str
    width: Optional[str]
    name: str


@dataclass(frozen=True)
class ModuleBlock:
    name: str
    parameters: Tuple[Parameter, ...]
    ports: Tuple[Port, ...]
    body: str = ""


@dataclass(frozen=True)
class FileSnapshot:
    source_path: Path
    content: bytes
    mode: int
    atime_ns: int
    mtime_ns: int


@dataclass(frozen=True)
class CopyPlanFile:
    relative_path: str
    snapshot: FileSnapshot


@dataclass(frozen=True)
class CopyMapping:
    plan_file: CopyPlanFile
    destination_path: Path
    safe_no_op: bool


def validate_repository(repository_root: Path) -> Path:
    root = repository_root.expanduser().resolve()
    if not root.exists():
        raise VlibError("Repository root does not exist: {}".format(root))
    if not root.is_dir():
        raise VlibError("Repository root is not a directory: {}".format(root))
    return root


def read_source_snapshot(path: Path) -> Tuple[bytes, str]:
    digest = hashlib.sha256()
    chunks = []  # type: List[bytes]
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            chunks.append(chunk)
            digest.update(chunk)
    return b"".join(chunks), digest.hexdigest()


def source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def strip_comments(text: str) -> str:
    """Replace comments with spaces while preserving strings and line breaks."""
    output = []
    index = 0
    state = "code"

    while index < len(text):
        character = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""

        if state == "code":
            if character == '"':
                output.append(character)
                state = "string"
            elif character == "/" and following == "/":
                output.extend((" ", " "))
                state = "line_comment"
                index += 1
            elif character == "/" and following == "*":
                output.extend((" ", " "))
                state = "block_comment"
                index += 1
            else:
                output.append(character)
        elif state == "string":
            output.append(character)
            if character == "\\" and following:
                output.append(following)
                index += 1
            elif character == '"':
                state = "code"
        elif state == "line_comment":
            if character in "\r\n":
                output.append(character)
                state = "code"
            else:
                output.append(" ")
        else:
            if character == "*" and following == "/":
                output.extend((" ", " "))
                state = "code"
                index += 1
            elif character in "\r\n":
                output.append(character)
            else:
                output.append(" ")

        index += 1

    return "".join(output)


def find_modules(source: str) -> List[str]:
    uncommented = strip_comments(source)
    return [match.group(1) for match in MODULE_DECLARATION.finditer(uncommented)]


def find_matching_delimiter(text: str, start: int) -> int:
    pairs = {"(": ")", "[": "]", "{": "}"}
    opener = text[start] if 0 <= start < len(text) else ""
    if opener not in pairs:
        raise VlibError("Expected an opening delimiter at offset {}.".format(start))

    expected = [pairs[opener]]
    in_string = False
    escaped = False
    for index in range(start + 1, len(text)):
        character = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue

        if character == '"':
            in_string = True
        elif character in pairs:
            expected.append(pairs[character])
        elif character in ")]}":
            if not expected or character != expected[-1]:
                raise VlibError("Unbalanced delimiter at offset {}.".format(index))
            expected.pop()
            if not expected:
                return index

    raise VlibError("Unclosed '{}' delimiter.".format(opener))


def split_top_level(
    text: str, separator: str, maxsplit: int = -1
) -> List[str]:
    if len(separator) != 1:
        raise ValueError("separator must be one character")

    pairs = {"(": ")", "[": "]", "{": "}"}
    expected = []  # type: List[str]
    parts = []  # type: List[str]
    part_start = 0
    split_count = 0
    in_string = False
    escaped = False

    for index, character in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue

        if character == '"':
            in_string = True
        elif character in pairs:
            expected.append(pairs[character])
        elif character in ")]}":
            if not expected or character != expected[-1]:
                raise VlibError("Unbalanced delimiter at offset {}.".format(index))
            expected.pop()
        elif (
            character == separator
            and not expected
            and (maxsplit < 0 or split_count < maxsplit)
        ):
            parts.append(text[part_start:index].strip())
            part_start = index + 1
            split_count += 1

    if expected:
        raise VlibError("Unclosed delimiter in declaration.")
    parts.append(text[part_start:].strip())
    return parts


def _skip_whitespace(text: str, position: int) -> int:
    while position < len(text) and text[position].isspace():
        position += 1
    return position


def _find_keyword_outside_strings(
    text: str, keyword: str, start: int
) -> Optional[int]:
    position = start
    in_string = False
    escaped = False
    identifier_characters = "_$"

    while position < len(text):
        character = text[position]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            position += 1
            continue
        if character == '"':
            in_string = True
            position += 1
            continue

        keyword_end = position + len(keyword)
        before = text[position - 1] if position > 0 else ""
        after = text[keyword_end] if keyword_end < len(text) else ""
        if (
            text.startswith(keyword, position)
            and not (
                before
                and (before.isalnum() or before in identifier_characters)
            )
            and not (
                after and (after.isalnum() or after in identifier_characters)
            )
        ):
            return position
        position += 1
    return None


def _declaration_name(text: str) -> Tuple[str, str]:
    match = IDENTIFIER_AT_END.search(text.strip())
    if match is None:
        raise VlibError("Cannot parse declaration: {}".format(text.strip()))
    return match.group(1), text.strip()[: match.start()].strip()


def _packed_width(prefix: str) -> Optional[str]:
    ranges = []  # type: List[str]
    position = 0
    while position < len(prefix):
        if prefix[position] == "[":
            end = find_matching_delimiter(prefix, position)
            ranges.append(prefix[position : end + 1].strip())
            position = end + 1
        else:
            position += 1
    return " ".join(ranges) or None


def parse_parameters(parameter_text: Optional[str]) -> Tuple[Parameter, ...]:
    if parameter_text is None or not parameter_text.strip():
        return ()

    parameters = []  # type: List[Parameter]
    inherited_type = "-"
    for item in split_top_level(parameter_text, ","):
        declaration = item.strip()
        keyword = re.match(r"^(?:parameter|localparam)\b", declaration)
        if keyword is not None:
            inherited_type = "integer"
            declaration = declaration[keyword.end() :].strip()

        assignment = split_top_level(declaration, "=", maxsplit=1)
        left = assignment[0]
        value = assignment[1] if len(assignment) == 2 else "-"
        name, type_prefix = _declaration_name(left)
        if type_prefix:
            inherited_type = type_prefix
        parameters.append(Parameter(name, inherited_type, value.strip() or "-"))
    return tuple(parameters)


def _starts_with_direction(text: str) -> bool:
    return DIRECTION.match(text.strip()) is not None


def parse_ansi_ports(port_text: str) -> Tuple[Port, ...]:
    ports = []  # type: List[Port]
    seen = set()
    inherited_direction = None  # type: Optional[str]
    inherited_width = None  # type: Optional[str]

    for item in split_top_level(port_text, ","):
        declaration = item.strip()
        if not declaration:
            continue
        direction_match = DIRECTION.match(declaration)
        if direction_match is not None:
            inherited_direction = direction_match.group(1)
            declaration = declaration[direction_match.end() :].strip()
            explicit_direction = True
        else:
            explicit_direction = False
        if inherited_direction is None:
            continue

        declaration = split_top_level(declaration, "=", maxsplit=1)[0]
        name, prefix = _declaration_name(declaration)
        if explicit_direction:
            inherited_width = _packed_width(prefix)
        if name not in seen:
            ports.append(Port(inherited_direction, inherited_width, name))
            seen.add(name)
    return tuple(ports)


def parse_non_ansi_ports(header_text: str, body: str) -> Tuple[Port, ...]:
    header_names = []  # type: List[str]
    for item in split_top_level(header_text, ","):
        declaration = split_top_level(item, "=", maxsplit=1)[0]
        if declaration.strip():
            name, _prefix = _declaration_name(declaration)
            if name not in header_names:
                header_names.append(name)

    declarations = {}  # type: Dict[str, Port]
    for statement in split_top_level(body, ";"):
        if not _starts_with_direction(statement):
            continue
        for port in parse_ansi_ports(statement):
            declarations.setdefault(port.name, port)
    return tuple(
        declarations[name] for name in header_names if name in declarations
    )


def parse_module_blocks(source: str) -> Tuple[ModuleBlock, ...]:
    text = strip_comments(source)
    blocks = []  # type: List[ModuleBlock]
    cursor = 0

    while True:
        declaration = MODULE_DECLARATION.search(text, cursor)
        if declaration is None:
            break
        name = declaration.group(1)
        endmodule_start = _find_keyword_outside_strings(
            text, "endmodule", declaration.end()
        )
        if endmodule_start is None:
            raise VlibError("Module '{}' has no matching endmodule.".format(name))

        position = _skip_whitespace(text, declaration.end())
        parameter_text = None  # type: Optional[str]
        if position < endmodule_start and text[position] == "#":
            position = _skip_whitespace(text, position + 1)
            if position >= endmodule_start or text[position] != "(":
                raise VlibError("Module '{}' has an invalid parameter block.".format(name))
            parameter_end = find_matching_delimiter(text, position)
            parameter_text = text[position + 1 : parameter_end]
            position = _skip_whitespace(text, parameter_end + 1)

        port_text = None  # type: Optional[str]
        if position < endmodule_start and text[position] == "(":
            port_end = find_matching_delimiter(text, position)
            port_text = text[position + 1 : port_end]
            position = _skip_whitespace(text, port_end + 1)

        if position >= endmodule_start or text[position] != ";":
            raise VlibError("Module '{}' has an invalid header.".format(name))
        body = text[position + 1 : endmodule_start]
        parameters = parse_parameters(parameter_text)
        if port_text is None or not port_text.strip():
            ports = ()  # type: Tuple[Port, ...]
        elif any(
            _starts_with_direction(item)
            for item in split_top_level(port_text, ",")
        ):
            ports = parse_ansi_ports(port_text)
        else:
            ports = parse_non_ansi_ports(port_text, body)
        blocks.append(ModuleBlock(name, parameters, ports, body))
        cursor = endmodule_start + len("endmodule")

    return tuple(blocks)


def _verilog_tokens(text: str) -> List[Tuple[str, int, int]]:
    return [
        (match.group(0), match.start(), match.end())
        for match in VERILOG_TOKEN.finditer(text)
    ]


def _skip_token_group(
    tokens: Sequence[Tuple[str, int, int]],
    position: int,
    opener: str,
    closer: str,
) -> int:
    if position >= len(tokens) or tokens[position][0] != opener:
        return position
    depth = 0
    for index in range(position, len(tokens)):
        value = tokens[index][0]
        if value == opener:
            depth += 1
        elif value == closer:
            depth -= 1
            if depth == 0:
                return index + 1
    return len(tokens)


def _consume_simple_statement(
    tokens: Sequence[Tuple[str, int, int]], position: int
) -> int:
    expected = []  # type: List[str]
    pairs = {"(": ")", "[": "]", "{": "}"}
    while position < len(tokens):
        value = tokens[position][0]
        if value in pairs:
            expected.append(pairs[value])
        elif value in ")]}":
            if expected and value == expected[-1]:
                expected.pop()
        elif value == ";" and not expected:
            return position + 1
        position += 1
    return len(tokens)


def _consume_procedural_statement(
    tokens: Sequence[Tuple[str, int, int]], position: int
) -> int:
    while position < len(tokens) and tokens[position][0] in {
        "priority",
        "unique",
        "unique0",
    }:
        position += 1

    while position < len(tokens) and tokens[position][0] in {"@", "#"}:
        position += 1
        if position < len(tokens) and tokens[position][0] == "(":
            position = _skip_token_group(tokens, position, "(", ")")
        elif position < len(tokens):
            position += 1

    if position >= len(tokens):
        return position

    value = tokens[position][0]
    if value == "begin":
        depth = 0
        for index in range(position, len(tokens)):
            current = tokens[index][0]
            if current == "begin":
                depth += 1
            elif current == "end":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    if end < len(tokens) and tokens[end][0] == ":":
                        end += 1
                        if end < len(tokens):
                            end += 1
                    return end
        return len(tokens)

    if value == "if":
        condition = position + 1
        if condition < len(tokens) and tokens[condition][0] == "(":
            condition = _skip_token_group(tokens, condition, "(", ")")
        end = _consume_procedural_statement(tokens, condition)
        if end < len(tokens) and tokens[end][0] == "else":
            return _consume_procedural_statement(tokens, end + 1)
        return end

    if value in {"case", "casex", "casez", "randcase"}:
        depth = 0
        for index in range(position, len(tokens)):
            current = tokens[index][0]
            if current in {"case", "casex", "casez", "randcase"}:
                depth += 1
            elif current == "endcase":
                depth -= 1
                if depth == 0:
                    return index + 1
        return len(tokens)

    if value == "fork":
        depth = 0
        for index in range(position, len(tokens)):
            current = tokens[index][0]
            if current == "fork":
                depth += 1
            elif current in {"join", "join_any", "join_none"}:
                depth -= 1
                if depth == 0:
                    return index + 1
        return len(tokens)

    if value in {"for", "foreach", "repeat", "while"}:
        body_start = position + 1
        if body_start < len(tokens) and tokens[body_start][0] == "(":
            body_start = _skip_token_group(tokens, body_start, "(", ")")
        return _consume_procedural_statement(tokens, body_start)

    if value == "forever":
        return _consume_procedural_statement(tokens, position + 1)

    if value == "do":
        end = _consume_procedural_statement(tokens, position + 1)
        if end < len(tokens) and tokens[end][0] == "while":
            end += 1
            if end < len(tokens) and tokens[end][0] == "(":
                end = _skip_token_group(tokens, end, "(", ")")
            if end < len(tokens) and tokens[end][0] == ";":
                end += 1
        return end

    if value in {"wait", "wait_order"}:
        body_start = position + 1
        if body_start < len(tokens) and tokens[body_start][0] == "(":
            body_start = _skip_token_group(tokens, body_start, "(", ")")
            return _consume_procedural_statement(tokens, body_start)

    return _consume_simple_statement(tokens, position)


def _consume_through_keyword(
    tokens: Sequence[Tuple[str, int, int]],
    position: int,
    start_keyword: str,
    end_keyword: str,
) -> int:
    depth = 0
    for index in range(position, len(tokens)):
        value = tokens[index][0]
        if value == start_keyword:
            depth += 1
        elif value == end_keyword:
            depth -= 1
            if depth == 0:
                return index + 1
    return len(tokens)


def _spaces_preserving_lines(text: str) -> str:
    return "".join(character if character in "\r\n" else " " for character in text)


def _is_declaration_only_subprogram(
    tokens: Sequence[Tuple[str, int, int]], position: int
) -> bool:
    prefixes = set()  # type: Set[str]
    position -= 1
    while position >= 0 and tokens[position][0] != ";":
        prefixes.add(tokens[position][0])
        position -= 1
    return bool(prefixes & {"import", "export", "extern"}) or {
        "pure",
        "virtual",
    }.issubset(prefixes)


def _is_subprogram_label(value: str) -> bool:
    return (
        re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", value) is not None
        or value.startswith("\\") and len(value) > 1
    )


def _procedural_mask(
    body: str,
) -> Tuple[str, List[Tuple[int, int]]]:
    text = re.sub(
        r"(?m)^[ \t]*`[^\r\n]*",
        lambda match: _spaces_preserving_lines(match.group(0)),
        body,
    )
    tokens = _verilog_tokens(text)
    token_count = len(tokens)
    scan_tokens = tokens + [
        ("__vlib_incomplete_sentinel", len(text), len(text))
    ]
    ranges = []  # type: List[Tuple[int, int, bool]]
    position = 0

    while position < token_count:
        value = tokens[position][0]
        if value in {"task", "function"} and _is_declaration_only_subprogram(
            scan_tokens, position
        ):
            end = _consume_simple_statement(scan_tokens, position)
        elif value in {"task", "function", "specify"}:
            terminator = {
                "task": "endtask",
                "function": "endfunction",
                "specify": "endspecify",
            }[value]
            end = _consume_through_keyword(
                scan_tokens, position, value, terminator
            )
            if (
                value in {"task", "function"}
                and end + 1 < token_count
                and tokens[end][0] == ":"
                and _is_subprogram_label(tokens[end + 1][0])
            ):
                end += 2
        elif value in {
            "initial",
            "always",
            "always_comb",
            "always_ff",
            "always_latch",
            "final",
        }:
            end = _consume_procedural_statement(
                scan_tokens, position + 1
            )
        else:
            position += 1
            continue

        complete = end <= token_count
        range_end = tokens[end - 1][2] if complete else len(text)
        ranges.append((tokens[position][1], range_end, complete))
        position = max(end, position + 1)

    characters = list(text)
    for start, end, _complete in ranges:
        for index in range(start, end):
            if characters[index] not in "\r\n":
                characters[index] = " "
    completed_ranges = [
        (start, end) for start, end, complete in ranges if complete
    ]
    return "".join(characters), completed_ranges


def mask_procedural_regions(body: str) -> str:
    masked, _completed_ranges = _procedural_mask(body)
    return masked


def _is_identifier(value: str) -> bool:
    return re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", value) is not None


@dataclass(frozen=True)
class _DependencyState:
    constraints: Tuple[Tuple[str, bool], ...]
    buffer: str


@dataclass
class _ConditionalNode:
    branches: List[
        Tuple[Tuple[Tuple[str, bool], ...], List[object]]
    ]


def _directive_parts(line: str) -> Tuple[Optional[str], Optional[str]]:
    match = re.match(
        r"^[ \t]*`([A-Za-z_][A-Za-z0-9_$]*)"
        r"(?:[ \t]+([A-Za-z_][A-Za-z0-9_$]*))?",
        line,
    )
    if match is None:
        return None, None
    return match.group(1), match.group(2)


def _parse_conditional_nodes(
    lines: Sequence[str],
    position: int,
    stop_directives: Set[str],
) -> Tuple[List[object], int, Optional[str]]:
    nodes = []  # type: List[object]
    text_lines = []  # type: List[str]

    while position < len(lines):
        directive, macro = _directive_parts(lines[position])
        if directive in stop_directives:
            if text_lines:
                nodes.append("".join(text_lines))
            return nodes, position, directive

        if directive not in {"ifdef", "ifndef"} or macro is None:
            text_lines.append(lines[position])
            position += 1
            continue

        if text_lines:
            nodes.append("".join(text_lines))
            text_lines = []

        test = (macro, directive == "ifdef")
        false_terms = [(macro, not test[1])]
        position += 1
        branch_nodes, position, terminator = _parse_conditional_nodes(
            lines, position, {"elsif", "else", "endif"}
        )
        branches = [
            ((test,), branch_nodes)
        ]  # type: List[Tuple[Tuple[Tuple[str, bool], ...], List[object]]]

        while terminator == "elsif":
            _elsif, elsif_macro = _directive_parts(lines[position])
            position += 1
            branch_nodes, position, terminator = _parse_conditional_nodes(
                lines, position, {"elsif", "else", "endif"}
            )
            if elsif_macro is not None:
                branch_terms = tuple(
                    false_terms + [(elsif_macro, True)]
                )
                branches.append((branch_terms, branch_nodes))
                false_terms.append((elsif_macro, False))

        if terminator == "else":
            position += 1
            branch_nodes, position, terminator = _parse_conditional_nodes(
                lines, position, {"endif"}
            )
            branches.append((tuple(false_terms), branch_nodes))
        else:
            branches.append((tuple(false_terms), []))

        if terminator == "endif":
            position += 1
        nodes.append(_ConditionalNode(branches))

    if text_lines:
        nodes.append("".join(text_lines))
    return nodes, position, None


def _merge_constraints(
    constraints: Tuple[Tuple[str, bool], ...],
    terms: Sequence[Tuple[str, bool]],
) -> Optional[Tuple[Tuple[str, bool], ...]]:
    merged = dict(constraints)
    for macro, expected in terms:
        if macro in merged and merged[macro] != expected:
            return None
        merged[macro] = expected
    return tuple(sorted(merged.items()))


def _split_safe_dependency_statements(text: str) -> Tuple[List[str], str]:
    masked, completed_ranges = _procedural_mask(text)
    buffer_characters = list(text)
    for start, end in completed_ranges:
        buffer_characters[start:end] = masked[start:end]
    buffer_text = "".join(buffer_characters)
    pairs = {"(": ")", "[": "]", "{": "}"}
    expected = []  # type: List[str]
    statement_ends = []  # type: List[int]
    in_string = False
    escaped = False

    for position, character in enumerate(masked):
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in pairs:
            expected.append(pairs[character])
        elif character in ")]}":
            if expected and character == expected[-1]:
                expected.pop()
        elif character == ";" and not expected:
            statement_ends.append(position + 1)

    statements = []  # type: List[str]
    start = 0
    for end in statement_ends:
        statements.append(buffer_text[start:end])
        start = end
    return statements, buffer_text[start:]


def _deduplicate_dependency_states(
    states: Sequence[_DependencyState],
) -> List[_DependencyState]:
    return list(dict.fromkeys(states))


def _extract_dependencies_from_body(module: str, body: str) -> Set[str]:
    text = mask_procedural_regions(body)
    characters = list(text)
    for value, start, end in _verilog_tokens(text):
        if value in {"generate", "endgenerate"}:
            characters[start:end] = " " * (end - start)
    text = "".join(characters)
    tokens = _verilog_tokens(text)
    dependencies = set()  # type: Set[str]
    expected = []  # type: List[str]
    pairs = {"(": ")", "[": "]", "{": "}"}

    for position, token in enumerate(tokens):
        value = token[0]
        if value in pairs:
            expected.append(pairs[value])
            continue
        if value in ")]}":
            if expected and value == expected[-1]:
                expected.pop()
            continue
        if expected or not _is_identifier(value):
            continue
        if value in VERILOG_KEYWORDS or value == module:
            continue

        next_position = position + 1
        if next_position < len(tokens) and tokens[next_position][0] == "#":
            next_position += 1
            if (
                next_position >= len(tokens)
                or tokens[next_position][0] != "("
            ):
                continue
            next_position = _skip_token_group(
                tokens, next_position, "(", ")"
            )
        if (
            next_position >= len(tokens)
            or not _is_identifier(tokens[next_position][0])
        ):
            continue

        next_position += 1
        while (
            next_position < len(tokens)
            and tokens[next_position][0] == "["
        ):
            next_position = _skip_token_group(
                tokens, next_position, "[", "]"
            )
        if (
            next_position < len(tokens)
            and tokens[next_position][0] == "("
        ):
            dependencies.add(value)

    return dependencies


def _append_dependency_text(
    state: _DependencyState,
    text: str,
    active_constraints: Tuple[Tuple[str, bool], ...],
    module: str,
    dependencies: Set[str],
) -> _DependencyState:
    statements, remainder = _split_safe_dependency_statements(
        state.buffer + text
    )
    for statement in statements:
        dependencies.update(
            _extract_dependencies_from_body(module, statement)
        )
    if not remainder.strip():
        remainder = ""
    constraints = active_constraints if statements else state.constraints
    return _DependencyState(constraints, remainder)


def _process_conditional_nodes(
    nodes: Sequence[object],
    states: Sequence[_DependencyState],
    active_constraints: Tuple[Tuple[str, bool], ...],
    module: str,
    dependencies: Set[str],
) -> List[_DependencyState]:
    current_states = list(states)
    for node in nodes:
        if isinstance(node, str):
            current_states = _deduplicate_dependency_states(
                [
                    _append_dependency_text(
                        state,
                        node,
                        active_constraints,
                        module,
                        dependencies,
                    )
                    for state in current_states
                ]
            )
            continue

        if not isinstance(node, _ConditionalNode):
            raise AssertionError("Unexpected conditional syntax node.")
        branch_states = []  # type: List[_DependencyState]
        for state in current_states:
            for terms, branch_nodes in node.branches:
                constrained = _merge_constraints(state.constraints, terms)
                branch_active = _merge_constraints(
                    active_constraints, terms
                )
                if constrained is None or branch_active is None:
                    continue
                processed = _process_conditional_nodes(
                    branch_nodes,
                    [_DependencyState(constrained, state.buffer)],
                    branch_active,
                    module,
                    dependencies,
                )
                for branch_state in processed:
                    if not branch_state.buffer:
                        branch_state = _DependencyState(
                            active_constraints, ""
                        )
                    branch_states.append(branch_state)
        current_states = _deduplicate_dependency_states(branch_states)
    return current_states


def extract_dependencies(block: ModuleBlock) -> List[str]:
    dependencies = set()  # type: Set[str]
    nodes, _position, _terminator = _parse_conditional_nodes(
        block.body.splitlines(keepends=True), 0, set()
    )
    states = _process_conditional_nodes(
        nodes,
        [_DependencyState((), "")],
        (),
        block.name,
        dependencies,
    )
    for buffer in {state.buffer for state in states if state.buffer.strip()}:
        dependencies.update(
            _extract_dependencies_from_body(block.name, buffer)
        )
    return sorted(dependencies)


def resolve_dependencies(
    module: str, index: Dict[str, object]
) -> Tuple[List[Tuple[str, str]], List[str]]:
    modules = index.get("modules")
    if not isinstance(modules, dict):
        raise VlibError("Invalid module index: 'modules' must be an object.")

    module_block_from_index(module, index)
    queue = [module]
    visited = {module}
    known = []  # type: List[Tuple[str, str]]
    missing = set()  # type: Set[str]
    position = 0

    while position < len(queue):
        current = queue[position]
        position += 1
        block = module_block_from_index(current, index)
        for dependency in extract_dependencies(block):
            if dependency == module or dependency in visited:
                continue
            visited.add(dependency)
            relative_path = modules.get(dependency)
            if relative_path is None:
                missing.add(dependency)
                continue
            if not isinstance(relative_path, str) or not relative_path:
                module_block_from_index(dependency, index)
                raise AssertionError("unreachable")
            known.append((dependency, relative_path))
            queue.append(dependency)

    return known, sorted(missing)


def extract_includes(source: str) -> List[str]:
    uncommented = strip_comments(source)
    includes = []  # type: List[str]
    for match in INCLUDE_DIRECTIVE.finditer(uncommented):
        includes.append(match.group(1) or match.group(2))
    return includes


def _repository_file(
    repository_root: Path, relative_path: str
) -> Tuple[Path, str]:
    indexed_path = Path(relative_path)
    if indexed_path.is_absolute():
        raise VlibError(
            "Invalid repository-relative path: {}".format(relative_path)
        )
    logical_path = Path(
        os.path.abspath(str(repository_root / indexed_path))
    )
    try:
        normalized_relative = logical_path.relative_to(repository_root)
    except ValueError:
        raise VlibError(
            "Path escapes the repository: {}".format(relative_path)
        )
    source_path = logical_path.resolve()
    try:
        source_path.relative_to(repository_root)
    except ValueError:
        raise VlibError(
            "Path resolves outside the repository: {}".format(relative_path)
        )
    if not source_path.is_file():
        raise VlibError("Source file is missing: {}".format(relative_path))
    return source_path, normalized_relative.as_posix()


def _resolve_include(
    include_name: str,
    including_relative: str,
    repository_root: Path,
) -> Optional[Tuple[Path, str]]:
    including_logical = repository_root / Path(including_relative)
    for base in (including_logical.parent, repository_root):
        logical_candidate = Path(
            os.path.abspath(str(base / Path(include_name)))
        )
        try:
            candidate_relative = logical_candidate.relative_to(
                repository_root
            )
        except ValueError:
            continue
        physical_candidate = logical_candidate.resolve()
        try:
            physical_candidate.relative_to(repository_root)
        except ValueError:
            continue
        if physical_candidate.is_file():
            return physical_candidate, candidate_relative.as_posix()
    return None


def _file_snapshot(
    source_path: Path, cache: Dict[Path, FileSnapshot]
) -> FileSnapshot:
    snapshot = cache.get(source_path)
    if snapshot is None:
        content = source_path.read_bytes()
        metadata = source_path.stat()
        snapshot = FileSnapshot(
            source_path=source_path,
            content=content,
            mode=metadata.st_mode,
            atime_ns=metadata.st_atime_ns,
            mtime_ns=metadata.st_mtime_ns,
        )
        cache[source_path] = snapshot
    return snapshot


def _copy_module_snapshot(
    module: str,
    index: Dict[str, object],
    snapshot_cache: Dict[Path, FileSnapshot],
    module_cache: Dict[str, Tuple[ModuleBlock, str, FileSnapshot]],
) -> Tuple[ModuleBlock, str, FileSnapshot]:
    cached = module_cache.get(module)
    if cached is not None:
        return cached

    modules = index.get("modules")
    if not isinstance(modules, dict):
        raise VlibError("Invalid module index: 'modules' must be an object.")
    if module not in modules:
        raise VlibError("Unknown module '{}'.".format(module))
    relative_path = modules[module]
    if not isinstance(relative_path, str) or not relative_path:
        raise VlibError(
            "Invalid module index path for module '{}'.".format(module)
        )

    repository_root = validate_repository(REPOSITORY_ROOT)
    source_path, normalized_relative = _repository_file(
        repository_root, relative_path
    )
    snapshot = _file_snapshot(source_path, snapshot_cache)
    source = snapshot.content.decode("utf-8", errors="replace")
    for block in parse_module_blocks(source):
        if block.name == module:
            result = (block, normalized_relative, snapshot)
            module_cache[module] = result
            return result
    raise VlibError(
        "Module '{}' is not present in indexed file '{}'; the index is stale. "
        "Run 'vlib index'.".format(module, relative_path)
    )


def build_copy_plan(
    module: str, index: Dict[str, object], with_deps: bool
) -> Tuple[List[CopyPlanFile], List[str], List[Tuple[str, str]]]:
    modules = index.get("modules")
    if not isinstance(modules, dict):
        raise VlibError("Invalid module index: 'modules' must be an object.")

    repository_root = validate_repository(REPOSITORY_ROOT)
    snapshot_cache = {}  # type: Dict[Path, FileSnapshot]
    module_cache = {}  # type: Dict[str, Tuple[ModuleBlock, str, FileSnapshot]]
    top_block, top_relative, top_snapshot = _copy_module_snapshot(
        module, index, snapshot_cache, module_cache
    )
    planned = {top_relative: top_snapshot}  # type: Dict[str, FileSnapshot]
    missing_module_names = set()  # type: Set[str]

    if with_deps:
        queue = [(module, top_block, top_relative, top_snapshot)]
        visited_modules = {module}
        position = 0
        while position < len(queue):
            _current, block, relative_path, snapshot = queue[position]
            position += 1
            planned[relative_path] = snapshot
            for dependency in extract_dependencies(block):
                if dependency == module or dependency in visited_modules:
                    continue
                visited_modules.add(dependency)
                if dependency not in modules:
                    missing_module_names.add(dependency)
                    continue
                dependency_data = _copy_module_snapshot(
                    dependency, index, snapshot_cache, module_cache
                )
                dependency_block, dependency_relative, dependency_snapshot = (
                    dependency_data
                )
                queue.append(
                    (
                        dependency,
                        dependency_block,
                        dependency_relative,
                        dependency_snapshot,
                    )
                )

    missing_includes = set()  # type: Set[Tuple[str, str]]
    if with_deps:
        include_queue = []  # type: List[Tuple[str, FileSnapshot, Tuple[Path, ...]]]
        visited = set()  # type: Set[Tuple[Path, str]]
        for logical_path in sorted(planned):
            snapshot = planned[logical_path]
            physical_path = snapshot.source_path
            state = (physical_path, logical_path)
            if state not in visited:
                include_queue.append(
                    (logical_path, snapshot, (physical_path,))
                )
                visited.add(state)
        include_cache = {}  # type: Dict[Path, List[str]]
        position = 0
        while position < len(include_queue):
            including_relative, including_snapshot, ancestry = (
                include_queue[position]
            )
            position += 1
            including_file = including_snapshot.source_path
            includes = include_cache.get(including_file)
            if includes is None:
                source = including_snapshot.content.decode(
                    "utf-8", errors="replace"
                )
                includes = extract_includes(source)
                include_cache[including_file] = includes
            for include_name in includes:
                resolved_include = _resolve_include(
                    include_name, including_relative, repository_root
                )
                if resolved_include is None:
                    missing_includes.add((include_name, including_relative))
                    continue
                included_file, included_relative = resolved_include
                included_snapshot = _file_snapshot(
                    included_file, snapshot_cache
                )
                planned[included_relative] = included_snapshot
                state = (included_file, included_relative)
                if included_file in ancestry or state in visited:
                    continue
                include_queue.append(
                    (
                        included_relative,
                        included_snapshot,
                        ancestry + (included_file,),
                    )
                )
                visited.add(state)

    copy_files = [
        CopyPlanFile(path, planned[path]) for path in sorted(planned)
    ]
    return copy_files, sorted(missing_module_names), sorted(missing_includes)


def iter_verilog_files(repository_root: Path) -> Iterator[Path]:
    candidates = (
        path
        for path in repository_root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".v", ".sv"}
    )
    yield from sorted(
        candidates,
        key=lambda path: path.relative_to(repository_root).as_posix(),
    )


def repository_snapshot(repository_root: Path) -> Dict[str, str]:
    snapshot = {}  # type: Dict[str, str]
    for path in iter_verilog_files(repository_root):
        relative_path = path.relative_to(repository_root).as_posix()
        snapshot[relative_path] = source_sha256(path)
    return snapshot


def build_index(repository_root: Path) -> Dict[str, object]:
    files = {}  # type: Dict[str, object]
    module_paths = {}  # type: Dict[str, List[str]]

    for path in iter_verilog_files(repository_root):
        relative_path = path.relative_to(repository_root).as_posix()
        source_bytes, source_hash = read_source_snapshot(path)
        declared_modules = find_modules(
            source_bytes.decode("utf-8", errors="replace")
        )

        for module_name in declared_modules:
            module_paths.setdefault(module_name, []).append(relative_path)

        files[relative_path] = {
            "modules": declared_modules,
            "sha256": source_hash,
        }

    duplicate_lines = []
    for module_name in sorted(module_paths):
        paths = module_paths[module_name]
        if len(paths) > 1:
            duplicate_lines.append(
                "Duplicate module '{}': {}".format(
                    module_name, ", ".join(sorted(set(paths)))
                )
            )
    if duplicate_lines:
        raise VlibError(
            "Duplicate modules found:\n{}".format("\n".join(duplicate_lines))
        )

    modules = {
        module_name: paths[0]
        for module_name, paths in module_paths.items()
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "repository_root": repository_root.as_posix(),
        "generated_at": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "files": files,
        "modules": modules,
    }


def atomic_write_json(path: Path, data: Dict[str, object]) -> None:
    temporary_path = None  # type: Optional[Path]
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=str(path.parent),
            prefix=".{}.".format(path.name),
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(data, temporary_file, indent=2, sort_keys=True)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(str(temporary_path), str(path))
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def load_index(check_root: bool = True) -> Dict[str, object]:
    if not INDEX_FILE.exists():
        raise VlibError(
            "Module index does not exist; run 'vlib index' first: {}".format(
                INDEX_FILE
            )
        )
    try:
        index = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VlibError("Invalid module index JSON: {}".format(error))

    if not isinstance(index, dict):
        raise VlibError("Invalid module index: top level must be an object.")
    schema_version = index.get("schema_version")
    if type(schema_version) is not int or schema_version != SCHEMA_VERSION:
        raise VlibError(
            "Unsupported module index schema {}; expected {}.".format(
                schema_version, SCHEMA_VERSION
            )
        )
    if not isinstance(index.get("files"), dict):
        raise VlibError("Invalid module index: 'files' must be an object.")
    if not isinstance(index.get("modules"), dict):
        raise VlibError("Invalid module index: 'modules' must be an object.")

    if check_root:
        indexed_root = index.get("repository_root")
        if not isinstance(indexed_root, str):
            raise VlibError(
                "Invalid module index: 'repository_root' must be a string."
            )
        configured_root = validate_repository(REPOSITORY_ROOT)
        normalized_indexed_root = Path(indexed_root).expanduser().resolve()
        if os.path.normcase(str(normalized_indexed_root)) != os.path.normcase(
            str(configured_root)
        ):
            raise VlibError(
                "Module index root '{}' does not match configured root '{}'; "
                "run 'vlib index'.".format(indexed_root, configured_root)
            )
    return index


def _is_module_identifier(value: object) -> bool:
    return (
        isinstance(value, str)
        and MODULE_IDENTIFIER.fullmatch(value) is not None
    )


def _is_canonical_repository_path(value: object) -> bool:
    if not isinstance(value, str) or not value or "\\" in value:
        return False
    posix_path = PurePosixPath(value)
    if posix_path.is_absolute() or Path(value).is_absolute():
        return False
    if any(part in {".", ".."} for part in value.split("/")):
        return False
    return bool(posix_path.parts) and posix_path.as_posix() == value


def _status_index_snapshot(
    index: Dict[str, object]
) -> Tuple[str, Dict[str, str]]:
    indexed_root = index.get("repository_root")
    if not isinstance(indexed_root, str) or not indexed_root:
        raise VlibError(
            "Invalid module index: 'repository_root' must be a string."
        )

    files = index["files"]
    if not isinstance(files, dict):
        raise VlibError("Invalid module index: 'files' must be an object.")
    snapshot = {}  # type: Dict[str, str]
    reconstructed_modules = {}  # type: Dict[str, str]
    for relative_path in sorted(files):
        if not _is_canonical_repository_path(relative_path):
            raise VlibError(
                "Invalid module index source path: {}.".format(relative_path)
            )
        file_record = files[relative_path]
        if not isinstance(file_record, dict):
            raise VlibError(
                "Invalid module index entry for '{}'.".format(relative_path)
            )
        declared_modules = file_record.get("modules")
        if not isinstance(declared_modules, list) or not all(
            _is_module_identifier(module_name)
            for module_name in declared_modules
        ):
            raise VlibError(
                "Invalid module index modules for '{}'.".format(relative_path)
            )
        for module_name in declared_modules:
            if module_name in reconstructed_modules:
                raise VlibError(
                    "Duplicate module '{}' in module index.".format(
                        module_name
                    )
                )
            reconstructed_modules[module_name] = relative_path
        source_hash = file_record.get("sha256")
        if not isinstance(source_hash, str) or re.fullmatch(
            r"[0-9a-f]{64}", source_hash
        ) is None:
            raise VlibError(
                "Invalid module index hash for '{}'.".format(relative_path)
            )
        snapshot[relative_path] = source_hash

    modules = index["modules"]
    if not isinstance(modules, dict):
        raise VlibError("Invalid module index: 'modules' must be an object.")
    for module_name, relative_path in modules.items():
        if (
            not _is_module_identifier(module_name)
            or not _is_canonical_repository_path(relative_path)
        ):
            raise VlibError("Invalid module index module mapping.")
    if modules != reconstructed_modules:
        raise VlibError(
            "Invalid module index: module mapping does not match "
            "file declarations."
        )
    return indexed_root, snapshot


def module_block_from_index(
    module: str, index: Dict[str, object]
) -> ModuleBlock:
    modules = index.get("modules")
    if not isinstance(modules, dict):
        raise VlibError("Invalid module index: 'modules' must be an object.")
    if module not in modules:
        raise VlibError("Unknown module '{}'.".format(module))

    relative_path = modules[module]
    if not isinstance(relative_path, str) or not relative_path:
        raise VlibError(
            "Invalid module index path for module '{}'.".format(module)
        )
    indexed_path = Path(relative_path)
    if indexed_path.is_absolute():
        raise VlibError(
            "Invalid module index path for module '{}': {}".format(
                module, relative_path
            )
        )

    repository_root = validate_repository(REPOSITORY_ROOT)
    source_path = (repository_root / indexed_path).resolve()
    try:
        source_path.relative_to(repository_root)
    except ValueError:
        raise VlibError(
            "Indexed path for module '{}' escapes the repository: {}".format(
                module, relative_path
            )
        )
    if not source_path.is_file():
        raise VlibError(
            "Indexed file for module '{}' is missing: {}; run 'vlib index'.".format(
                module, relative_path
            )
        )

    source = source_path.read_text(encoding="utf-8", errors="replace")
    for block in parse_module_blocks(source):
        if block.name == module:
            return block
    raise VlibError(
        "Module '{}' is not present in indexed file '{}'; the index is stale. "
        "Run 'vlib index'.".format(module, relative_path)
    )


def index_command(_arguments: argparse.Namespace) -> int:
    repository_root = validate_repository(REPOSITORY_ROOT)
    index = build_index(repository_root)
    atomic_write_json(INDEX_FILE, index)
    print(
        "Indexed {} modules from {} files.".format(
            len(index["modules"]), len(index["files"])
        )
    )
    return 0


def status_command(_arguments: argparse.Namespace) -> int:
    try:
        repository_root = validate_repository(REPOSITORY_ROOT)
    except (OSError, RuntimeError, ValueError, VlibError) as error:
        print("Repository: INVALID ({})".format(error))
        print("Index: UNAVAILABLE")
        return 1

    print("Repository: {}".format(repository_root))
    if not INDEX_FILE.exists():
        print("Index: MISSING")
        return 1

    try:
        index = load_index(check_root=False)
        indexed_root, indexed_snapshot = _status_index_snapshot(index)
        normalized_indexed_root = Path(indexed_root).expanduser().resolve()
    except (OSError, RuntimeError, ValueError, VlibError) as error:
        print("Index: INCOMPATIBLE ({})".format(error))
        return 1

    if os.path.normcase(str(normalized_indexed_root)) != os.path.normcase(
        str(repository_root)
    ):
        print("Index: WRONG_REPOSITORY ({})".format(indexed_root))
        return 1

    print("Modules: {}".format(len(index["modules"])))
    print("Source files: {}".format(len(index["files"])))
    try:
        current_snapshot = repository_snapshot(repository_root)
    except (OSError, RuntimeError, ValueError, VlibError) as error:
        print("Index: UNAVAILABLE ({})".format(error))
        return 1

    indexed_paths = set(indexed_snapshot)
    current_paths = set(current_snapshot)
    added = sorted(current_paths - indexed_paths)
    modified = sorted(
        path
        for path in current_paths & indexed_paths
        if current_snapshot[path] != indexed_snapshot[path]
    )
    deleted = sorted(indexed_paths - current_paths)

    if not added and not modified and not deleted:
        print("Index: CURRENT")
        return 0

    print("Index: STALE")
    for path in added:
        print("Added: {}".format(path))
    for path in modified:
        print("Modified: {}".format(path))
    for path in deleted:
        print("Deleted: {}".format(path))
    return 1


def show_command(arguments: argparse.Namespace) -> int:
    index = load_index()
    block = module_block_from_index(arguments.module, index)

    print("Parameters:")
    if block.parameters:
        for parameter in block.parameters:
            print(
                "  {} | {} | {}".format(
                    parameter.name, parameter.type, parameter.value
                )
            )
    else:
        print("  (none)")

    print("Ports:")
    if block.ports:
        for port in block.ports:
            print(
                "  {} | {} | {}".format(
                    port.direction, port.width or "-", port.name
                )
            )
    else:
        print("  (none)")
    return 0


def deps_command(arguments: argparse.Namespace) -> int:
    index = load_index()
    known, missing = resolve_dependencies(arguments.module, index)

    print("Dependencies for {}:".format(arguments.module))
    if not known and not missing:
        print("  (none)")
    else:
        for dependency, relative_path in known:
            print("  {} -> {}".format(dependency, relative_path))
        for dependency in missing:
            print("  {} -> MISSING".format(dependency))
    return 1 if missing else 0


def list_command(_arguments: argparse.Namespace) -> int:
    index = load_index()
    modules = index["modules"]
    if not isinstance(modules, dict):
        raise VlibError("Invalid module index: 'modules' must be an object.")
    for module in sorted(modules):
        print(module)
    return 0


def _paths_alias(first: Path, second: Path) -> bool:
    if os.path.normcase(str(first)) == os.path.normcase(str(second)):
        return True
    try:
        return os.path.samefile(str(first), str(second))
    except (FileNotFoundError, OSError):
        return False


def _copy_path_label(path: Path, repository_root: Path) -> str:
    try:
        return path.relative_to(repository_root).as_posix()
    except ValueError:
        return path.as_posix()


def _preflight_copy_targets(
    copy_files: Sequence[CopyPlanFile], destination_root: Path
) -> List[CopyMapping]:
    repository_root = validate_repository(REPOSITORY_ROOT)
    mappings = []  # type: List[CopyMapping]
    for plan_file in copy_files:
        relative_path = plan_file.relative_path
        destination_path = (destination_root / Path(relative_path)).resolve()
        try:
            destination_path.relative_to(destination_root)
        except ValueError:
            raise VlibError(
                "Copy destination escapes the requested directory: {}".format(
                    relative_path
                )
            )
        mappings.append(CopyMapping(plan_file, destination_path, False))

    for index, mapping in enumerate(mappings):
        relative_path = mapping.plan_file.relative_path
        destination_path = mapping.destination_path
        for earlier_mapping in mappings[:index]:
            earlier_relative = earlier_mapping.plan_file.relative_path
            if _paths_alias(
                destination_path, earlier_mapping.destination_path
            ):
                raise VlibError(
                    "Copy conflict: targets '{}' and '{}' alias each other.".format(
                        earlier_relative, relative_path
                    )
                )

    preflighted = []  # type: List[CopyMapping]
    for index, mapping in enumerate(mappings):
        relative_path = mapping.plan_file.relative_path
        destination_path = mapping.destination_path
        aliasing_sources = [
            source_index
            for source_index, other_mapping in enumerate(mappings)
            if _paths_alias(
                destination_path,
                other_mapping.plan_file.snapshot.source_path,
            )
        ]
        safe_no_op = aliasing_sources == [index]
        if aliasing_sources and not safe_no_op:
            conflict_index = next(
                (
                    source_index
                    for source_index in aliasing_sources
                    if source_index != index
                ),
                aliasing_sources[0],
            )
            conflicting_source = mappings[
                conflict_index
            ].plan_file.relative_path
            raise VlibError(
                "Copy conflict: target '{}' for '{}' aliases source '{}'.".format(
                    _copy_path_label(destination_path, repository_root),
                    relative_path,
                    conflicting_source,
                )
            )
        preflighted.append(
            CopyMapping(mapping.plan_file, destination_path, safe_no_op)
        )
    return preflighted


def _temporary_sibling(destination_path: Path, purpose: str) -> Path:
    with tempfile.NamedTemporaryFile(
        mode="wb",
        dir=str(destination_path.parent),
        prefix=".{}.vlib-{}-".format(destination_path.name, purpose),
        suffix=".tmp",
        delete=False,
    ) as temporary_file:
        return Path(temporary_file.name)


def _write_staged_snapshot(snapshot: bytes, staging_path: Path) -> None:
    with staging_path.open("wb") as staged_file:
        staged_file.write(snapshot)
        staged_file.flush()
        os.fsync(staged_file.fileno())


def _apply_snapshot_metadata(
    snapshot: FileSnapshot, staging_path: Path
) -> None:
    os.chmod(str(staging_path), snapshot.mode & 0o7777)
    os.utime(
        str(staging_path),
        ns=(snapshot.atime_ns, snapshot.mtime_ns),
    )


def _unlink_if_present(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _cleanup_temporary_paths(paths: Sequence[Path]) -> None:
    first_error = None  # type: Optional[OSError]
    for path in reversed(paths):
        try:
            _unlink_if_present(path)
        except OSError as error:
            if first_error is None:
                first_error = error
    if first_error is not None:
        raise first_error


def _stage_copy_mappings(
    mappings: Sequence[CopyMapping],
) -> List[Tuple[CopyMapping, Optional[Path]]]:
    staged = []  # type: List[Tuple[CopyMapping, Optional[Path]]]
    staging_paths = []  # type: List[Path]
    try:
        for mapping in mappings:
            if mapping.safe_no_op:
                current_content = (
                    mapping.plan_file.snapshot.source_path.read_bytes()
                )
                if current_content != mapping.plan_file.snapshot.content:
                    raise VlibError(
                        "Source changed after planning: {}".format(
                            mapping.plan_file.relative_path
                        )
                    )
                staged.append((mapping, None))
                continue
            mapping.destination_path.parent.mkdir(
                parents=True, exist_ok=True
            )
            staging_path = _temporary_sibling(
                mapping.destination_path, "stage"
            )
            staging_paths.append(staging_path)
            _write_staged_snapshot(
                mapping.plan_file.snapshot.content, staging_path
            )
            _apply_snapshot_metadata(
                mapping.plan_file.snapshot, staging_path
            )
            staged.append((mapping, staging_path))
    except Exception:
        _cleanup_temporary_paths(staging_paths)
        raise
    return staged


def _commit_staged_mappings(
    staged: Sequence[Tuple[CopyMapping, Optional[Path]]],
) -> None:
    staging_paths = [
        staging_path
        for _mapping, staging_path in staged
        if staging_path is not None
    ]
    backup_paths = []  # type: List[Path]
    applied = []  # type: List[Tuple[Path, Optional[Path], bool]]
    try:
        for mapping, staging_path in staged:
            if staging_path is None:
                continue
            destination_path = mapping.destination_path
            backup_path = None  # type: Optional[Path]
            if destination_path.exists():
                backup_path = _temporary_sibling(
                    destination_path, "backup"
                )
                backup_paths.append(backup_path)
                os.replace(str(destination_path), str(backup_path))
            applied.append((destination_path, backup_path, False))
            os.replace(str(staging_path), str(destination_path))
            applied[-1] = (destination_path, backup_path, True)
    except Exception as copy_error:
        rollback_errors = []  # type: List[OSError]
        for destination_path, backup_path, installed in reversed(applied):
            try:
                if backup_path is not None:
                    os.replace(str(backup_path), str(destination_path))
                elif installed:
                    _unlink_if_present(destination_path)
            except OSError as rollback_error:
                rollback_errors.append(rollback_error)
        _cleanup_temporary_paths(staging_paths)
        if not rollback_errors:
            _cleanup_temporary_paths(backup_paths)
            raise
        raise VlibError(
            "Copy failed: {}; rollback failed: {}".format(
                copy_error, rollback_errors[0]
            )
        ) from copy_error
    _cleanup_temporary_paths(staging_paths)
    _cleanup_temporary_paths(backup_paths)


def copy_command(arguments: argparse.Namespace) -> int:
    index = load_index()
    copy_files, missing_modules, missing_includes = build_copy_plan(
        arguments.module, index, arguments.with_deps
    )
    destination_root = Path(arguments.destination).expanduser().resolve()
    copy_mappings = _preflight_copy_targets(copy_files, destination_root)
    staged_mappings = _stage_copy_mappings(copy_mappings)
    _commit_staged_mappings(staged_mappings)

    for mapping in copy_mappings:
        print("Copied: {}".format(mapping.plan_file.relative_path))

    for missing_module in missing_modules:
        print("Missing module: {}".format(missing_module), file=sys.stderr)
    for include_name, including_relative in missing_includes:
        print(
            "Missing include: {} from {}".format(
                include_name, including_relative
            ),
            file=sys.stderr,
        )
    return 1 if missing_modules or missing_includes else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage a standalone Verilog module library."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    index_parser = subparsers.add_parser(
        "index", help="scan the repository and rebuild the module index"
    )
    index_parser.set_defaults(handler=index_command)
    show_parser = subparsers.add_parser(
        "show", help="show parameters and ports for an indexed module"
    )
    show_parser.add_argument("module", help="module name to inspect")
    show_parser.set_defaults(handler=show_command)
    deps_parser = subparsers.add_parser(
        "deps", help="show transitive dependencies for an indexed module"
    )
    deps_parser.add_argument("module", help="module name to resolve")
    deps_parser.set_defaults(handler=deps_command)
    list_parser = subparsers.add_parser(
        "list", help="list indexed modules"
    )
    list_parser.set_defaults(handler=list_command)
    copy_parser = subparsers.add_parser(
        "copy", help="copy an indexed module into a destination directory"
    )
    copy_parser.add_argument("module", help="module name to copy")
    copy_parser.add_argument(
        "destination", help="directory that receives repository-relative files"
    )
    copy_parser.add_argument(
        "--with-deps",
        action="store_true",
        help="also copy transitive dependencies and included files",
    )
    copy_parser.set_defaults(handler=copy_command)
    status_parser = subparsers.add_parser(
        "status",
        help="report whether the module index matches the repository",
    )
    status_parser.set_defaults(handler=status_command)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        return arguments.handler(arguments)
    except (OSError, VlibError) as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
