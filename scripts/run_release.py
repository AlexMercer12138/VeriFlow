#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Release helper for VeriFlow.

Examples:
    python scripts/run_release.py --check
    python scripts/run_release.py --update 1.2.0
    python scripts/run_release.py --update
    python scripts/run_release.py --package
    python scripts/run_release.py --all 1.2.0
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Tuple


ROOT = Path(__file__).resolve().parents[1]
PY_VERSION_FILE = ROOT / "src" / "version.py"
PYPROJECT_FILE = ROOT / "pyproject.toml"
VSCODE_PACKAGE_FILE = ROOT / "veriflow-vscode" / "package.json"
VSCODE_DIR = ROOT / "veriflow-vscode"
VSCODE_CHANGELOG_FILE = VSCODE_DIR / "CHANGELOG.md"
CRLF_WARNING_RE = re.compile(
    r"^warning: in the working copy of '.+', LF will be replaced by CRLF the next time Git touches it$"
)


class ReleaseError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[release] {message}", flush=True)


def run(cmd: List[str], cwd: Path = ROOT, suppress_crlf_warnings: bool = False) -> None:
    executable = shutil.which(cmd[0])
    if not executable:
        raise ReleaseError(f"command not found: {cmd[0]}")

    run_cmd = [executable] + cmd[1:]
    display_cmd = cmd[:]
    if Path(cmd[0]).name.lower() in {"git", "git.exe"}:
        run_cmd = [executable, "--no-pager"] + cmd[1:]
        display_cmd = [cmd[0], "--no-pager"] + cmd[1:]

    env = os.environ.copy()
    env.setdefault("GIT_PAGER", "cat")
    env.setdefault("PAGER", "cat")

    log(f"run: {' '.join(display_cmd)}")
    if suppress_crlf_warnings:
        completed = subprocess.run(
            run_cmd,
            cwd=str(cwd),
            shell=False,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if completed.stdout:
            print(completed.stdout, end="")
        if completed.stderr:
            for line in completed.stderr.splitlines(keepends=True):
                if not CRLF_WARNING_RE.match(line.rstrip("\r\n")):
                    print(line, end="", file=sys.stderr)
    else:
        completed = subprocess.run(run_cmd, cwd=str(cwd), shell=False, env=env)
    if completed.returncode != 0:
        raise ReleaseError(f"command failed ({completed.returncode}): {' '.join(display_cmd)}")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def read_versions() -> dict:
    py_version_text = read_text(PY_VERSION_FILE)
    py_version_match = re.search(r'__version__\s*=\s*"([^"]+)"', py_version_text)
    if not py_version_match:
        raise ReleaseError(f"could not read __version__ from {PY_VERSION_FILE}")

    pyproject_text = read_text(PYPROJECT_FILE)
    pyproject_match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject_text, re.MULTILINE)
    if not pyproject_match:
        raise ReleaseError(f"could not read project.version from {PYPROJECT_FILE}")

    package_json = json.loads(read_text(VSCODE_PACKAGE_FILE))
    package_version = package_json.get("version")
    if not isinstance(package_version, str):
        raise ReleaseError(f"could not read version from {VSCODE_PACKAGE_FILE}")

    return {
        "src/version.py": py_version_match.group(1),
        "pyproject.toml": pyproject_match.group(1),
        "veriflow-vscode/package.json": package_version,
    }


def parse_version(version: str) -> Tuple[int, int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version.strip())
    if not match:
        raise ReleaseError(f"version must use MAJOR.MINOR.PATCH, got: {version!r}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def next_patch_version(current: str) -> str:
    major, minor, patch = parse_version(current)
    return f"{major}.{minor}.{patch + 1}"


def ensure_versions_match() -> str:
    versions = read_versions()
    unique = set(versions.values())
    if len(unique) != 1:
        details = "\n".join(f"  {name}: {version}" for name, version in versions.items())
        raise ReleaseError(f"version mismatch:\n{details}")
    version = unique.pop()
    log(f"version: {version}")
    return version


def ensure_changelog_has_version(version: str) -> None:
    if not VSCODE_CHANGELOG_FILE.exists():
        raise ReleaseError(f"missing VS Code changelog: {VSCODE_CHANGELOG_FILE}")

    changelog = read_text(VSCODE_CHANGELOG_FILE)
    heading = re.compile(rf"^##\s+\[{re.escape(version)}\](?:\s+-\s+.*)?\s*$", re.MULTILINE)
    if not heading.search(changelog):
        raise ReleaseError(
            f"missing changelog heading for version {version} in {VSCODE_CHANGELOG_FILE}"
        )

    log(f"changelog heading found: {version}")


def update_version(target_version: Optional[str]) -> str:
    current = ensure_versions_match()
    new_version = target_version or next_patch_version(current)
    parse_version(new_version)

    log(f"update version: {current} -> {new_version}")

    py_version_text = read_text(PY_VERSION_FILE)
    py_version_text = re.sub(
        r'__version__\s*=\s*"[^"]+"',
        f'__version__ = "{new_version}"',
        py_version_text,
        count=1,
    )
    write_text(PY_VERSION_FILE, py_version_text)

    pyproject_text = read_text(PYPROJECT_FILE)
    pyproject_text = re.sub(
        r'^version\s*=\s*"[^"]+"',
        f'version = "{new_version}"',
        pyproject_text,
        count=1,
        flags=re.MULTILINE,
    )
    write_text(PYPROJECT_FILE, pyproject_text)

    package_json = json.loads(read_text(VSCODE_PACKAGE_FILE))
    package_json["version"] = new_version
    write_text(VSCODE_PACKAGE_FILE, json.dumps(package_json, indent=2, ensure_ascii=False) + "\n")

    return new_version


def release_check() -> None:
    version = ensure_versions_match()
    ensure_changelog_has_version(version)
    run([sys.executable, "-m", "pytest"])
    run(["npm", "test"], cwd=VSCODE_DIR)
    run(["git", "diff", "--check"], suppress_crlf_warnings=True)
    run(["git", "status", "--short", "--branch"])


def package_release() -> None:
    ensure_versions_match()
    run(["pyinstaller", "VeriFlow.spec", "--noconfirm"])
    run(["pyinstaller", "VeriFlow-cli.spec", "--noconfirm"])
    run(
        ["npm", "run", "package", "--workspace", "veriflow-vscode"],
        cwd=ROOT,
    )


def selected_actions(args: argparse.Namespace) -> List[str]:
    actions = []
    if args.all:
        return ["update", "check", "package"]
    if args.update is not None:
        actions.append("update")
    if args.check:
        actions.append("check")
    if args.package:
        actions.append("package")
    return actions


def normalize_update_version(args: argparse.Namespace) -> Optional[str]:
    if args.all:
        return args.all_version
    if args.update is None:
        return None
    return args.update


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run VeriFlow release tasks.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "-c", "--check",
        action="store_true",
        help="run release checks: version consistency, Python tests, VS Code tests, diff check, git status",
    )
    parser.add_argument(
        "-u", "--update",
        nargs="?",
        const="",
        metavar="VERSION",
        help="update all project versions. If VERSION is omitted, increment PATCH",
    )
    parser.add_argument(
        "-p", "--package",
        action="store_true",
        help="build Python GUI/CLI executables and VS Code VSIX package",
    )
    parser.add_argument(
        "-a", "--all",
        nargs="?",
        const="",
        dest="all_version",
        metavar="VERSION",
        help="run update -> check -> package. If VERSION is omitted, increment PATCH",
    )
    return parser


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    args.all = args.all_version is not None

    actions = selected_actions(args)
    if not actions:
        parser.print_help()
        return 1

    target_version = normalize_update_version(args)
    if target_version == "":
        target_version = None

    try:
        for action in actions:
            if action == "update":
                update_version(target_version)
            elif action == "check":
                release_check()
            elif action == "package":
                package_release()
        log("done")
        return 0
    except ReleaseError as exc:
        print(f"[release] ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
