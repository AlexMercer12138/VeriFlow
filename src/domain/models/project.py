# -*- coding: utf-8 -*-
"""
工程相关领域模型
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Dict


@dataclass
class SimulatorConfig:
    """仿真器配置"""
    name: str
    compile_cmd: str
    run_cmd: str

    def to_dict(self) -> dict:
        return {
            'compile_cmd': self.compile_cmd,
            'run_cmd': self.run_cmd,
        }

    @classmethod
    def from_dict(cls, name: str, data: dict) -> 'SimulatorConfig':
        return cls(
            name=name,
            compile_cmd=data['compile_cmd'],
            run_cmd=data['run_cmd'],
        )


@dataclass
class WaveViewerConfig:
    """波形查看器配置"""
    name: str
    launch_cmd: str

    @classmethod
    def from_dict(cls, name: str, data: dict) -> 'WaveViewerConfig':
        return cls(name=name, launch_cmd=data['launch_cmd'])


@dataclass
class Project:
    """仿真工程模型"""
    name: str
    root_dir: Path
    lib_dirs: List[Path] = field(default_factory=list)
    top_module: str = ""
    simulator: str = "iverilog"
    wave_viewer: str = "surfer"
    wave_file_template: str = "{top_module}.vcd"
    source_files: List[Path] = field(default_factory=list)
    file_order: List[Path] = field(default_factory=list)
    simulators: Dict[str, SimulatorConfig] = field(default_factory=dict)
    wave_viewers: Dict[str, WaveViewerConfig] = field(default_factory=dict)

    def resolve_wave_file(self) -> Path:
        """根据模板解析波形文件路径"""
        path = self.wave_file_template.replace('{top_module}', self.top_module)
        return self.root_dir / path

    def to_dict(self) -> dict:
        return {
            'project_name': self.name,
            'project_root': str(self.root_dir),
            'lib_dirs': [str(d) for d in self.lib_dirs],
            'top_module': self.top_module,
            'simulator': self.simulator,
            'wave_viewer': self.wave_viewer,
            'wave_file_template': self.wave_file_template,
            'simulators': {
                k: v.to_dict() for k, v in self.simulators.items()
            },
            'wave_viewers': {
                k: v.launch_cmd for k, v in self.wave_viewers.items()
            },
            'file_order': [str(f) for f in self.file_order],
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'Project':
        simulators = {
            k: SimulatorConfig.from_dict(k, v)
            for k, v in data.get('simulators', {}).items()
        }
        wave_viewers = {
            k: WaveViewerConfig.from_dict(k, {'launch_cmd': v} if isinstance(v, str) else v)
            for k, v in data.get('wave_viewers', {}).items()
        }
        return cls(
            name=data.get('project_name', 'untitled'),
            root_dir=Path(data.get('project_root', '.')),
            lib_dirs=[Path(d) for d in data.get('lib_dirs', [])],
            top_module=data.get('top_module', ''),
            simulator=data.get('simulator', 'iverilog'),
            wave_viewer=data.get('wave_viewer', 'surfer'),
            wave_file_template=data.get('wave_file_template', '{top_module}.vcd'),
            simulators=simulators,
            wave_viewers=wave_viewers,
            file_order=[Path(f) for f in data.get('file_order', [])],
        )
