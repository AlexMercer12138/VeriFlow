# -*- coding: utf-8 -*-
"""验证 Testbench 生成器对非法信号名的处理"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.infrastructure.file_service import FileService
from src.domain.services.port_parser_service import PortParserService
from src.domain.services.testbench_generator import TestbenchGenerator


def create_test_module(tmpdir: Path):
    """创建包含各种信号名的测试模块"""
    mod_v = tmpdir / "test_mod.v"
    mod_v.write_text("""
module test_mod (
    input        clk,
    input        rst_n,
    input  [7:0] data_in,
    output [7:0] data_out,
    output       valid
);
    assign data_out = data_in;
    assign valid = 1'b1;
endmodule
""", encoding="utf-8")
    return mod_v


def test_tb_generator_invalid_signal():
    print("=== 测试 Testbench 非法信号名处理 ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        mod_v = create_test_module(tmpdir_path)

        gen = TestbenchGenerator()
        config = {
            'name': 'tb_test',
            'time_unit': '1ns',
            'time_precision': '1ps',
            'clocks_mhz': ['100'],
            'reset_active_high': False,
            'reset_duration': '100',
            'modules': [{
                'module_name': 'test_mod',
                'instance_name': 'u_test_mod',
                'filepath': str(mod_v),
                'port_signals': {
                    'clk': 'clk',
                    'rst_n': 'rst_n',
                    'data_in': '8',           # 非法信号名：数字开头
                    'data_out': 'data_out',
                    'valid': '1',             # 非法信号名：数字开头
                },
                'param_values': {},
            }],
            'wave_file': 'tb_test.vcd',
            'timeout': '1000000',
        }

        output_dir = tmpdir_path
        filepath = gen.generate(config, output_dir)

        print(f"\n生成的 Testbench: {filepath}")
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        print(content)

        # 验证：合法信号名生成 reg/wire 声明
        assert 'reg clk = 0;' in content, "clk 应该生成 reg 声明"
        assert 'reg rst_n = 1' in content, "rst_n 应该生成 reg 声明"
        assert 'wire [7:0] data_out;' in content, "data_out 应该生成 wire 声明"

        # 验证：非法信号名（数字开头）不生成 reg/wire 声明
        assert 'reg [7:0] 8;' not in content, "'8' 不应该生成 reg 声明"
        assert 'wire 1;' not in content, "'1' 不应该生成 wire 声明"

        # 验证：例化时仍然连接非法信号名
        assert '.data_in(8)' in content, "data_in 应该连接到 '8'"
        assert '.valid(1)' in content, "valid 应该连接到 '1'"

        print("\n=== 所有测试通过！===")


if __name__ == '__main__':
    test_tb_generator_invalid_signal()
