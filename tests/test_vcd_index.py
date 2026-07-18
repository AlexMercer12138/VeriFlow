from __future__ import annotations

import pytest

from src.domain.services.vcd_index_format import (
    INDEX_VERSION,
    MAX_WEB_TIMESTAMP,
    RawRecordCodec,
    SummaryRecordCodec,
    VcdIndexError,
    pack_logic_value,
    unpack_logic_value,
    validate_manifest,
)


@pytest.mark.parametrize(
    ("value", "width", "expected"),
    [
        ("1", 1, bytes([0x40])),
        ("10xz", 4, bytes([0x4B])),
        ("101010101", 9, bytes([0x44, 0x44, 0x40])),
        ("x", 9, bytes([0xAA, 0xAA, 0x80])),
    ],
)
def test_logic_value_round_trip(value: str, width: int, expected: bytes) -> None:
    packed = pack_logic_value(value, width)
    assert packed == expected
    normalized = value.lower()
    if len(normalized) == 1 and width > 1 and normalized in "xz":
        normalized *= width
    else:
        normalized = normalized.rjust(width, "0")[-width:]
    assert unpack_logic_value(packed, width) == normalized


def test_raw_record_round_trip() -> None:
    codec = RawRecordCodec(width=4)
    record = codec.encode(2**40 + 7, "10xz")

    assert codec.record_size == 9
    assert codec.decode(record) == (2**40 + 7, "10xz")


def test_summary_record_round_trip() -> None:
    codec = SummaryRecordCodec(width=4)
    record = codec.encode(
        first_time=5,
        last_time=12,
        first_value="1010",
        last_value="10xz",
        flags=0b1111,
    )

    assert codec.record_size == 19
    assert codec.decode(record) == (5, 12, "1010", "10xz", 0b1111)


def test_records_reject_unsafe_web_timestamp() -> None:
    codec = RawRecordCodec(width=1)

    with pytest.raises(VcdIndexError, match="timestamp"):
        codec.encode(MAX_WEB_TIMESTAMP + 1, "0")


def test_manifest_validation() -> None:
    manifest = validate_manifest(
        {
            "formatVersion": INDEX_VERSION,
            "dataFile": "waveform.vfi",
            "streams": [],
            "signals": [],
        }
    )
    assert manifest["formatVersion"] == INDEX_VERSION

    with pytest.raises(VcdIndexError, match="version"):
        validate_manifest({"formatVersion": INDEX_VERSION + 1})

    with pytest.raises(VcdIndexError, match="streams"):
        validate_manifest(
            {
                "formatVersion": INDEX_VERSION,
                "dataFile": "waveform.vfi",
                "streams": "invalid",
                "signals": [],
            }
        )
