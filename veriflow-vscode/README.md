# Verilog Design Flow (VeriFlow)

[简体中文](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/veriflow-vscode/README_zh-CN.md)

Verilog Design Flow brings a focused Verilog/SystemVerilog workflow into VS Code: scan modules, analyze dependencies, compile and simulate, inspect schematics, open VCD waveforms, instantiate modules, and generate testbenches.

![VeriFlow preview](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## Requirements

- VS Code 1.82 or newer
- A simulator: Icarus Verilog, VCS, XSim, or custom commands
- A waveform viewer only when not using the built-in VCD viewer

## Quick Start

1. Open a workspace containing `.v` or `.sv` files.
2. Open **VeriFlow** from the Activity Bar and select the top module.
3. Run **Analyze Dependencies** or **Compile & Simulate**.
4. Run **Open Waveform** to inspect the generated VCD.

You can also open `.vcd` files directly with **VeriFlow Waveform Viewer**.

## Schematic View

Run **Open as VeriFlow Schematic** on a `.v` or `.sv` file. VeriFlow places inputs on the left, outputs on the right, and module pins on their matching side. Modules are arranged in deterministic columns; networks use orthogonal channel routing and top/bottom outer lanes for feedback.

The view supports search, zoom, minimap, whole-network selection, column-snapped dragging, and **Relayout schematic**. Layout changes are stored separately and do not rewrite HDL source.

## Other Commands

- **Select Top Module**
- **Scan Modules**
- **Instantiate Module**
- **Open VCD in VeriFlow Viewer**
- **Generate Testbench** from the Testbench Generator view

## Settings

| Setting | Purpose |
|---|---|
| `veriflow.libDirs` | HDL library directories |
| `veriflow.defines` | SystemVerilog preprocessor definitions |
| `veriflow.simulator` | `iverilog`, `vcs`, `xsim`, or `custom` |
| `veriflow.waveViewer` | `builtin`, `surfer`, `gtkwave`, or `custom` |
| `veriflow.waveFileTemplate` | Generated waveform path template |
| `veriflow.testbenchOutputDir` | Workspace-relative testbench output directory |

Custom simulator and viewer command templates are available in VS Code settings.

## License

MIT
