# -*- coding: utf-8 -*-
"""
仿真相关领域模型
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class LogEntry:
    """日志条目"""
    level: str
    message: str
    file_ref: Optional[str] = None
    line_no: Optional[int] = None

    @property
    def is_error(self) -> bool:
        return self.level.upper() == 'ERROR'


@dataclass
class SimulationResult:
    """仿真结果"""
    success: bool
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""
    log_entries: List[LogEntry] = field(default_factory=list)
    wave_file: Optional[Path] = None
    elapsed_time: float = 0.0

    @property
    def has_wave(self) -> bool:
        return self.wave_file is not None and self.wave_file.exists()

    def get_errors(self) -> List[LogEntry]:
        return [e for e in self.log_entries if e.is_error]
