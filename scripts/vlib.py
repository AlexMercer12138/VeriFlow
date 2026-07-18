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
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Sequence, Tuple


REPOSITORY_ROOT = Path(r"D:\Software\VeriFlow")
INDEX_FILE = REPOSITORY_ROOT / ".verilog_module_index.json"
SCHEMA_VERSION = 1

MODULE_DECLARATION = re.compile(
    r"^[ \t]*module\s+(?:(?:automatic|static)\s+)?"
    r"([A-Za-z_][A-Za-z0-9_$]*)\b",
    re.MULTILINE,
)
DIRECTION = re.compile(r"^(input|output|inout)\b")
IDENTIFIER_AT_END = re.compile(
    r"([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\[[^\]]*\]\s*)*$"
)


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
            and not (before.isalnum() or before in identifier_characters)
            and not (after.isalnum() or after in identifier_characters)
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
        blocks.append(ModuleBlock(name, parameters, ports))
        cursor = endmodule_start + len("endmodule")

    return tuple(blocks)


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
