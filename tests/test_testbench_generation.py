# -*- coding: utf-8 -*-
from pathlib import Path

from src.domain.services.testbench_generator import TestbenchGenerator


def test_testbench_generator_creates_configured_output_dir(
    uart_project_dir: Path,
    golden_uart: dict,
) -> None:
    output_dir = uart_project_dir / "generated" / "tb"
    tb_spec = golden_uart["generated_testbench"]

    filepath = TestbenchGenerator().generate(
        {
            "name": tb_spec["name"],
            "modules": [
                {
                    "module_name": "uart_tx",
                    "instance_name": "u_tx0",
                    "filepath": str(uart_project_dir / "uart_tx.v"),
                    "port_signals": {
                        "clk": "clk",
                        "rst_n": "rst_n",
                        "tx_data": "tx_payload",
                    },
                    "param_values": {
                        "SYS_CLK_FREQ": "1_000_000",
                        "BAUD_RATE": "115200",
                    },
                }
            ],
            "wave_file": tb_spec["wave_file"],
        },
        output_dir,
    )

    generated = Path(filepath)
    content = generated.read_text(encoding="utf-8")

    assert generated == output_dir / f"{tb_spec['name']}.v"
    assert generated.exists()
    for snippet in tb_spec["required_snippets"]:
        assert snippet in content


def test_testbench_generator_skips_invalid_signal_declarations(
    uart_project_dir: Path,
) -> None:
    filepath = TestbenchGenerator().generate(
        {
            "name": "tb_invalid_signal",
            "modules": [
                {
                    "module_name": "uart_rx",
                    "instance_name": "u_rx0",
                    "filepath": str(uart_project_dir / "uart_rx.v"),
                    "port_signals": {
                        "rx_ready": "1'b1",
                        "uart_rx": "serial_line",
                    },
                    "param_values": {},
                }
            ],
        },
        uart_project_dir / "generated",
    )

    content = Path(filepath).read_text(encoding="utf-8")
    assert "wire 1'b1;" not in content
    assert ".rx_ready(1'b1)" in content
    assert "wire serial_line;" in content or "reg serial_line;" in content
