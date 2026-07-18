from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Any, Mapping


INDEX_VERSION = 1
DATA_MAGIC = b"VFI1"
MAX_WEB_TIMESTAMP = 2**53 - 1

SYMBOL_TO_BITS = {"0": 0, "1": 1, "x": 2, "z": 3}
BITS_TO_SYMBOL = "01xz"

SUMMARY_CHANGED = 1 << 0
SUMMARY_HAS_X = 1 << 1
SUMMARY_HAS_Z = 1 << 2
SUMMARY_DENSE = 1 << 3


class VcdIndexError(ValueError):
    pass


def packed_value_size(width: int) -> int:
    if not isinstance(width, int) or width <= 0:
        raise VcdIndexError("signal width must be a positive integer")
    return (width * 2 + 7) // 8


def normalize_logic_value(value: str, width: int) -> str:
    packed_value_size(width)
    normalized = str(value or "").strip().lower()
    if normalized.startswith("b"):
        normalized = normalized[1:]
    if not normalized:
        normalized = "x"
    if any(symbol not in SYMBOL_TO_BITS for symbol in normalized):
        raise VcdIndexError(f"unsupported logic value: {value!r}")
    if len(normalized) == 1 and width > 1 and normalized in "xz":
        normalized *= width
    else:
        normalized = normalized.rjust(width, "0")[-width:]
    return normalized


def pack_logic_value(value: str, width: int) -> bytes:
    normalized = normalize_logic_value(value, width)
    size = packed_value_size(width)
    packed = bytearray(size)
    slots = size * 4
    for index, symbol in enumerate(normalized):
        shift = (slots - index - 1) * 2
        byte_index = (size * 8 - shift - 2) // 8
        bit_offset = shift % 8
        packed[byte_index] |= SYMBOL_TO_BITS[symbol] << bit_offset
    return bytes(packed)


def unpack_logic_value(packed: bytes, width: int) -> str:
    size = packed_value_size(width)
    if len(packed) != size:
        raise VcdIndexError(
            f"packed value length {len(packed)} does not match width {width}"
        )
    slots = size * 4
    symbols = []
    for index in range(width):
        shift = (slots - index - 1) * 2
        byte_index = (size * 8 - shift - 2) // 8
        bit_offset = shift % 8
        symbols.append(BITS_TO_SYMBOL[(packed[byte_index] >> bit_offset) & 0b11])
    return "".join(symbols)


def _validate_timestamp(timestamp: int) -> int:
    if not isinstance(timestamp, int) or timestamp < 0:
        raise VcdIndexError("timestamp must be a non-negative integer")
    if timestamp > MAX_WEB_TIMESTAMP:
        raise VcdIndexError(
            f"timestamp {timestamp} exceeds the exact WebView integer range"
        )
    return timestamp


@dataclass(frozen=True)
class RawRecordCodec:
    width: int

    def __post_init__(self) -> None:
        packed_value_size(self.width)

    @property
    def value_size(self) -> int:
        return packed_value_size(self.width)

    @property
    def record_size(self) -> int:
        return 8 + self.value_size

    def encode(self, timestamp: int, value: str) -> bytes:
        return struct.pack("<Q", _validate_timestamp(timestamp)) + pack_logic_value(
            value, self.width
        )

    def decode(self, record: bytes) -> tuple[int, str]:
        if len(record) != self.record_size:
            raise VcdIndexError("raw record has an invalid length")
        timestamp = struct.unpack_from("<Q", record, 0)[0]
        _validate_timestamp(timestamp)
        return timestamp, unpack_logic_value(record[8:], self.width)


@dataclass(frozen=True)
class SummaryRecordCodec:
    width: int

    def __post_init__(self) -> None:
        packed_value_size(self.width)

    @property
    def value_size(self) -> int:
        return packed_value_size(self.width)

    @property
    def record_size(self) -> int:
        return 17 + 2 * self.value_size

    def encode(
        self,
        first_time: int,
        last_time: int,
        first_value: str,
        last_value: str,
        flags: int,
    ) -> bytes:
        if not isinstance(flags, int) or not 0 <= flags <= 0xFF:
            raise VcdIndexError("summary flags must fit in one byte")
        return b"".join(
            (
                struct.pack(
                    "<QQ",
                    _validate_timestamp(first_time),
                    _validate_timestamp(last_time),
                ),
                pack_logic_value(first_value, self.width),
                pack_logic_value(last_value, self.width),
                bytes([flags]),
            )
        )

    def decode(self, record: bytes) -> tuple[int, int, str, str, int]:
        if len(record) != self.record_size:
            raise VcdIndexError("summary record has an invalid length")
        first_time, last_time = struct.unpack_from("<QQ", record, 0)
        _validate_timestamp(first_time)
        _validate_timestamp(last_time)
        value_size = self.value_size
        first_start = 16
        last_start = first_start + value_size
        return (
            first_time,
            last_time,
            unpack_logic_value(record[first_start:last_start], self.width),
            unpack_logic_value(
                record[last_start : last_start + value_size], self.width
            ),
            record[-1],
        )


def validate_manifest(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise VcdIndexError("manifest must be an object")
    if value.get("formatVersion") != INDEX_VERSION:
        raise VcdIndexError("unsupported waveform index version")
    if not isinstance(value.get("dataFile"), str) or not value["dataFile"]:
        raise VcdIndexError("manifest dataFile must be a non-empty string")
    if not isinstance(value.get("streams"), list):
        raise VcdIndexError("manifest streams must be an array")
    if not isinstance(value.get("signals"), list):
        raise VcdIndexError("manifest signals must be an array")
    return dict(value)
