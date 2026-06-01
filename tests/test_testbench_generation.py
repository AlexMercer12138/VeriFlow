# -*- coding: utf-8 -*-
from pathlib import Path

from src.domain.services.testbench_generator import TestbenchGenerator


def test_testbench_generator_creates_configured_output_dir(
    uart_project_dir: Path,
) -> None:
    output_dir = uart_project_dir / "generated" / "tb"

    filepath = TestbenchGenerator().generate(
        {
            "name": "tb_uart_generated",
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
            "wave_file": "waves/tb_uart_generated.vcd",
        },
        output_dir,
    )

    generated = Path(filepath)
    content = generated.read_text(encoding="utf-8")

    assert generated == output_dir / "tb_uart_generated.v"
    assert generated.exists()
    assert "module tb_uart_generated;" in content
    assert '        $dumpfile("waves/tb_uart_generated.vcd");' in content
    assert "uart_tx #(" in content
    assert ".SYS_CLK_FREQ(1_000_000)" in content
    assert ".tx_data(tx_payload)" in content


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

