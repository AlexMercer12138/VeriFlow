# Vik-VeriFlow

Vik-VeriFlow 是面向 Verilog/SystemVerilog 项目的一键分析、仿真与可视化设计工具。项目提供 `veriflow` Node CLI 和 **Verilog Design Flow** VS Code 扩展，两种产品共享同一套 TypeScript 核心能力。

## 功能

- 管理工程、全局库目录和顶层模块
- 扫描 HDL 模块并生成依赖与编译顺序
- 调用 Icarus Verilog、VCS、XSim 或自定义命令完成编译仿真
- 使用内置查看器打开 VCD 波形，也可调用 Surfer、GTKWave 或自定义查看器
- 在 VS Code 中浏览模块、编辑原理图、生成 Testbench，并完成分析、仿真和波形查看

## 环境要求

- CLI 与源码开发：Node.js `24.14.1` 或更高版本、npm
- VS Code 扩展：VS Code `1.82.0` 或更高版本
- 仿真：安装至少一种受支持的 HDL 仿真器；推荐开源的 Icarus Verilog

内置波形查看器无需额外安装。CLI 安装包包含 Electron 波形窗口，因此体积会大于普通命令行工具。

## CLI 使用

全局安装：

```bash
npm install -g @veriflow/cli
veriflow --help
```

创建工程并执行完整流程：

```bash
veriflow project new --name demo --root ./rtl --top top --output project.json
veriflow analyze --project project.json
veriflow sim --project project.json
veriflow wave --project project.json
```

常用管理命令：

```bash
veriflow project open --project project.json
veriflow project show --project project.json
veriflow lib add --lib ./shared_libs
veriflow lib list
veriflow top set --project project.json --top top_tb
veriflow top get --project project.json
```

所有命令均支持 `--help`，例如 `veriflow sim --help`。

## VS Code 扩展

在扩展商店搜索 **Verilog Design Flow**，或从 [GitHub Releases](https://github.com/AlexMercer12138/Vik-VeriFlow/releases) 下载 `.vsix` 后手动安装。

基本流程：

1. 打开包含 `.v` 或 `.sv` 文件的工作区。
2. 从活动栏进入 **VeriFlow**，扫描模块并选择顶层模块。
3. 执行 **Analyze Dependencies** 或 **Compile & Simulate**。
4. 执行 **Open Waveform** 查看仿真生成的 VCD 文件。

`.vcd` 文件也可以直接使用 **VeriFlow Waveform Viewer** 打开。原理图编辑、模块例化和 Testbench 生成可从 VeriFlow 视图、编辑器右键菜单或命令面板进入。

常用设置包括 `veriflow.libDirs`、`veriflow.defines`、`veriflow.simulator`、`veriflow.waveViewer` 和 `veriflow.testbenchOutputDir`。

## 工程配置

CLI 工程使用 JSON 保存。相对路径以工程文件所在目录为基准：

```json
{
  "project_name": "demo",
  "project_root": "./rtl",
  "lib_dirs": ["./libs"],
  "top_module": "top",
  "simulator": "iverilog",
  "wave_viewer": "builtin",
  "wave_file_template": "{top_module}.vcd",
  "testbench_output_dir": "."
}
```

`simulator` 支持 `iverilog`、`vcs`、`xsim` 和 `custom`；`wave_viewer` 支持 `builtin`、`surfer`、`gtkwave` 和 `custom`。通过 `veriflow project new` 创建的文件会自动补齐默认命令模板。

## 源码开发

```bash
npm ci
npm run build
npm run test:shared
npm run test:cli
npm test --workspace veriflow-vscode
```

发布检查与打包：

```bash
npm run release -- --check
npm run release -- --package
```

## 发布与许可证

npm CLI 包名为 [`@veriflow/cli`](https://www.npmjs.com/package/@veriflow/cli)。npm tarball、VSIX 和校验和可在 [GitHub Releases](https://github.com/AlexMercer12138/Vik-VeriFlow/releases) 下载。

本项目采用 [MIT License](LICENSE)。
