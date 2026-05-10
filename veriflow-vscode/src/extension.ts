import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import { getWorkspaceRoot, getTopModule, setTopModule, getSettings, ExtensionSettings } from './config';
import { ModuleTreeProvider } from './moduleTreeProvider';
import { TestbenchPanelProvider } from './testbenchPanel';
import * as output from './output';
import {
    DependencyAnalyzer, SimulationRunner, LogParser,
    listVerilogFiles, readText, removeComments,
    ModuleScanResult, DependencyResult, SimulationResult,
    SimulatorConfig, WaveViewerConfig, MODULE_DECL_RE,
} from './core';

const DEFAULT_SIMULATORS: Record<string, SimulatorConfig> = {
    iverilog: {
        name: 'iverilog',
        compileCmd: 'iverilog -o "{output}" {files}',
        runCmd: 'vvp "{output}"',
    },
    vcs: {
        name: 'vcs',
        compileCmd: 'vcs -full64 -o "{output}" {files}',
        runCmd: './"{output}"',
    },
    xsim: {
        name: 'xsim',
        compileCmd: 'xvlog {files} && xelab {top_module} -snapshot "{output}"',
        runCmd: 'xsim "{output}" --runall',
    },
    custom: {
        name: 'custom',
        compileCmd: '',
        runCmd: '',
    },
};

const DEFAULT_VIEWERS: Record<string, WaveViewerConfig> = {
    surfer: { name: 'surfer', launchCmd: 'surfer "{wave_file}"' },
    gtkwave: { name: 'gtkwave', launchCmd: 'gtkwave "{wave_file}"' },
    custom: { name: 'custom', launchCmd: '' },
};

let treeProvider: ModuleTreeProvider;
let tbPanelProvider: TestbenchPanelProvider;
let statusBarItem: vscode.StatusBarItem;
let simulateProcess: child_process.ChildProcess | null = null;
let depAnalyzer = new DependencyAnalyzer();
let simRunner = new SimulationRunner();

export function activate(context: vscode.ExtensionContext): void {
    treeProvider = new ModuleTreeProvider();
    tbPanelProvider = new TestbenchPanelProvider(context);

    const treeView = vscode.window.createTreeView('veriflow.modules', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            TestbenchPanelProvider.viewType,
            tbPanelProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(circuit-board) VeriFlow';
    statusBarItem.tooltip = 'VeriFlow: Verilog Simulation Manager';
    statusBarItem.command = 'veriflow.showOutput';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    const cmds: [string, (...args: any[]) => any][] = [
        ['veriflow.selectTop', () => cmdSelectTop(context)],
        ['veriflow.analyze', () => cmdAnalyze(context)],
        ['veriflow.simulate', () => cmdSimulate(context)],
        ['veriflow.openWave', () => cmdOpenWave(context)],
        ['veriflow.scanModules', () => cmdScanModules(context)],
        ['veriflow.showOutput', () => output.show()],
    ];
    for (const [name, fn] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(name, fn));
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('veriflow')) { cmdScanModules(context); }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => { cmdScanModules(context); })
    );

    const savedTop = getTopModule(context);
    if (savedTop) { treeProvider.topModule = savedTop; }

    cmdScanModules(context);
}

export function deactivate(): void {
    if (simulateProcess) {
        simulateProcess.kill();
        simulateProcess = null;
    }
    output.dispose();
}

function _resolveSimulator(settings: ExtensionSettings): SimulatorConfig {
    if (settings.simulator === 'custom') {
        return {
            name: 'custom',
            compileCmd: settings.simulatorCompileCmd || '',
            runCmd: settings.simulatorRunCmd || '',
        };
    }
    return DEFAULT_SIMULATORS[settings.simulator] || DEFAULT_SIMULATORS.iverilog;
}

function _resolveViewer(settings: ExtensionSettings): WaveViewerConfig {
    if (settings.waveViewer === 'custom') {
        return { name: 'custom', launchCmd: settings.waveViewerCmd || '' };
    }
    return DEFAULT_VIEWERS[settings.waveViewer] || DEFAULT_VIEWERS.surfer;
}

function _collectSearchDirs(root: string, libDirs: string[]): string[] {
    const dirs = [root];
    for (const d of libDirs) {
        if (d && !dirs.includes(d)) { dirs.push(d); }
    }
    return dirs;
}

function _scanModulesInternal(root: string, libDirs: string[]): ModuleScanResult {
    const searchDirs = _collectSearchDirs(root, libDirs);
    const modulesByDir: Record<string, string[]> = {};
    const allModuleFiles: Record<string, string> = {};
    const allModules = new Map<string, string[]>();

    for (const searchDir of searchDirs) {
        if (!require('fs').existsSync(searchDir)) { continue; }
        const dirModules: string[] = [];
        for (const vfile of listVerilogFiles(searchDir)) {
            try {
                const content = readText(vfile);
                const cleaned = removeComments(content);
                MODULE_DECL_RE.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = MODULE_DECL_RE.exec(cleaned)) !== null) {
                    const modName = match[1];
                    if (!allModules.has(modName)) {
                        allModules.set(modName, []);
                    }
                    allModules.get(modName)!.push(vfile);
                    if (!(modName in allModuleFiles)) {
                        allModuleFiles[modName] = vfile;
                    }
                    if (!dirModules.includes(modName)) {
                        dirModules.push(modName);
                    }
                }
            } catch {
                // skip
            }
        }
        if (dirModules.length > 0) {
            modulesByDir[searchDir] = dirModules.sort();
        }
    }

    const duplicates: Record<string, string[]> = {};
    for (const [modName, files] of allModules.entries()) {
        const unique = [...new Set(files)];
        if (unique.length > 1) {
            duplicates[modName] = unique;
        }
    }

    return {
        root,
        libDirs,
        totalModules: allModules.size,
        modules: Array.from(allModules.keys()).sort(),
        modulesByDir,
        moduleFiles: allModuleFiles,
        duplicates,
    };
}

async function cmdScanModules(context: vscode.ExtensionContext): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { return; }

    const settings = getSettings();
    statusBarItem.text = '$(sync~spin) VeriFlow: scanning...';

    const result = _scanModulesInternal(root, settings.libDirs);
    treeProvider.setScanResult(result);
    tbPanelProvider.setModuleMap(result.moduleFiles);
    statusBarItem.text = `$(circuit-board) VeriFlow: ${result.totalModules} modules`;
}

async function cmdSelectTop(context: vscode.ExtensionContext): Promise<void> {
    const moduleNames = treeProvider.getModuleNames();
    if (moduleNames.length === 0) {
        vscode.window.showWarningMessage('No modules found. Open a Verilog workspace first.');
        return;
    }
    const selected = await vscode.window.showQuickPick(moduleNames, {
        placeHolder: 'Select top module for simulation',
    });
    if (selected) {
        treeProvider.topModule = selected;
        await setTopModule(context, selected);
        output.appendInfo(`Top module: ${selected}`);
    }
}

async function cmdAnalyze(context: vscode.ExtensionContext): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }

    let topModule = treeProvider.topModule;
    if (!topModule) {
        await cmdSelectTop(context);
        topModule = treeProvider.topModule;
    }
    if (!topModule) { vscode.window.showWarningMessage('Please select a top module.'); return; }

    const settings = getSettings();
    const searchDirs = _collectSearchDirs(root, settings.libDirs);

    output.clear();
    output.show();
    output.appendInfo(`Analyzing: top=${topModule}, root=${root}`);
    statusBarItem.text = '$(search) VeriFlow: analyzing...';

    const result = depAnalyzer.resolve(topModule, searchDirs);
    treeProvider.setAnalyzeResult(result);

    if (result.missingModules.length === 0) {
        output.appendSuccess(`Analysis complete: ${result.files.length} file(s).`);
        result.files.forEach(f => output.appendLine(`  ${f}`));
        statusBarItem.text = `$(check) VeriFlow: ${result.files.length} files`;
    } else {
        output.appendError(`Missing modules: ${result.missingModules.join(', ')}`);
        statusBarItem.text = '$(warning) VeriFlow: missing modules';
    }
}

async function cmdSimulate(context: vscode.ExtensionContext): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }

    let topModule = treeProvider.topModule;
    if (!topModule) {
        await cmdSelectTop(context);
        topModule = treeProvider.topModule;
    }
    if (!topModule) { vscode.window.showWarningMessage('Please select a top module.'); return; }

    const settings = getSettings();
    const searchDirs = _collectSearchDirs(root, settings.libDirs);
    const simulator = _resolveSimulator(settings);

    output.clear();
    output.show(true);
    output.appendInfo('========================================');
    output.appendInfo(`Simulation: ${topModule}`);
    output.appendInfo(`Simulator: ${simulator.name}`);
    output.appendInfo(`Root: ${root}`);
    output.appendInfo('========================================');
    statusBarItem.text = '$(run) VeriFlow: simulating...';

    const depResult = depAnalyzer.resolve(topModule, searchDirs);
    if (depResult.missingModules.length > 0) {
        output.appendError(`Missing modules: ${depResult.missingModules.join(', ')}`);
        statusBarItem.text = '$(error) VeriFlow: missing modules';
        return;
    }

    output.appendInfo(`Resolved ${depResult.files.length} file(s)`);
    const outFile = path.join(root, `${topModule}.out`);

    // Run synchronously with progress indication
    const result = simRunner.compileAndRun(
        depResult.files, outFile, simulator, root, topModule
    );

    if (result.stdout) {
        for (const line of result.stdout.split('\n')) {
            if (line.trim()) { output.appendLine(line); }
        }
    }
    if (result.stderr) {
        for (const line of result.stderr.split('\n')) {
            if (line.trim()) { output.appendError(line); }
        }
    }

    if (result.success) {
        output.appendSuccess(`Simulation OK (${result.elapsedTime.toFixed(2)}s)`);
        statusBarItem.text = '$(check) VeriFlow: simulation OK';
    } else {
        output.appendError(`Simulation FAILED (exit=${result.exitCode})`);
        for (const entry of result.logEntries) {
            if (entry.level === 'ERROR') {
                output.appendError(entry.message);
            }
        }
        statusBarItem.text = `$(error) VeriFlow: failed (${result.exitCode})`;
    }
    output.show();
}

async function cmdOpenWave(context: vscode.ExtensionContext): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }

    let topModule = treeProvider.topModule;
    if (!topModule) {
        await cmdSelectTop(context);
        topModule = treeProvider.topModule;
    }
    if (!topModule) { vscode.window.showWarningMessage('Please select a top module.'); return; }

    const settings = getSettings();
    const waveFile = path.join(root, settings.waveFileTemplate.replace('{top_module}', topModule));

    const fs = require('fs');
    if (!fs.existsSync(waveFile)) {
        output.appendWarning(`Wave file not found: ${waveFile}`);
        output.appendInfo('Run simulation first to generate waveform.');
        vscode.window.showInformationMessage(
            'Waveform file not found. Run simulation first.', 'Simulate'
        ).then(choice => {
            if (choice === 'Simulate') {
                vscode.commands.executeCommand('veriflow.simulate');
            }
        });
        return;
    }

    const viewer = _resolveViewer(settings);
    output.appendInfo(`Opening ${viewer.name}: ${waveFile}`);
    try {
        simRunner.openWave(waveFile, viewer);
        output.appendSuccess(`Opened ${viewer.name}: ${waveFile}`);
    } catch (err: any) {
        output.appendError(`Failed to open ${viewer.name}: ${err.message}`);
    }
    statusBarItem.text = '$(pulse) VeriFlow';
}
