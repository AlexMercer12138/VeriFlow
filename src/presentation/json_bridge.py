# -*- coding: utf-8 -*-
"""
VS Code Extension JSON Bridge
供 VS Code 扩展调用的 JSON 接口，不使用工程文件，以工作区目录为根

Usage:
    python -m src.presentation.json_bridge scan --root /path/to/workspace [--libs lib1,lib2]
    python -m src.presentation.json_bridge analyze --root /path/to/workspace --top top_tb [--libs lib1,lib2]
    python -m src.presentation.json_bridge simulate --root /path/to/workspace --top top_tb
        --simulator iverilog [--libs lib1,lib2] [--wave-viewer surfer]
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.application.coordinator import ApplicationCoordinator
from src.infrastructure.file_service import FileService
from src.domain.models.project import Project, SimulatorConfig, WaveViewerConfig
from src.domain.services.sim_runner_service import SimRunnerService
from src.domain.services.verilog_utils import remove_comments
from src.domain.services.project_manager_service import (
    DEFAULT_SIMULATORS, DEFAULT_VIEWERS,
)


def _create_project(args) -> Project:
    root = Path(args.root).resolve()
    lib_dirs = []
    if args.libs:
        lib_dirs = [Path(d.strip()).resolve() for d in args.libs.split(',') if d.strip()]

    simulators = dict(DEFAULT_SIMULATORS)
    if getattr(args, 'compile_cmd', None) and getattr(args, 'run_cmd', None):
        simulators['custom'] = SimulatorConfig(
            name='custom',
            compile_cmd=args.compile_cmd,
            run_cmd=args.run_cmd,
        )

    wave_viewers = dict(DEFAULT_VIEWERS)
    if getattr(args, 'wave_cmd', None):
        wave_viewers['custom'] = WaveViewerConfig(
            name='custom',
            launch_cmd=args.wave_cmd,
        )

    return Project(
        name=root.name or 'workspace',
        root_dir=root,
        lib_dirs=lib_dirs,
        top_module=args.top or '',
        simulator=args.simulator or 'iverilog',
        wave_viewer=args.wave_viewer or 'surfer',
        simulators=simulators,
        wave_viewers=wave_viewers,
    )


def cmd_scan(args) -> int:
    """扫描所有模块，JSON 输出"""
    root = Path(args.root).resolve()
    file_service = FileService()
    app = ApplicationCoordinator()

    lib_dirs = []
    if args.libs:
        for d in args.libs.split(','):
            d = d.strip()
            if d:
                lib_dirs.append(Path(d).resolve())

    search_dirs = [root] + lib_dirs

    modules_by_dir = {}
    all_modules: dict = {}

    for search_dir in search_dirs:
        if not search_dir.exists():
            continue
        dir_label = str(search_dir)
        dir_modules = {}
        for vfile in file_service.list_files(str(search_dir)):
            try:
                content = file_service.read_text(str(vfile))
            except Exception:
                continue
            import re
            content = remove_comments(content)
            for match in re.finditer(r'\bmodule\s+(\w+)', content):
                mod_name = match.group(1)
                if mod_name not in all_modules:
                    all_modules[mod_name] = str(vfile)
                dir_modules[mod_name] = str(vfile.resolve())
        if dir_modules:
            modules_by_dir[dir_label] = dir_modules

    result = {
        'root': str(root),
        'lib_dirs': [str(d) for d in lib_dirs],
        'total_modules': len(all_modules),
        'modules': sorted(all_modules.keys()),
        'modules_by_dir': {
            label: sorted(mods.keys())
            for label, mods in modules_by_dir.items()
        },
        'module_files': {
            name: str(fp) for name, fp in all_modules.items()
        },
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_analyze(args) -> int:
    """分析依赖，JSON 输出"""
    if not args.top:
        result = {'success': False, 'error': 'No top module specified'}
        print(json.dumps(result, ensure_ascii=False))
        return 1

    root = Path(args.root).resolve()
    app = ApplicationCoordinator()

    lib_dirs = []
    if args.libs:
        lib_dirs = [d.strip() for d in args.libs.split(',') if d.strip()]

    dep_result = app.analyze_dependencies(args.top, str(root), lib_dirs)

    result = {
        'success': dep_result.success,
        'top_module': dep_result.top_module,
        'file_count': len(dep_result.files),
        'files': [str(f.resolve()) for f in dep_result.get_compile_order()],
        'missing_modules': dep_result.missing_modules,
        'dep_graph': dep_result.dep_graph,
        'module_map': {k: str(v.resolve()) for k, v in dep_result.module_map.items()},
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if dep_result.success else 1


def cmd_simulate(args) -> int:
    """执行仿真，直接流式输出"""
    if not args.top:
        print('[ERROR] No top module specified', file=sys.stderr)
        return 1

    project = _create_project(args)
    app = ApplicationCoordinator()

    print(f'[INFO] Project: {project.name}')
    print(f'[INFO] Top: {project.top_module}')
    print(f'[INFO] Root: {project.root_dir}')
    print(f'[INFO] Simulator: {project.simulator}')
    sys.stdout.flush()

    search_dirs = [project.root_dir]
    search_dirs.extend(project.lib_dirs)

    dep_result = app.dependency_analyzer.resolve(project.top_module, search_dirs)

    if not dep_result.success:
        print(f'[ERROR] Missing modules: {", ".join(dep_result.missing_modules)}')
        return 1

    print(f'[INFO] Resolved {len(dep_result.files)} file(s)')
    compile_order = dep_result.get_compile_order()
    print(f'[INFO] Compile order:')
    for f in compile_order:
        print(f'[INFO]   {f}')
    sys.stdout.flush()

    simulator_config = project.simulators.get(project.simulator)
    if not simulator_config:
        print(f'[ERROR] Unknown simulator: {project.simulator}')
        return 1

    output = project.root_dir / f'{project.top_module}.out'
    sim_runner = SimRunnerService()

    print(f'[INFO] Compiling...')
    sys.stdout.flush()

    result = sim_runner.compile_and_run(
        compile_order, output, simulator_config,
        cwd=project.root_dir, top_module=project.top_module,
    )

    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    if result.success:
        print(f'[OK] Simulation passed ({result.elapsed_time:.2f}s)')
    else:
        print(f'[FAIL] Simulation failed (exit={result.exit_code})')

    return 0 if result.success else 1


def cmd_open_wave(args) -> int:
    """打开波形"""
    if not args.top:
        print('[ERROR] No top module specified', file=sys.stderr)
        return 1

    project = _create_project(args)
    wave_file = project.resolve_wave_file()

    if not wave_file.exists():
        print(f'[ERROR] Wave file not found: {wave_file}')
        print('[ERROR] Run simulation first to generate waveform')
        return 1

    viewer_config = project.wave_viewers.get(project.wave_viewer)
    if not viewer_config:
        print(f'[ERROR] Unknown wave viewer: {project.wave_viewer}')
        return 1

    sim_runner = SimRunnerService()
    try:
        sim_runner.open_wave(wave_file, viewer_config)
        print(f'[OK] Opened {project.wave_viewer}: {wave_file}')
    except Exception as e:
        print(f'[ERROR] Failed to open {project.wave_viewer}: {e}')
        return 1

    return 0


def main():
    parser = argparse.ArgumentParser(
        description='VeriFlow VS Code JSON Bridge',
    )
    parser.add_argument('--root', '-r', required=True, help='Workspace root directory')
    parser.add_argument('--top', '-t', default='', help='Top module name')
    parser.add_argument('--libs', '-L', default='', help='Library directories (comma-separated)')
    parser.add_argument('--simulator', '-s', default='iverilog', help='Simulator name')
    parser.add_argument('--wave-viewer', '-w', default='surfer', help='Waveform viewer name')
    parser.add_argument('--compile-cmd', default='', help='Custom simulator compile command template')
    parser.add_argument('--run-cmd', default='', help='Custom simulator run command template')
    parser.add_argument('--wave-cmd', default='', help='Custom wave viewer launch command template')

    sub = parser.add_subparsers(dest='command')

    sub.add_parser('scan', help='Scan all modules (JSON output)')
    sub.add_parser('analyze', help='Analyze dependencies (JSON output)')
    sub.add_parser('simulate', help='Run simulation (text output)')
    sub.add_parser('wave', help='Open waveform viewer')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    if args.command == 'scan':
        return cmd_scan(args)
    elif args.command == 'analyze':
        return cmd_analyze(args)
    elif args.command == 'simulate':
        return cmd_simulate(args)
    elif args.command == 'wave':
        return cmd_open_wave(args)
    else:
        parser.print_help()
        return 1


if __name__ == '__main__':
    sys.exit(main())
