# -*- coding: utf-8 -*-
"""
国际化模块 — 支持中文（默认）和英文
"""

_TRANSLATIONS = {
    # ---------- Menu ----------
    "menu.file":                    {"zh": "文件(&F)",               "en": "&File"},
    "menu.file.new_project":        {"zh": "新建工程(&N)",            "en": "&New Project"},
    "menu.file.open_project":       {"zh": "打开工程(&O)...",        "en": "&Open Project..."},
    "menu.file.save_as":            {"zh": "工程另存为(&A)...",      "en": "Save Project &As..."},
    "menu.file.exit":               {"zh": "退出(&X)",               "en": "E&xit"},

    "menu.view":                    {"zh": "视图(&V)",               "en": "&View"},
    "menu.view.language":           {"zh": "语言(&L)",               "en": "&Language"},
    "menu.view.lang_zh":            {"zh": "中文",                   "en": "中文"},
    "menu.view.lang_en":            {"zh": "English",                "en": "English"},
    "menu.view.theme":              {"zh": "主题(&T)",               "en": "&Theme"},
    "menu.view.theme_dark":         {"zh": "暗色主题",               "en": "Dark"},
    "menu.view.theme_light":        {"zh": "亮色主题",               "en": "Light"},

    # ---------- Project Panel ----------
    "project.group":                {"zh": "工程",                   "en": "Project"},
    "project.no_project":           {"zh": "未打开工程",             "en": "No project opened"},
    "project.rename":               {"zh": "重命名",                "en": "Rename"},
    "project.rename_tip":           {"zh": "重命名工程",             "en": "Rename project"},
    "project.new":                  {"zh": "新建",                   "en": "New"},
    "project.open":                 {"zh": "打开",                   "en": "Open"},

    "top_module.group":             {"zh": "顶层模块",               "en": "Top Module"},
    "top_module.placeholder":       {"zh": "选择或输入顶层模块...",  "en": "Select or type top module..."},

    "file_tree.group":              {"zh": "文件目录",               "en": "File Directory"},
    "file_tree.filter":             {"zh": "过滤文件...",            "en": "Filter files..."},

    "action.analyze":               {"zh": "分析依赖",               "en": "Analyze Dependencies"},
    "action.simulate":              {"zh": "编译并仿真",             "en": "Compile && Simulate"},
    "action.open_wave":             {"zh": "打开波形",               "en": "Open Waveform"},

    # ---------- Dialogs ----------
    "dialog.new_project_title":     {"zh": "创建新工程 JSON",         "en": "Create New Project JSON"},
    "dialog.open_project_title":    {"zh": "打开工程 JSON",           "en": "Open Project JSON"},
    "dialog.json_filter":           {"zh": "JSON 文件 (*.json);;所有文件 (*)", "en": "JSON Files (*.json);;All Files (*)"},
    "dialog.rename_title":          {"zh": "重命名工程",              "en": "Rename Project"},
    "dialog.rename_prompt":         {"zh": "工程名称：",              "en": "Project name:"},

    # ---------- Project Config Panel ----------
    "config.global_lib":            {"zh": "全局库（跨工程共享）",   "en": "Global Libraries (shared across projects)"},
    "config.project_lib":           {"zh": "工程库",                 "en": "Project Libraries"},
    "config.add_global":            {"zh": "+ 添加全局库",           "en": "+ Add Global"},
    "config.remove":                {"zh": "- 移除",                 "en": "- Remove"},
    "config.add_project":           {"zh": "+ 添加工程库",           "en": "+ Add Project Lib"},

    "config.simulator":             {"zh": "仿真器",                 "en": "Simulator"},
    "config.sim_tool":              {"zh": "工具：",                 "en": "Tool:"},
    "config.sim_compile":           {"zh": "编译命令：",             "en": "Compile command:"},
    "config.sim_compile_ph":        {"zh": "例如: iverilog -o \"{output}\" {files}", "en": "e.g. iverilog -o \"{output}\" {files}"},
    "config.sim_run":               {"zh": "运行命令：",             "en": "Run command:"},
    "config.sim_run_ph":            {"zh": "例如: vvp \"{output}\"", "en": "e.g. vvp \"{output}\""},

    "config.wave_viewer":           {"zh": "波形查看器",             "en": "Wave Viewer"},
    "config.wave_tool":             {"zh": "工具：",                 "en": "Tool:"},
    "config.wave_launch":           {"zh": "启动命令：",             "en": "Launch command:"},
    "config.wave_launch_ph":        {"zh": "例如: gtkwave \"{wave_file}\"", "en": "e.g. gtkwave \"{wave_file}\""},
    "config.wave_path":             {"zh": "波形文件路径：",         "en": "Wave file path:"},
    "config.wave_path_ph":          {"zh": "{top_module}.vcd",       "en": "{top_module}.vcd"},

    "config.dialog_global_lib":     {"zh": "选择全局库目录",         "en": "Select Global Library Directory"},
    "config.dialog_project_lib":    {"zh": "选择工程库目录",         "en": "Select Project Library Directory"},

    # ---------- Tab Titles ----------
    "tab.config":                   {"zh": "工程配置",               "en": "Project Config"},
    "tab.modules":                  {"zh": "模块",                   "en": "Modules"},
    "tab.log":                      {"zh": "日志",                   "en": "Log"},
    "tab.tb":                       {"zh": "测试平台",              "en": "Testbench"},

    # ---------- Log Panel ----------
    "log.clear":                    {"zh": "清空",                   "en": "Clear"},

    # ---------- Module Panel ----------
    "module.count":                 {"zh": "模块: {total} ({dep} 个依赖, {unused} 个未使用)",
                                     "en": "Modules: {total} ({dep} deps, {unused} unused)"},
    "module.count_basic":           {"zh": "模块: {total}",          "en": "Modules: {total}"},
    "module.filter_ph":             {"zh": "过滤模块...",            "en": "Filter modules..."},
    "module.dep_section":           {"zh": "依赖模块",               "en": "Dependency Modules"},
    "module.no_modules":            {"zh": "(未扫描到模块)",         "en": "(no modules scanned)"},

    # ---------- Testbench Panel ----------
    "tb.props":                     {"zh": "测试平台属性",         "en": "Testbench Properties"},
    "tb.name_label":                {"zh": "名称:",                 "en": "Name:"},
    "tb.name":                      {"zh": "测试平台名称",         "en": "Testbench Name"},
    "tb.name_ph":                   {"zh": "例如: tb_top",         "en": "e.g. tb_top"},
    "tb.output_dir":                {"zh": "输出目录:",             "en": "Output dir:"},
    "tb.output_dir_ph":             {"zh": "留空则使用工程根目录，例如: sim/tb", "en": "empty for project root, e.g. sim/tb"},
    "tb.time_unit":                 {"zh": "时间单位:",             "en": "Time unit:"},
    "tb.time_prec":                 {"zh": "时间精度:",             "en": "Time precision:"},
    "tb.clock":                     {"zh": "时钟（最多6个）",       "en": "Clocks (max 6)"},
    "tb.clock_mhz":                 {"zh": "MHz",                   "en": "MHz"},
    "tb.reset":                     {"zh": "复位",                  "en": "Reset"},
    "tb.reset_polarity":            {"zh": "极性:",                 "en": "Polarity:"},
    "tb.reset_active_high":         {"zh": "高有效",                "en": "Active High"},
    "tb.reset_active_low":          {"zh": "低有效",                "en": "Active Low"},
    "tb.reset_duration":            {"zh": "持续时间（周期）:",     "en": "Duration (cycles):"},
    "tb.reset_duration_ph":         {"zh": "例如: 100",             "en": "e.g. 100"},
    "tb.module":                    {"zh": "被测模块（最多20个）",  "en": "Modules Under Test (max 20)"},
    "tb.module_add":                {"zh": "添加模块:",             "en": "Add module:"},
    "tb.module_placeholder":        {"zh": "从左侧列表选择一个模块", "en": "Select a module from the list"},
    "tb.module_inst":               {"zh": "实例名:",               "en": "Instance Name:"},
    "tb.module_params":             {"zh": "── 参数 ──",          "en": "-- Parameters --"},
    "tb.module_ports":              {"zh": "── 端口 ──",          "en": "-- Ports --"},
    "tb.wave":                      {"zh": "波形转储",             "en": "Waveform Dump"},
    "tb.wave_file":                 {"zh": "文件:",                 "en": "File:"},
    "tb.wave_ph":                   {"zh": "留空则使用 {name}.vcd", "en": "leave empty for {name}.vcd"},
    "tb.timeout":                   {"zh": "超时",                  "en": "Timeout"},
    "tb.timeout_max":               {"zh": "最大仿真时间:",        "en": "Max simulation time:"},
    "tb.timeout_ph":                {"zh": "例如: 1000000",        "en": "e.g. 1000000"},
    "tb.generate":                  {"zh": "生成测试平台",         "en": "Generate Testbench"},
    "tb.no_project":                {"zh": "未打开工程，请先新建或打开工程。", "en": "No project opened. Please open or create a project first."},
    "tb.name_empty":                {"zh": "请输入测试平台名称。",  "en": "Please enter a testbench name."},
    "tb.generated":                 {"zh": "测试平台已生成: {path}", "en": "Testbench generated: {path}"},

    # ---------- MainWindow ----------
    "window.title":                 {"zh": "VeriFlow - Verilog 仿真管理器", "en": "VeriFlow - Verilog Simulation Manager"},
    "status.ready":                 {"zh": "就绪",                   "en": "Ready"},
    "status.scanning":              {"zh": "正在扫描模块...",        "en": "Scanning modules..."},
    "status.analyzing":             {"zh": "正在分析依赖...",        "en": "Analyzing dependencies..."},
    "status.simulating":            {"zh": "正在仿真...",            "en": "Simulating..."},
    "status.done":                  {"zh": "分析完成: {count} 文件",  "en": "Analysis done: {count} files"},
    "status.failed_missing":        {"zh": "分析失败: 缺失模块",     "en": "Analysis failed: missing modules"},
    "status.sim_ok":                {"zh": "仿真通过 ({time}s)",     "en": "Simulation OK ({time}s)"},
    "status.sim_failed":            {"zh": "仿真失败",               "en": "Simulation failed"},
    "status.wave_sim_running":      {"zh": "正在仿真（为了生成波形）...", "en": "Simulation running (for wave)..."},
    "status.wave_opened":           {"zh": "波形已打开: {file}",     "en": "Wave opened: {file}"},
    "status.wave_not_found":        {"zh": "找不到波形文件",         "en": "Wave file not found"},
    "status.wave_failed":           {"zh": "打开波形失败: 仿真错误", "en": "Wave open failed: simulation error"},
    "status.modules_count":         {"zh": "模块数: {count}",        "en": "Modules: {count}"},
    "status.tb_generated":          {"zh": "测试平台已生成: {path}", "en": "Testbench generated: {path}"},

    # ---------- Welcome / Log Messages ----------
    "welcome.title":                {"zh": "欢迎使用 VeriFlow！",    "en": "Welcome to VeriFlow!"},
    "welcome.hint":                 {"zh": "点击新建或打开以开始。",  "en": "Click New or Open to start."},
    "log.loaded_global_libs":       {"zh": "已加载 {n} 个全局库目录", "en": "Loaded {n} global library directories"},
    "log.analyzing":                {"zh": "正在分析: top='{top}', root={root}", "en": "Analyzing: top='{top}', root={root}"},
    "log.analysis_done":            {"zh": "分析完成: {n} 个文件。",  "en": "Analysis complete: {n} file(s)."},
    "log.missing_modules":          {"zh": "缺失模块: {modules}",     "en": "Missing modules: {modules}"},
    "log.simulating":               {"zh": "正在仿真 {top} (cd {root})", "en": "Simulating {top} (cd {root})"},
    "log.sim_done":                 {"zh": "仿真完成！",             "en": "Simulation completed!"},
    "log.sim_failed":               {"zh": "仿真失败 (exit={code})", "en": "Simulation FAILED (exit={code})"},
    "log.new_project":              {"zh": "新建工程: {path}",        "en": "New project created: {path}"},
    "log.open_project":             {"zh": "已打开工程: {path}",      "en": "Project opened: {path}"},
    "log.project_saved":            {"zh": "工程已保存: {path}",      "en": "Project saved: {path}"},
    "log.project_renamed":          {"zh": "工程已重命名: {name}",    "en": "Project renamed to: {name}"},
    "log.duplicate_modules":        {"zh": "模块重名: {modules}",     "en": "Duplicate modules: {modules}"},
    "log.duplicate_module_detail":   {"zh": "  模块 {module} 定义于: {file}:{line}", "en": "  Module {module} defined in: {file}:{line}"},
    "log.open_project_failed":      {"zh": "打开工程失败: {err}",     "en": "Failed to open project: {err}"},
    "log.no_project":               {"zh": "未打开工程。",           "en": "No project opened."},
    "log.wave_not_found":           {"zh": "波形文件未找到: {file}",  "en": "Wave file not found: {file}"},
    "log.wave_running_sim":         {"zh": "正在运行仿真以生成波形...", "en": "Running simulation to generate waveform..."},
    "log.wave_open_ok":             {"zh": "已打开 {viewer}: {file}", "en": "Opened {viewer}: {file}"},
    "log.wave_open_failed":         {"zh": "打开 {viewer} 失败: {err}", "en": "Failed to open {viewer}: {err}"},
    "log.wave_sim_failed":          {"zh": "仿真失败，无法打开波形。", "en": "Simulation failed, cannot open waveform."},
    "log.wave_check_dumpfile":      {"zh": "波形文件未找到: {file}\n请检查 testbench 中的 $dumpfile 设置或工程配置中的波形文件路径。",
                                     "en": "Wave file not found: {file}\nCheck testbench $dumpfile setting or wave file path in Project Config."},
    "log.file_open_failed":         {"zh": "无法打开文件: {err}",     "en": "Failed to open file: {err}"},
    "log.created":                  {"zh": "已创建: {path}",          "en": "Created: {path}"},
    "log.opened":                   {"zh": "已打开: {path}",          "en": "Opened: {path}"},
    "log.saved":                    {"zh": "已保存: {path}",          "en": "Saved: {path}"},

    # ---------- Message Boxes ----------
    "msgbox.error":                 {"zh": "错误",                   "en": "Error"},
    "msgbox.missing":               {"zh": "缺少信息",               "en": "Missing"},
    "msgbox.no_project":            {"zh": "未打开工程，请先新建或打开。", "en": "No project opened. Use New or Open first."},
    "msgbox.no_top_module":         {"zh": "请输入顶层模块名称。",    "en": "Please enter a top module name."},
    "msgbox.save_as_title":         {"zh": "工程另存为 JSON",        "en": "Save Project As JSON"},
}

_current_lang = "zh"


def set_language(lang: str):
    global _current_lang
    _current_lang = lang if lang in ("zh", "en") else "zh"


def get_language() -> str:
    return _current_lang


def tr(key: str, **kwargs) -> str:
    entry = _TRANSLATIONS.get(key)
    if entry:
        text = entry.get(_current_lang, entry.get("en", key))
    else:
        text = key
    if kwargs:
        text = text.format(**kwargs)
    return text
