from __future__ import annotations

import json
import os
import shutil
import base64
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from src.domain.services.vcd_index_format import (
    DATA_MAGIC,
    INDEX_VERSION,
    RawRecordCodec,
    SummaryRecordCodec,
    SUMMARY_CHANGED,
    SUMMARY_DENSE,
    SUMMARY_HAS_X,
    SUMMARY_HAS_Z,
    VcdIndexError,
    normalize_logic_value,
    pack_logic_value,
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


def _logic_flags(value: str) -> int:
    flags = 0
    if "x" in value:
        flags |= SUMMARY_HAS_X
    if "z" in value:
        flags |= SUMMARY_HAS_Z
    return flags


def _build_summary_levels(
    handle,
    streams: list[dict],
    cancelled: Optional[CancelCallback],
    on_progress: Optional[ProgressCallback],
) -> None:
    handle.flush()
    handle.seek(0, os.SEEK_END)
    append_offset = handle.tell()
    total_streams = max(1, len(streams))

    for stream_index, stream in enumerate(streams):
        _check_cancel(cancelled)
        raw_codec = RawRecordCodec(stream["width"])
        summary_codec = SummaryRecordCodec(stream["width"])
        source_kind = "raw"
        source_offset = stream["rawOffset"]
        source_count = stream["count"]
        source_record_size = raw_codec.record_size
        levels: list[dict] = []

        while source_count > 1:
            level_offset = append_offset
            level_count = 0
            for group_start in range(0, source_count, 8):
                if group_start % (8 * 512) == 0:
                    _check_cancel(cancelled)
                group_count = min(8, source_count - group_start)
                handle.seek(source_offset + group_start * source_record_size)
                records = []
                for _ in range(group_count):
                    record = handle.read(source_record_size)
                    if len(record) != source_record_size:
                        raise VcdIndexError("waveform index summary source is truncated")
                    records.append(
                        raw_codec.decode(record)
                        if source_kind == "raw"
                        else summary_codec.decode(record)
                    )

                if source_kind == "raw":
                    first_time, first_value = records[0]
                    last_time, last_value = records[-1]
                    flags = 0
                    previous = first_value
                    for _timestamp, value in records:
                        flags |= _logic_flags(value)
                        if value != previous:
                            flags |= SUMMARY_CHANGED
                        previous = value
                else:
                    first_time, _first_last, first_value, _unused, _flags = records[0]
                    _last_first, last_time, _unused, last_value, _flags = records[-1]
                    flags = 0
                    previous = first_value
                    for (
                        _record_first_time,
                        _record_last_time,
                        record_first_value,
                        record_last_value,
                        record_flags,
                    ) in records:
                        flags |= record_flags
                        if record_first_value != previous:
                            flags |= SUMMARY_CHANGED
                        previous = record_last_value
                if group_count == 8 and flags & SUMMARY_CHANGED:
                    flags |= SUMMARY_DENSE
                encoded = summary_codec.encode(
                    first_time,
                    last_time,
                    first_value,
                    last_value,
                    flags,
                )
                handle.seek(append_offset)
                handle.write(encoded)
                append_offset += len(encoded)
                level_count += 1

            levels.append(
                {
                    "offset": level_offset,
                    "count": level_count,
                    "recordSize": summary_codec.record_size,
                }
            )
            source_kind = "summary"
            source_offset = level_offset
            source_count = level_count
            source_record_size = summary_codec.record_size

        stream["levels"] = levels
        _emit(
            on_progress,
            {
                "phase": "summarize",
                "completed": stream_index + 1,
                "total": total_streams,
                "percent": 85 + round(14 * (stream_index + 1) / total_streams),
            },
        )


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
            _build_summary_levels(handle, scan.streams, cancelled, on_progress)
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

    def _stream_for_reference(self, reference: str) -> tuple[dict, dict]:
        signal = self._signal_for_reference(reference)
        return signal, self.manifest["streams"][signal["stream"]]

    @staticmethod
    def _read_raw(handle, stream: dict, codec: RawRecordCodec, index: int) -> tuple[int, str]:
        handle.seek(stream["rawOffset"] + index * codec.record_size)
        record = handle.read(codec.record_size)
        if len(record) != codec.record_size:
            raise VcdIndexError("waveform index raw stream is truncated")
        return codec.decode(record)

    def _lower_bound_raw(
        self, handle, stream: dict, codec: RawRecordCodec, timestamp: int
    ) -> int:
        low = 0
        high = stream["count"]
        while low < high:
            middle = (low + high) // 2
            current, _value = self._read_raw(handle, stream, codec, middle)
            if current < timestamp:
                low = middle + 1
            else:
                high = middle
        return low

    def _upper_bound_raw(
        self, handle, stream: dict, codec: RawRecordCodec, timestamp: int
    ) -> int:
        low = 0
        high = stream["count"]
        while low < high:
            middle = (low + high) // 2
            current, _value = self._read_raw(handle, stream, codec, middle)
            if current <= timestamp:
                low = middle + 1
            else:
                high = middle
        return low

    @staticmethod
    def _read_summary(
        handle, level: dict, codec: SummaryRecordCodec, index: int
    ) -> tuple[int, int, str, str, int]:
        handle.seek(level["offset"] + index * codec.record_size)
        record = handle.read(codec.record_size)
        if len(record) != codec.record_size:
            raise VcdIndexError("waveform index summary stream is truncated")
        return codec.decode(record)

    def _summary_range(
        self,
        handle,
        level: dict,
        codec: SummaryRecordCodec,
        start: int,
        end: int,
    ) -> tuple[int, int]:
        low = 0
        high = level["count"]
        while low < high:
            middle = (low + high) // 2
            _first, last, _first_value, _last_value, _flags = self._read_summary(
                handle, level, codec, middle
            )
            if last < start:
                low = middle + 1
            else:
                high = middle
        first_index = low
        low = first_index
        high = level["count"]
        while low < high:
            middle = (low + high) // 2
            first, _last, _first_value, _last_value, _flags = self._read_summary(
                handle, level, codec, middle
            )
            if first <= end:
                low = middle + 1
            else:
                high = middle
        return first_index, low

    def query_window_for_reference(
        self,
        reference: str,
        start: int,
        end: int,
        *,
        pixel_width: int,
        cancelled: Optional[CancelCallback] = None,
    ) -> dict:
        _check_cancel(cancelled)
        if end < start:
            start, end = end, start
        _signal, stream = self._stream_for_reference(reference)
        raw_codec = RawRecordCodec(stream["width"])
        max_records = max(1, int(pixel_width) * 2)

        with self.data_path.open("rb") as handle:
            first_in_range = self._lower_bound_raw(handle, stream, raw_codec, start)
            raw_start = max(0, first_in_range - 1)
            raw_end = self._upper_bound_raw(handle, stream, raw_codec, end)
            if raw_end < raw_start + 1 and stream["count"]:
                raw_end = min(stream["count"], raw_start + 1)
            raw_count = max(0, raw_end - raw_start)
            if raw_count <= max_records or not stream.get("levels"):
                times: list[int] = []
                packed_values = bytearray()
                for index in range(raw_start, raw_end):
                    if index % 4096 == 0:
                        _check_cancel(cancelled)
                    timestamp, value = self._read_raw(handle, stream, raw_codec, index)
                    times.append(timestamp)
                    packed_values.extend(pack_logic_value(value, stream["width"]))
                return {
                    "kind": "raw",
                    "width": stream["width"],
                    "times": times,
                    "values": base64.b64encode(packed_values).decode("ascii"),
                    "valueStride": raw_codec.value_size,
                }

            summary_codec = SummaryRecordCodec(stream["width"])
            selected_level = stream["levels"][-1]
            selected_range = self._summary_range(
                handle, selected_level, summary_codec, start, end
            )
            for level in stream["levels"]:
                candidate_range = self._summary_range(
                    handle, level, summary_codec, start, end
                )
                if candidate_range[1] - candidate_range[0] <= max_records:
                    selected_level = level
                    selected_range = candidate_range
                    break

            first_times: list[int] = []
            last_times: list[int] = []
            first_values = bytearray()
            last_values = bytearray()
            flags: list[int] = []
            for index in range(selected_range[0], selected_range[1]):
                _check_cancel(cancelled)
                first_time, last_time, first_value, last_value, record_flags = (
                    self._read_summary(handle, selected_level, summary_codec, index)
                )
                first_times.append(first_time)
                last_times.append(last_time)
                first_values.extend(pack_logic_value(first_value, stream["width"]))
                last_values.extend(pack_logic_value(last_value, stream["width"]))
                flags.append(record_flags)
            return {
                "kind": "summary",
                "width": stream["width"],
                "firstTimes": first_times,
                "lastTimes": last_times,
                "firstValues": base64.b64encode(first_values).decode("ascii"),
                "lastValues": base64.b64encode(last_values).decode("ascii"),
                "valueStride": summary_codec.value_size,
                "flags": flags,
            }

    def value_at(self, reference: str, timestamp: int) -> str:
        _signal, stream = self._stream_for_reference(reference)
        codec = RawRecordCodec(stream["width"])
        if not stream["count"]:
            return "x" * stream["width"]
        with self.data_path.open("rb") as handle:
            index = self._upper_bound_raw(handle, stream, codec, timestamp) - 1
            if index < 0:
                return "x" * stream["width"]
            return self._read_raw(handle, stream, codec, index)[1]

    def values_at(self, references: list[str], timestamp: int) -> dict[str, str]:
        return {reference: self.value_at(reference, timestamp) for reference in references}

    @staticmethod
    def _search_value(text: str, width: int) -> str:
        cleaned = str(text or "").lower().replace("_", "").replace(" ", "")
        try:
            if cleaned.startswith("0x"):
                numeric = int(cleaned[2:], 16)
            elif cleaned.startswith("h"):
                numeric = int(cleaned[1:], 16)
            elif cleaned.startswith("0b"):
                numeric = int(cleaned[2:], 2)
            elif cleaned.startswith("b"):
                numeric = int(cleaned[1:], 2)
            else:
                numeric = int(cleaned, 10)
        except ValueError as error:
            raise VcdIndexError("invalid waveform search value") from error
        if numeric < 0 or numeric >= 1 << width:
            raise VcdIndexError("waveform search value exceeds signal width")
        return format(numeric, f"0{width}b")

    @staticmethod
    def _bit_value(value: str, bit_index: Optional[int]) -> str:
        if bit_index is None:
            return value
        if bit_index < 0 or bit_index >= len(value):
            raise VcdIndexError("bus bit index is outside signal width")
        return value[-1 - bit_index]

    def search(
        self,
        reference: str,
        cursor_time: int,
        direction: int,
        mode: str,
        query: str = "",
        *,
        bit_index: Optional[int] = None,
        cancelled: Optional[CancelCallback] = None,
    ) -> Optional[dict]:
        _check_cancel(cancelled)
        _signal, stream = self._stream_for_reference(reference)
        codec = RawRecordCodec(stream["width"])
        target_value = (
            self._search_value(query, 1 if bit_index is not None else stream["width"])
            if mode == "value"
            else ""
        )
        if mode in {"rising", "falling"} and stream["width"] != 1 and bit_index is None:
            raise VcdIndexError("edge search requires a scalar signal or bus bit")
        valid_modes = {"change", "rising", "falling", "value", "xz"}
        if mode not in valid_modes:
            raise VcdIndexError("unsupported waveform search mode")

        with self.data_path.open("rb") as handle:
            if direction >= 0:
                indices = range(
                    self._upper_bound_raw(handle, stream, codec, cursor_time),
                    stream["count"],
                )
            else:
                indices = range(
                    self._lower_bound_raw(handle, stream, codec, cursor_time) - 1,
                    -1,
                    -1,
                )
            for iteration, index in enumerate(indices):
                if iteration % 4096 == 0:
                    _check_cancel(cancelled)
                timestamp, full_value = self._read_raw(handle, stream, codec, index)
                value = self._bit_value(full_value, bit_index)
                matches = mode == "change"
                if mode == "xz":
                    matches = "x" in value or "z" in value
                elif mode == "value":
                    matches = value == target_value
                elif mode in {"rising", "falling"} and index > 0:
                    previous_full = self._read_raw(handle, stream, codec, index - 1)[1]
                    previous = self._bit_value(previous_full, bit_index)
                    matches = (
                        previous == "0" and value == "1"
                        if mode == "rising"
                        else previous == "1" and value == "0"
                    )
                if matches:
                    return {
                        "reference": reference,
                        "time": timestamp,
                        "value": value,
                        "fullValue": full_value,
                        "bitIndex": bit_index,
                    }
        return None
