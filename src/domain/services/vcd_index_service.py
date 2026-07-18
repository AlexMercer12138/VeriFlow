from __future__ import annotations

import json
import os
import shutil
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from src.domain.services.vcd_index_format import (
    DATA_MAGIC,
    INDEX_VERSION,
    RawRecordCodec,
    VcdIndexError,
    validate_manifest,
)


ProgressCallback = Callable[[dict], None]
MetadataCallback = Callable[[dict], None]
CancelCallback = Callable[[], bool]


class VcdIndexCancelled(VcdIndexError):
    pass


@dataclass
class _ScanResult:
    metadata: dict
    streams: list[dict]
    signals: list[dict]


def _check_cancel(cancelled: Optional[CancelCallback]) -> None:
    if cancelled is not None and cancelled():
        raise VcdIndexCancelled("waveform index build cancelled")


def _emit(callback: Optional[Callable[[dict], None]], event: dict) -> None:
    if callback is not None:
        callback(event)


def _parse_change(line: str) -> Optional[tuple[str, str]]:
    if not line:
        return None
    if line[0] in "01xXzZ":
        identifier = line[1:].strip()
        return (identifier, line[0].lower()) if identifier else None
    if line[0] in "bB":
        parts = line[1:].split(None, 1)
        if len(parts) == 2:
            return parts[1].strip(), parts[0].lower()
    return None


def _scan_vcd(
    source: Path,
    on_metadata: Optional[MetadataCallback],
    on_progress: Optional[ProgressCallback],
    cancelled: Optional[CancelCallback],
) -> _ScanResult:
    source_size = source.stat().st_size
    _emit(
        on_progress,
        {"phase": "scan", "completed": 0, "total": source_size, "percent": 0},
    )

    scopes: list[dict] = []
    scope_stack: list[str] = []
    signals: list[dict] = []
    streams: list[dict] = []
    stream_by_identifier: dict[str, int] = {}
    warnings: list[dict] = []
    metadata = {
        "version": "",
        "date": "",
        "timescale": "",
        "startTime": 0,
        "endTime": 0,
        "scopes": scopes,
        "signals": signals,
        "warnings": warnings,
    }
    current_time = 0
    end_definitions = False
    metadata_emitted = False
    directive_name = ""
    directive_parts: list[str] = []

    def finish_directive() -> None:
        nonlocal directive_name, directive_parts
        value = " ".join(part for part in directive_parts if part).strip()
        if directive_name in {"version", "date", "timescale"}:
            metadata[directive_name] = value
        directive_name = ""
        directive_parts = []

    with source.open("r", encoding="utf-8", errors="ignore", newline=None) as handle:
        for line_number, raw in enumerate(handle, 1):
            if line_number % 4096 == 0:
                _check_cancel(cancelled)
            line = raw.strip()
            if not line:
                continue

            if directive_name:
                before, marker, _after = line.partition("$end")
                directive_parts.append(before.strip())
                if marker:
                    finish_directive()
                continue

            if not end_definitions:
                matched_directive = False
                for name in ("date", "version", "timescale", "comment"):
                    prefix = "$" + name
                    if not line.startswith(prefix):
                        continue
                    rest = line[len(prefix) :].strip()
                    before, marker, _after = rest.partition("$end")
                    directive_name = name
                    directive_parts = [before.strip()]
                    if marker:
                        finish_directive()
                    matched_directive = True
                    break
                if matched_directive:
                    continue
                if line.startswith("$scope"):
                    parts = line.split()
                    if len(parts) >= 4:
                        name = parts[2]
                        full_name = ".".join([*scope_stack, name])
                        scopes.append(
                            {
                                "name": name,
                                "fullName": full_name,
                                "depth": len(scope_stack),
                            }
                        )
                        scope_stack.append(name)
                    else:
                        warnings.append(
                            {"line": line_number, "message": "Malformed $scope directive"}
                        )
                    continue
                if line.startswith("$upscope"):
                    if scope_stack:
                        scope_stack.pop()
                    else:
                        warnings.append(
                            {"line": line_number, "message": "Unexpected $upscope"}
                        )
                    continue
                if line.startswith("$var"):
                    parts = line.split()
                    if len(parts) < 6:
                        warnings.append(
                            {"line": line_number, "message": "Malformed $var directive"}
                        )
                        continue
                    try:
                        width = int(parts[2])
                    except ValueError:
                        warnings.append(
                            {"line": line_number, "message": "Invalid signal width"}
                        )
                        continue
                    identifier = parts[3]
                    reference = " ".join(parts[4:-1])
                    stream_index = stream_by_identifier.get(identifier)
                    if stream_index is None:
                        stream_index = len(streams)
                        stream_by_identifier[identifier] = stream_index
                        streams.append(
                            {
                                "identifier": identifier,
                                "width": width,
                                "count": 0,
                                "rawOffset": 0,
                                "rawRecordSize": RawRecordCodec(width).record_size,
                                "levels": [],
                            }
                        )
                    elif streams[stream_index]["width"] != width:
                        raise VcdIndexError(
                            f"alias width mismatch for identifier {identifier!r}"
                        )
                    scope = ".".join(scope_stack)
                    signals.append(
                        {
                            "id": identifier,
                            "reference": reference,
                            "fullName": f"{scope}.{reference}" if scope else reference,
                            "scope": scope,
                            "type": parts[1],
                            "width": width,
                            "stream": stream_index,
                        }
                    )
                    continue
                if line.startswith("$enddefinitions"):
                    end_definitions = True
                    metadata_emitted = True
                    _emit(on_metadata, json.loads(json.dumps(metadata)))
                    continue
                continue

            if line.startswith("#"):
                try:
                    current_time = int(line[1:].strip())
                except ValueError:
                    warnings.append(
                        {"line": line_number, "message": "Invalid VCD timestamp"}
                    )
                metadata["endTime"] = max(metadata["endTime"], current_time)
                continue
            change = _parse_change(line)
            if change is None:
                continue
            identifier, _value = change
            stream_index = stream_by_identifier.get(identifier)
            if stream_index is None:
                warnings.append(
                    {
                        "line": line_number,
                        "message": f"Value change for unknown id {identifier!r}",
                    }
                )
                continue
            streams[stream_index]["count"] += 1

    _check_cancel(cancelled)
    if not metadata_emitted:
        raise VcdIndexError("VCD is missing $enddefinitions")
    _emit(
        on_progress,
        {
            "phase": "scan",
            "completed": source_size,
            "total": source_size,
            "percent": 40,
        },
    )
    return _ScanResult(metadata=metadata, streams=streams, signals=signals)


def _iter_changes(source: Path) -> Iterator[tuple[int, str, str]]:
    current_time = 0
    end_definitions = False
    with source.open("r", encoding="utf-8", errors="ignore", newline=None) as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            if not end_definitions:
                if line.startswith("$enddefinitions"):
                    end_definitions = True
                continue
            if line.startswith("#"):
                try:
                    current_time = int(line[1:].strip())
                except ValueError:
                    pass
                continue
            change = _parse_change(line)
            if change is not None:
                yield current_time, change[0], change[1]


class _BufferedPositionWriter:
    def __init__(
        self,
        handle,
        streams: list[dict],
        per_stream_limit: int = 64 * 1024,
        total_limit: int = 64 * 1024 * 1024,
    ) -> None:
        self._handle = handle
        self._streams = streams
        self._positions = [stream["rawOffset"] for stream in streams]
        self._buffers: OrderedDict[int, bytearray] = OrderedDict()
        self._per_stream_limit = per_stream_limit
        self._total_limit = total_limit
        self._total_buffered = 0

    def append(self, stream_index: int, record: bytes) -> None:
        buffer = self._buffers.get(stream_index)
        if buffer is None:
            buffer = bytearray()
            self._buffers[stream_index] = buffer
        else:
            self._buffers.move_to_end(stream_index)
        buffer.extend(record)
        self._total_buffered += len(record)
        if len(buffer) >= self._per_stream_limit:
            self.flush(stream_index)
        while self._total_buffered > self._total_limit and self._buffers:
            self.flush(next(iter(self._buffers)))

    def flush(self, stream_index: int) -> None:
        buffer = self._buffers.pop(stream_index, None)
        if not buffer:
            return
        self._handle.seek(self._positions[stream_index])
        self._handle.write(buffer)
        self._positions[stream_index] += len(buffer)
        self._total_buffered -= len(buffer)

    def flush_all(self) -> None:
        for stream_index in list(self._buffers):
            self.flush(stream_index)


def build_vcd_index(
    source: Path,
    index_dir: Path,
    *,
    on_metadata: Optional[MetadataCallback] = None,
    on_progress: Optional[ProgressCallback] = None,
    cancelled: Optional[CancelCallback] = None,
) -> dict:
    source = Path(source).resolve()
    index_dir = Path(index_dir)
    if index_dir.exists():
        raise VcdIndexError(f"index directory already exists: {index_dir}")

    scan = _scan_vcd(source, on_metadata, on_progress, cancelled)
    offset = len(DATA_MAGIC)
    for stream in scan.streams:
        stream["rawOffset"] = offset
        offset += stream["count"] * stream["rawRecordSize"]

    index_dir.mkdir(parents=True)
    data_path = index_dir / "waveform.vfi"
    try:
        with data_path.open("w+b") as handle:
            handle.write(DATA_MAGIC)
            handle.truncate(offset)
            writer = _BufferedPositionWriter(handle, scan.streams)
            stream_by_identifier = {
                stream["identifier"]: index
                for index, stream in enumerate(scan.streams)
            }
            codecs = [RawRecordCodec(stream["width"]) for stream in scan.streams]
            total_changes = sum(stream["count"] for stream in scan.streams)
            written_changes = 0
            _emit(
                on_progress,
                {
                    "phase": "write",
                    "completed": 0,
                    "total": total_changes,
                    "percent": 40,
                },
            )
            for timestamp, identifier, value in _iter_changes(source):
                if written_changes % 4096 == 0:
                    _check_cancel(cancelled)
                stream_index = stream_by_identifier.get(identifier)
                if stream_index is None:
                    continue
                writer.append(stream_index, codecs[stream_index].encode(timestamp, value))
                written_changes += 1
            writer.flush_all()
            handle.flush()
            os.fsync(handle.fileno())

        manifest = {
            "formatVersion": INDEX_VERSION,
            "dataFile": "waveform.vfi",
            **scan.metadata,
            "streams": scan.streams,
            "signals": scan.signals,
        }
        manifest_path = index_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        _emit(
            on_progress,
            {
                "phase": "complete",
                "completed": total_changes,
                "total": total_changes,
                "percent": 100,
            },
        )
        return manifest
    except Exception:
        shutil.rmtree(index_dir, ignore_errors=True)
        raise


class VcdIndexReader:
    def __init__(self, index_dir: Path) -> None:
        self.index_dir = Path(index_dir)
        self.manifest = validate_manifest(
            json.loads((self.index_dir / "manifest.json").read_text(encoding="utf-8"))
        )
        self.data_path = self.index_dir / self.manifest["dataFile"]
        with self.data_path.open("rb") as handle:
            if handle.read(len(DATA_MAGIC)) != DATA_MAGIC:
                raise VcdIndexError("waveform index data magic is invalid")

    @property
    def metadata(self) -> dict:
        return {
            key: self.manifest.get(key)
            for key in (
                "version",
                "date",
                "timescale",
                "startTime",
                "endTime",
                "scopes",
                "signals",
                "warnings",
            )
        }

    def _signal_for_reference(self, reference: str) -> dict:
        for signal in self.manifest["signals"]:
            if signal.get("reference") == reference:
                return signal
        raise KeyError(reference)

    def raw_changes_for_reference(self, reference: str) -> list[tuple[int, str]]:
        signal = self._signal_for_reference(reference)
        stream = self.manifest["streams"][signal["stream"]]
        codec = RawRecordCodec(stream["width"])
        result: list[tuple[int, str]] = []
        with self.data_path.open("rb") as handle:
            handle.seek(stream["rawOffset"])
            for _ in range(stream["count"]):
                record = handle.read(codec.record_size)
                if len(record) != codec.record_size:
                    raise VcdIndexError("waveform index raw stream is truncated")
                result.append(codec.decode(record))
        return result
