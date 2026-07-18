from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.domain.services.vcd_index_service import (
    VcdIndexCancelled,
    VcdIndexReader,
    build_vcd_index,
)


def _percentiles(samples: list[float]) -> dict:
    ordered = sorted(samples)
    if not ordered:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0}

    def percentile(fraction: float) -> float:
        index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
        return round(ordered[index], 4)

    return {"p50": percentile(0.50), "p95": percentile(0.95), "p99": percentile(0.99)}


def _directory_size(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def benchmark_waveform_index(
    source: Path,
    output: Path,
    *,
    query_count: int = 32,
) -> dict:
    source = Path(source).resolve()
    output = Path(output)
    query_count = max(1, int(query_count))
    metadata_time = None

    with tempfile.TemporaryDirectory(prefix="veriflow-waveform-benchmark-") as temporary:
        root = Path(temporary)
        index_dir = root / "index"
        started = time.perf_counter()
        tracemalloc.start()

        def on_metadata(_metadata: dict) -> None:
            nonlocal metadata_time
            if metadata_time is None:
                metadata_time = time.perf_counter()

        manifest = build_vcd_index(source, index_dir, on_metadata=on_metadata)
        build_finished = time.perf_counter()
        _current_memory, peak_memory = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        reader = VcdIndexReader(index_dir)
        references = []
        for signal in manifest["signals"]:
            reference = signal["reference"]
            if reference not in references:
                references.append(reference)
            if len(references) == 8:
                break
        end_time = max(1, int(manifest.get("endTime", 1)))
        window_size = max(1, end_time // 20)
        queries = []
        for index in range(query_count):
            reference = references[index % len(references)]
            start = min(end_time - 1, (index * window_size) % end_time)
            queries.append((reference, start, min(end_time, start + window_size)))

        cold_samples = []
        warm_samples = []
        max_response_records = 0
        for reference, start, end in queries:
            query_started = time.perf_counter()
            response = reader.query_window_for_reference(
                reference,
                start,
                end,
                pixel_width=512,
            )
            cold_samples.append((time.perf_counter() - query_started) * 1000)
            max_response_records = max(
                max_response_records,
                len(response.get("times", response.get("firstTimes", []))),
            )
        for reference, start, end in queries:
            query_started = time.perf_counter()
            response = reader.query_window_for_reference(
                reference,
                start,
                end,
                pixel_width=512,
            )
            warm_samples.append((time.perf_counter() - query_started) * 1000)
            max_response_records = max(
                max_response_records,
                len(response.get("times", response.get("firstTimes", []))),
            )

        cancel_started = time.perf_counter()
        try:
            build_vcd_index(
                source,
                root / "cancelled-index",
                cancelled=lambda: True,
            )
        except VcdIndexCancelled:
            pass
        cancel_latency_ms = (time.perf_counter() - cancel_started) * 1000

        report = {
            "formatVersion": 1,
            "source": str(source),
            "sourceBytes": source.stat().st_size,
            "changes": sum(int(stream["count"]) for stream in manifest["streams"]),
            "signals": len(manifest["signals"]),
            "metadataLatencySeconds": round((metadata_time or build_finished) - started, 6),
            "buildSeconds": round(build_finished - started, 6),
            "indexBytes": _directory_size(index_dir),
            "coldQueryMilliseconds": _percentiles(cold_samples),
            "warmQueryMilliseconds": _percentiles(warm_samples),
            "cancelLatencyMilliseconds": round(cancel_latency_ms, 4),
            "peakMemoryBytes": peak_memory,
            "maxResponseRecords": max_response_records,
            "queryCount": query_count,
            "python": platform.python_version(),
            "meanColdQueryMilliseconds": round(statistics.fmean(cold_samples), 4),
            "meanWarmQueryMilliseconds": round(statistics.fmean(warm_samples), 4),
        }

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    try:
        with temporary_output.open("w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_output, output)
    finally:
        temporary_output.unlink(missing_ok=True)
    return report


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark the VeriFlow waveform disk index")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--queries", type=int, default=32)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = benchmark_waveform_index(args.source, args.output, query_count=args.queries)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
