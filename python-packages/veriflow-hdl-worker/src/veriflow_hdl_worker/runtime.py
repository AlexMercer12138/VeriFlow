import importlib.resources
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict


@dataclass(frozen=True)
class RuntimePaths:
    executable: Path
    web_tree_sitter_wasm: Path
    system_verilog_wasm: Path
    manifest: Path


def runtime_paths() -> RuntimePaths:
    try:
        package_root = importlib.resources.files("veriflow_hdl_worker")
    except AttributeError:
        import importlib_resources

        package_root = importlib_resources.files("veriflow_hdl_worker")
    package_bin = package_root.joinpath("bin")
    bin_path = Path(str(package_bin))
    return RuntimePaths(
        executable=bin_path / "parser-worker.exe",
        web_tree_sitter_wasm=bin_path / "web-tree-sitter.wasm",
        system_verilog_wasm=bin_path / "tree-sitter-systemverilog.wasm",
        manifest=bin_path / "manifest.json",
    )


def startup_info() -> Dict[str, int]:
    if os.name != "nt":
        raise RuntimeError("The VeriFlow HDL worker is only available on Windows")
    return {"creationflags": subprocess.CREATE_NO_WINDOW}
