# VeriFlow

<div align="center">

**轻量级跨平台 Verilog 仿真工程管理器，支持 Node CLI 和 VS Code 扩展**

[![Node.js](https://img.shields.io/badge/Node.js-24.14.1-green.svg)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Waveform-Electron-47848F.svg)](https://www.electronjs.org/)
[![VS Code](https://img.shields.io/badge/VS_Code-Extension-007ACC.svg)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## 概述

**VeriFlow**是一个专为简化 Verilog 开发流程而设计的工具。它能自动完成依赖解析、编译排序、仿真执行和波形查看，并通过 Node CLI 或 VS Code 侧边栏提供一致的 TypeScript 核心能力。

> **产品状态：** Node CLI 和 VS Code 扩展是持续维护的产品形态。Python GUI/CLI 已弃用，仅在首个弃用版本中保留兼容制品；完成 retirement gate 后将删除。

无论你是在开发一个小模块，还是管理一个跨多目录、多库依赖的大型设计，VeriFlow 都能帮你一条龙完成 **分析 → 编译 → 仿真 → 查看**。

### 核心功能

- **自动依赖解析** — 基于 BFS 算法提取模块例化关系，计算正确的拓扑编译顺序
- **多仿真器支持** — 预置 Icarus Verilog、Synopsys VCS、Xilinx XSim 及自定义仿真器配置
- **波形查看器集成** — 一键启动 Surfer、GTKWave 或任意自定义波形查看器
- **模块扫描与重名检测** — 扫描工程及库目录下所有 Verilog 文件，检测模块命名冲突
- **Testbench 生成** — 可视化配置时钟、复位、DUT 模块，一键生成 Verilog Testbench（GUI 和 VS Code 扩展均支持）
- **端口解析与模板生成** — 解析基础 Verilog / 常见 SystemVerilog 端口，生成带对齐的例化模板和连线声明
- **结构化日志解析** — 将仿真器/编译器输出解析为带文件和行号引用的结构化日志条目
- **全局库管理** — Node CLI 与兼容产品共享 `~/.veriflow_config.json`
- **Electron 波形窗口** — Node CLI 复用与 VS Code 相同的共享波形前端
- **Node CLI 命令行** — 支持脚本化和 CI/CD 集成
- **VS Code 扩展** — 原生 TypeScript 实现，无需安装 Python，在编辑器中直接完成全流程
- **Python GUI/CLI（已弃用）** — 仅为迁移期兼容和回滚保留一个发布周期

---

## 架构

Node CLI 和 VS Code 扩展通过 npm workspaces 共享宿主无关的 TypeScript 包：

```text
packages/
├── flow-core/          # 工程配置、模板、仿真后端和日志
├── hdl-core/           # HDL 语义模型与预处理
├── hdl-runtime/        # Tree-sitter worker、索引和依赖分析
├── waveform-runtime/   # VCD 索引、缓存和 worker
├── waveform-desktop/   # context-isolated Electron host
└── cli/                # Node CLI 产品入口
veriflow-vscode/        # VS Code 产品适配层
```

共享包不依赖 Electron、VS Code 或 Python 产品入口。Electron 和 VS Code 只负责宿主 transport、窗口生命周期和编辑器 API。

弃用的 Python 兼容实现仍按原 Clean Architecture 分层保留到 retirement gate：

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

### 设计模式

| 模式 | 用途 |
|------|------|
| **外观（Facade）** | `ApplicationCoordinator` 统一封装所有领域服务 |
| **依赖反转** | 领域接口（ABC）由基础设施/服务层实现 |
| **仓储（Repository）** | `ConfigService` 和 `FileService` 抽象 I/O 操作 |
| **模板方法** | `TemplateEngine` 通过占位符替换渲染仿真器/查看器命令 |
| **工作线程** | GUI 使用 `QThread` 工作线程保持界面响应 |

---

## 安装

### 前置要求

- **Node.js 24.14.1**
- **至少一款 Verilog 仿真器**：
  - [Icarus Verilog](https://bleyer.org/icarus/)（`iverilog` + `vvp`，开源）
  - [Synopsys VCS](https://www.synopsys.com/verification/simulation/vcs.html)（商业）
  - [Xilinx Vivado XSim](https://www.xilinx.com/products/design-tools/vivado.html)（商业）
- **波形查看器（可选）**：
  - [Surfer](https://surfer-project.org/)（推荐，开源）
  - [GTKWave](https://gtkwave.sourceforge.net/)

### 安装步骤

```bash
npm install --global @veriflow/cli
veriflow --version
```

Node CLI 安装会同时安装 Electron 波形宿主，因此安装体积较大。`analyze`、`sim` 和外部波形查看器命令不会加载 Electron；只有内置 `wave` 命令会启动窗口。

从源码开发时使用仓库根目录唯一的 lockfile：

```bash
git clone https://github.com/AlexMercer12138/VeriFlow.git
cd VeriFlow
npm ci
npm run build:cli
```

### Python 兼容产品（已弃用）

Python GUI/CLI 只用于弃用发布和迁移回滚，不再接收新功能。临时安装方式保持不变：

```bash
python -m pip install -e .
```

### 打包为 EXE（Python 版本）

以下制品仅保留到 retirement gate，不是新的默认安装方式。

```bash
# 安装 PyInstaller
pip install pyinstaller

# 一键打包GUI（输出 dist/VeriFlow.exe）
pyinstaller VeriFlow.spec --noconfirm

# 一键打包CLI（输出 dist/VeriFlow-cli.exe）
pyinstaller VeriFlow-cli.spec --noconfirm
```

打包后的 `VeriFlow.exe` 和 `VeriFlow-cli.exe` 为单文件免安装应用，GUI 版本双击即可运行，CLI 版本将路径添加到PATH后从命令行运行。

### 打包为 VSIX（VS Code 版本）

```bash
# 在仓库根目录安装唯一 lockfile 的依赖
npm ci

# 打包为 VSIX 文件（输出 veriflow-vscode/veriflow-{version}.vsix）
npm run package --workspace veriflow-vscode
```

`vscode:prepublish` 会通过仓库根目录的 `scripts/build-vscode.mjs` 构建规范的
Web 资源并同步到扩展的 `media` 目录，然后 VSCE 才创建 VSIX。

打包后的 `veriflow-{version}.vsix` 文件可上传至 [VS Code Marketplace](https://marketplace.visualstudio.com/) 或直接分发给用户安装。

---

## 使用方式

### Python GUI 模式（已弃用）

Python GUI 不再新增功能，建议使用 Node CLI 或 VS Code 扩展完成以下流程。

**典型操作流程**：

1. 新建工程 或 打开工程，创建/加载 .json 工程文件
2. 生成 Testbench 模板并添加测试激励
3. 设置 顶层模块 名称（从扫描列表中选择）
4. 在工程配置标签页中配置 库目录、仿真器 和 波形查看器
5. 点击 分析依赖 解析模块依赖图
6. 点击 编译并仿真 运行仿真
7. 点击 打开波形 查看生成的波形文件

### Node CLI 模式

```bash
# 1. 创建工程
veriflow project new -n my_proj -r ./rtl -t top_module

# 2. 添加全局库（可选）
veriflow lib add -L ./shared_libs

# 3. 查看工程配置
veriflow project show -p my_proj.json

# 4. 分析依赖
veriflow analyze -p my_proj.json

# 5. 编译仿真
veriflow sim -p my_proj.json

# 6. 打开波形
veriflow wave -p my_proj.json

# 7. 查看帮助
veriflow --help

# 8. 查看版本
veriflow --version
```

### VS Code 扩展模式

**扩展安装**：
1. 在 VS Code 中按 `Ctrl+Shift+P`
2. 输入 `Extensions: Install from VSIX`
3. 选择打包好的 `veriflow-{version}.vsix` 文件

**扩展使用流程**：

1. 在 VS Code 中打开包含 `.v` / `.sv` 文件的目录
2. 点击活动栏的 **VeriFlow** 图标，侧边栏自动展示扫描到的模块
3. 点击 `Select Top Module` 选择顶层模块
4. 点击 `Analyze Dependencies` 分析依赖关系
5. 点击 `Compile & Simulate` 编译并仿真
6. 点击 `Open Waveform` 查看波形

**扩展设置**（在 VS Code `settings.json` 中搜索 `veriflow`）：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `veriflow.libDirs` | 库目录列表 | `[]` |
| `veriflow.simulator` | 仿真器选择 | `iverilog` |
| `veriflow.waveViewer` | 波形查看器 | `builtin` |
| `veriflow.waveFileTemplate` | 波形文件路径模板 | `{top_module}.vcd` |
| `veriflow.testbenchOutputDir` | Testbench 输出目录，相对路径以工作区根目录为基准 | `.` |

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
  "wave_viewer": "builtin",
  "wave_file_template": "{top_module}.vcd",
  "testbench_output_dir": ".",
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
    "builtin": "",
    "surfer": "surfer \"{wave_file}\"",
    "gtkwave": "gtkwave \"{wave_file}\"",
    "custom": ""
  }
}
```

---

## 全局配置

Node CLI 和弃用的 Python 兼容产品都读取 `~/.veriflow_config.json`，目前支持：

- **`lib_dirs`**：全局库目录，会自动纳入所有工程的模块扫描和依赖解析。

- **`language`**：界面语言，默认中文。

- **`theme`**：界面主题，默认暗黑模式。

通过 GUI 设置（工程配置 → 全局库目录），或手动编辑 JSON 文件。

通过 CLI `veriflow lib add -L ./shared_libs` 命令添加全局库目录。

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
3. **轻量预处理** — 去除注释，并按文件内 ``define`` / ``undef`` 选择 `ifdef` / `ifndef` / `elsif` / `else` 分支
4. **参数块展平** — 剥离 `#(...)` 参数覆写，避免误匹配
5. **关键字过滤** — 过滤 Verilog 关键字，避免将内置原语误识别为模块依赖
6. **拓扑排序** — 叶子模块（无依赖）优先编译，顶层模块最后编译
7. **缺失模块检测** — 报告所有被引用但在搜索路径中找不到的模块

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

### Verilog / SystemVerilog 解析范围

VeriFlow 的解析器用于模块扫描、依赖分析、端口提取和 Testbench 生成，不替代仿真器/综合器的完整前端。

当前支持：

- `.v` / `.sv` / `.vh` / `.svh` 文件扫描。
- 文件内 ``define``、``undef``、``ifdef``、``ifndef``、``elsif``、``else``、``endif`` 的简单分支选择。
- ANSI 与非 ANSI 端口声明。
- 常见端口修饰符：`wire`、`reg`、`logic`、`var`、`signed`、`unsigned`、`bit`、`tri`。
- 参数声明中的简单类型标注，例如 `parameter int WIDTH = 8`。

边界说明：

- 不提供工程级宏定义配置；宏应由用户源码或仿真器命令负责。
- 不展开复杂宏函数，不做完整 include 级预处理。
- 如果源码条件编译或宏定义不完整，VeriFlow 的扫描/分析结果可能不完整；最终编译错误以用户配置的仿真器输出为准。

---

## 发布流程

项目发布统一使用 `scripts/run_release.py`，同步共享包、Node CLI、VS Code 扩展和临时 Python 兼容制品的版本与门禁。

### 发布前检查

```bash
python scripts/run_release.py --check
# 或
python scripts/run_release.py -c
```

检查内容包括：

- 根目录、所有 workspace `package.json`、`src/version.py`、`pyproject.toml` 与 VS Code 扩展版本一致性
- `veriflow-vscode/CHANGELOG.md` 是否包含当前版本标题
- Python 测试：`python -m pytest`
- shared、Node CLI、Electron 和 VS Code 测试
- npm tarball 空目录安装及 `help/version/analyze` smoke
- 生成资源一致性
- `git diff --check`
- `git status --short --branch`

### 更新版本号

```bash
# 指定版本
python scripts/run_release.py --update 1.2.0

# 不指定版本时，自动将 PATCH 位加一
python scripts/run_release.py --update

# 短参数
python scripts/run_release.py -u 1.2.0
```

版本号会同步更新：

- `src/version.py`
- `pyproject.toml`
- 根目录、所有 workspace 与 `veriflow-vscode/package.json`
- workspace 内部依赖版本和 `package-lock.json`

### 打包发布产物

```bash
python scripts/run_release.py --package
# 或
python scripts/run_release.py -p
```

打包内容包括：

- Node shared/CLI/Electron 包：`dist/npm/*.tgz`
- VS Code 扩展：`veriflow-vscode/veriflow-{version}.vsix`
- Python GUI（已弃用）：`dist/VeriFlow.exe`
- Python CLI（已弃用）：`dist/VeriFlow-cli.exe`

### 一键发布流程

```bash
# 指定发布版本，按 版本更新 -> 发布检查 -> 应用打包 执行
python scripts/run_release.py --all 1.2.0

# 不指定版本时，自动将 PATCH 位加一
python scripts/run_release.py --all

# 短参数
python scripts/run_release.py -a 1.2.0
```

`--all` 的执行顺序固定为：

1. 更新版本号
2. 发布前检查
3. 打包发布产物

---

## 许可证

本项目基于 MIT 许可证开源。详见 [LICENSE](LICENSE) 文件。

---

## 贡献

欢迎贡献！请随时提交 issues 和 pull requests。

---

## Developer build commands

Run the generated-asset and parser feasibility builds from the repository root:

```bash
npm ci
npm test --workspace @veriflow/parser-worker
npm run build:web
npm run verify:generated
npm run build:vscode
npm run build:parser
node scripts/smoke-parser-probe.mjs
npm run test:release
npm run pack:node
python -m pip install build==1.5.0 setuptools==82.0.1 wheel==0.46.3 pyinstaller==6.19.0 pytest==9.0.3 PyYAML==6.0.3
python scripts/build_parser_probe_wheel.py
```

The Windows x64 feasibility sequence runs the parser source suite before the
SEA, wheel, and PyInstaller checks, using the pinned packaging tools above. See
[HDL runtime feasibility evidence](docs/architecture/hdl-runtime-feasibility.md)
for the pinned inputs, checksums, provenance contract, and stop conditions.
