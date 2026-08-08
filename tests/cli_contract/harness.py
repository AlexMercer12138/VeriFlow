from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

from src.infrastructure.process_manager import ProcessManager
from src.presentation.cli import main as cli_main
import src.infrastructure.global_config_service as global_config_service


FIXTURE_ROOT = Path(__file__).parent / "fixtures"


def load_contract(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _replace_tokens(value: Any, tokens: dict[str, str]) -> Any:
    if isinstance(value, str):
        for token, replacement in tokens.items():
            value = value.replace(token, replacement)
        return value
    if isinstance(value, list):
        return [_replace_tokens(item, tokens) for item in value]
    if isinstance(value, dict):
        return {key: _replace_tokens(item, tokens) for key, item in value.items()}
    return value


def _normalize(value: Any, replacements: list[tuple[str, str]]) -> Any:
    if isinstance(value, str):
        for source, replacement in replacements:
            value = value.replace(source, replacement)
            value = value.replace(source.replace("/", "\\"), replacement)
        return value.replace("\\", "/")
    if isinstance(value, list):
        return [_normalize(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _normalize(item, replacements) for key, item in value.items()}
    return value


def _write_initial_files(
    case_root: Path,
    files: list[dict[str, Any]],
    tokens: dict[str, str],
) -> None:
    for entry in files:
        destination = case_root / entry["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        if "fixture" in entry:
            shutil.copyfile(FIXTURE_ROOT / entry["fixture"], destination)
        elif "json" in entry:
            value = _replace_tokens(entry["json"], tokens)
            destination.write_text(
                json.dumps(value, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        else:
            destination.write_text(
                _replace_tokens(entry.get("content", ""), tokens),
                encoding="utf-8",
            )
        if "mode" in entry and os.name != "nt":
            destination.chmod(int(entry["mode"], 8))


def _observed_json(case_root: Path, paths: list[str]) -> dict[str, Any]:
    observed: dict[str, Any] = {}
    for relative in paths:
        path = case_root / relative
        observed[relative] = (
            json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        )
    return observed


def capture_case(case: dict[str, Any], case_root: Path) -> dict[str, Any]:
    case_root = case_root.resolve()
    cwd = case_root / case.get("cwd", "workspace")
    home = case_root / "home"
    cwd.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    tokens = {
        "<CASE_ROOT>": str(case_root),
        "<CWD>": str(cwd),
        "<HOME>": str(home),
        "<PYTHON>": sys.executable,
    }
    _write_initial_files(case_root, case.get("initial_files", []), tokens)

    process_results = list(case.get("process_results", []))
    process_calls: list[dict[str, Any]] = []
    popen_calls: list[dict[str, Any]] = []

    def fake_run(
        cmd: str,
        cwd: Path | None = None,
        timeout: float | None = 300.0,
    ) -> tuple[int, str, str, float]:
        process_calls.append({
            "cmd": cmd,
            "cwd": str(cwd) if cwd else None,
            "timeout": timeout,
        })
        if not process_results:
            raise AssertionError(f"Unexpected process invocation: {cmd}")
        result = process_results.pop(0)
        return (
            result["exit_code"],
            result.get("stdout", ""),
            result.get("stderr", ""),
            result.get("elapsed", 0.0),
        )

    class FakeProcess:
        pass

    def fake_popen(cmd: str, *, shell: bool = False, **kwargs: Any) -> FakeProcess:
        popen_calls.append({"cmd": cmd, "shell": shell, "kwargs": kwargs})
        return FakeProcess()

    stdout = io.StringIO()
    stderr = io.StringIO()
    old_cwd = Path.cwd()
    old_argv = sys.argv
    old_home = os.environ.get("HOME")
    old_userprofile = os.environ.get("USERPROFILE")
    old_columns = os.environ.get("COLUMNS")
    old_config_path = global_config_service.GLOBAL_CONFIG_PATH
    old_run = ProcessManager.__dict__["run"]
    old_popen = subprocess.Popen
    exit_code: Any = 0
    try:
        os.chdir(cwd)
        os.environ["HOME"] = str(home)
        os.environ["USERPROFILE"] = str(home)
        os.environ["COLUMNS"] = "80"
        global_config_service.GLOBAL_CONFIG_PATH = home / ".veriflow_config.json"
        ProcessManager.run = staticmethod(fake_run)
        subprocess.Popen = fake_popen
        sys.argv = ["veriflow", *_replace_tokens(case["argv"], tokens)]
        with redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                result = cli_main()
                exit_code = 0 if result is None else result
            except SystemExit as error:
                exit_code = error.code if isinstance(error.code, int) else 1
    finally:
        sys.argv = old_argv
        ProcessManager.run = old_run
        subprocess.Popen = old_popen
        global_config_service.GLOBAL_CONFIG_PATH = old_config_path
        os.chdir(old_cwd)
        if old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = old_home
        if old_userprofile is None:
            os.environ.pop("USERPROFILE", None)
        else:
            os.environ["USERPROFILE"] = old_userprofile
        if old_columns is None:
            os.environ.pop("COLUMNS", None)
        else:
            os.environ["COLUMNS"] = old_columns

    replacements = sorted([
        (sys.executable, "<PYTHON>"),
        (str(cwd), "<CWD>"),
        (str(home), "<HOME>"),
        (str(case_root), "<CASE_ROOT>"),
    ], key=lambda item: len(item[0]), reverse=True)
    captured = {
        "exit_code": exit_code,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "observed_json": _observed_json(case_root, case.get("observe_json", [])),
        "process_calls": process_calls,
        "popen_calls": popen_calls,
    }
    if process_results:
        captured["unused_process_results"] = len(process_results)
    return _normalize(captured, replacements)
