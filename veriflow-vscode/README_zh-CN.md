# Verilog Design Flow（VeriFlow）

[English](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/veriflow-vscode/README.md)

Verilog Design Flow 将模块扫描、依赖分析、编译仿真、波形查看、原理图浏览和可视化架构设计集成到 VS Code。

![VeriFlow 功能预览](https://img.cdn1.vip/i/6a0a6a9964326_1779067545.webp)

## 环境要求

- VS Code `1.82.0` 或更高版本
- 无需安装外部仿真器，默认使用内置 WASM 版 Icarus Verilog
- 无需安装外部波形工具，默认使用内置 VCD 查看器

内置仿真器目标为 Verilog-2005。需要调用本机工具时，在设置中选择
`custom` 并填写命令模板。

## HDL 工作流

1. 打开包含 `.v` 或 `.sv` 文件的工作区。
2. 从活动栏进入 **VeriFlow**，在 **Simulation** 区域选择顶层模块。
3. 执行 **Analyze Dependencies** 或 **Compile & Simulate**。
4. 执行 **Open Waveform** 查看生成的 VCD。

`.vcd` 文件可直接使用 **VeriFlow Waveform Viewer** 打开。对 `.v` 或 `.sv` 文件执行 **Open as VeriFlow Schematic**，可查看支持稳定列布局、正交布线、搜索、缩放、minimap、整网选择和布局调整的只读原理图。

## 架构设计编辑器

在 **Arch Designs** 区域点击 **Create Arch Design**，输入顶层模块名并选择 `.ad` 文件保存位置，新设计会直接在可视化编辑器中打开。

使用工具栏添加模块实例和顶层端口。连线时先单击任意一侧端点，再单击另一侧端点；两次单击之间可以平移画布。选中模块、端口、引脚、网络或识别出的接口，可在右侧属性栏查看和修改对应内容。

错误和警告会实时显示在 E/W 计数与 Problems 面板中。编辑器内只保留画布工具栏的 **Export RTL** 导出入口；每个文件的 **Arch Designs** 右键菜单和命令面板也可执行验证与导出。默认导出同目录、同名的 `.v` 文件；可在属性栏选择 SystemVerilog 和相对 `.sv` 输出路径。扩展不会覆盖手写 RTL。

`.ad` 是 VeriFlow 的 Arch Design 格式，不表示兼容 Vivado Block Design。

编辑器可根据 HDL 端口名称和方向识别内置的 AXI4、AXI-Stream、APB 与 AHB-Lite 接口，AXI4-Lite 按成员不完整的 AXI4 处理。接口可折叠、展开、从 Master 连接到 Slave，或整体提升为顶层接口；展开后的成员仍可作为普通引脚单独提升。无法自动推断角色时，可在属性栏指定 Master 或 Slave。

协议接口固定一对一连接，一对多应使用专门的互联模块。已有输出找不到对端输入时保持悬空；已有输入找不到对端输出时使用属性栏显示的连接自定义值或协议默认值。协议定义不包含位宽，位宽始终取自 HDL 端口；Master 与 Slave 位宽不一致时显示警告，但不阻止 RTL 导出。

项目自定义协议与内置协议使用相同的识别和导出流程。在 `project.json` 中引用相对工作区的协议文件：

```json
{
  "schematic": {
    "interface_protocols": ["protocols/my-bus.json"]
  }
}
```

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
| `veriflow.simulator` | `builtin`（内置 Icarus Verilog WASM）或 `custom` |
| `veriflow.waveViewer` | `builtin`（内置 VeriFlow VCD 查看器）或 `custom` |
| `veriflow.waveFileTemplate` | 波形文件路径模板 |
| `veriflow.testbenchOutputDir` | 工作区相对 Testbench 输出目录 |

自定义命令可在 VS Code 设置中配置，以下是常见工具的模板示例：

```text
Icarus Verilog 编译：iverilog -g2005 -o "{output}" {files}
Icarus Verilog 运行：vvp "{output}"
VCS 编译：          vcs -full64 -o "{output}" {files}
VCS 运行：          ./"{output}"
XSim 编译：         xvlog {files} && xelab {top_module} -snapshot "{output}"
XSim 运行：         xsim "{output}" --runall
Surfer：            surfer "{wave_file}"
GTKWave：           gtkwave "{wave_file}"
```

## 许可证

VeriFlow 扩展主体代码采用 MIT 许可证。内置 Icarus Verilog WASM 运行时采用
`GPL-2.0-or-later`，许可证与对应源码获取方式见
[Icarus Verilog WASM 说明](https://github.com/AlexMercer12138/Vik-VeriFlow/blob/main/docs/licenses/iverilog-wasm.md)。
