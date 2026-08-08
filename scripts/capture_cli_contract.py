#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPOSITORY_ROOT))

from tests.cli_contract.harness import capture_case, load_contract


DEFAULT_CONTRACT = REPOSITORY_ROOT / "tests" / "cli_contract" / "cases.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture the Python CLI compatibility contract")
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--update", action="store_true", help="write captured results to the contract")
    args = parser.parse_args()

    contract = load_contract(args.contract)
    with tempfile.TemporaryDirectory(prefix="veriflow-cli-contract-") as temporary:
        root = Path(temporary)
        for case in contract["cases"]:
            case["expected"] = capture_case(case, root / case["id"])

    rendered = json.dumps(contract, indent=2, ensure_ascii=False) + "\n"
    if args.update:
        args.contract.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
