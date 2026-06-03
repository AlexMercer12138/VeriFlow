# -*- coding: utf-8 -*-
from dataclasses import dataclass, field
from typing import Dict, List, Tuple


@dataclass
class VcdChangePoint:
    time: int
    value: str


@dataclass
class VcdSignal:
    id: str
    reference: str
    full_name: str
    scope: str
    type: str
    width: int
    changes: List[VcdChangePoint] = field(default_factory=list)


@dataclass
class VcdScope:
    name: str
    full_name: str
    depth: int


@dataclass
class VcdParseIssue:
    line: int
    message: str


@dataclass
class VcdData:
    version: str
    date: str
    timescale: str
    start_time: int
    end_time: int
    scopes: List[VcdScope]
    signals: List[VcdSignal]
    warnings: List[VcdParseIssue]


def _read_directive_block(lines: List[str], start_index: int, token: str) -> Tuple[str, int]:
    first_line = lines[start_index].strip()
    prefix = f"${token}"
    if first_line.startswith(prefix) and first_line.endswith("$end"):
        value = first_line[len(prefix): -len("$end")].strip()
        return value, start_index

    parts: List[str] = []
    first_content = first_line[len(prefix):].strip()
    if first_content:
        parts.append(first_content)

    index = start_index + 1
    while index < len(lines):
        line = lines[index].strip()
        if line == "$end":
            return " ".join(parts).strip(), index
        if line.endswith("$end"):
            parts.append(line[:-len("$end")].strip())
            return " ".join(parts).strip(), index
        if line:
            parts.append(line)
        index += 1

    return " ".join(parts).strip(), start_index


def _unique_full_name(scope: str, reference: str, used_names: set[str]) -> str:
    base = f"{scope}.{reference}" if scope else reference
    candidate = base
    index = 1
    while candidate in used_names:
        index += 1
        candidate = f"{base}#{index}"
    used_names.add(candidate)
    return candidate


class VcdParserService:
    def parse(self, content: str) -> VcdData:
        lines = content.splitlines()
        warnings: List[VcdParseIssue] = []
        scopes: List[VcdScope] = []
        scope_stack: List[str] = []
        signals_by_id: Dict[str, List[VcdSignal]] = {}
        declared_signals: List[VcdSignal] = []
        used_names: set[str] = set()
        version = ""
        date = ""
        timescale = ""
        current_time = 0
        end_definitions = False

        i = 0
        while i < len(lines):
            raw = lines[i]
            line = raw.strip()
            line_number = i + 1
            if not line:
                i += 1
                continue

            if not end_definitions:
                if line.startswith("$date"):
                    date, i = _read_directive_block(lines, i, "date")
                    i += 1
                    continue
                if line.startswith("$version"):
                    version, i = _read_directive_block(lines, i, "version")
                    i += 1
                    continue
                if line.startswith("$timescale"):
                    timescale, i = _read_directive_block(lines, i, "timescale")
                    i += 1
                    continue
                if line.startswith("$comment"):
                    _, i = _read_directive_block(lines, i, "comment")
                    i += 1
                    continue
                if line.startswith("$scope"):
                    parts = line.split()
                    name = parts[2] if len(parts) >= 3 else f"scope_{len(scopes) + 1}"
                    scope_stack.append(name)
                    scopes.append(VcdScope(
                        name=name,
                        full_name=".".join(scope_stack),
                        depth=max(0, len(scope_stack) - 1),
                    ))
                    i += 1
                    continue
                if line.startswith("$upscope"):
                    if scope_stack:
                        scope_stack.pop()
                    i += 1
                    continue
                if line.startswith("$var"):
                    parts = line.split()
                    if len(parts) < 6 or parts[-1] != "$end":
                        warnings.append(VcdParseIssue(line_number, "Could not parse $var declaration."))
                        i += 1
                        continue
                    signal_type = parts[1]
                    try:
                        width = int(parts[2])
                    except ValueError:
                        width = 1
                    signal_id = parts[3]
                    reference = " ".join(parts[4:-1]).strip()
                    scope = ".".join(scope_stack)
                    signal = VcdSignal(
                        id=signal_id,
                        reference=reference,
                        full_name=_unique_full_name(scope, reference, used_names),
                        scope=scope,
                        type=signal_type,
                        width=width,
                    )
                    signals_by_id.setdefault(signal_id, []).append(signal)
                    declared_signals.append(signal)
                    i += 1
                    continue
                if line.startswith("$enddefinitions"):
                    end_definitions = True
                    i += 1
                    continue
                i += 1
                continue

            if line.startswith("#"):
                try:
                    current_time = int(line[1:])
                except ValueError:
                    pass
                i += 1
                continue
            if line.startswith("$"):
                i += 1
                continue
            if line[0] in ("b", "B"):
                parts = line[1:].split(maxsplit=1)
                if len(parts) != 2:
                    i += 1
                    continue
                value = parts[0].lower() or "x"
                signal_id = parts[1].strip()
            elif line[0] in "01xXzZ":
                value = line[0].lower()
                signal_id = line[1:].strip()
            else:
                i += 1
                continue

            for signal in signals_by_id.get(signal_id, []):
                signal.changes.append(VcdChangePoint(current_time, value))
            i += 1

        signals: List[VcdSignal] = []
        for signal in declared_signals:
            if not signal.changes:
                signal.changes = [VcdChangePoint(0, "x")]
            signal.changes.sort(key=lambda change: change.time)
            signals.append(signal)

        end_time = current_time
        for signal in signals:
            if signal.changes and signal.changes[-1].time > end_time:
                end_time = signal.changes[-1].time

        return VcdData(
            version=version,
            date=date,
            timescale=timescale,
            start_time=0,
            end_time=end_time,
            scopes=scopes,
            signals=signals,
            warnings=warnings,
        )
