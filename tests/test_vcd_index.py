from __future__ import annotations

import json
from pathlib import Path

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
from src.domain.services.vcd_index_service import VcdIndexReader, build_vcd_index


ROOT = Path(__file__).resolve().parents[1]
WAVEFORM_FIXTURE = ROOT / "tests" / "fixtures" / "waveform_debug.vcd"
INDEX_EXPECTED = ROOT / "tests" / "fixtures" / "waveform_index_expected.json"


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


def test_builds_two_pass_index_and_reads_raw_streams(tmp_path: Path) -> None:
    metadata_events: list[dict] = []
    progress_events: list[dict] = []
    index_dir = tmp_path / "index"

    manifest = build_vcd_index(
        WAVEFORM_FIXTURE,
        index_dir,
        on_metadata=metadata_events.append,
        on_progress=progress_events.append,
    )

    assert len(metadata_events) == 1
    assert metadata_events[0]["timescale"] == "10ns"
    assert len(metadata_events[0]["signals"]) == 6
    assert manifest["endTime"] == 20
    assert (index_dir / "manifest.json").is_file()
    assert (index_dir / "waveform.vfi").read_bytes().startswith(b"VFI1")
    assert progress_events[0]["phase"] == "scan"
    assert progress_events[-1]["phase"] == "complete"

    streams = sorted(manifest["streams"], key=lambda stream: stream["rawOffset"])
    for left, right in zip(streams, streams[1:]):
        left_end = left["rawOffset"] + left["count"] * left["rawRecordSize"]
        assert left_end <= right["rawOffset"]

    reader = VcdIndexReader(index_dir)
    expected = json.loads(INDEX_EXPECTED.read_text(encoding="utf-8"))
    assert reader.metadata["timescale"] == expected["timescale"]
    assert reader.metadata["endTime"] == expected["endTime"]
    assert reader.raw_changes_for_reference("clk") == [tuple(item) for item in expected["clk"]]
    assert reader.raw_changes_for_reference("data [3:0]") == [
        tuple(item) for item in expected["data"]
    ]


def test_aliases_share_one_index_stream(tmp_path: Path) -> None:
    source = tmp_path / "alias.vcd"
    source.write_text(
        """$timescale 1ns $end
$scope module top $end
$var wire 1 ! a $end
$var wire 1 ! alias_a $end
$upscope $end
$enddefinitions $end
#0
0!
#5
1!
""",
        encoding="utf-8",
    )

    manifest = build_vcd_index(source, tmp_path / "alias-index")

    assert len(manifest["streams"]) == 1
    assert len(manifest["signals"]) == 2
    assert {signal["stream"] for signal in manifest["signals"]} == {0}
