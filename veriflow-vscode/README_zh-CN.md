# Verilog Design Flow（VeriFlow）

[English](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/veriflow-vscode/README.md)

Verilog Design Flow 将模块扫描、依赖分析、编译仿真、波形查看、原理图浏览和可视化架构设计集成到 VS Code。

![VeriFlow 功能预览](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## 环境要求

- VS Code `1.82.0` 或更高版本
- 执行仿真时需要 Icarus Verilog、VCS、XSim 或自定义仿真命令
- 使用内置 VCD 查看器时无需安装外部波形工具

## HDL 工作流

1. 打开包含 `.v` 或 `.sv` 文件的工作区。
2. 从活动栏进入 **VeriFlow** 并选择顶层模块。
3. 执行 **Analyze Dependencies** 或 **Compile & Simulate**。
4. 执行 **Open Waveform** 查看生成的 VCD。

`.vcd` 文件可直接使用 **VeriFlow Waveform Viewer** 打开。对 `.v` 或 `.sv` 文件执行 **Open as VeriFlow Schematic**，可查看支持稳定列布局、正交布线、搜索、缩放、minimap、整网选择和布局调整的只读原理图。

## 架构设计编辑器

先创建有效的 `.ad` 文件，再用可视化架构设计编辑器打开。最小内容如下，将 `soc_top` 改为需要生成的顶层模块名：

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

使用工具栏添加模块实例和顶层端口，启用连线模式后从输出引脚拖到输入引脚。选中模块、端口或网络，可在右侧属性栏修改名称、参数、默认值和导出设置。

使用 **Validate Arch Design** 校验当前设计，使用 **Export Arch Design RTL** 生成 RTL。默认导出同目录、同名的 `.v` 文件；可在属性栏选择 SystemVerilog 和相对 `.sv` 输出路径。扩展不会覆盖手写 RTL。

`.ad` 是 VeriFlow 的 Arch Design 格式，不表示兼容 Vivado Block Design。当前编辑器提供标量连接；AXI、APB、AHB 总线识别、接口折叠和自定义协议将在后续版本实现。

## 其他命令

- **Select Top Module**
- **Scan Modules**
- **Instantiate Module**
- **Open VCD in VeriFlow Viewer**
- Testbench Generator 中的 **Generate Testbench**

## 常用设置

| 设置 | 用途 |
|---|---|
| `veriflow.libDirs` | HDL 库目录 |
| `veriflow.defines` | SystemVerilog 预处理宏 |
| `veriflow.simulator` | `iverilog`、`vcs`、`xsim` 或 `custom` |
| `veriflow.waveViewer` | `builtin`、`surfer`、`gtkwave` 或 `custom` |
| `veriflow.waveFileTemplate` | 波形文件路径模板 |
| `veriflow.testbenchOutputDir` | 工作区相对 Testbench 输出目录 |

自定义仿真器和波形查看器命令可在 VS Code 设置中配置。

## 许可证

MIT
