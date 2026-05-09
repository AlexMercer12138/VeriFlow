# -*- coding: utf-8 -*-
"""
工程管理服务 — 工程的创建、打开、保存
"""

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

        for name, config in DEFAULT_SIMULATORS.items():
            if name not in project.simulators:
                project.simulators[name] = config
        for name, config in DEFAULT_VIEWERS.items():
            if name not in project.wave_viewers:
                project.wave_viewers[name] = config

        return project

    def save(self, project: Project, filepath: Path) -> None:
        self._config.save(filepath, project.to_dict())

    def update_config(self, project: Project, **kwargs) -> Project:
        for key, value in kwargs.items():
            if hasattr(project, key):
                setattr(project, key, value)
        return project
