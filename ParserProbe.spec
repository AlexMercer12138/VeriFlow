# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path


SPEC_ROOT = Path(SPECPATH).resolve()
if str(SPEC_ROOT) not in sys.path:
    sys.path.insert(0, str(SPEC_ROOT))

from PyInstaller.utils.hooks import collect_data_files
from scripts.worker_wheel_provenance import verify_installed_worker_provenance_from_env


verify_installed_worker_provenance_from_env()
datas = collect_data_files("veriflow_hdl_worker")

a = Analysis(
    ["scripts/parser_probe_entry.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
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
    name="parser-probe",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
