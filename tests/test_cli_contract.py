from pathlib import Path
import subprocess
import sys

import pytest

from tests.cli_contract.harness import capture_case, load_contract


CONTRACT_PATH = Path(__file__).parent / "cli_contract" / "cases.json"
CONTRACT = load_contract(CONTRACT_PATH)
CASES = CONTRACT["cases"]


def test_capture_script_runs_from_repository_root() -> None:
    repository_root = Path(__file__).parent.parent
    result = subprocess.run(
        [sys.executable, "scripts/capture_cli_contract.py", "--help"],
        cwd=repository_root,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_contract_covers_every_leaf_command() -> None:
    leaves = {
        tuple(case["argv"][:2]) if case["argv"][0] in {"project", "lib", "top"}
        else (case["argv"][0],)
        for case in CASES
        if case["argv"] and not case["argv"][0].startswith("-")
    }
    assert {
        ("project", "new"),
        ("project", "open"),
        ("project", "show"),
        ("lib", "add"),
        ("lib", "remove"),
        ("lib", "list"),
        ("top", "set"),
        ("top", "get"),
        ("analyze",),
        ("sim",),
        ("wave",),
    }.issubset(leaves)


def test_contract_captures_required_failure_modes() -> None:
    cases_by_id = {case["id"]: case for case in CASES}
    expected_messages = {
        "project_open_missing_project": "Project file not found",
        "analyze_project_without_top": "Top module not set",
        "analyze_missing_module": "Missing modules: absent",
        "sim_unknown_simulator": "Unknown simulator: missing",
        "wave_missing_file": "Wave file not found",
    }
    for case_id, message in expected_messages.items():
        expected = cases_by_id[case_id]["expected"]
        assert expected["exit_code"] != 0
        assert message in expected["stdout"] + expected["stderr"]


def test_contract_capture_is_independent_of_terminal_width(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("COLUMNS", "40")
    case = next(case for case in CASES if case["id"] == "root_help")
    assert capture_case(case, tmp_path / case["id"]) == case["expected"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_python_cli_contract(case: dict, tmp_path: Path) -> None:
    assert case["expected"] is not None, (
        f"{case['id']} has not been captured; run scripts/capture_cli_contract.py --update"
    )
    assert capture_case(case, tmp_path / case["id"]) == case["expected"]
