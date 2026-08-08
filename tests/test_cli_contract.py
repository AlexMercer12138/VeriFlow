import argparse
from pathlib import Path
import subprocess
import sys

import pytest

from tests.cli_contract.harness import _normalize, capture_case, load_contract


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


def test_contract_covers_options_help_and_runtime_failures() -> None:
    case_ids = {case["id"] for case in CASES}
    assert {
        "root_help_short",
        "root_help_long",
        "version_short",
        "project_new_long_options",
        "analyze_project_overrides",
        "analyze_short_overrides",
        "sim_project_overrides",
        "sim_short_overrides",
        "sim_compile_failure",
        "sim_run_failure",
        "wave_external_viewer",
        "wave_unknown_viewer",
    }.issubset(case_ids)

    leaves = {
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
    }
    all_argv = {tuple(case["argv"]) for case in CASES}
    expected_help_argv = {
        (*command, flag)
        for command in leaves | {("project",), ("lib",), ("top",)}
        for flag in ("-h", "--help")
    }
    assert expected_help_argv.issubset(all_argv)
    assert {
        (), ("project",), ("lib",), ("top",),
        ("-h",), ("--help",), ("-v",), ("--version",),
    }.issubset(all_argv)

    aliases_by_leaf = {
        ("project", "new"): [
            ("-n", "--name"), ("-r", "--root"), ("-t", "--top"),
            ("-L", "--lib"), ("-s", "--sim"), ("-w", "--wave"),
            ("-o", "--output"),
        ],
        ("project", "open"): [("-p", "--project")],
        ("project", "show"): [("-p", "--project")],
        ("lib", "add"): [("-L", "--lib")],
        ("lib", "remove"): [("-L", "--lib")],
        ("top", "set"): [("-p", "--project"), ("-t", "--top")],
        ("top", "get"): [("-p", "--project")],
        ("analyze",): [
            ("-p", "--project"), ("-t", "--top"), ("-r", "--root"),
            ("-L", "--lib"), ("-s", "--sim"), ("-w", "--wave"),
        ],
        ("sim",): [
            ("-p", "--project"), ("-t", "--top"), ("-L", "--lib"),
            ("-s", "--sim"), ("-w", "--wave"),
        ],
        ("wave",): [("-p", "--project")],
    }
    for leaf, aliases in aliases_by_leaf.items():
        leaf_argv = [
            case["argv"][len(leaf):]
            for case in CASES
            if tuple(case["argv"][:len(leaf)]) == leaf
        ]
        for short, long in aliases:
            assert any(short in argv for argv in leaf_argv), f"{leaf} misses {short}"
            assert any(long in argv for argv in leaf_argv), f"{leaf} misses {long}"

    assert {
        "required_project_new_name",
        "required_project_open_project",
        "required_project_show_project",
        "required_lib_add_lib",
        "required_lib_remove_lib",
        "required_top_set_arguments",
        "required_top_get_project",
        "sim_missing_required_project",
        "required_wave_project",
    }.issubset(case_ids)


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


def test_contract_fixture_references_are_tracked() -> None:
    repository_root = Path(__file__).parent.parent
    fixture_paths = sorted({
        f"tests/cli_contract/fixtures/{entry['fixture']}"
        for case in CASES
        for entry in case.get("initial_files", [])
        if "fixture" in entry
    })
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", *fixture_paths],
        cwd=repository_root,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_contract_captures_exact_json_serialization() -> None:
    case = next(case for case in CASES if case["id"] == "project_new_relative_paths")
    raw = case["expected"]["observed_text"]["workspace/configs/demo.json"]
    assert raw.startswith('{\n  "project_name": "demo",\n')
    assert raw.endswith("\n}")
    assert not raw.endswith("\n")


def test_contract_normalization_only_normalizes_temporary_path_prefixes() -> None:
    value = {
        "stdout": "Root: C:\\contract\\workspace\\libs\\project\n",
        "observed_text": '"lib_dirs": ["C:\\\\contract\\\\workspace\\\\libs\\\\project"]',
        "metadata": r"pattern=\d+\w; source=rtl\top.v",
        "lookalike": r"C:\contract\workspace-old",
        "diagnostic": (
            "C:\\contract\\workspace\\libs\\project: "
            r"escaped=\signal regex=\d+\w"
        ),
    }

    assert _normalize(value, [(r"C:\contract\workspace", "<CWD>")]) == {
        "stdout": "Root: <CWD>/libs/project\n",
        "observed_text": '"lib_dirs": ["<CWD>/libs/project"]',
        "metadata": r"pattern=\d+\w; source=rtl\top.v",
        "lookalike": r"C:\contract\workspace-old",
        "diagnostic": r"<CWD>/libs/project: escaped=\signal regex=\d+\w",
    }


def test_contract_capture_is_independent_of_terminal_width(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("COLUMNS", "40")
    case = next(case for case in CASES if case["id"] == "root_help")
    assert capture_case(case, tmp_path / case["id"]) == case["expected"]


def test_cli_help_is_stable_when_argparse_repeats_option_metavars(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    def legacy_action_invocation(
        formatter: argparse.HelpFormatter,
        action: argparse.Action,
    ) -> str:
        if not action.option_strings:
            default = formatter._get_default_metavar_for_positional(action)
            return " ".join(formatter._metavar_formatter(action, default)(1))
        if action.nargs == 0:
            return ", ".join(action.option_strings)
        default = formatter._get_default_metavar_for_optional(action)
        return ", ".join(
            f"{option} {formatter._format_args(action, default)}"
            for option in action.option_strings
        )

    monkeypatch.setattr(
        argparse.HelpFormatter,
        "_format_action_invocation",
        legacy_action_invocation,
    )
    case = next(case for case in CASES if case["id"] == "help_top_get_short")

    assert capture_case(case, tmp_path / case["id"]) == case["expected"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_python_cli_contract(case: dict, tmp_path: Path) -> None:
    assert case["expected"] is not None, (
        f"{case['id']} has not been captured; run scripts/capture_cli_contract.py --update"
    )
    assert capture_case(case, tmp_path / case["id"]) == case["expected"]
