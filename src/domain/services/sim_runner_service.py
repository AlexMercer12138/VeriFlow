# -*- coding: utf-8 -*-
"""
仿真运行服务 — 编译/运行/波形三阶段调度
"""

import subprocess
from pathlib import Path
from typing import List

from src.infrastructure.process_manager import ProcessManager
from src.infrastructure.template_engine import TemplateEngine
from src.domain.models.project import SimulatorConfig, WaveViewerConfig
from src.domain.models.simulation import SimulationResult
from src.domain.interfaces.i_sim_runner import ISimulationRunner
from src.domain.services.log_parser_service import LogParserService


class SimRunnerService(ISimulationRunner):
    """仿真运行服务"""

    def __init__(self):
        self._process = ProcessManager()
        self._template = TemplateEngine()
        self._log_parser = LogParserService()
        self._last_compile_cmd = ""
        self._last_run_cmd = ""
        self._last_wave_cmd = ""

    @property
    def last_compile_cmd(self) -> str:
        return self._last_compile_cmd

    @property
    def last_run_cmd(self) -> str:
        return self._last_run_cmd

    @property
    def last_wave_cmd(self) -> str:
        return self._last_wave_cmd

    def _resolve_file_paths(
        self, files: List[Path], cwd: Path
    ) -> List[str]:
        result = []
        for f in files:
            abs_f = f.resolve() if not f.is_absolute() else f
            try:
                rel = abs_f.relative_to(cwd.resolve())
                result.append(str(rel))
            except ValueError:
                result.append(str(abs_f))
        return result

    def compile(
        self,
        files: List[Path],
        output: Path,
        simulator: SimulatorConfig,
        cwd: Path = None,
        top_module: str = "",
    ) -> SimulationResult:
        cwd = Path(cwd) if cwd else Path.cwd()
        file_args = self._resolve_file_paths(files, cwd)

        out_rel = output
        try:
            out_rel = output.resolve().relative_to(cwd.resolve())
        except ValueError:
            out_rel = output.resolve()

        cmd = self._template.render_compile(
            simulator.compile_cmd,
            output=str(out_rel),
            files=file_args,
            top_module=top_module,
        )
        self._last_compile_cmd = cmd

        returncode, stdout, stderr, elapsed = self._process.run(cmd, cwd=cwd)
        combined = stdout + '\n' + stderr
        log_entries = self._log_parser.parse(combined)
        has_errors = self._log_parser.has_errors(stderr)

        return SimulationResult(
            success=(returncode == 0 and not has_errors),
            exit_code=returncode,
            stdout=stdout,
            stderr=stderr,
            log_entries=log_entries,
            elapsed_time=elapsed,
        )

    def run(
        self,
        output: Path,
        simulator: SimulatorConfig,
        cwd: Path = None,
    ) -> SimulationResult:
        cwd = Path(cwd) if cwd else Path.cwd()
        out_rel = output
        try:
            out_rel = output.resolve().relative_to(cwd.resolve())
        except ValueError:
            out_rel = output.resolve()

        cmd = self._template.render_run(simulator.run_cmd, str(out_rel))
        self._last_run_cmd = cmd

        returncode, stdout, stderr, elapsed = self._process.run(cmd, cwd=cwd)
        combined = stdout + '\n' + stderr
        log_entries = self._log_parser.parse(combined)

        return SimulationResult(
            success=(returncode == 0),
            exit_code=returncode,
            stdout=stdout,
            stderr=stderr,
            log_entries=log_entries,
            elapsed_time=elapsed,
        )

    def compile_and_run(
        self,
        files: List[Path],
        output: Path,
        simulator: SimulatorConfig,
        cwd: Path = None,
        top_module: str = "",
    ) -> SimulationResult:
        compile_result = self.compile(files, output, simulator, cwd=cwd, top_module=top_module)
        if not compile_result.success:
            return compile_result

        run_result = self.run(output, simulator, cwd=cwd)
        run_result.elapsed_time += compile_result.elapsed_time
        run_result.log_entries = compile_result.log_entries + run_result.log_entries
        return run_result

    def open_wave(
        self,
        wave_file: Path,
        viewer: WaveViewerConfig,
    ) -> None:
        cmd = self._template.render_wave(viewer.launch_cmd, str(wave_file))
        self._last_wave_cmd = cmd
        subprocess.Popen(cmd, shell=True)
