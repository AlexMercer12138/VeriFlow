from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.domain.services.dep_analyzer_service import DependencyAnalyzerService
from src.domain.services.port_parser_service import PortParserService
from src.infrastructure.file_service import FileService


FIXTURE_MANIFEST = ROOT / "tests" / "benchmarks" / "hdl-fixtures.json"


def benchmark_hdl_baseline(repetitions: int) -> dict:
    manifest = json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))
    parser = PortParserService(FileService())
    analyzer = DependencyAnalyzerService(FileService())
    parse_samples = []
    index_samples = []

    for _ in range(repetitions):
        started = time.perf_counter()
        for fixture in manifest["files"]:
            parser.parse_file(str(ROOT / fixture))
        parse_samples.append(time.perf_counter() - started)

        started = time.perf_counter()
        analyzer.resolve(manifest["topModule"], [ROOT / "tests" / "project_test"])
        index_samples.append(time.perf_counter() - started)

    return {
        "schemaVersion": 1,
        "repetitions": repetitions,
        "parseMedianSeconds": statistics.median(parse_samples),
        "indexMedianSeconds": statistics.median(index_samples),
        "fixtureManifest": FIXTURE_MANIFEST.relative_to(ROOT).as_posix(),
        "environment": {
            "platform": platform.platform(),
            "python": sys.version,
        },
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark the pre-migration regex HDL services"
    )
    parser.add_argument("--repetitions", type=int, default=7)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = benchmark_hdl_baseline(args.repetitions)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    output.write_text(f"{rendered}\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
