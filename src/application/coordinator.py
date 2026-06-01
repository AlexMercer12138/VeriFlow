# -*- coding: utf-8 -*-
"""
应用协调器 — 门面模式，统一调度各领域服务
"""

import re
from collections import defaultdict
from pathlib import Path
from typing import List, Optional, Dict

from src.infrastructure.file_service import FileService
from src.infrastructure.config_service import ConfigService
from src.infrastructure.global_config_service import GlobalConfigService
from src.domain.models.project import Project
from src.domain.models.dependency import DependencyResult
from src.domain.models.simulation import SimulationResult, LogEntry
from src.domain.services.dep_analyzer_service import DependencyAnalyzerService
from src.domain.services.sim_runner_service import SimRunnerService
from src.domain.services.project_manager_service import ProjectManagerService
from src.domain.services.verilog_utils import preprocess_verilog, remove_comments


class ApplicationCoordinator:
    """应用门面协调器"""

    def __init__(self):
        self._file_service = FileService()
        self._config_service = ConfigService()
        self._global_config = GlobalConfigService()
        self._project_mgr = ProjectManagerService(self._config_service)
        self._dep_analyzer = DependencyAnalyzerService(self._file_service)
        self._sim_runner = SimRunnerService()

    @property
    def project_manager(self) -> ProjectManagerService:
        return self._project_mgr

    @property
    def dependency_analyzer(self) -> DependencyAnalyzerService:
        return self._dep_analyzer

    @property
    def sim_runner(self) -> SimRunnerService:
        return self._sim_runner

    @property
    def global_config(self) -> GlobalConfigService:
        return self._global_config

    def create_project(self, name: str, root_dir: str) -> Project:
        return self._project_mgr.create(name, Path(root_dir))

    def open_project(self, filepath: str) -> Project:
        return self._project_mgr.open(Path(filepath))

    def save_project(self, project: Project, filepath: str) -> None:
        self._project_mgr.save(project, Path(filepath))

    def _collect_search_dirs(self, project: Project = None) -> List[Path]:
        """收集所有搜索目录：全局库 + 项目库 + 项目根目录，去重"""
        seen = set()
        dirs = []
        for d in self._global_config.get_lib_dirs():
            p = Path(d).resolve()
            if p.exists() and p not in seen:
                seen.add(p)
                dirs.append(p)
        if project:
            p = project.root_dir.resolve()
            if p.exists() and p not in seen:
                seen.add(p)
                dirs.append(p)
            for d in project.lib_dirs:
                p = Path(d).resolve()
                if p.exists() and p not in seen:
                    seen.add(p)
                    dirs.append(p)
        return dirs

    def _search_dir_labels(self, project: Project = None) -> Dict[Path, str]:
        """返回搜索目录路径到可读标签的映射"""
        labels: Dict[Path, str] = {}
        if project:
            p = project.root_dir.resolve()
            if p.exists():
                labels[p] = "Project Root"
        for d in self._global_config.get_lib_dirs():
            p = Path(d).resolve()
            if p.exists() and p not in labels:
                labels[p] = f"Global: {d}"
        if project:
            for d in project.lib_dirs:
                p = Path(d).resolve()
                if p.exists() and p not in labels:
                    labels[p] = f"Project: {d}"
        return labels

    def scan_modules_categorized(
        self,
        project: Project = None,
    ) -> Dict[str, Dict[str, Path]]:
        """按库源目录分类扫描所有模块

        Returns:
            {library_label: {module_name: filepath}}
        """
        dir_labels = self._search_dir_labels(project)
        if not dir_labels:
            return {}

        categorized: Dict[str, Dict[str, Path]] = defaultdict(dict)
        seen_modules: Dict[str, Path] = {}

        for search_dir, label in dir_labels.items():
            for vfile in self._file_service.list_files(str(search_dir)):
                try:
                    content = self._file_service.read_text(str(vfile))
                except Exception:
                    continue
                content = preprocess_verilog(remove_comments(content))
                for match in re.finditer(r'\bmodule\s+(\w+)', content):
                    mod_name = match.group(1)
                    if mod_name not in seen_modules:
                        seen_modules[mod_name] = vfile
                        categorized[label][mod_name] = vfile

        return dict(categorized)

    def get_project_root_modules(
        self,
        project: Project = None,
    ) -> Dict[str, Path]:
        """仅返回项目根目录下的模块"""
        if not project:
            return {}
        root = project.root_dir.resolve()
        if not root.exists():
            return {}
        result: Dict[str, Path] = {}
        for vfile in self._file_service.list_files(str(root)):
            try:
                content = self._file_service.read_text(str(vfile))
            except Exception:
                continue
            content = preprocess_verilog(remove_comments(content))
            for match in re.finditer(r'\bmodule\s+(\w+)', content):
                result[match.group(1)] = vfile
        return result

    def scan_all_modules(
        self,
        project: Project = None,
    ) -> Dict[str, Path]:
        """扫描所有模块，检测重名"""
        search_dirs = self._collect_search_dirs(project)
        if not search_dirs:
            return {}

        index: Dict[str, Path] = {}
        duplicates: Dict[str, List[Path]] = defaultdict(list)

        for search_dir in search_dirs:
            for vfile in self._file_service.list_files(str(search_dir)):
                try:
                    content = self._file_service.read_text(str(vfile))
                except Exception:
                    continue

                content = preprocess_verilog(remove_comments(content))
                for match in re.finditer(r'\bmodule\s+(\w+)', content):
                    mod_name = match.group(1)
                    if mod_name in index:
                        duplicates[mod_name].append(vfile)
                        if index[mod_name] not in duplicates[mod_name]:
                            duplicates[mod_name].insert(0, index[mod_name])
                    else:
                        index[mod_name] = vfile

        for name, files in duplicates.items():
            index[f"{name}"] = files[0]

        return index

    def get_duplicate_modules(
        self,
        project: Project = None,
    ) -> Dict[str, List[Path]]:
        """返回重名模块及其所有文件路径（同一文件不视为重名）"""
        search_dirs = self._collect_search_dirs(project)
        if not search_dirs:
            return {}

        all_modules: Dict[str, List[Path]] = defaultdict(list)
        for search_dir in search_dirs:
            for vfile in self._file_service.list_files(str(search_dir)):
                try:
                    content = self._file_service.read_text(str(vfile))
                except Exception:
                    continue
                content = preprocess_verilog(remove_comments(content))
                for match in re.finditer(r'\bmodule\s+(\w+)', content):
                    mod_name = match.group(1)
                    all_modules[mod_name].append(vfile.resolve())

        result = {}
        for mod_name, files in all_modules.items():
            unique = list(dict.fromkeys(files))
            if len(unique) > 1:
                result[mod_name] = unique
        return result

    def get_duplicate_modules_with_lines(
        self,
        project: Project = None,
    ) -> Dict[str, List[dict]]:
        """返回重名模块及其所有文件路径和行号

        Returns:
            {module_name: [{"file": Path, "line": int}, ...]}
        """
        search_dirs = self._collect_search_dirs(project)
        if not search_dirs:
            return {}

        all_modules: Dict[str, List[dict]] = defaultdict(list)
        for search_dir in search_dirs:
            for vfile in self._file_service.list_files(str(search_dir)):
                try:
                    content = self._file_service.read_text(str(vfile))
                except Exception:
                    continue
                content = preprocess_verilog(remove_comments(content))
                for match in re.finditer(r'\bmodule\s+(\w+)', content):
                    mod_name = match.group(1)
                    line_no = content.count('\n', 0, match.start()) + 1
                    all_modules[mod_name].append({
                        "file": vfile.resolve(),
                        "line": line_no,
                    })

        result = {}
        for mod_name, entries in all_modules.items():
            seen_files = set()
            unique_entries = []
            for entry in entries:
                fpath = entry["file"]
                if fpath not in seen_files:
                    seen_files.add(fpath)
                    unique_entries.append(entry)
            if len(unique_entries) > 1:
                result[mod_name] = unique_entries
        return result

    def analyze_dependencies(
        self,
        top_module: str,
        project_root: str,
        lib_dirs: Optional[List[str]] = None,
    ) -> DependencyResult:
        search_dirs = [Path(project_root)]
        for d in self._global_config.get_lib_dirs():
            search_dirs.append(Path(d))
        if lib_dirs:
            search_dirs.extend(Path(d) for d in lib_dirs)
        return self._dep_analyzer.resolve(top_module, search_dirs)

    def simulate(
        self,
        project: Project,
        output_dir: Optional[str] = None,
    ) -> SimulationResult:
        search_dirs = [project.root_dir]
        for d in self._global_config.get_lib_dirs():
            search_dirs.append(Path(d))
        search_dirs.extend(project.lib_dirs)

        dep_result = self._dep_analyzer.resolve(project.top_module, search_dirs)

        if not dep_result.success:
            return SimulationResult(
                success=False,
                exit_code=-1,
                stderr=f"Missing modules: {', '.join(dep_result.missing_modules)}",
                log_entries=[
                    LogEntry('ERROR', f"Module not found: {m}")
                    for m in dep_result.missing_modules
                ],
            )

        cwd = project.root_dir
        out_dir = Path(output_dir) if output_dir else project.root_dir
        output = out_dir / f"{project.top_module}.out"

        simulator_config = project.simulators.get(project.simulator)
        if not simulator_config:
            return SimulationResult(
                success=False,
                exit_code=-1,
                stderr=f"Simulator '{project.simulator}' not configured",
                log_entries=[LogEntry('ERROR', f"Unknown simulator: {project.simulator}")],
            )

        result = self._sim_runner.compile_and_run(
            dep_result.get_compile_order(), output, simulator_config, cwd=cwd,
            top_module=project.top_module,
        )

        result.stdout = (
            f"[CMD] Compile: {self._sim_runner.last_compile_cmd}\n"
            + result.stdout
        )
        if result.success and self._sim_runner.last_run_cmd:
            result.stdout += f"\n[CMD] Run: {self._sim_runner.last_run_cmd}\n"

        return result
