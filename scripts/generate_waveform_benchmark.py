from __future__ import annotations

import argparse
import os
from pathlib import Path


def _identifier(index: int) -> str:
    value = index
    result = ""
    while True:
        result = chr(33 + value % 94) + result
        value = value // 94 - 1
        if value < 0:
            return result


def generate_waveform_benchmark(
    output: Path,
    *,
    target_bytes: int = 0,
    changes: int = 0,
    signals: int = 64,
    seed: int = 1,
) -> dict:
    output = Path(output)
    target_bytes = max(0, int(target_bytes))
    changes = max(0, int(changes))
    signals = int(signals)
    if target_bytes == 0 and changes == 0:
        raise ValueError("target_bytes or changes must be positive")
    if signals < 4:
        raise ValueError("signals must be at least 4")

    changing_signals = signals - 2
    identifiers = [_identifier(index) for index in range(changing_signals + 1)]
    widths = [1 if index % 4 == 0 else (8, 16, 32)[(index - 1) % 3] for index in range(changing_signals)]
    output.parent.mkdir(parents=True, exist_ok=True)
    bytes_written = 0
    changes_written = 0
    state = int(seed) & 0xFFFFFFFF

    def write(handle, text: str) -> None:
        nonlocal bytes_written
        data = text.encode("ascii")
        handle.write(data)
        bytes_written += len(data)

    with output.open("wb", buffering=1024 * 1024) as handle:
        write(handle, "$date deterministic benchmark $end\n")
        write(handle, "$version VeriFlow benchmark generator $end\n")
        write(handle, "$timescale 1ns $end\n")
        write(handle, "$scope module benchmark $end\n")
        for index in range(changing_signals):
            width = widths[index]
            reference = f"signal_{index}" if width == 1 else f"signal_{index} [{width - 1}:0]"
            write(handle, f"$var wire {width} {identifiers[index]} {reference} $end\n")
        write(handle, f"$var wire 1 {identifiers[0]} alias_signal_0 $end\n")
        write(handle, f"$var wire 1 {identifiers[-1]} declared_idle $end\n")
        write(handle, "$upscope $end\n$enddefinitions $end\n")

        while changes_written < changes or bytes_written < target_bytes:
            timestamp = changes_written
            signal_index = changes_written % changing_signals
            width = widths[signal_index]
            state = (1664525 * state + 1013904223) & 0xFFFFFFFF
            if changes_written % 97 == 0:
                value = "x"
            elif changes_written % 193 == 0:
                value = "z"
            elif width == 1:
                value = "1" if state & 1 else "0"
            else:
                value = format(state & ((1 << width) - 1), f"0{width}b")
            write(handle, f"#{timestamp}\n")
            if width == 1:
                write(handle, f"{value}{identifiers[signal_index]}\n")
            else:
                write(handle, f"b{value} {identifiers[signal_index]}\n")
            changes_written += 1

        handle.flush()
        os.fsync(handle.fileno())

    return {
        "bytes": bytes_written,
        "changes": changes_written,
        "signals": signals,
        "seed": int(seed),
        "targetBytes": target_bytes,
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a deterministic waveform benchmark VCD")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-bytes", type=int, default=0)
    parser.add_argument("--changes", type=int, default=0)
    parser.add_argument("--signals", type=int, default=64)
    parser.add_argument("--seed", type=int, default=1)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    result = generate_waveform_benchmark(
        args.output,
        target_bytes=args.target_bytes,
        changes=args.changes,
        signals=args.signals,
        seed=args.seed,
    )
    print(
        f"generated {args.output}: {result['bytes']} bytes, "
        f"{result['changes']} changes, {result['signals']} signals"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
