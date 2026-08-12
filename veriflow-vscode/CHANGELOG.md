# Change Log

## [Unreleased]

- 新增 `.ad` Arch Design 可视化编辑器，可添加模块实例、顶层端口、参数、标量连接和默认值。
- 新增 Arch Design 校验和 Verilog/SystemVerilog RTL 导出，默认生成同名 `.v`，并拒绝覆盖手写 RTL。
- Arch Design 与只读 HDL 原理图共享列布局、正交布线、网络选择和右侧属性栏。
- 改善原理图端口标注、网络选择效果和明暗主题对比度。

## [1.4.0] - 2026-08-09

- 发布共享 TypeScript 核心、Node CLI 和 context-isolated Electron 波形窗口。
- Node CLI 与 VS Code 扩展共享 HDL、仿真和波形 runtime。
- Python GUI/CLI 进入弃用周期，在 retirement gate 完成前继续提供兼容制品。
- 扩展展示名由 Verilog Simulation Flow 更新为 Verilog Design Flow，扩展 ID 和配置键保持不变。

## [1.3.2]

- 修复波形查看器已知bug

## [1.3.1]

- 修复波形查看器已知bug
- 优化导入大波形文件时的速度

## [1.3.0]

- 优化内置波形查看器的性能。
- 波形查看器功能更新。

## [1.2.1]

- 修复某些情况下扫描不到例化的bug。
- 添加内置波形查看器（beta）。

## [1.2.0]

- 添加 testbench 生成路径的配置项。
- 添加目录变化时自动扫描模块的功能。
- 完善根据宏定义实现分析依赖与扫描端口的功能。

## [1.1.3]

- 修复扫描模块时会意外扫描到注释内模块的问题。

## [1.1.2]

- 完善 CLI 应用的功能。

## [1.1.1]

- 修复编译状态检查不生效的 bug。

## [1.1.0]

- 添加 testbench 生成功能。
- 添加 VS Code 扩展版本。

## [1.0.0]

- Python 初始版本发布。
