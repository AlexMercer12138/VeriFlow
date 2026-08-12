# Verilog Design Flow (VeriFlow)

[简体中文](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/veriflow-vscode/README_zh-CN.md)

Verilog Design Flow brings module discovery, dependency analysis, simulation, waveform inspection, schematic browsing, and visual Arch Design editing into VS Code.

![VeriFlow preview](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## Requirements

- VS Code 1.82 or newer
- Icarus Verilog, VCS, XSim, or custom simulator commands for simulation
- No external waveform tool is required when using the built-in VCD viewer

## HDL Workflow

1. Open a workspace containing `.v` or `.sv` files.
2. Open **VeriFlow** from the Activity Bar and select the top module.
3. Run **Analyze Dependencies** or **Compile & Simulate**.
4. Run **Open Waveform** to inspect the generated VCD.

Open a `.vcd` file directly with **VeriFlow Waveform Viewer**. Run **Open as VeriFlow Schematic** on `.v` or `.sv` to inspect a read-only schematic with deterministic columns, orthogonal routing, search, zoom, minimap, network selection, and layout controls.

## Arch Design Editor

Create a valid `.ad` file, then open it to use the visual architecture editor. This is the minimal document; replace `soc_top` with the generated top-level module name:

```json
{
  "format": "vik-veriflow.arch-design",
  "schemaVersion": 1,
  "module": "soc_top",
  "ports": [],
  "instances": [],
  "connections": [],
  "interfaceConnections": [],
  "defaults": {},
  "export": {},
  "presentation": {}
}
```

Add module instances and top-level ports from the toolbar, enable connection mode, then drag from an output pin to an input pin. Select an instance, port, or network to edit its name, parameters, defaults, and export settings in the Inspector.

Use **Validate Arch Design** to check the current design and **Export Arch Design RTL** to generate RTL. Verilog is exported to a sibling `.v` file by default; SystemVerilog and a relative `.sv` output can be selected in the Inspector. Existing hand-written RTL is never overwritten.

`.ad` is the VeriFlow Arch Design format and does not claim Vivado Block Design compatibility. The current editor authors scalar connections. AXI/APB/AHB recognition, collapsed interfaces, and project-defined protocols are planned separately.

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
| `veriflow.testbenchOutputDir` | Workspace-relative Testbench output directory |

Custom simulator and waveform viewer commands are available in VS Code settings.

## License

MIT
