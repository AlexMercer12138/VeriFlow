from __future__ import annotations

import json
import base64
import os
import shutil
from pathlib import Path

import pytest

from src.domain.services.vcd_index_format import (
    INDEX_VERSION,
    MAX_WEB_TIMESTAMP,
    RawRecordCodec,
    SUMMARY_CHANGED,
    SUMMARY_HAS_X,
    SUMMARY_HAS_Z,
    SummaryRecordCodec,
    VcdIndexError,
    pack_logic_value,
    unpack_logic_value,
    validate_manifest,
)
from src.domain.services.vcd_index_service import (
    VcdIndexCancelled,
    VcdIndexReader,
    build_vcd_index,
)
from src.infrastructure.waveform_cache import (
    WaveformCache,
    _CacheLock,
    source_fingerprint,
)
from scripts.benchmark_waveform_index import benchmark_waveform_index
from scripts.generate_waveform_benchmark import generate_waveform_benchmark


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


@pytest.fixture
def index_reader(tmp_path: Path) -> VcdIndexReader:
    index_dir = tmp_path / "query-index"
    build_vcd_index(WAVEFORM_FIXTURE, index_dir)
    return VcdIndexReader(index_dir)


def _decode_series_values(series: dict) -> list[str]:
    raw = base64.b64decode(series["values"])
    stride = series["valueStride"]
    width = series["width"]
    return [
        unpack_logic_value(raw[index : index + stride], width)
        for index in range(0, len(raw), stride)
    ]


def test_raw_window_includes_boundary_value(index_reader: VcdIndexReader) -> None:
    series = index_reader.query_window_for_reference("clk", 7, 12, pixel_width=32)

    assert series["kind"] == "raw"
    assert series["times"] == [5, 10]
    assert _decode_series_values(series) == ["1", "0"]


def test_full_range_uses_summary_with_xz_flags(index_reader: VcdIndexReader) -> None:
    series = index_reader.query_window_for_reference(
        "data [3:0]", 0, 20, pixel_width=1
    )

    assert series["kind"] == "summary"
    assert len(series["firstTimes"]) <= 2
    assert series["flags"][0] & SUMMARY_CHANGED
    assert series["flags"][0] & SUMMARY_HAS_X
    assert series["flags"][0] & SUMMARY_HAS_Z


def test_cursor_values_are_exact(index_reader: VcdIndexReader) -> None:
    assert index_reader.values_at(["clk", "data [3:0]", "ready"], 11) == {
        "clk": "0",
        "data [3:0]": "1010",
        "ready": "0",
    }


def test_searches_raw_changes_and_bus_bits(index_reader: VcdIndexReader) -> None:
    assert index_reader.search("clk", 0, 1, "rising")["time"] == 5
    assert index_reader.search("clk", 12, -1, "falling")["time"] == 10
    assert index_reader.search("data [3:0]", 0, 1, "value", "0xA")["time"] == 6
    assert index_reader.search("data [3:0]", 6, 1, "xz")["time"] == 12
    assert index_reader.search(
        "data [3:0]", 0, 1, "rising", bit_index=1
    )["time"] == 6
    assert index_reader.search("clk", 20, 1, "change") is None


def test_query_cancellation(index_reader: VcdIndexReader) -> None:
    with pytest.raises(VcdIndexCancelled):
        index_reader.query_window_for_reference(
            "clk", 0, 20, pixel_width=32, cancelled=lambda: True
        )


def test_source_fingerprint_detects_sampled_rewrite(tmp_path: Path) -> None:
    source = tmp_path / "large.vcd"
    fixed_mtime_ns = 1_700_000_000_123_456_700
    source.write_bytes(b"a" * (64 * 1024) + b"middle" + b"z" * (64 * 1024))
    os.utime(source, ns=(fixed_mtime_ns, fixed_mtime_ns))
    before = source_fingerprint(source)

    source.write_bytes(b"b" + source.read_bytes()[1:-1] + b"y")
    os.utime(source, ns=(fixed_mtime_ns, fixed_mtime_ns))
    after = source_fingerprint(source)

    assert before.size == after.size
    assert before.mtime_ns == after.mtime_ns
    assert before.head_sha256 != after.head_sha256
    assert before.tail_sha256 != after.tail_sha256
    assert before.key != after.key
    if os.name == "nt":
        assert before.normalized_path == before.normalized_path.lower().replace("\\", "/")


def test_waveform_cache_reuses_recovers_cleans_and_evicts(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    cache = WaveformCache(root=cache_root)
    source_one = tmp_path / "one.vcd"
    source_two = tmp_path / "two.vcd"
    shutil.copyfile(WAVEFORM_FIXTURE, source_one)
    shutil.copyfile(WAVEFORM_FIXTURE, source_two)
    source_two.write_text(
        source_two.read_text(encoding="utf-8") + "#21\n1#\n",
        encoding="utf-8",
    )

    first = cache.get_or_build(source_one)
    data_mtime_ns = (first / "waveform.vfi").stat().st_mtime_ns
    assert cache.get_or_build(source_one) == first
    assert (first / "waveform.vfi").stat().st_mtime_ns == data_mtime_ns
    cache.release(first)
    (first / "waveform.vfi").write_bytes(b"BAD!")
    assert cache.get_or_build(source_one) == first
    assert (first / "waveform.vfi").read_bytes().startswith(b"VFI1")
    cache.release(first)

    second_fingerprint = source_fingerprint(source_two)
    cache_root.mkdir(parents=True, exist_ok=True)
    (cache_root / f"{second_fingerprint.key}.lock").write_text(
        json.dumps({"pid": 999_999_999, "heartbeatMs": 0, "token": "stale"}),
        encoding="utf-8",
    )
    second = cache.get_or_build(source_two)
    assert second.name == second_fingerprint.key
    assert not (cache_root / f"{second_fingerprint.key}.lock").exists()
    cache.release(second)

    cancelled_source = tmp_path / "cancelled.vcd"
    shutil.copyfile(WAVEFORM_FIXTURE, cancelled_source)
    with pytest.raises(VcdIndexCancelled):
        cache.get_or_build(cancelled_source, cancelled=lambda: True)
    assert not any(".tmp." in entry.name or entry.suffix == ".lock" for entry in cache_root.iterdir())

    first_manifest = json.loads((first / "manifest.json").read_text(encoding="utf-8"))
    second_manifest = json.loads((second / "manifest.json").read_text(encoding="utf-8"))
    first_manifest["lastAccessNs"] = "1"
    second_manifest["lastAccessNs"] = "2"
    (first / "manifest.json").write_text(json.dumps(first_manifest), encoding="utf-8")
    (second / "manifest.json").write_text(json.dumps(second_manifest), encoding="utf-8")
    first_size = sum(item.stat().st_size for item in first.rglob("*") if item.is_file())
    second_size = sum(item.stat().st_size for item in second.rglob("*") if item.is_file())
    cache.max_bytes = max(first_size, second_size)

    cache.cleanup()

    assert not first.exists()
    assert second.exists()


def test_waveform_cache_reclaims_malformed_stale_lock(tmp_path: Path) -> None:
    lock_path = tmp_path / "broken.lock"
    lock_path.write_text("{", encoding="utf-8")
    os.utime(lock_path, (1, 1))
    lock = _CacheLock(lock_path, stale_seconds=0.001)

    assert lock.acquire()
    lock.release()
    assert not lock_path.exists()


def test_benchmark_generator_and_report_are_deterministic(tmp_path: Path) -> None:
    first = tmp_path / "first.vcd"
    second = tmp_path / "second.vcd"
    first_result = generate_waveform_benchmark(
        first,
        changes=2_000,
        signals=8,
        seed=1234,
    )
    second_result = generate_waveform_benchmark(
        second,
        changes=2_000,
        signals=8,
        seed=1234,
    )

    assert first.read_bytes() == second.read_bytes()
    assert first_result == second_result
    assert first_result["changes"] == 2_000
    assert first_result["signals"] == 8
    text = first.read_text(encoding="ascii")
    declarations = [line for line in text.splitlines() if line.startswith("$var")]
    assert len(declarations) == 8
    identifiers = [line.split()[3] for line in declarations]
    assert len(set(identifiers)) == 7
    assert "declared_idle" in text
    assert "bx" in text
    assert "bz" in text

    report_path = tmp_path / "report.json"
    report = benchmark_waveform_index(first, report_path, query_count=8)
    assert json.loads(report_path.read_text(encoding="utf-8")) == report
    for key in (
        "sourceBytes",
        "changes",
        "metadataLatencySeconds",
        "buildSeconds",
        "indexBytes",
        "coldQueryMilliseconds",
        "warmQueryMilliseconds",
        "cancelLatencyMilliseconds",
        "peakMemoryBytes",
        "maxResponseRecords",
    ):
        assert key in report
    assert report["sourceBytes"] == first.stat().st_size
    assert report["changes"] == 2_000
    assert report["maxResponseRecords"] <= 2 * 512 * 8
    assert not any(path.name.endswith(".tmp") for path in tmp_path.iterdir())
