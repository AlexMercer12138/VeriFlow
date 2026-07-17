#!/usr/bin/env python3
"""Standalone Verilog library indexer."""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
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


class VlibError(Exception):
    """An expected command failure that can be shown directly to the user."""


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage a standalone Verilog module library."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    index_parser = subparsers.add_parser(
        "index", help="scan the repository and rebuild the module index"
    )
    index_parser.set_defaults(handler=index_command)
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
