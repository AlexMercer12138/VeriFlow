# -*- coding: utf-8 -*-
"""完整功能验证"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.infrastructure.file_service import FileService
from src.infrastructure.template_engine import TemplateEngine
from src.infrastructure.process_manager import ProcessManager
from src.infrastructure.config_service import ConfigService
from src.domain.models.project import Project
from src.domain.services.port_parser_service import PortParserService
from src.domain.services.dep_analyzer_service import DependencyAnalyzerService
from src.domain.services.project_manager_service import ProjectManagerService
from src.domain.services.log_parser_service import LogParserService
from src.domain.services.sim_runner_service import SimRunnerService
from src.application.coordinator import ApplicationCoordinator


def test_infrastructure():
    print('=== Infrastructure Layer ===')

    fs = FileService()
    verilog_dir = Path(__file__).parent.parent.parent / 'verilog' / 'common'
    files = fs.list_files(str(verilog_dir))
    assert len(files) >= 5, f'Expected at least 5 files, got {len(files)}'
    print(f'  FileService: {len(files)} files found OK')

    te = TemplateEngine()
    result = te.render('hello {name}', {'name': 'world'})
    assert result == 'hello world'
    print(f'  TemplateEngine: render OK')

    lp = LogParserService()
    entries = lp.parse('foo.v:10: error: syntax error\nwarning: unused wire\nok')
    assert len(entries) == 3
    assert entries[0].level == 'ERROR' and entries[0].line_no == 10
    assert entries[1].level == 'WARNING'
    assert entries[2].level == 'INFO'
    print(f'  LogParser: {len(entries)} entries parsed OK')

    cs = ConfigService()
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        f.write('{"test": 123}')
        tmp_path = f.name
    data = cs.load(Path(tmp_path))
    assert data['test'] == 123
    Path(tmp_path).unlink()
    print(f'  ConfigService: load OK')

    print('  Infrastructure: ALL PASSED\n')


def test_domain_services():
    print('=== Domain Services ===')

    fs = FileService()
    verilog_dir = Path(__file__).parent.parent.parent / 'verilog' / 'common'

    parser = PortParserService(fs)
    info = parser.parse_file(str(next(verilog_dir.glob('*.v'))))
    assert info.name, 'Module name should not be empty'
    print(f'  PortParser: parsed module="{info.name}" OK')

    dep = DependencyAnalyzerService(fs)
    index, file_mods = dep.build_index([verilog_dir])
    assert len(index) >= 5, f'Expected at least 5 modules, got {len(index)}'
    result = dep.resolve('i2c_master', [verilog_dir])
    assert result.success
    print(f'  DepAnalyzer: index={len(index)}, resolve OK')

    pm = ProjectManagerService()
    project = pm.create('test_proj', Path.cwd())
    assert project.name == 'test_proj'
    assert 'iverilog' in project.simulators
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        f.write('{"project_name":"from_file","project_root":".","lib_dirs":[],"simulators":{},"wave_viewers":{}}')
        tmp_path = f.name
    opened = pm.open(Path(tmp_path))
    assert opened.name == 'from_file'
    Path(tmp_path).unlink()
    print(f'  ProjectManager: create/open OK')

    print('  Domain Services: ALL PASSED\n')


def test_coordinator():
    print('=== ApplicationCoordinator ===')
    app = ApplicationCoordinator()
    project = app.create_project('my_test', '.')
    assert project.name == 'my_test'
    print(f'  create_project: "{project.name}" OK')

    verilog_dir = str(Path(__file__).parent.parent.parent / 'verilog' / 'common')
    result = app.analyze_dependencies('i2c_master', verilog_dir)
    assert result.success
    assert len(result.files) == 1
    assert result.files[0].name == 'i2c_master.v'
    print(f'  analyze_dependencies: {result.files[0].name} OK')

    result2 = app.analyze_dependencies('nonexistent', verilog_dir)
    assert not result2.success
    assert 'nonexistent' in result2.missing_modules
    print(f'  analyze_dependencies(missing): correctly detected OK')

    print('  Coordinator: ALL PASSED\n')


def test_template_rendering():
    print('=== Template Rendering ===')
    te = TemplateEngine()
    compile_cmd = 'iverilog -o "{output}" {files}'
    rendered = te.render_compile(compile_cmd, 'build/sim.out', ['a.v', 'b.v'])
    assert 'build/sim.out' in rendered
    assert '"a.v"' in rendered
    assert '"b.v"' in rendered
    print(f'  compile: {rendered[:80]}... OK')

    run_cmd = 'vvp "{output}"'
    rendered = te.render_run(run_cmd, 'build/sim.out')
    assert 'build/sim.out' in rendered
    print(f'  run: {rendered} OK')

    wave_cmd = 'gtkwave "{wave_file}"'
    rendered = te.render_wave(wave_cmd, 'dump.vcd')
    assert 'dump.vcd' in rendered
    print(f'  wave: {rendered} OK')

    print('  Template Rendering: ALL PASSED\n')


def main():
    test_infrastructure()
    test_domain_services()
    test_coordinator()
    test_template_rendering()
    print('=' * 50)
    print(' ALL VERIFICATION TESTS PASSED!')
    print('=' * 50)


if __name__ == '__main__':
    main()
