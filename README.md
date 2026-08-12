# Vik-VeriFlow

Vik-VeriFlow 是面向 Verilog/SystemVerilog 工程的一键分析、仿真和可视化设计工具。目前维护两种产品形态：`veriflow` Node 命令行工具和 **Verilog Design Flow** VS Code 扩展，两者共享 TypeScript 核心组件。

## 功能

- 扫描 HDL 模块、分析层次依赖并生成稳定的编译顺序
- 使用 Icarus Verilog、VCS、XSim 或自定义命令完成仿真
- 使用内置窗口查看 VCD 波形，也可调用 Surfer、GTKWave 或自定义查看器
- 以只读原理图浏览 `.v`、`.sv` 文件，支持列布局、正交布线、搜索和布局调整
- 在 VS Code 中可视化编辑 `.ad` 架构设计，添加模块、顶层端口、参数、标量连接和默认值
- 校验 `.ad` 设计并导出 Verilog 或 SystemVerilog 顶层
- 在 VS Code 中选择顶层、例化模块和生成 Testbench

## 安装

命令行工具需要 Node.js `24.14.1` 或更高版本：

```bash
npm install --global @veriflow/cli
veriflow --help
```

命令行安装包包含 Electron 波形窗口，因此体积会大于普通命令行工具。执行仿真还需安装至少一种 HDL 仿真器，推荐 Icarus Verilog。

VS Code 扩展可在扩展商店搜索 **Verilog Design Flow**，也可从 [GitHub 发布页](https://github.com/AlexMercer12138/Vik-VeriFlow/releases) 下载 `.vsix`。扩展要求 VS Code `1.82.0` 或更高版本。

## 命令行使用

创建工程并完成分析、仿真和波形查看：

```bash
veriflow project new --name demo --root ./rtl --top top --output project.json
veriflow analyze --project project.json
veriflow sim --project project.json
veriflow wave --project project.json
```

校验并导出架构设计：

```bash
veriflow ad validate design/soc.ad
veriflow ad export design/soc.ad
veriflow ad export design/soc.ad --language systemverilog -o generated/soc.sv
```

`.ad` 是 Vik-VeriFlow 的架构设计源文件，不表示兼容 Vivado Block Design。默认导出同目录、同名的 `.v` 文件；选择 SystemVerilog 时输出 `.sv`。导出只会覆盖带有 Vik-VeriFlow 生成标记的文件，不会覆盖手写 RTL。

每个命令都支持 `--help`，例如 `veriflow sim --help`。

## VS Code 使用

1. 打开包含 `.v` 或 `.sv` 文件的工作区。
2. 从活动栏进入 **VeriFlow**，扫描模块并选择顶层。
3. 执行 **Analyze Dependencies** 或 **Compile & Simulate**。
4. 执行 **Open Waveform** 查看生成的 VCD。

`.vcd` 文件可直接使用内置波形编辑器打开。对 `.v`、`.sv` 文件执行 **Open as VeriFlow Schematic** 可查看只读原理图。

先创建一个有效的 `.ad` 文件，最小内容如下，将 `soc_top` 改为需要生成的顶层模块名：

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

用 VS Code 打开后，可在图形编辑器中添加模块和顶层端口，启用连线模式后从输出引脚拖到输入引脚。选中模块、端口或网络可在右侧属性栏编辑名称、参数、默认值和导出设置。设计校验位于编辑器标题和命令面板，RTL 导出也可从画布工具栏执行。

当前 `.ad` 编辑器提供标量连接；AXI、APB、AHB 等总线识别、折叠接口和自定义协议将在后续版本加入。

## 本地开发

```bash
nvm use
npm ci
npm run build
npm test
```

项目采用 [MIT 许可证](LICENSE)。
