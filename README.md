# VeriFlow

<div align="center">

**轻量级跨平台 Verilog 仿真工程管理器，支持桌面 GUI、命令行和 VS Code 扩展**

[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](https://www.python.org/)
[![PySide6](https://img.shields.io/badge/GUI-PySide6-green.svg)](https://pypi.org/project/PySide6/)
[![VS Code](https://img.shields.io/badge/VS_Code-Extension-007ACC.svg)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## 概述

**VeriFlow**是一个专为简化 Verilog 开发流程而设计的工具。它能自动完成依赖解析、编译排序、仿真执行和波形查看——全部集成在简洁的深色主题 GUI、灵活的命令行界面或 VS Code 侧边栏中。

无论你是在开发一个小模块，还是管理一个跨多目录、多库依赖的大型设计，VeriFlow 都能帮你一条龙完成 **分析 → 编译 → 仿真 → 查看**。

### 核心功能

- **自动依赖解析** — 基于 BFS 算法提取模块例化关系，计算正确的拓扑编译顺序
- **多仿真器支持** — 预置 Icarus Verilog、Synopsys VCS、Xilinx XSim 及自定义仿真器配置
- **波形查看器集成** — 一键启动 Surfer、GTKWave 或任意自定义波形查看器
- **模块扫描与重名检测** — 扫描工程及库目录下所有 Verilog 文件，检测模块命名冲突
- **端口解析与模板生成** — 解析模块端口，生成带对齐的例化模板和连线声明
- **结构化日志解析** — 将仿真器/编译器输出解析为带文件和行号引用的结构化日志条目
- **全局库管理** — 配置跨工程共享的库目录（Python 版）
- **桌面 GUI** — 深色主题 PySide6 界面，包含工程侧边栏、依赖树、模块浏览器和日志面板
- **CLI 命令行** — 支持脚本化和 CI/CD 集成
- **VS Code 扩展** — 原生 TypeScript 实现，无需安装 Python，在编辑器中直接完成全流程

---

## VS Code 扩展（推荐）

VeriFlow 提供了一个 **零依赖的 VS Code 扩展**（`vscode-extension/`），所有核心逻辑用 TypeScript 原生实现，不需要安装 Python。

### 安装方式

1. 克隆仓库后在 VS Code 中打开 `vscode-extension/` 目录
2. 运行 `npm install && npm run compile`
3. 按 `F5` 启动扩展调试

### 使用流程

1. 在 VS Code 中打开一个包含 `.v` / `.sv` 文件的目录
2. 点击活动栏的 VeriFlow 图标（烧杯），右侧侧边栏会自动展示扫描到的模块
3. 点击 `Select Top Module` 选择一个顶层模块
4. 点击 `Analyze Dependencies` 分析依赖关系
5. 点击 `Compile & Simulate` 编译并仿真
6. 点击 `Open Waveform` 查看波形

### 扩展设置

在 VS Code `settings.json` 中搜索 `veriflow` 即可配置所有选项：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `veriflow.libDirs` | 库目录列表 | `[]` |
| `veriflow.simulator` | 仿真器选择 | `iverilog` |
| `veriflow.waveViewer` | 波形查看器 | `surfer` |
| `veriflow.simulatorCompileCmd` | 自定义编译命令模板 | `""` |
| `veriflow.simulatorRunCmd` | 自定义运行命令模板 | `""` |
| `veriflow.waveViewerCmd` | 自定义波形查看器命令 | `""` |
| `veriflow.waveFileTemplate` | 波形文件路径模板 | `{top_module}.vcd` |

> **注意**：扩展版不管理工程文件，直接以 VS Code 打开的当前目录作为编译根目录；不区分全局库和项目库，所有库路径在扩展设置中统一配置。

---

## 架构

VeriFlow 遵循 **Clean Architecture**（领域驱动设计），分为四个独立层级：

```
src/
├── presentation/       # 表现层：GUI（PySide6）、CLI、JSON桥接
│   ├── gui/
│   │   ├── main_window.py
│   │   ├── worker_threads.py
│   │   └── widgets/
│   │       ├── project_panel.py
│   │       ├── project_config_panel.py
│   │       ├── unified_module_panel.py
│   │       ├── file_tree_panel.py
│   │       └── log_panel.py
│   └── cli.py
├── application/        # 应用层：协调器（外观模式）
│   └── coordinator.py
├── domain/             # 领域层：业务逻辑与领域模型
│   ├── interfaces/     # 抽象接口（ABC）
│   │   ├── i_dep_analyzer.py
│   │   ├── i_port_parser.py
│   │   ├── i_project_manager.py
│   │   └── i_sim_runner.py
│   ├── models/         # 数据类
│   │   ├── dependency.py
│   │   ├── port.py
│   │   ├── project.py
│   │   └── simulation.py
│   └── services/       # 领域服务实现
│       ├── dep_analyzer_service.py
│       ├── log_parser_service.py
│       ├── port_parser_service.py
│       ├── project_manager_service.py
│       ├── sim_runner_service.py
│       └── verilog_utils.py
└── infrastructure/     # 基础设施层：外部服务适配
    ├── config_service.py
    ├── file_service.py
    ├── global_config_service.py
    ├── process_manager.py
    └── template_engine.py
```

### VS Code 扩展架构（TypeScript）

```
vscode-extension/src/
├── core/                       # 核心引擎（与 Python 版功能对等）
│   ├── types.ts                # 类型定义
│   ├── verilogUtils.ts         # Verilog 工具（注释移除、generate/ifdef展开）
│   ├── fileService.ts          # 文件 I/O
│   ├── dependencyAnalyzer.ts   # BFS 依赖解析
│   ├── templateEngine.ts       # 命令模板渲染
│   ├── processManager.ts       # 外部进程管理
│   ├── logParser.ts            # 日志解析
│   ├── simulationRunner.ts     # 仿真运行
│   └── portParser.ts           # 端口解析
├── config.ts                   # 扩展配置管理
├── output.ts                   # 输出通道封装
├── moduleTreeProvider.ts       # 模块树视图数据源
└── extension.ts                # 扩展主入口
```

### 设计模式

| 模式 | 用途 |
|------|------|
| **外观（Facade）** | `ApplicationCoordinator` 统一封装所有领域服务 |
| **依赖反转** | 领域接口（ABC）由基础设施/服务层实现 |
| **仓储（Repository）** | `ConfigService` 和 `FileService` 抽象 I/O 操作 |
| **模板方法** | `TemplateEngine` 通过占位符替换渲染仿真器/查看器命令 |
| **工作线程** | GUI 使用 `QThread` 工作线程保持界面响应 |

---

## 安装（Python 版）

### 前置要求

- **Python 3.8+**
- **至少一款 Verilog 仿真器**：
  - [Icarus Verilog](http://iverilog.icarus.com/)（`iverilog` + `vvp`，开源）
  - [Synopsys VCS](https://www.synopsys.com/verification/simulation/vcs.html)（商业）
  - [Xilinx Vivado XSim](https://www.xilinx.com/products/design-tools/vivado.html)（商业）
- **波形查看器（可选）**：
  - [Surfer](https://surfer-project.org/)（推荐，开源）
  - [GTKWave](https://gtkwave.sourceforge.net/)

### 安装步骤

```bash
git clone https://github.com/AlexMercer12138/VeriFlow.git
cd VeriFlow
pip install -r requirements.txt
```

Python 依赖仅需 **PySide6**（>= 6.5.0）用于 GUI，CLI 无需额外依赖。

---

## 使用方式

### GUI 模式

```bash
python -m src.presentation.gui
```

典型操作流程：

1. **新建工程** 或 **打开工程**，创建/加载 `.json` 工程文件
2. 设置 **顶层模块** 名称（从扫描列表中选择或手动输入）
3. 在工程配置标签页中配置 **库目录**、**仿真器** 和 **波形查看器**
4. 点击 **分析依赖** 解析模块依赖图
5. 点击 **编译并仿真** 运行仿真
6. 点击 **打开波形** 查看生成的波形文件

### CLI 模式

```bash
# 仅分析依赖，不执行仿真
python -m src.presentation.cli analyze --root ./rtl --top top_tb --lib-dir ./libs

# 一键仿真
python -m src.presentation.cli simulate --root ./rtl --top top_tb --simulator iverilog

# 使用已有工程文件仿真
python -m src.presentation.cli simulate --project config/my_project.json

# 创建新工程文件
python -m src.presentation.cli new --name my_design --root ./rtl --top top_tb -o my_design.json
```

#### CLI 参数

| 参数 | 缩写 | 说明 |
|------|------|------|
| `--root` | `-r` | 工程根目录 |
| `--top` | `-t` | 顶层模块名 |
| `--lib-dir` | `-L` | 库目录（逗号分隔） |
| `--project` | `-p` | 工程 JSON 文件路径 |
| `--name` | `-n` | 工程名称（默认：`my_project`） |
| `--simulator` | `-s` | 仿真器名称（默认：`iverilog`） |
| `--wave-viewer` | `-w` | 波形查看器（默认：`surfer`） |
| `--output` | `-o` | 输出 JSON 路径（`new` 命令专用） |

#### CLI 命令

| 命令 | 说明 |
|------|------|
| `analyze` | 分析模块依赖并显示编译顺序 |
| `simulate` | 完整的编译 + 仿真流程 |
| `new` | 创建新的工程 JSON 文件 |

---

## 工程配置

工程以 JSON 文件存储。示例：

```json
{
  "project_name": "my_design",
  "project_root": "./rtl",
  "lib_dirs": ["./libs", "../shared"],
  "top_module": "top_tb",
  "simulator": "iverilog",
  "wave_viewer": "surfer",
  "wave_file_template": "{top_module}.vcd",
  "simulators": {
    "iverilog": {
      "compile_cmd": "iverilog -o \"{output}\" {files}",
      "run_cmd": "vvp \"{output}\""
    },
    "vcs": {
      "compile_cmd": "vcs -full64 -o \"{output}\" {files}",
      "run_cmd": "./\"{output}\""
    },
    "xsim": {
      "compile_cmd": "xvlog {files} && xelab {top_module} -snapshot \"{output}\"",
      "run_cmd": "xsim \"{output}\" --runall"
    },
    "custom": {
      "compile_cmd": "",
      "run_cmd": ""
    }
  },
  "wave_viewers": {
    "surfer": "surfer \"{wave_file}\"",
    "gtkwave": "gtkwave \"{wave_file}\"",
    "custom": ""
  }
}
```

### 模板变量

仿真器和查看器命令使用 `{placeholder}` 占位符语法：

| 变量 | 使用场景 | 说明 |
|------|----------|------|
| `{files}` | 编译 | 空格分隔的源码文件列表（带引号） |
| `{output}` | 编译 & 运行 | 编译输出产物路径 |
| `{top_module}` | 编译 | 顶层模块名称 |
| `{wave_file}` | 波形查看 | 波形文件路径 |

---

## 全局配置（Python GUI 版）

VeriFlow 全局设置保存在 `~/.veriflow_config.json`，目前支持：

- **`lib_dirs`**：全局库目录，会自动纳入所有工程的模块扫描和依赖解析。

通过 GUI 设置（工程配置 → 全局库目录），或手动编辑 JSON 文件。

---

## 支持的仿真器

| 仿真器 | 标识 | 开源 | 备注 |
|--------|------|:----:|------|
| Icarus Verilog | `iverilog` | ✅ | 默认选择，通过包管理器安装 |
| Synopsys VCS | `vcs` | ❌ | 需要商业许可证 |
| Xilinx XSim | `xsim` | ❌ | Vivado 安装包的一部分 |
| 自定义 | `custom` | — | 自行定义编译/运行命令 |

## 支持的波形查看器

| 查看器 | 标识 | 开源 | 备注 |
|--------|------|:----:|------|
| Surfer | `surfer` | ✅ | 现代化、高性能的 VCD 查看器 |
| GTKWave | `gtkwave` | ✅ | 经典波形查看器 |
| 自定义 | `custom` | — | 自行定义启动命令 |

---

## 核心功能详解

### 依赖分析

依赖分析器采用 **BFS（广度优先搜索）** 递归解析模块例化关系：

1. **模块索引** — 扫描所有搜索目录中的 Verilog 文件，构建 `模块名 → 文件路径` 索引
2. **注释移除** — 分析前剥离 `//` 和 `/* */` 注释
3. **generate/ifdef 展开** — 展开 `generate`/`endgenerate` 及 `ifdef`/`endif` 块，捕获内部的例化
4. **参数块展平** — 剥离 `#(...)` 参数覆写，避免误匹配
5. **关键字过滤** — 过滤 Verilog 关键字，避免将内置原语误识别为模块依赖
6. **拓扑排序** — 叶子模块（无依赖）优先编译，顶层模块最后编译
7. **缺失模块检测** — 报告所有被引用但在搜索路径中找不到的模块

### 端口解析与例化模板

端口解析器功能：
- 提取 `input`/`output`/`inout` 端口及位宽信息
- 提取 `parameter` 参数声明
- 生成格式化对齐的 Verilog 例化模板
- 生成测试平台用的连线声明

### 日志解析

日志解析器能理解主流仿真器的输出格式，并分类为结构化条目：

- **错误条目** — 带文件引用和行号解析
- **警告条目** — 与错误分离，便于筛选
- **信息条目** — 所有其他输出行

支持 iverilog、VCS 和 Xilinx 工具的常见输出格式。

### 模块管理

- **重名检测** — 扫描所有目录，标记在多处定义的模块
- **按库分类视图** — 模块按来源目录分组（工程根目录、全局库、工程库）
- **搜索过滤** — 模块面板支持快速文本过滤
- **自动填充顶层模块选择器** — 下拉列表列出所有已扫描模块，快速选取

---

## 工程结构速查

```
VeriFlow/
├── config/
│   └── default_config.json            # 默认工程配置模板
├── src/
│   ├── application/
│   │   └── coordinator.py             # 外观模式：ApplicationCoordinator
│   ├── domain/
│   │   ├── interfaces/                # 抽象接口
│   │   ├── models/                    # 领域数据类
│   │   └── services/                  # 领域服务实现
│   ├── infrastructure/                # 基础设施层
│   └── presentation/                  # 表现层
│       ├── cli.py                     # CLI 入口
│       ├── json_bridge.py             # VS Code 桥接接口
│       └── gui/                       # GUI 入口及组件
├── vscode-extension/                  # VS Code 扩展（TypeScript）
│   ├── src/
│   │   ├── core/                      # 核心引擎（与 Python 版功能对等）
│   │   │   ├── types.ts
│   │   │   ├── verilogUtils.ts
│   │   │   ├── fileService.ts
│   │   │   ├── dependencyAnalyzer.ts
│   │   │   ├── templateEngine.ts
│   │   │   ├── processManager.ts
│   │   │   ├── logParser.ts
│   │   │   ├── simulationRunner.ts
│   │   │   └── portParser.ts
│   │   ├── config.ts
│   │   ├── output.ts
│   │   ├── moduleTreeProvider.ts
│   │   └── extension.ts
│   ├── package.json
│   └── tsconfig.json
├── tests/
├── requirements.txt
└── README.md
```

---

## 开发指南

```bash
# 运行 GUI 验证
python -m tests.verify_gui

# 运行服务验证
python -m tests.verify_services

# 运行单元测试（需要 pytest）
# pip install pytest
# pytest tests/

# VS Code 扩展开发
cd vscode-extension
npm install
npm run compile
# 按 F5 启动调试
```

---

## 路线图

- [ ] 从模块端口定义自动生成测试平台
- [ ] 波形对比工具
- [ ] 类似 LSP 的编辑器集成
- [ ] 覆盖率报告解析与可视化
- [ ] CI/CD 集成示例（GitHub Actions、GitLab CI）
- [ ] 自定义仿真器插件系统
- [ ] 多语言支持（SystemVerilog、VHDL）

---

## 许可证

本项目基于 MIT 许可证开源。详见 [LICENSE](LICENSE) 文件。

---

## 贡献

欢迎贡献！请随时提交 issues 和 pull requests。
