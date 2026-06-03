# -*- coding: utf-8 -*-
"""
进程管理器 — subprocess 封装
"""

import subprocess
import time
import locale
from pathlib import Path
from typing import Optional, Tuple


class ProcessManager:
    """外部进程管理器"""

    @staticmethod
    def _decode_output(data: bytes) -> str:
        if not data:
            return ''
        encodings = ['utf-8', locale.getpreferredencoding(False), 'gbk']
        for encoding in dict.fromkeys(encodings):
            try:
                return data.decode(encoding)
            except UnicodeDecodeError:
                continue
        return data.decode('utf-8', errors='replace')

    @staticmethod
    def run(
        cmd: str,
        cwd: Optional[Path] = None,
        timeout: Optional[float] = 300.0,
    ) -> Tuple[int, str, str, float]:
        start = time.time()
        try:
            result = subprocess.run(
                cmd,
                cwd=str(cwd) if cwd else None,
                capture_output=True,
                timeout=timeout,
                shell=True,
            )
            elapsed = time.time() - start
            return (
                result.returncode,
                ProcessManager._decode_output(result.stdout),
                ProcessManager._decode_output(result.stderr),
                elapsed,
            )
        except subprocess.TimeoutExpired:
            elapsed = time.time() - start
            return (-1, '', f'Process timed out after {timeout}s', elapsed)
        except FileNotFoundError:
            elapsed = time.time() - start
            return (-2, '', f'Command not found: {cmd.split()[0]}', elapsed)

    @staticmethod
    def run_piped(
        cmd: str,
        cwd: Optional[Path] = None,
        timeout: Optional[float] = 300.0,
        on_stdout: callable = None,
        on_stderr: callable = None,
    ) -> Tuple[int, float]:
        start = time.time()
        try:
            process = subprocess.Popen(
                cmd,
                cwd=str(cwd) if cwd else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                shell=True,
            )

            stdout_lines = []
            stderr_lines = []

            import threading

            def read_stdout():
                for line in process.stdout:
                    line = line.rstrip()
                    stdout_lines.append(line)
                    if on_stdout:
                        on_stdout(line)

            def read_stderr():
                for line in process.stderr:
                    line = line.rstrip()
                    stderr_lines.append(line)
                    if on_stderr:
                        on_stderr(line)

            t1 = threading.Thread(target=read_stdout, daemon=True)
            t2 = threading.Thread(target=read_stderr, daemon=True)
            t1.start()
            t2.start()

            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                elapsed = time.time() - start
                return (-1, elapsed)

            t1.join(timeout=1)
            t2.join(timeout=1)

            elapsed = time.time() - start
            return (process.returncode, elapsed)

        except FileNotFoundError:
            elapsed = time.time() - start
            return (-2, elapsed)
