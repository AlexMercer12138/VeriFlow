# -*- coding: utf-8 -*-
"""
VeriFlow CLI - 轻量级 Verilog 仿真管理器

Usage:
    veriflow project new -n my_proj -r ./rtl -t top_module
    veriflow project open -p config.json
    veriflow project show -p config.json

    veriflow lib add -L ./libs
    veriflow lib remove -L ./libs
    veriflow lib list

    veriflow top set -p config.json -t top_module
    veriflow top get -p config.json

    veriflow analyze -p config.json
    veriflow sim -p config.json
    veriflow wave -p config.json
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.application.coordinator import ApplicationCoordinator
from src.version import VERSION


def _print(msg: str = ""):
    print(msg)


def _print_error(msg: str):
    print(f"Error: {msg}", file=sys.stderr)


def cmd_project_new(args):
    app = ApplicationCoordinator()
    project = app.create_project(args.name, args.root or '.')

    if args.top:
        project.top_module = args.top
    if args.lib:
        project.lib_dirs = [Path(d) for d in args.lib.split(',')]
    if args.sim:
        project.simulator = args.sim
    if args.wave:
        project.wave_viewer = args.wave

    out_path = Path(args.output) if args.output else Path(f"{project.name}.json")
    app.save_project(project, str(out_path))
    _print(f"Project created: {out_path}")
    return 0


def cmd_project_open(args):
    try:
        app = ApplicationCoordinator()
        project = app.open_project(args.project)
        _print(f"Project: {project.name}")
        _print(f"Root: {project.root_dir}")
        _print(f"Top: {project.top_module or '(not set)'}")
        _print(f"Simulator: {project.simulator}")
        _print(f"Wave viewer: {project.wave_viewer}")
        _print(f"Lib dirs: {', '.join(str(d) for d in project.lib_dirs) or '(none)'}")
        return 0
    except Exception as e:
        _print_error(str(e))
        return 1


def cmd_project_show(args):
    app = ApplicationCoordinator()
    project = app.open_project(args.project)

    _print(f"=== Project: {project.name} ===")
    _print(f"Root: {project.root_dir}")
    _print(f"Top module: {project.top_module or '(not set)'}")
    _print(f"Simulator: {project.simulator}")
    _print(f"Wave viewer: {project.wave_viewer}")

    global_libs = app.global_config.get_lib_dirs()
    _print(f"\nGlobal lib dirs ({len(global_libs)}):")
    if global_libs:
        for lib in global_libs:
            _print(f"  - {lib}")
    else:
        _print(f"  (none)")

    _print(f"\nProject lib dirs ({len(project.lib_dirs)}):")
    if project.lib_dirs:
        for lib in project.lib_dirs:
            _print(f"  - {lib}")
    else:
        _print(f"  (none)")

    _print(f"\nSearch dirs (all):")
    for search_dir, label in app._search_dir_labels(project).items():
        _print(f"  [{label}] {search_dir}")

    return 0


def cmd_lib_add(args):
    app = ApplicationCoordinator()
    lib_path = Path(args.lib).resolve()

    if not lib_path.exists():
        _print_error(f"Directory not found: {args.lib}")
        return 1

    app.global_config.add_lib_dir(str(lib_path))
    _print(f"Added global lib: {lib_path}")
    return 0


def cmd_lib_remove(args):
    app = ApplicationCoordinator()
    app.global_config.remove_lib_dir(args.lib)
    _print(f"Removed global lib: {args.lib}")
    return 0


def cmd_lib_list(args):
    app = ApplicationCoordinator()
    libs = app.global_config.get_lib_dirs()

    if not libs:
        _print("No global lib dirs configured.")
        return 0

    _print(f"Global lib dirs ({len(libs)}):")
    for lib in libs:
        p = Path(lib)
        exists = "[OK]" if p.exists() else "[--]"
        _print(f"  {exists} {lib}")
    return 0


def cmd_top_set(args):
    app = ApplicationCoordinator()
    project = app.open_project(args.project)

    project.top_module = args.top
    app.save_project(project, args.project)

    _print(f"Top module set to: {args.top}")
    return 0


def cmd_top_get(args):
    app = ApplicationCoordinator()
    project = app.open_project(args.project)

    if project.top_module:
        _print(project.top_module)
    else:
        _print("(not set)")
    return 0


def cmd_analyze(args):
    app = ApplicationCoordinator()

    if args.project:
        project = app.open_project(args.project)

        if args.top:
            project.top_module = args.top
            app.save_project(project, args.project)
        if args.lib:
            project.lib_dirs = [Path(d) for d in args.lib.split(',')]
            app.save_project(project, args.project)
        if args.sim:
            project.simulator = args.sim
            app.save_project(project, args.project)
        if args.wave:
            project.wave_viewer = args.wave
            app.save_project(project, args.project)

        search_dirs = app._collect_search_dirs(project)
        top_module = project.top_module
        root = str(project.root_dir)
    else:
        if not args.top:
            _print_error("Either --project or --top is required")
            return 1
        top_module = args.top
        root = args.root or '.'
        search_dirs = [Path(root)]
        for lib in app.global_config.get_lib_dirs():
            search_dirs.append(Path(lib))
        if args.lib:
            for d in args.lib.split(','):
                search_dirs.append(Path(d))

    if not top_module:
        _print_error("Top module not set. Use --top or set in project file.")
        return 1

    result = app.dependency_analyzer.resolve(top_module, search_dirs)

    _print(f"Top module: {top_module}")
    _print(f"Files ({len(result.files)}):")
    for f in result.get_compile_order():
        _print(f"  {f}")

    if result.missing_modules:
        _print(f"\nMissing modules: {', '.join(result.missing_modules)}")
        return 1

    _print(f"\nAnalysis: OK")
    return 0


def cmd_sim(args):
    app = ApplicationCoordinator()

    if not args.project:
        _print_error("--project is required")
        return 1

    project = app.open_project(args.project)

    if args.top:
        project.top_module = args.top
        app.save_project(project, args.project)
    if args.lib:
        project.lib_dirs = [Path(d) for d in args.lib.split(',')]
        app.save_project(project, args.project)
    if args.sim:
        project.simulator = args.sim
        app.save_project(project, args.project)
    if args.wave:
        project.wave_viewer = args.wave
        app.save_project(project, args.project)

    if not project.top_module:
        _print_error("Top module not set in project.")
        return 1

    _print(f"Simulating: {project.top_module}")
    _print(f"Simulator: {project.simulator}")
    _print(f"Wave viewer: {project.wave_viewer}")

    result = app.simulate(project)

    if result.stdout:
        for line in result.stdout.splitlines():
            if line.strip():
                _print(line)

    if result.stderr and not result.success:
        for line in result.stderr.splitlines():
            if line.strip():
                _print(f"  {line}")

    if result.success:
        _print(f"\nSimulation: OK ({result.elapsed_time:.2f}s)")
        return 0
    else:
        _print(f"\nSimulation: FAILED (exit={result.exit_code})")
        errors = result.get_errors()
        if errors:
            _print("Errors:")
            for entry in errors:
                loc = f"{entry.file_ref}:{entry.line_no}" if entry.file_ref else ""
                _print(f"  [{entry.level}] {loc} {entry.message}")
        return 1


def cmd_wave(args):
    app = ApplicationCoordinator()

    if not args.project:
        _print_error("--project is required")
        return 1

    project = app.open_project(args.project)

    if not project.top_module:
        _print_error("Top module not set in project.")
        return 1

    wave_file = project.resolve_wave_file()

    if not wave_file.exists():
        _print_error(f"Wave file not found: {wave_file}")
        return 1

    viewer_config = project.wave_viewers.get(project.wave_viewer)
    if not viewer_config:
        _print_error(f"Wave viewer '{project.wave_viewer}' not configured")
        return 1

    _print(f"Opening wave file: {wave_file}")
    app.sim_runner.open_wave(wave_file, viewer_config)
    _print(f"Wave viewer launched: {project.wave_viewer}")
    return 0


def main():
    parser = argparse.ArgumentParser(
        prog='veriflow',
        description='VeriFlow - Lightweight Verilog Simulation Manager',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('-v', '--version', action='version', version=f'VeriFlow {VERSION}')

    sub = parser.add_subparsers(dest='command', metavar='COMMAND')

    p_proj = sub.add_parser('project', help='project management')
    p_proj_sub = p_proj.add_subparsers(dest='subcommand', metavar='ACTION')

    p_proj_new = p_proj_sub.add_parser('new', help='create new project (auto-saved)')
    p_proj_new.add_argument('-n', '--name', required=True, help='project name')
    p_proj_new.add_argument('-r', '--root', help='project root directory')
    p_proj_new.add_argument('-t', '--top', help='top module name')
    p_proj_new.add_argument('-L', '--lib', help='lib dirs (comma separated)')
    p_proj_new.add_argument('-s', '--sim', help='simulator (iverilog/vcs/xsim/custom)')
    p_proj_new.add_argument('-w', '--wave', help='wave viewer (builtin/surfer/gtkwave/custom)')
    p_proj_new.add_argument('--output', '-o', help='output JSON file path')
    p_proj_new.set_defaults(func=cmd_project_new)

    p_proj_open = p_proj_sub.add_parser('open', help='open and show project')
    p_proj_open.add_argument('--project', '-p', required=True, help='project JSON file')
    p_proj_open.set_defaults(func=cmd_project_open)

    p_proj_show = p_proj_sub.add_parser('show', help='show project details')
    p_proj_show.add_argument('--project', '-p', required=True, help='project JSON file')
    p_proj_show.set_defaults(func=cmd_project_show)

    p_lib = sub.add_parser('lib', help='global library management')
    p_lib_sub = p_lib.add_subparsers(dest='subcommand', metavar='ACTION')

    p_lib_add = p_lib_sub.add_parser('add', help='add global library')
    p_lib_add.add_argument('-L','--lib', required=True, help='library directory')
    p_lib_add.set_defaults(func=cmd_lib_add)

    p_lib_remove = p_lib_sub.add_parser('remove', help='remove global library')
    p_lib_remove.add_argument('-L','--lib', required=True, help='library directory')
    p_lib_remove.set_defaults(func=cmd_lib_remove)

    p_lib_list = p_lib_sub.add_parser('list', help='list global libraries')
    p_lib_list.set_defaults(func=cmd_lib_list)

    p_top = sub.add_parser('top', help='top module management')
    p_top_sub = p_top.add_subparsers(dest='subcommand', metavar='ACTION')

    p_top_set = p_top_sub.add_parser('set', help='set top module (auto-saved)')
    p_top_set.add_argument('-p', '--project', required=True, help='project JSON file')
    p_top_set.add_argument('-t', '--top', required=True, help='top module name')
    p_top_set.set_defaults(func=cmd_top_set)

    p_top_get = p_top_sub.add_parser('get', help='get current top module')
    p_top_get.add_argument('-p', '--project', required=True, help='project JSON file')
    p_top_get.set_defaults(func=cmd_top_get)

    p_analyze = sub.add_parser('analyze', help='analyze dependencies')
    p_analyze.add_argument('-p', '--project', help='project JSON file')
    p_analyze.add_argument('-t', '--top', help='top module name (auto-saved)')
    p_analyze.add_argument('-r', '--root', help='project root (use with --top)')
    p_analyze.add_argument('-L', '--lib', help='lib dirs (comma separated, auto-saved)')
    p_analyze.add_argument('-s', '--sim', help='simulator (auto-saved)')
    p_analyze.add_argument('-w', '--wave', help='wave viewer (auto-saved)')
    p_analyze.set_defaults(func=cmd_analyze)

    p_sim = sub.add_parser('sim', help='compile and simulate')
    p_sim.add_argument('--project', '-p', required=True, help='project JSON file')
    p_sim.add_argument('--top', '-t', help='top module name (auto-saved)')
    p_sim.add_argument('--lib', '-L', help='lib dirs (comma separated, auto-saved)')
    p_sim.add_argument('--sim', '-s', help='simulator (auto-saved)')
    p_sim.add_argument('--wave', '-w', help='wave viewer (auto-saved)')
    p_sim.set_defaults(func=cmd_sim)

    p_wave = sub.add_parser('wave', help='open waveform viewer')
    p_wave.add_argument('-p', '--project', required=True, help='project JSON file')
    p_wave.set_defaults(func=cmd_wave)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    if hasattr(args, 'func'):
        try:
            return args.func(args)
        except Exception as e:
            _print_error(str(e))
            import traceback
            traceback.print_exc()
            return 1
    else:
        parser.print_help()
        return 0


if __name__ == '__main__':
    sys.exit(main())
