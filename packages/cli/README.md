# Vik-VeriFlow CLI

The maintained Node.js command-line interface for Vik-VeriFlow Verilog design
workflows. It shares HDL analysis, simulation, and waveform components with the
VS Code extension.

## Install

```bash
npm install --global @veriflow/cli
veriflow --help
```

Node.js 24.14.1 or newer is required. The package includes the Electron
waveform host, so the installed size is larger than a typical command-line
package. Simulation and VCD viewing work without installing a separate HDL
simulator or waveform application: new projects use the bundled Icarus Verilog
WebAssembly runtime and the built-in waveform viewer by default.

The bundled simulator targets Verilog-2005. To use a local tool, select
`custom` in the project configuration and provide command templates. Existing
tool commands can be used as templates:

```text
Icarus Verilog: iverilog -g2005 -o "{output}" {files}; vvp "{output}"
VCS:             vcs -full64 -o "{output}" {files}; ./"{output}"
XSim:            xvlog {files} && xelab {top_module} -snapshot "{output}"; xsim "{output}" --runall
Surfer:          surfer "{wave_file}"
GTKWave:         gtkwave "{wave_file}"
```

The command templates use `{files}`, `{output}`, `{top_module}`, and
`{wave_file}` placeholders. The VS Code extension uses the same placeholder
syntax.

The bundled Icarus Verilog WebAssembly runtime is distributed under
`GPL-2.0-or-later`. See the
[license and corresponding-source details](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/docs/licenses/iverilog-wasm.md).

See the project repository for configuration and command documentation:
https://github.com/AlexMercer12138/Vik-VeriFlow
