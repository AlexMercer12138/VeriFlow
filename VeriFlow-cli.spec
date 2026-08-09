# -*- mode: python ; coding: utf-8 -*-
# Retained for one Python deprecation release; remove only after the retirement gate.

a = Analysis(
    ['run_cli.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'src.application.coordinator',
        'src.infrastructure.global_config_service',
        'src.infrastructure.file_service',
        'src.infrastructure.config_service',
        'src.infrastructure.template_engine',
        'src.infrastructure.process_manager',
        'src.domain.services.dep_analyzer_service',
        'src.domain.services.port_parser_service',
        'src.domain.services.project_manager_service',
        'src.domain.services.sim_runner_service',
        'src.domain.services.verilog_utils',
        'src.domain.services.log_parser_service',
        'src.domain.services.testbench_generator',
        'src.domain.models.dependency',
        'src.domain.models.port',
        'src.domain.models.project',
        'src.domain.models.simulation',
        'src.presentation.cli',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='VeriFlow-cli',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['src/presentation/gui/resources/icon.ico'],
)
