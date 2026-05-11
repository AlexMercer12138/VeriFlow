# -*- coding: utf-8 -*-
"""验证递归依赖分析功能"""
import sys
import tempfile
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.infrastructure.file_service import FileService
from src.domain.services.dep_analyzer_service import DependencyAnalyzerService


def create_test_files(tmpdir: Path):
    """创建多层嵌套例化的测试文件"""
    # top.v - 顶层模块，例化 mid1 和 mid2
    top_v = tmpdir / "top.v"
    top_v.write_text("""
module top (
    input clk,
    input rst_n,
    output [7:0] out
);
    wire [3:0] mid1_out;
    wire [3:0] mid2_out;

    mid1 u_mid1 (
        .clk(clk),
        .rst_n(rst_n),
        .out(mid1_out)
    );

    mid2 u_mid2 (
        .clk(clk),
        .rst_n(rst_n),
        .out(mid2_out)
    );

    assign out = {mid1_out, mid2_out};
endmodule
""", encoding="utf-8")

    # mid1.v - 中间模块1，例化 leaf1
    mid1_v = tmpdir / "mid1.v"
    mid1_v.write_text("""
module mid1 (
    input clk,
    input rst_n,
    output [3:0] out
);
    wire [1:0] leaf_out;

    leaf1 u_leaf1 (
        .clk(clk),
        .rst_n(rst_n),
        .out(leaf_out)
    );

    assign out = {leaf_out, leaf_out};
endmodule
""", encoding="utf-8")

    # mid2.v - 中间模块2，例化 leaf2
    mid2_v = tmpdir / "mid2.v"
    mid2_v.write_text("""
module mid2 (
    input clk,
    input rst_n,
    output [3:0] out
);
    wire [1:0] leaf_out;

    leaf2 u_leaf2 (
        .clk(clk),
        .rst_n(rst_n),
        .out(leaf_out)
    );

    assign out = {leaf_out, leaf_out};
endmodule
""", encoding="utf-8")

    # leaf1.v - 叶子模块1
    leaf1_v = tmpdir / "leaf1.v"
    leaf1_v.write_text("""
module leaf1 (
    input clk,
    input rst_n,
    output reg [1:0] out
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            out <= 2'b00;
        else
            out <= out + 1'b1;
    end
endmodule
""", encoding="utf-8")

    # leaf2.v - 叶子模块2
    leaf2_v = tmpdir / "leaf2.v"
    leaf2_v.write_text("""
module leaf2 (
    input clk,
    input rst_n,
    output reg [1:0] out
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            out <= 2'b00;
        else
            out <= out + 1'b1;
    end
endmodule
""", encoding="utf-8")


def test_recursive_dependencies():
    print("=== 测试递归依赖分析 ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        create_test_files(tmpdir_path)

        fs = FileService()
        dep = DependencyAnalyzerService(fs)

        result = dep.resolve('top', [tmpdir_path])

        print(f"顶层模块: {result.top_module}")
        print(f"分析成功: {result.success}")
        print(f"缺失模块: {result.missing_modules}")
        print(f"依赖图: {result.dep_graph}")
        print(f"文件列表: {[f.name for f in result.files]}")
        print(f"拓扑排序: {[f.name for f in result.get_compile_order()]}")

        assert result.success, f"存在缺失模块: {result.missing_modules}"
        assert 'top' in result.dep_graph, "顶层模块应在依赖图中"
        assert 'mid1' in result.dep_graph['top'], "top 应依赖 mid1"
        assert 'mid2' in result.dep_graph['top'], "top 应依赖 mid2"
        assert 'leaf1' in result.dep_graph['mid1'], "mid1 应依赖 leaf1"
        assert 'leaf2' in result.dep_graph['mid2'], "mid2 应依赖 leaf2"

        all_module_names = set(result.dep_graph.keys())
        assert all_module_names == {'top', 'mid1', 'mid2', 'leaf1', 'leaf2'}, \
            f"应包含所有5个模块，实际: {all_module_names}"

        file_names = {f.name for f in result.files}
        assert file_names == {'top.v', 'mid1.v', 'mid2.v', 'leaf1.v', 'leaf2.v'}, \
            f"应包含所有5个文件，实际: {file_names}"

        compile_order = [f.name for f in result.get_compile_order()]
        assert compile_order.index('leaf1.v') < compile_order.index('mid1.v'), \
            "leaf1.v 应在 mid1.v 之前编译"
        assert compile_order.index('leaf2.v') < compile_order.index('mid2.v'), \
            "leaf2.v 应在 mid2.v 之前编译"
        assert compile_order.index('mid1.v') < compile_order.index('top.v'), \
            "mid1.v 应在 top.v 之前编译"
        assert compile_order.index('mid2.v') < compile_order.index('top.v'), \
            "mid2.v 应在 top.v 之前编译"

        print("\n=== 所有测试通过！===")


def test_param_override():
    print("=== 测试参数覆盖例化 ===")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)

        top_v = tmpdir_path / "top.v"
        top_v.write_text("""
module top;
    leaf #(
        .WIDTH(16)
    ) u_leaf (
        .clk(clk),
        .out(out)
    );
endmodule
""", encoding="utf-8")

        leaf_v = tmpdir_path / "leaf.v"
        leaf_v.write_text("""
module leaf #(
    parameter WIDTH = 8
)(
    input clk,
    output [WIDTH-1:0] out
);
    assign out = {WIDTH{1'b0}};
endmodule
""", encoding="utf-8")

        fs = FileService()
        dep = DependencyAnalyzerService(fs)

        result = dep.resolve('top', [tmpdir_path])

        print(f"依赖图: {result.dep_graph}")
        assert result.success
        assert 'leaf' in result.dep_graph['top']

        print("=== 参数覆盖例化测试通过！===")


if __name__ == '__main__':
    test_recursive_dependencies()
    test_param_override()
