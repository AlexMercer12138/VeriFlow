# VeriFlow - VS Code Extension

[简体中文](https://github.com/AlexMercer12138/VeriFlow/blob/main/veriflow-vscode/README_zh-CN.md)

<div align="center">

**Run a lightweight Verilog simulation flow inside VS Code: scan modules, analyze dependencies, compile, simulate, open waveforms, and generate testbenches.**

[![VS Code](https://img.shields.io/badge/VS_Code-^1.80.0-007ACC.svg)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6.svg)](https://www.typescriptlang.org/)

</div>

---

## Overview

VeriFlow is a VS Code extension for Verilog and SystemVerilog projects. It brings module scanning, dependency analysis, simulation execution, waveform opening, and Testbench generation into the VS Code sidebar.

The extension core is implemented in TypeScript, so the VS Code extension itself does not require a Python runtime.

## Preview

![Preview](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## Quick Start

### Requirements

- **VS Code 1.80+**
- **A Verilog simulator**, such as:
  - [Icarus Verilog](https://bleyer.org/icarus/) - open source, recommended
  - [Synopsys VCS](https://www.synopsys.com/verification/simulation/vcs.html)
  - [Xilinx XSim](https://www.xilinx.com/products/design-tools/vivado.html)
  - A custom simulator command
- **A waveform viewer** (optional), such as:
  - Built-in VeriFlow waveform viewer for `.vcd` files
  - [Surfer](https://surfer-project.org/) - open source, recommended
  - [GTKWave](https://gtkwave.sourceforge.net/)
  - A custom waveform viewer command

### Installation

Install `VeriFlow` from the VS Code Marketplace, or install a local `.vsix` package manually.

### Basic Flow

1. Open a folder that contains `.v` or `.sv` files.
2. Open the **VeriFlow** view from the Activity Bar.
3. VeriFlow scans modules automatically and groups them by directory.
4. Click **Select Top Module** and choose the top module.
5. Click **Analyze Dependencies** to resolve the compile order.
6. Click **Compile & Simulate** to run simulation.
7. Click **Open Waveform** to open the generated waveform file.

You can also open `.vcd` files directly in VS Code with **VeriFlow Waveform Viewer**.

## Module Instantiation

Run **VeriFlow: Instantiate Module** from the Command Palette, or choose **Instantiate Module** from a Verilog/SystemVerilog editor's context menu. Select a scanned workspace or library module, then insert the aligned instantiation at the cursor or copy it to the clipboard. Modules with the same name are listed separately by source path.

---

## Testbench Generator

The **Testbench Generator** view can generate a Verilog testbench from scanned modules.

### Options

| Option | Description | Default |
|--------|-------------|---------|
| **Name** | Testbench module name | `tb_top` |
| **Unit / Prec** | `timescale` time unit and precision | `1ns` / `1ps` |
| **Clocks** | Clock frequency in MHz, up to 6 clocks | `100` |
| **Reset** | Reset polarity and duration | Active Low / `100` |
| **DUT Modules** | Modules instantiated in the testbench, including repeated instances | - |
| **Ports** | Parsed module ports with editable signal names | - |
| **Parameters** | Parsed module parameters with editable values | - |
| **Waveform** | Waveform file name | `{name}.vcd` |
| **Timeout** | Simulation timeout in ns | `1000000` |

### Usage

1. Click `+` in **DUT Modules** and select the modules to instantiate.
2. Select a DUT module and edit its port connections and parameter values.
3. Configure clocks, reset, waveform, and timeout options.
4. Click **Generate Testbench** to create and open the testbench file.

Generated testbenches are written to the workspace root by default. Set `veriflow.testbenchOutputDir` to write them into a workspace-relative subdirectory. VeriFlow creates the directory if it does not exist.

---

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `veriflow.libDirs` | `string[]` | `[]` | Library directories used for module search and dependency resolution |
| `veriflow.simulator` | `enum` | `iverilog` | Simulator: `iverilog` / `vcs` / `xsim` / `custom` |
| `veriflow.waveViewer` | `enum` | `builtin` | Waveform viewer: `builtin` / `surfer` / `gtkwave` / `custom` |
| `veriflow.simulatorCompileCmd` | `string` | `""` | Custom compile command template. Supports `{files}` `{output}` `{top_module}` |
| `veriflow.simulatorRunCmd` | `string` | `""` | Custom run command template. Supports `{output}` |
| `veriflow.waveViewerCmd` | `string` | `""` | Custom waveform viewer command template. Supports `{wave_file}` |
| `veriflow.waveFileTemplate` | `string` | `{top_module}.vcd` | Waveform file path template. Supports `{top_module}` |
| `veriflow.testbenchOutputDir` | `string` | `.` | Testbench output directory, resolved from the workspace root |

---

## Sidebar

The sidebar contains two views.

### VeriFlow

The title bar actions are:

- **Select Top Module** - choose the top module from scanned modules
- **Analyze Dependencies** - analyze dependencies and generate compile order
- **Compile & Simulate** - compile and run simulation
- **Open Waveform** - open the configured waveform viewer
- **Scan Modules** - rescan the workspace

The module list refreshes when the VeriFlow view is opened, when the Testbench Generator is opened, when a testbench is generated, and when workspace files or relevant settings change.

### Testbench Generator

This view contains:

- **Properties** - testbench name and timescale
- **Clocks** - clock frequency configuration
- **Reset** - reset polarity and duration
- **DUT Modules** - module selection, port editing, and parameter editing
- **Waveform** - waveform file configuration
- **Timeout** - simulation timeout configuration

---

## Built-in Waveform Viewer

VeriFlow can preview `.vcd` files inside VS Code.

Ways to open it:

- Open a `.vcd` file and choose **VeriFlow Waveform Viewer**.
- Right-click a `.vcd` file and run **Open VCD in VeriFlow Viewer**.
- Set `veriflow.waveViewer` to `builtin`, then use **Open Waveform** after simulation.

The current viewer is an early prototype. It supports signal search, time grid, cursor, zoom, pan, single-bit signals, bus signals, and dense waveform aggregation.

---

## Output Panel

Simulation output is written to the VS Code **Output** panel under the `VeriFlow` channel.

Messages are grouped by level:

- `[INFO]` - normal information
- `[OK]` - successful operation
- `[WARN]` - warning
- `[ERROR]` - error message, including file and line references when available

---

## Built-in Simulator Commands

| Simulator | Compile command template | Run command template |
|-----------|--------------------------|----------------------|
| iverilog | `iverilog -o "{output}" {files}` | `vvp "{output}"` |
| vcs | `vcs -full64 -o "{output}" {files}` | `./"{output}"` |
| xsim | `xvlog {files} && xelab {top_module} -snapshot "{output}"` | `xsim "{output}" --runall` |
| custom | User-defined | User-defined |

## Custom Simulator Example

```json
{
  "veriflow.simulator": "custom",
  "veriflow.simulatorCompileCmd": "verilator --cc --exe --build -j -o {output} {files}",
  "veriflow.simulatorRunCmd": "{output}",
  "veriflow.waveViewer": "custom",
  "veriflow.waveViewerCmd": "gtkwave {wave_file} &",
  "veriflow.libDirs": [
    "/path/to/shared/libs",
    "/path/to/vip"
  ]
}
```

---

## License

MIT

---

## Feedback

Issues and suggestions are welcome on [GitHub Issues](https://github.com/AlexMercer12138/VeriFlow/issues).
