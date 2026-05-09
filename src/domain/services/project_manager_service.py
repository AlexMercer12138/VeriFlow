# -*- coding: utf-8 -*-
"""
工程管理服务 — 工程的创建、打开、保存
保存时根目录自动转为相对于 JSON 文件的相对路径，迁移工程时无需修改
"""

import os
from pathlib import Path
from typing import Optional

from src.infrastructure.config_service import ConfigService
from src.domain.models.project import Project, SimulatorConfig, WaveViewerConfig
from src.domain.interfaces.i_project_manager import IProjectManager


DEFAULT_SIMULATORS = {
    'iverilog': SimulatorConfig(
        name='iverilog',
        compile_cmd='iverilog -o "{output}" {files}',
        run_cmd='vvp "{output}"',
    ),
    'vcs': SimulatorConfig(
        name='vcs',
        compile_cmd='vcs -full64 -o "{output}" {files}',
        run_cmd='./"{output}"',
    ),
    'xsim': SimulatorConfig(
        name='xsim',
        compile_cmd='xvlog {files} && xelab {top_module} -snapshot "{output}"',
        run_cmd='xsim "{output}" --runall',
    ),
    'custom': SimulatorConfig(
        name='custom',
        compile_cmd='',
        run_cmd='',
    ),
}

DEFAULT_VIEWERS = {
    'surfer': WaveViewerConfig(
        name='surfer',
        launch_cmd='surfer "{wave_file}"',
    ),
    'gtkwave': WaveViewerConfig(
        name='gtkwave',
        launch_cmd='gtkwave "{wave_file}"',
    ),
    'custom': WaveViewerConfig(
        name='custom',
        launch_cmd='',
    ),
}


def _rel_path(abs_path: Path, base: Path) -> str:
    try:
        rel = os.path.relpath(str(abs_path), str(base))
        return rel.replace('\\', '/') if rel != '.' else '.'
    except ValueError:
        return str(abs_path)


def _abs_path(path_str: str, base: Path) -> Path:
    p = Path(path_str)
    if p.is_absolute():
        return p
    return (base / p).resolve()


class ProjectManagerService(IProjectManager):
    """工程管理器服务"""

    def __init__(self, config_service: Optional[ConfigService] = None):
        self._config = config_service or ConfigService()

    def create(self, name: str, root_dir: Path) -> Project:
        return Project(
            name=name,
            root_dir=root_dir,
            simulators=dict(DEFAULT_SIMULATORS),
            wave_viewers=dict(DEFAULT_VIEWERS),
        )

    def open(self, project_file: Path) -> Project:
        data = self._config.load(project_file)
        project = Project.from_dict(data)

        config_dir = project_file.parent.resolve()
        project.root_dir = _abs_path(str(data.get('project_root', '.')), config_dir)
        project.lib_dirs = [
            _abs_path(str(d), config_dir) for d in data.get('lib_dirs', [])
        ]

        for name, config in DEFAULT_SIMULATORS.items():
            if name not in project.simulators:
                project.simulators[name] = config
        for name, config in DEFAULT_VIEWERS.items():
            if name not in project.wave_viewers:
                project.wave_viewers[name] = config

        return project

    def save(self, project: Project, filepath: Path) -> None:
        config_dir = filepath.parent.resolve()
        data = project.to_dict()
        data['project_root'] = _rel_path(project.root_dir, config_dir)
        data['lib_dirs'] = [_rel_path(d, config_dir) for d in project.lib_dirs]
        self._config.save(filepath, data)

    def update_config(self, project: Project, **kwargs) -> Project:
        for key, value in kwargs.items():
            if hasattr(project, key):
                setattr(project, key, value)
        return project
