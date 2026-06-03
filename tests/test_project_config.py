# -*- coding: utf-8 -*-
import json
from pathlib import Path

from src.application.coordinator import ApplicationCoordinator
from src.domain.models.dependency import DependencyResult
from src.domain.models.project import Project
from src.domain.services.project_manager_service import ProjectManagerService
from src.infrastructure.global_config_service import GlobalConfigService


def test_project_json_open_save_and_relative_paths(
    uart_project_dir: Path,
    tmp_path: Path,
    isolated_global_config: Path,
) -> None:
    app = ApplicationCoordinator()
    project_file = uart_project_dir / "uart_sim.json"

    project = app.open_project(str(project_file))
    assert project.name == "uart_sim"
    assert project.root_dir == uart_project_dir.resolve()
    assert project.top_module == "uart_tb"
    assert project.testbench_output_dir == "."

    project.testbench_output_dir = "generated/tb"
    project.lib_dirs = [uart_project_dir / "libs"]

    saved_file = tmp_path / "configs" / "uart_saved.json"
    app.save_project(project, str(saved_file))
    saved = json.loads(saved_file.read_text(encoding="utf-8"))

    assert saved["project_root"] == "../uart_project"
    assert saved["lib_dirs"] == ["../uart_project/libs"]
    assert saved["testbench_output_dir"] == "generated/tb"

    reopened = app.open_project(str(saved_file))
    assert reopened.root_dir == uart_project_dir.resolve()
    assert reopened.lib_dirs == [(uart_project_dir / "libs").resolve()]
    assert reopened.resolve_testbench_output_dir() == (
        uart_project_dir / "generated" / "tb"
    ).resolve()


def test_old_project_auto_adds_builtin_wave_viewer(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    project_root.mkdir()
    project_file = tmp_path / "legacy.json"
    project_file.write_text(
        json.dumps({
            "project_name": "legacy",
            "project_root": str(project_root),
            "wave_viewer": "surfer",
            "wave_viewers": {
                "surfer": "surfer \"{wave_file}\"",
                "gtkwave": "gtkwave \"{wave_file}\"",
            },
        }),
        encoding="utf-8",
    )

    project = ApplicationCoordinator().open_project(str(project_file))

    assert "builtin" in project.wave_viewers
    assert project.wave_viewers["builtin"].launch_cmd == ""


def test_new_project_uses_builtin_wave_viewer_by_default(tmp_path: Path) -> None:
    project = ProjectManagerService().create("demo", tmp_path)

    assert project.wave_viewer == "builtin"
    assert "builtin" in project.wave_viewers
    assert project.wave_viewers["builtin"].launch_cmd == ""


def test_default_config_uses_builtin_wave_viewer() -> None:
    config = json.loads(
        Path("config/default_config.json").read_text(encoding="utf-8")
    )

    assert config["wave_viewer"] == "builtin"
    assert config["wave_viewers"]["builtin"] == ""


def test_dependency_result_roundtrip(uart_project_dir: Path) -> None:
    result = DependencyResult(
        top_module="uart_tb",
        files=[uart_project_dir / "uart_tb.v"],
        missing_modules=[],
        module_map={"uart_tb": uart_project_dir / "uart_tb.v"},
        dep_graph={"uart_tb": []},
        _topo_file_order=[uart_project_dir / "uart_tb.v"],
    )

    restored = DependencyResult.from_dict(result.to_dict())
    assert restored.top_module == result.top_module
    assert restored.files == result.files
    assert restored.module_map == result.module_map
    assert restored.get_compile_order() == result.get_compile_order()


def test_global_config_is_isolated_and_persistent(isolated_global_config: Path) -> None:
    cfg = GlobalConfigService(isolated_global_config)

    cfg.set_lib_dirs(["/tmp/lib1", "/tmp/lib2"])
    cfg.set_language("en")
    cfg.set_theme("light")

    reopened = GlobalConfigService(isolated_global_config)
    assert reopened.get_lib_dirs() == ["/tmp/lib1", "/tmp/lib2"]
    assert reopened.get_language() == "en"
    assert reopened.get_theme() == "light"


def test_project_model_resolves_absolute_and_relative_testbench_dirs(
    tmp_path: Path,
) -> None:
    project = Project(
        name="demo",
        root_dir=tmp_path / "project",
        testbench_output_dir="sim/tb",
    )
    assert project.resolve_testbench_output_dir() == tmp_path / "project" / "sim" / "tb"

    absolute = tmp_path / "absolute_tb"
    project.testbench_output_dir = str(absolute)
    assert project.resolve_testbench_output_dir() == absolute
