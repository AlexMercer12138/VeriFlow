def test_hdl_benchmark_manifest_resolves_all_inputs() -> None:
    import json
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    manifest = json.loads(
        (root / "tests/benchmarks/hdl-fixtures.json").read_text(encoding="utf-8")
    )

    assert manifest["schemaVersion"] == 1
    assert manifest["topModule"] == "uart_tb"
    assert all((root / item).is_file() for item in manifest["files"])


def test_hdl_benchmark_report_records_environment_and_positive_timings(
    tmp_path, monkeypatch, capsys
) -> None:
    import json
    import platform
    import sys

    from scripts import benchmark_hdl_baseline

    output = tmp_path / "reports" / "hdl-baseline.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "benchmark_hdl_baseline.py",
            "--repetitions",
            "1",
            "--output",
            str(output),
        ],
    )

    assert benchmark_hdl_baseline.main() == 0

    raw_report = output.read_text(encoding="utf-8")
    report = json.loads(raw_report)
    assert json.loads(capsys.readouterr().out) == report
    assert raw_report.endswith("\n")
    assert report["schemaVersion"] == 1
    assert report["repetitions"] == 1
    assert report["parseMedianSeconds"] > 0
    assert report["indexMedianSeconds"] > 0
    assert report["fixtureManifest"] == "tests/benchmarks/hdl-fixtures.json"
    assert report["environment"] == {
        "platform": platform.platform(),
        "python": sys.version,
    }
