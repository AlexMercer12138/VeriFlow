# Verilog Design Flow (VeriFlow)

[简体中文](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/veriflow-vscode/README_zh-CN.md)

Verilog Design Flow brings module discovery, dependency analysis, simulation, waveform inspection, schematic browsing, and visual Arch Design editing into VS Code.

![VeriFlow preview](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## Requirements

- VS Code 1.82 or newer
- No external simulator is required: the default is the bundled Icarus Verilog WebAssembly runtime
- No external waveform tool is required: the default is the built-in VCD viewer

The bundled simulator targets Verilog-2005. Choose `custom` in the settings when
the project should invoke a local simulator or waveform application.

## HDL Workflow

1. Open a workspace containing `.v` or `.sv` files.
2. Open **VeriFlow** from the Activity Bar, then select the top module in **Simulation**.
3. Run **Analyze Dependencies** or **Compile & Simulate**.
4. Run **Open Waveform** to inspect the generated VCD.

Open a `.vcd` file directly with **VeriFlow Waveform Viewer**. Run **Open as VeriFlow Schematic** on `.v` or `.sv` to inspect a read-only schematic with deterministic columns, orthogonal routing, search, zoom, minimap, network selection, and layout controls.

## Arch Design Editor

In **Arch Designs**, select **Create Arch Design**, enter the top-level module name, and choose where to save the `.ad` file. The new design opens directly in the visual editor.

Add module instances and top-level ports from the toolbar. To connect them, click either endpoint and then click the other endpoint; you can pan the canvas between clicks. Select an instance, port, pin, network, or recognized interface to inspect and edit it.

Errors and warnings update live in the E/W counters and the Problems panel. The editor has one in-editor export action: **Export RTL** in the canvas toolbar. Validate and export are also available from each file's **Arch Designs** context menu and the Command Palette. Verilog is exported to a sibling `.v` file by default; SystemVerilog and a relative `.sv` output can be selected in the Inspector. Existing hand-written RTL is never overwritten.

`.ad` is the VeriFlow Arch Design format and does not claim Vivado Block Design compatibility.

The editor recognizes built-in AXI4, AXI-Stream, APB, and AHB-Lite interfaces from HDL port names and directions. AXI4-Lite is handled as an incomplete AXI4 interface. Interfaces can be collapsed, expanded, connected from Master to Slave, or exposed as top-level interfaces. Expanded members remain available as ordinary pins, including individual top-level promotion. Roles that cannot be inferred can be assigned in the Inspector.

Interface connections are intentionally one-to-one; use a dedicated interconnect module for fan-out. An output without a peer input remains open, while an input without a peer output uses the connection override or protocol default shown in the Inspector. Protocol definitions contain no widths: widths always come from HDL ports, and a Master/Slave mismatch produces a warning without blocking RTL export.

Project-defined protocol JSON files use the same recognition and export path as built-ins. Reference workspace-relative files from `project.json`:

```json
{
  "schematic": {
    "interface_protocols": ["protocols/my-bus.json"]
  }
}
```

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
| `veriflow.simulator` | `builtin` (bundled Icarus Verilog WASM) or `custom` |
| `veriflow.waveViewer` | `builtin` (VeriFlow VCD viewer) or `custom` |
| `veriflow.waveFileTemplate` | Generated waveform path template |
| `veriflow.testbenchOutputDir` | Workspace-relative Testbench output directory |

Custom command templates are available in VS Code settings. Examples:

```text
Icarus Verilog compile: iverilog -g2005 -o "{output}" {files}
Icarus Verilog run:     vvp "{output}"
VCS compile:            vcs -full64 -o "{output}" {files}
VCS run:                ./"{output}"
XSim compile:           xvlog {files} && xelab {top_module} -snapshot "{output}"
XSim run:               xsim "{output}" --runall
Surfer:                 surfer "{wave_file}"
GTKWave:                gtkwave "{wave_file}"
```

## License

The VeriFlow extension code is licensed under MIT. The bundled Icarus Verilog
WebAssembly runtime is distributed under `GPL-2.0-or-later`; see the
[license and corresponding-source details](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/docs/licenses/iverilog-wasm.md).
