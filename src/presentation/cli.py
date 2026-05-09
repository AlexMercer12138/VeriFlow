# -*- coding: utf-8 -*-
"""
轻量级 Verilog 仿真管理器 — CLI 入口

Usage:
    python -m src.presentation.cli --project config/project.json
    python -m src.presentation.cli --root ./rtl --top top_tb --sim
    python -m src.presentation.cli --root ./rtl --top top_tb --analyze
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.application.coordinator import ApplicationCoordinator


def cmd_analyze(args):
    """分析依赖"""
    app = ApplicationCoordinator()
    lib_dirs = args.lib_dir.split(',') if args.lib_dir else []
    result = app.analyze_dependencies(args.top, args.root, lib_dirs)

    print(f"Top module: {result.top_module}")
    print(f"Files ({len(result.files)}):")
    for f in result.get_compile_order():
        print(f"  {f}")
    if result.missing_modules:
        print(f"Missing modules: {', '.join(result.missing_modules)}")
    return result.success


def cmd_simulate(args):
    """一键仿真"""
    app = ApplicationCoordinator()

    if args.project:
        project = app.open_project(args.project)
    else:
        project = app.create_project(
            args.name or 'cli_project',
            args.root or '.'
        )
        project.top_module = args.top
        if args.lib_dir:
            project.lib_dirs = [Path(d) for d in args.lib_dir.split(',')]
        project.simulator = args.simulator
        project.wave_viewer = args.wave_viewer

    print(f"Project: {project.name}")
    print(f"Top: {project.top_module}")
    print(f"Simulator: {project.simulator}, Viewer: {project.wave_viewer}")

    result = app.simulate(project)

    if result.success:
        print(f"Simulation OK ({result.elapsed_time:.2f}s)")
    else:
        print(f"Simulation FAILED (exit={result.exit_code})")
        for entry in result.get_errors():
            loc = f"{entry.file_ref}:{entry.line_no}" if entry.file_ref else ""
            print(f"  [{entry.level}] {loc} {entry.message}")

    return result.success


def cmd_new(args):
    """创建新工程"""
    app = ApplicationCoordinator()
    project = app.create_project(args.name, args.root or '.')
    project.top_module = args.top or ''
    if args.lib_dir:
        project.lib_dirs = [Path(d) for d in args.lib_dir.split(',')]
    project.simulator = args.simulator
    project.wave_viewer = args.wave_viewer

    out_path = Path(args.output) if args.output else Path(f"{project.name}.json")
    app.save_project(project, str(out_path))
    print(f"Project saved to: {out_path}")
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Verilog 轻量仿真管理器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--root', '-r', help='工程根目录')
    parser.add_argument('--top', '-t', help='顶层模块名')
    parser.add_argument('--lib-dir', '-L', help='库目录（逗号分隔）')
    parser.add_argument('--project', '-p', help='工程 JSON 文件路径')
    parser.add_argument('--name', '-n', default='my_project', help='工程名称')
    parser.add_argument('--simulator', '-s', default='iverilog', help='仿真器')
    parser.add_argument('--wave-viewer', '-w', default='surfer', help='波形查看器')

    sub = parser.add_subparsers(dest='command')

    p_analyze = sub.add_parser('analyze', help='分析模块依赖')
    p_analyze.set_defaults(func=cmd_analyze)

    p_sim = sub.add_parser('simulate', help='一键仿真')
    p_sim.set_defaults(func=cmd_simulate)

    p_new = sub.add_parser('new', help='创建新工程文件')
    p_new.add_argument('--output', '-o', help='输出 JSON 文件路径')
    p_new.set_defaults(func=cmd_new)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    success = args.func(args)
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
