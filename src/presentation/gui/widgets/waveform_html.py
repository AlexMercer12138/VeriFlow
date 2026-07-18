# -*- coding: utf-8 -*-
import json
import sys
from pathlib import Path

from src.domain.services.vcd_parser_service import VcdData


def _to_web_data(data: VcdData) -> dict:
    return {
        "version": data.version,
        "date": data.date,
        "timescale": data.timescale,
        "startTime": data.start_time,
        "endTime": data.end_time,
        "scopes": [
            {
                "name": scope.name,
                "fullName": scope.full_name,
                "depth": scope.depth,
            }
            for scope in data.scopes
        ],
        "signals": [
            {
                "id": signal.id,
                "reference": signal.reference,
                "fullName": signal.full_name,
                "scope": signal.scope,
                "type": signal.type,
                "width": signal.width,
                "changes": [
                    {"time": change.time, "value": change.value}
                    for change in signal.changes
                ],
            }
            for signal in data.signals
        ],
        "warnings": [
            {"line": warning.line, "message": warning.message}
            for warning in data.warnings
        ],
    }


def _waveform_assets_dir() -> Path:
    bundled_root = getattr(sys, "_MEIPASS", None)
    if bundled_root:
        bundled = Path(bundled_root) / "veriflow-vscode" / "media" / "waveform"
        if bundled.exists():
            return bundled
    return Path(__file__).resolve().parents[4] / "veriflow-vscode" / "media" / "waveform"


def _read_asset(name: str) -> str:
    return (_waveform_assets_dir() / name).read_text(encoding="utf-8")


def _viewer_script(*, indexed: bool = False) -> str:
    script = _read_asset("viewer.js")
    if not indexed:
        script = script.replace("waveformTransport.send({ type: 'ready' });", "")
    return script.replace("const bootstrap = ${stateJson};", "const bootstrap = {};")


def _viewer_core_script() -> str:
    return _read_asset("viewer-core.js")


def _viewer_transport_script() -> str:
    return _read_asset("viewer-transport.js")


def _build_waveform_html(file_name: str, data: VcdData) -> str:
    payload = json.dumps(
        {"type": "vcd", "fileName": file_name, "data": _to_web_data(data)},
        ensure_ascii=False,
    )
    css = _read_asset("viewer.css")
    body = _read_asset("viewer.html")
    core_script = _viewer_core_script()
    transport_script = _viewer_transport_script()
    script = _viewer_script()
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VeriFlow Waveform</title>
<style>
{css}
</style>
</head>
<body>
{body}
<script>
{transport_script}
{core_script}
{script}
window.addEventListener('load', () => {{
    window.postMessage({payload}, '*');
}});
</script>
</body>
</html>"""


def _build_empty_waveform_html() -> str:
    css = _read_asset("viewer.css")
    body = _read_asset("viewer.html")
    core_script = _viewer_core_script()
    transport_script = _viewer_transport_script()
    script = _viewer_script(indexed=True)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VeriFlow Waveform</title>
<style>
{css}
</style>
</head>
<body>
{body}
<script src="qrc:///qtwebchannel/qwebchannel.js"></script>
<script>
{transport_script}
{core_script}
{script}
window.addEventListener('load', () => {{
    window.postMessage({{"type": "empty"}}, '*');
}});
</script>
</body>
</html>"""
