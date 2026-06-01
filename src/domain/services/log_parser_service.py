# -*- coding: utf-8 -*-
"""
日志解析服务 — 解析仿真器/编译器的错误输出
"""

import re
from typing import List
from src.domain.models.simulation import LogEntry


class LogParserService:
    """日志解析器"""

    _ERROR_PATTERNS = [
        re.compile(r'^(?P<file>[^:]+):(?P<line>\d+):\s*error\s*:\s*(?P<msg>.+)$', re.IGNORECASE),
        re.compile(r'^(?P<file>[^:]+):(?P<line>\d+):\s*(?P<msg>.+)$', re.IGNORECASE),
        re.compile(r'^ERROR:\s*(?P<msg>.+)$', re.IGNORECASE),
        re.compile(r'^Error\s*\([^)]*\):\s*(?P<msg>.+)$'),
    ]

    _WARNING_PATTERNS = [
        re.compile(r'^(?P<file>[^:]+):(?P<line>\d+):\s*warning\s*:\s*(?P<msg>.+)$', re.IGNORECASE),
        re.compile(r'^WARNING:\s*(?P<msg>.+)$', re.IGNORECASE),
    ]

    def parse(self, text: str) -> List[LogEntry]:
        entries = []
        for line in text.splitlines():
            entry = self._parse_line(line.strip())
            if entry:
                entries.append(entry)
        return entries

    def _parse_line(self, line: str) -> LogEntry:
        if not line:
            return None

        for pattern in self._WARNING_PATTERNS:
            m = pattern.match(line)
            if m:
                return LogEntry(
                    level='WARNING',
                    message=m.groupdict().get('msg', line),
                    file_ref=m.groupdict().get('file'),
                    line_no=int(m.group('line')) if 'line' in m.groupdict() and m.group('line') else None,
                )

        for pattern in self._ERROR_PATTERNS:
            m = pattern.match(line)
            if m:
                return LogEntry(
                    level='ERROR',
                    message=m.groupdict().get('msg', line),
                    file_ref=m.groupdict().get('file'),
                    line_no=int(m.group('line')) if 'line' in m.groupdict() and m.group('line') else None,
                )

        if 'error' in line.lower():
            return LogEntry(level='ERROR', message=line)
        if 'warning' in line.lower():
            return LogEntry(level='WARNING', message=line)

        return LogEntry(level='INFO', message=line)

    def has_errors(self, text: str) -> bool:
        return any(e.is_error for e in self.parse(text))
