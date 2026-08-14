# Vik-VeriFlow

Vik-VeriFlow 是面向 Verilog/SystemVerilog 工程的一键分析、仿真、波形查看和可视化架构设计工具。目前维护 `veriflow` Node CLI 与 **Verilog Design Flow** VS Code 扩展，两者共享 TypeScript 核心组件。

## 功能

- 扫描 HDL 模块、分析依赖并生成稳定的编译顺序
- 使用 Icarus Verilog、VCS、XSim 或自定义命令完成仿真
- 使用内置窗口查看 VCD，也可调用 Surfer、GTKWave 或自定义查看器
- 浏览带列布局、正交布线和搜索功能的 HDL 原理图
- 可视化编辑 `.ad` 架构设计并导出 Verilog/SystemVerilog 顶层
- 自动识别 AXI4、AXI-Stream、APB、AHB-Lite 及项目自定义接口
- 在 VS Code 中选择顶层、例化模块和生成 Testbench

## 安装

需要 Node.js `24.14.1` 或更高版本：

```bash
npm install --global @veriflow/cli
veriflow --help
```

CLI 包含 Electron 波形窗口，因此安装包体积较大。执行仿真还需安装至少一种 HDL 仿真器，推荐 Icarus Verilog。

VS Code 扩展可在扩展商店搜索 **Verilog Design Flow**，也可从 [GitHub 发布页](https://github.com/AlexMercer12138/Vik-VeriFlow/releases) 下载 `.vsix`。扩展要求 VS Code `1.82.0` 或更高版本。

## 命令行

```bash
veriflow project new --name demo --root ./rtl --top top --output project.json
veriflow analyze --project project.json
veriflow sim --project project.json
veriflow wave --project project.json

veriflow ad new soc_top -o design/soc.ad
veriflow ad validate design/soc.ad --project project.json
veriflow ad export design/soc.ad --project project.json
veriflow ad export design/soc.ad --language systemverilog -o generated/soc.sv
```

每个命令都支持 `--help`。`.ad` 是 Vik-VeriFlow 的 Arch Design 格式，不表示兼容 Vivado Block Design。默认导出同目录、同名的 `.v`；选择 SystemVerilog 时输出 `.sv`。导出只覆盖带 Vik-VeriFlow 生成标记的文件，不覆盖手写 RTL。

## VS Code

打开 HDL 工作区后，从活动栏进入 **VeriFlow**。**Simulation** 区域用于选择顶层、分析依赖、仿真和查看波形；`.vcd` 可直接用内置查看器打开，对 `.v`、`.sv` 执行 **Open as VeriFlow Schematic** 可查看只读原理图。

在 **Arch Designs** 区域点击 **Create Arch Design**，依次输入顶层模块名和保存位置，扩展会创建并打开规范的 `.ad` 文件。编辑器支持添加实例和顶层端口、编辑参数与默认值，以及连接标量或协议接口。连线时依次单击两个端点即可，起点方向不限，两次单击之间可平移画布。

设计错误和警告会实时显示在 E/W 计数与 Problems 面板中。编辑器内只保留画布工具栏的 **Export RTL** 按钮；验证和导出也可从 **Arch Designs** 文件右键菜单或命令面板执行。默认导出同目录、同名的 `.v`，也可在属性栏选择 SystemVerilog 和相对 `.sv` 输出路径。

接口按端口名称和方向自动识别，可折叠为一条连接，也可展开后单独操作成员。角色无法推断时可在属性栏指定 Master 或 Slave；协议接口固定一对一连接，一对多应使用专门的互联模块。实例接口可整体提升为顶层接口，展开后的成员也可按普通端口单独提升。

内置协议包括 AXI4、AXI-Stream、APB 和 AHB-Lite。AXI4-Lite 作为成员不完整的 AXI4 处理。自定义协议文件在 `project.json` 中声明，路径相对该项目文件所在目录；VS Code 使用工作区根目录的 `project.json`：

```json
{
  "schematic": {
    "interface_protocols": ["protocols/my-bus.json"]
  }
}
```

协议 JSON 定义成员、方向、识别特征和缺失输入的默认表达式，不定义位宽。位宽来自实际 HDL 端口；Master 与 Slave 位宽不一致时显示警告，但不会阻止 RTL 导出。已有输出找不到对端输入时保持悬空；已有输入找不到对端输出时使用连接自定义值或协议默认值。

## 开发

```bash
nvm use
npm ci
npm run build
npm test
```

项目采用 [MIT 许可证](LICENSE)。
