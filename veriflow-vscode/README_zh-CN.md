# Verilog Design Flow（VeriFlow）

[English](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/veriflow-vscode/README.md)

Verilog Design Flow 将 Verilog/SystemVerilog 常用工作流集成到 VS Code：扫描模块、分析依赖、编译仿真、查看原理图和 VCD 波形、例化模块以及生成 Testbench。

![VeriFlow 功能预览](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## 环境要求

- VS Code 1.82 或更高版本
- Icarus Verilog、VCS、XSim 或自定义仿真命令
- 使用内置 VCD 查看器时无需安装外部波形工具

## 快速开始

1. 打开包含 `.v` 或 `.sv` 文件的工作区。
2. 从活动栏进入 **VeriFlow** 并选择顶层模块。
3. 执行 **Analyze Dependencies** 或 **Compile & Simulate**。
4. 执行 **Open Waveform** 查看生成的 VCD。

`.vcd` 文件也可以直接使用 **VeriFlow Waveform Viewer** 打开。

## 原理图

对 `.v` 或 `.sv` 文件执行 **Open as VeriFlow Schematic**。输入位于左侧、输出位于右侧，模块输入引脚和输出引脚分别固定在模块左右两边。模块按稳定列布局，网络使用正交通道，反馈连接使用上下外轨。

原理图支持搜索、缩放、minimap、整网选择、列吸附拖动和 **Relayout schematic**。布局单独保存，不会改写 HDL 源码。

## 其他命令

- **Select Top Module**
- **Scan Modules**
- **Instantiate Module**
- **Open VCD in VeriFlow Viewer**
- Testbench Generator 中的 **Generate Testbench**

## 常用设置

| 设置 | 用途 |
|---|---|
| `veriflow.libDirs` | HDL 库目录 |
| `veriflow.defines` | SystemVerilog 预处理宏 |
| `veriflow.simulator` | `iverilog`、`vcs`、`xsim` 或 `custom` |
| `veriflow.waveViewer` | `builtin`、`surfer`、`gtkwave` 或 `custom` |
| `veriflow.waveFileTemplate` | 波形文件路径模板 |
| `veriflow.testbenchOutputDir` | 工作区相对 Testbench 输出目录 |

自定义仿真器和波形查看器命令可在 VS Code 设置中配置。

## 许可证

MIT
