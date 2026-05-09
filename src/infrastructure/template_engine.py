# -*- coding: utf-8 -*-
"""
命令模板引擎 — 占位符替换
"""

from typing import List, Dict
from pathlib import Path


class TemplateEngine:
    """命令模板渲染器"""

    @staticmethod
    def render(template: str, variables: Dict[str, str]) -> str:
        result = template
        for key, value in variables.items():
            result = result.replace('{' + key + '}', str(value))
        return result

    @staticmethod
    def render_compile(
        compile_cmd: str,
        output: str,
        files: List[str],
        top_module: str = "",
    ) -> str:
        return TemplateEngine.render(compile_cmd, {
            'output': output,
            'files': ' '.join(f'"{f}"' for f in files),
            'top_module': top_module,
        })

    @staticmethod
    def render_run(run_cmd: str, output: str) -> str:
        return TemplateEngine.render(run_cmd, {
            'output': output,
        })

    @staticmethod
    def render_wave(launch_cmd: str, wave_file: str) -> str:
        return TemplateEngine.render(launch_cmd, {
            'wave_file': wave_file,
        })
