# -*- coding: utf-8 -*-
"""
仿真运行器接口
"""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import List

from ..models.project import SimulatorConfig, WaveViewerConfig
from ..models.simulation import SimulationResult


class ISimulationRunner(ABC):
    """仿真运行器接口"""

    @abstractmethod
    def compile(
        self,
        files: List[Path],
        output: Path,
        simulator: SimulatorConfig,
        cwd: Path = None,
    ) -> SimulationResult:
        pass

    @abstractmethod
    def run(
        self,
        output: Path,
        simulator: SimulatorConfig,
        cwd: Path = None,
    ) -> SimulationResult:
        pass

    @abstractmethod
    def compile_and_run(
        self,
        files: List[Path],
        output: Path,
        simulator: SimulatorConfig,
        cwd: Path = None,
    ) -> SimulationResult:
        pass

    @abstractmethod
    def open_wave(
        self,
        wave_file: Path,
        viewer: WaveViewerConfig,
    ) -> None:
        pass
