# Vik-VeriFlow

Vik-VeriFlow 是面向 Verilog/SystemVerilog 工程的一键分析、仿真与可视化工具，提供 `veriflow` Node CLI 和 **Verilog Design Flow** VS Code 扩展。两种产品共享 TypeScript 核心组件。

## 主要功能

- 扫描 HDL 模块，分析层次依赖并生成稳定的编译顺序
- 使用 Icarus Verilog、VCS、XSim 或自定义命令完成一键仿真
- 内置 VCD 波形窗口，也可调用 Surfer、GTKWave 或自定义查看器
- 浏览 Verilog/SystemVerilog 原理图并编辑布局
- 校验 Arch Design 架构设计并导出 Verilog/SystemVerilog 顶层
- 在 VS Code 中选择顶层、例化模块、生成 Testbench

原理图会自动将输入放在左侧、输出放在右侧，模块输入引脚位于左边、输出引脚位于右边。模块按列排列，网络使用正交折线和独立通道，反馈连接走上下外轨；拖动模块会吸附到合法列，工具栏中的 **Relayout schematic** 可恢复自动布局。

## 安装

CLI 需要 Node.js `24.14.1` 或更高版本：

```bash
npm install --global @veriflow/cli
veriflow --help
```

CLI 包含 Electron 波形窗口，因此安装体积会大于普通命令行工具。仿真还需要至少安装一种 HDL 仿真器，推荐 Icarus Verilog。

VS Code 扩展可在扩展商店搜索 **Verilog Design Flow**，也可从 [GitHub Releases](https://github.com/AlexMercer12138/Vik-VeriFlow/releases) 下载 `.vsix` 安装。扩展要求 VS Code `1.82.0` 或更高版本。

## CLI 使用

创建工程：

```bash
veriflow project new --name demo --root ./rtl --top top --output project.json
```

分析、一键仿真并打开波形：

```bash
veriflow analyze --project project.json
veriflow sim --project project.json
veriflow wave --project project.json
```

常用工程命令：

```bash
veriflow project show --project project.json
veriflow lib add --lib ./shared_libs
veriflow lib list
veriflow top set --project project.json --top top_tb
veriflow top get --project project.json
```

校验并导出架构设计：

```bash
veriflow ad validate design/soc.ad
veriflow ad export design/soc.ad
veriflow ad export design/soc.ad --language systemverilog -o generated/soc.sv
```

`.ad` 是架构设计源文件。默认导出同目录、同名的 `.v` 文件；指定 SystemVerilog 时输出 `.sv`。为保护手写 RTL，导出只会覆盖带有 VeriFlow 生成标记的文件。

每个命令都支持 `--help`，例如 `veriflow sim --help`。

## VS Code 使用

1. 打开包含 `.v` 或 `.sv` 文件的工作区。
2. 从活动栏进入 **VeriFlow**，扫描模块并选择顶层。
3. 执行 **Analyze Dependencies** 或 **Compile & Simulate**。
4. 执行 **Open Waveform** 查看生成的 VCD。

`.vcd` 文件可直接使用内置波形编辑器打开。对 `.v`/`.sv` 文件执行 **Open as VeriFlow Schematic** 可查看原理图；原理图支持搜索、缩放、minimap、整网选择、列吸附拖动和重新布局。

常用设置包括：

- `veriflow.libDirs`：HDL 库目录
- `veriflow.defines`：SystemVerilog 预处理宏
- `veriflow.simulator`：仿真器
- `veriflow.waveViewer`：波形查看器
- `veriflow.testbenchOutputDir`：Testbench 输出目录

## 本地开发

```bash
nvm use
npm ci
npm run build
npm test
```

项目采用 [MIT License](LICENSE)。
