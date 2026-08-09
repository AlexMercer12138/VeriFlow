# VeriFlow - VS Code 扩展

[English](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/veriflow-vscode/README.md)

<div align="center">

**在 VS Code 中完成专注的 Verilog 设计流程：模块扫描、依赖分析、原理图编辑、编译仿真、波形查看和 Testbench 生成。**

[![VS Code](https://img.shields.io/badge/VS_Code-^1.80.0-007ACC.svg)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6.svg)](https://www.typescriptlang.org/)

</div>

---

## 简介

VeriFlow 是一个面向 Verilog/SystemVerilog 项目的 VS Code 扩展。它将模块扫描、依赖分析、编译仿真、波形查看和 Testbench 生成集成到 VS Code 侧边栏中。

扩展核心由 TypeScript 实现，VS Code 扩展本身不依赖 Python 运行环境。

## 功能演示

![功能演示](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## 快速开始

### 前提条件

- **VS Code 1.80+**
- **一款 Verilog 仿真器**，例如：
  - [Icarus Verilog](https://bleyer.org/icarus/) - 开源，推荐
  - [Synopsys VCS](https://www.synopsys.com/verification/simulation/vcs.html)
  - [Xilinx XSim](https://www.xilinx.com/products/design-tools/vivado.html)
  - 或自行配置自定义仿真器命令
- **波形查看器**（可选），例如：
  - VeriFlow 内置 `.vcd` 波形查看器
  - [Surfer](https://surfer-project.org/) - 开源，推荐
  - [GTKWave](https://gtkwave.sourceforge.net/)
  - 或自行配置自定义波形查看器命令

### 安装

在 VS Code 扩展商店搜索 `VeriFlow` 安装，或手动安装本地 `.vsix` 文件。

### 基本流程

1. 在 VS Code 中打开包含 `.v` 或 `.sv` 文件的文件夹
2. 从活动栏打开 **VeriFlow** 视图
3. VeriFlow 自动扫描模块，并按目录分组展示
4. 点击 **Select Top Module** 选择顶层模块
5. 点击 **Analyze Dependencies** 解析依赖并生成编译顺序
6. 点击 **Compile & Simulate** 运行仿真
7. 点击 **Open Waveform** 打开生成的波形文件

也可以在 VS Code 中直接打开 `.vcd` 文件，并选择 **VeriFlow Waveform Viewer** 进行预览。

## 一键例化模块

从命令面板运行 **VeriFlow: Instantiate Module**，或在 Verilog/SystemVerilog 编辑器右键菜单中选择 **Instantiate Module**。选择工作区或库目录中已扫描的模块后，可将对齐后的例化代码插入光标处或复制到剪贴板。同名模块会按源文件路径分别列出。

---

## Testbench 生成器

**Testbench Generator** 视图可以根据已扫描模块生成 Verilog Testbench。

### 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| **Name** | Testbench 模块名 | `tb_top` |
| **Unit / Prec** | `timescale` 时间单位 / 精度 | `1ns` / `1ps` |
| **Clocks** | 时钟频率（MHz），最多支持 6 个时钟 | `100` |
| **Reset** | 复位极性和持续时间 | Active Low / `100` |
| **DUT Modules** | 选择要实例化到 Testbench 中的模块，支持同一模块多次例化 | - |
| **Ports** | 自动解析模块端口，并支持修改连接信号名 | - |
| **Parameters** | 自动解析模块参数，并支持修改参数值 | - |
| **Waveform** | 波形文件名 | `{name}.vcd` |
| **Timeout** | 仿真超时时间（ns） | `1000000` |

### 使用步骤

1. 在 **DUT Modules** 区域点击 `+` 选择要实例化的模块
2. 选中一个 DUT 模块，编辑端口连接和参数值
3. 配置时钟、复位、波形和超时选项
4. 点击 **Generate Testbench** 生成并打开 Testbench 文件

生成目录默认是工作区根目录。可通过 `veriflow.testbenchOutputDir` 配置为相对工作区的子目录；目录不存在时 VeriFlow 会自动创建。

---

## 扩展设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `veriflow.libDirs` | `string[]` | `[]` | 用于模块搜索和依赖解析的库目录 |
| `veriflow.simulator` | `enum` | `iverilog` | 仿真器：`iverilog` / `vcs` / `xsim` / `custom` |
| `veriflow.waveViewer` | `enum` | `builtin` | 波形查看器：`builtin` / `surfer` / `gtkwave` / `custom` |
| `veriflow.simulatorCompileCmd` | `string` | `""` | 自定义编译命令模板，支持 `{files}` `{output}` `{top_module}` |
| `veriflow.simulatorRunCmd` | `string` | `""` | 自定义运行命令模板，支持 `{output}` |
| `veriflow.waveViewerCmd` | `string` | `""` | 自定义波形查看器命令模板，支持 `{wave_file}` |
| `veriflow.waveFileTemplate` | `string` | `{top_module}.vcd` | 波形文件路径模板，支持 `{top_module}` |
| `veriflow.testbenchOutputDir` | `string` | `.` | Testbench 输出目录，相对路径以工作区根目录为基准 |

---

## 侧边栏

侧边栏包含两个视图。

### VeriFlow

标题栏操作从左到右依次为：

- **Select Top Module** - 从已扫描模块中选择顶层
- **Analyze Dependencies** - 分析依赖并生成编译顺序
- **Compile & Simulate** - 编译并运行仿真
- **Open Waveform** - 打开配置的波形查看器
- **Scan Modules** - 重新扫描工作区

模块列表会在打开 VeriFlow 视图、打开 Testbench Generator、生成 Testbench，以及工作区文件或相关配置变化时刷新。

### Testbench Generator

该视图包含：

- **Properties** - Testbench 名称和 timescale 配置
- **Clocks** - 时钟频率配置
- **Reset** - 复位极性和持续时间
- **DUT Modules** - 模块选择、端口编辑和参数编辑
- **Waveform** - 波形文件配置
- **Timeout** - 仿真超时配置

---

## 内置波形查看器

VeriFlow 可以在 VS Code 内直接预览 `.vcd` 文件。

打开方式：

- 打开 `.vcd` 文件，并选择 **VeriFlow Waveform Viewer**。
- 右键点击 `.vcd` 文件，执行 **Open VCD in VeriFlow Viewer**。
- 将 `veriflow.waveViewer` 设置为 `builtin`，仿真后点击 **Open Waveform**。

当前查看器仍是早期原型，已支持信号搜索、时间轴、光标、缩放、平移、单 bit 信号、总线信号和密集波形聚合显示。

---

## 输出面板

仿真过程中的输出会显示在 VS Code **Output** 面板的 `VeriFlow` 通道中。

日志级别包括：

- `[INFO]` - 普通信息
- `[OK]` - 成功信息
- `[WARN]` - 警告
- `[ERROR]` - 错误信息，包含可识别的文件和行号引用

---

## 支持的仿真器预置命令

| 仿真器 | 编译命令模板 | 运行命令模板 |
|--------|-------------|-------------|
| iverilog | `iverilog -o "{output}" {files}` | `vvp "{output}"` |
| vcs | `vcs -full64 -o "{output}" {files}` | `./"{output}"` |
| xsim | `xvlog {files} && xelab {top_module} -snapshot "{output}"` | `xsim "{output}" --runall` |
| custom | 自行定义 | 自行定义 |

## 自定义仿真器配置示例

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

## 许可证

MIT

---

## 反馈

有问题或建议，欢迎在 [GitHub Issues](https://github.com/AlexMercer12138/Vik-VeriFlow/issues) 反馈。
