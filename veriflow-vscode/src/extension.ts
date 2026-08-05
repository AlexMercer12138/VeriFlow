import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
    getWorkspaceRoot, getTopModule, setTopModule, getSettings, ExtensionSettings,
    getAnalyzeStatus, setAnalyzeStatus, getSimulateStatus, setSimulateStatus,
    getDependencyResult, setDependencyResult,
} from './config';
import { ModuleTreeProvider } from './moduleTreeProvider';
import { showModuleInstantiationPicker } from './moduleInstantiationCommand';
import { TestbenchPanelProvider } from './testbenchPanel';
import { WaveformEditorProvider } from './waveformEditorProvider';
import * as output from './output';
import {
    DependencyAnalyzer, SimulationRunner, LogParser,
    listVerilogFiles, readText, preprocessVerilog, removeComments,
    ModuleScanResult, DependencyResult, SimulationResult,
    SimulatorConfig, WaveViewerConfig, MODULE_DECL_RE,
    HdlParserClient, createHdlParserClient, WorkspaceHdlIndex,
} from './core';
import { WorkspaceIndexStore } from './core/hdl/workspaceIndexStore';

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
    builtin: { name: 'builtin', launchCmd: '' },
    surfer: { name: 'surfer', launchCmd: 'surfer "{wave_file}"' },
    gtkwave: { name: 'gtkwave', launchCmd: 'gtkwave "{wave_file}"' },
    custom: { name: 'custom', launchCmd: '' },
};

let treeProvider: ModuleTreeProvider;
let tbPanelProvider: TestbenchPanelProvider;
let statusBarItem: vscode.StatusBarItem;
let simulateProcess: child_process.ChildProcess | null = null;
let depAnalyzer: DependencyAnalyzer | undefined;
let simRunner = new SimulationRunner();
let hdlParser: HdlParserClient | undefined;
let hdlParserExtensionPath: string | undefined;
let hdlIndex: WorkspaceHdlIndex | undefined;
let hdlIndexLoad: Promise<void> | undefined;
let hdlIndexIdentity: string | undefined;
let hdlOperationTail: Promise<void> = Promise.resolve();
let hdlPreparationInFlight: {
    identity: string;
    promise: Promise<DependencyAnalyzer>;
} | undefined;

const HDL_PARSER_FINGERPRINT = 'tree-sitter-systemverilog-0.4.0';

// 状态管理
let _analyzeStatus: string = 'idle';
let _simulateStatus: string = 'idle';
let _lastDepFileHashes: Record<string, string> = {};
let _pendingSimulateAfterAnalyze = false;
let _pendingWaveAfterSimulate = false;
let _pendingWaveAfterAnalyze = false;

export function activate(context: vscode.ExtensionContext): void {
    if (hdlParser && hdlParserExtensionPath !== context.extensionPath) {
        throw new Error(
            'HDL parser belongs to a different extension path; call deactivate() before reactivating'
        );
    }
    treeProvider = new ModuleTreeProvider();
    tbPanelProvider = new TestbenchPanelProvider(context);

    const treeView = vscode.window.createTreeView('veriflow.modules', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    treeView.onDidChangeVisibility((e) => {
        if (e.visible) { cmdScanModules(context); }
    });
    context.subscriptions.push(treeView);
    tbPanelProvider.setBeforeGenerate(async () => {
        await cmdScanModules(context);
    });
    tbPanelProvider.setOnVisible(async () => {
        await cmdScanModules(context);
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            TestbenchPanelProvider.viewType,
            tbPanelProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            WaveformEditorProvider.viewType,
            new WaveformEditorProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
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
        ['veriflow.openVcdViewer', (uri?: vscode.Uri) => cmdOpenVcdViewer(uri)],
        ['veriflow.scanModules', () => cmdScanModules(context)],
        ['veriflow.instantiateModule', () => cmdInstantiateModule(context)],
        ['veriflow.showOutput', () => output.show()],
    ];
    for (const [name, fn] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(name, fn));
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('veriflow.defines')) {
                hdlParser?.clearCache();
            }
            if (e.affectsConfiguration('veriflow')) { cmdScanModules(context); }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => { cmdScanModules(context); })
    );

    // 文件系统监视器：检测工作区文件变动
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{v,sv,vh,svh}');
    watcher.onDidChange(() => _markOutdatedIfCompleted(context));
    watcher.onDidCreate(() => _markOutdatedIfCompleted(context));
    watcher.onDidDelete(() => _markOutdatedIfCompleted(context));
    context.subscriptions.push(watcher);

    // 窗口焦点变化检测
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => {
            if (e.focused) {
                _checkDepFilesChanged(context);
            } else {
                _saveDepFileHashes(context);
            }
        })
    );

    const savedTop = getTopModule(context);
    if (savedTop) { treeProvider.topModule = savedTop; }

    // 恢复状态
    _restoreState(context);

    cmdScanModules(context);
}

export function getHdlParser(context: vscode.ExtensionContext): HdlParserClient {
    if (hdlParser) {
        if (hdlParserExtensionPath !== context.extensionPath) {
            throw new Error(
                'HDL parser belongs to a different extension path; call deactivate() before reuse'
            );
        }
        return hdlParser;
    }
    hdlParser = createHdlParserClient(context);
    hdlParserExtensionPath = context.extensionPath;
    return hdlParser;
}

function _filterHdlDefines(
    defines: Record<string, string | boolean>
): Record<string, string | true> {
    return Object.fromEntries(
        Object.entries(defines).filter(
            (entry): entry is [string, string | true] => entry[1] !== false
        )
    );
}

function _isHdlUri(uri: vscode.Uri): boolean {
    return ['.v', '.sv', '.vh', '.svh'].includes(path.posix.extname(uri.path).toLowerCase());
}

function _joinRelativeUri(base: vscode.Uri, relativePath: string): vscode.Uri {
    const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    return vscode.Uri.joinPath(base, ...segments);
}

function _absoluteUri(base: vscode.Uri, value: string): vscode.Uri | undefined {
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
        return vscode.Uri.file(value);
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
        return vscode.Uri.parse(value);
    }
    if (value.startsWith('/')) {
        return base.scheme === 'file'
            ? vscode.Uri.file(value)
            : base.with({ path: path.posix.normalize(value) });
    }
    return undefined;
}

function _dependencyRootUris(root: string, libDirs: string[]): string[] {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
        ?? vscode.Uri.file(root);
    const roots = [workspaceRoot];
    for (const libDir of libDirs) {
        if (!libDir) {
            continue;
        }
        roots.push(_absoluteUri(workspaceRoot, libDir)
            ?? _joinRelativeUri(workspaceRoot, libDir));
    }
    return [...new Set(roots.map(uri => uri.toString()))];
}

async function _findHdlFiles(root: vscode.Uri, files: string[]): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
        return;
    }
    entries.sort(([left], [right]) => left.localeCompare(right));
    for (const [name, fileType] of entries) {
        const uri = vscode.Uri.joinPath(root, name);
        if ((fileType & vscode.FileType.Directory) !== 0) {
            if (!name.startsWith('.')) {
                await _findHdlFiles(uri, files);
            }
        } else if ((fileType & vscode.FileType.File) !== 0 && _isHdlUri(uri)) {
            files.push(uri.toString());
        }
    }
}

async function _isFile(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return (stat.type & vscode.FileType.File) !== 0;
    } catch {
        return false;
    }
}

function _createWorkspaceHdlIndex(
    context: vscode.ExtensionContext,
    defines: Record<string, string | true>,
    rootIdentity: string
): WorkspaceHdlIndex {
    const knownHdlUris = new Set<string>();
    const rootUris: vscode.Uri[] = [];
    const store = new WorkspaceIndexStore(context.workspaceState);
    return new WorkspaceHdlIndex({
        parser: getHdlParser(context),
        store,
        parserFingerprint: `${HDL_PARSER_FINGERPRINT}:${crypto.createHash('sha256')
            .update(rootIdentity)
            .digest('hex')}`,
        defines,
        async findFiles(roots: string[]): Promise<string[]> {
            knownHdlUris.clear();
            rootUris.splice(0, rootUris.length, ...roots.map(root => vscode.Uri.parse(root)));
            const files: string[] = [];
            for (const root of rootUris) {
                await _findHdlFiles(root, files);
            }
            for (const uri of files) {
                knownHdlUris.add(uri);
            }
            return [...knownHdlUris].sort();
        },
        async readFile(uri: string) {
            const resource = vscode.Uri.parse(uri);
            const [bytes, stat] = await Promise.all([
                vscode.workspace.fs.readFile(resource),
                vscode.workspace.fs.stat(resource),
            ]);
            return {
                text: Buffer.from(bytes).toString('utf8'),
                version: stat.mtime,
                mtimeMs: stat.mtime,
                size: stat.size,
            };
        },
        async resolveInclude(fromUri: string, includePath: string) {
            const source = vscode.Uri.parse(fromUri);
            const absolute = _absoluteUri(source, includePath);
            const candidates = absolute ? [absolute] : [
                _joinRelativeUri(vscode.Uri.joinPath(source, '..'), includePath),
                ...rootUris.map(root => _joinRelativeUri(root, includePath)),
            ];
            if (!absolute) {
                const normalizedSuffix = `/${includePath
                    .replace(/\\/g, '/')
                    .replace(/^\/+/, '')}`;
                for (const knownUri of [...knownHdlUris].sort()) {
                    const candidate = vscode.Uri.parse(knownUri);
                    if (candidate.path.endsWith(normalizedSuffix)) {
                        candidates.push(candidate);
                    }
                }
            }
            const seen = new Set<string>();
            for (const candidate of candidates) {
                const key = candidate.toString();
                if (!seen.has(key) && await _isFile(candidate)) {
                    return key;
                }
                seen.add(key);
            }
            return undefined;
        },
    });
}

async function _getDependencyAnalyzer(
    context: vscode.ExtensionContext,
    rootUris: string[],
    defines: Record<string, string | true>
): Promise<DependencyAnalyzer> {
    const rootIdentity = JSON.stringify(rootUris);
    if (hdlIndex && hdlIndexIdentity !== rootIdentity) {
        _resetDependencyIndex();
    }
    let index = hdlIndex;
    if (!index) {
        index = _createWorkspaceHdlIndex(context, defines, rootIdentity);
        hdlIndex = index;
        hdlIndexIdentity = rootIdentity;
        depAnalyzer = new DependencyAnalyzer(index);
        hdlIndexLoad = index.load();
    }
    return _finishDependencyIndexPreparation(
        index,
        depAnalyzer!,
        hdlIndexLoad!,
        rootUris,
        defines
    );
}

function _resetDependencyIndex(): void {
    const index = hdlIndex;
    hdlIndex = undefined;
    hdlIndexLoad = undefined;
    hdlIndexIdentity = undefined;
    depAnalyzer = undefined;
    index?.dispose();
}

function _runDependencyOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = hdlOperationTail.then(operation);
    hdlOperationTail = result.then(() => undefined, () => undefined);
    return result;
}

function _prepareDependencyAnalyzer(
    context: vscode.ExtensionContext,
    rootUris: string[],
    defines: Record<string, string | true>
): Promise<DependencyAnalyzer> {
    const identity = JSON.stringify([
        rootUris,
        Object.entries(defines).sort(([left], [right]) => left.localeCompare(right)),
    ]);
    if (hdlPreparationInFlight?.identity === identity) {
        return hdlPreparationInFlight.promise;
    }
    const preparation = {
        identity,
        promise: _runDependencyOperation(async () => {
            try {
                return await _getDependencyAnalyzer(context, rootUris, defines);
            } catch (error) {
                _resetDependencyIndex();
                throw error;
            }
        }),
    };
    hdlPreparationInFlight = preparation;
    const clearPreparation = (): void => {
        if (hdlPreparationInFlight === preparation) {
            hdlPreparationInFlight = undefined;
        }
    };
    void preparation.promise.then(clearPreparation, clearPreparation);
    return preparation.promise;
}

function _resolveDependencies(
    context: vscode.ExtensionContext,
    root: string,
    settings: ExtensionSettings,
    topDefinitionKeyOrName: string
): Promise<DependencyResult> {
    const rootUris = _dependencyRootUris(root, settings.libDirs);
    const defines = _filterHdlDefines(settings.defines);
    const preparation = _prepareDependencyAnalyzer(context, rootUris, defines);
    return _runDependencyOperation(async () => {
        const analyzer = await preparation;
        try {
            return analyzer.resolve(
                _definitionKeyOrName(hdlIndex!, topDefinitionKeyOrName)
            );
        } catch (error) {
            _resetDependencyIndex();
            throw error;
        }
    });
}

async function _finishDependencyIndexPreparation(
    index: WorkspaceHdlIndex,
    analyzer: DependencyAnalyzer,
    load: Promise<void>,
    rootUris: string[],
    defines: Record<string, string | true>
): Promise<DependencyAnalyzer> {
    await load;
    await index.updateConfiguration(defines);
    await index.scan(rootUris);
    return analyzer;
}

function _definitionKeyOrName(index: WorkspaceHdlIndex, value: string): string {
    const exact = index.getDefinition(value);
    if (exact?.kind === 'module') {
        return exact.key;
    }
    const definitions = index.findDefinitions(value, 'module');
    return definitions.length === 1 ? definitions[0].key : value;
}

export async function deactivate(): Promise<void> {
    if (simulateProcess) {
        simulateProcess.kill();
        simulateProcess = null;
    }
    await hdlOperationTail;
    hdlOperationTail = Promise.resolve();
    hdlPreparationInFlight = undefined;
    _resetDependencyIndex();
    const parser = hdlParser;
    hdlParser = undefined;
    hdlParserExtensionPath = undefined;
    try {
        await parser?.dispose();
    } finally {
        output.dispose();
    }
}

function _restoreState(context: vscode.ExtensionContext): void {
    _analyzeStatus = getAnalyzeStatus(context);
    _simulateStatus = getSimulateStatus(context);
    const savedResult = getDependencyResult(context);
    if (savedResult) {
        treeProvider.setAnalyzeResult(savedResult);
        _saveDepFileHashes(context, savedResult);
    }
    _updateStatusBar();
}

function _updateStatusBar(): void {
    const parts: string[] = ['$(circuit-board) VeriFlow'];
    if (_analyzeStatus !== 'idle') {
        const icon = _analyzeStatus === 'completed' ? '$(check)' : _analyzeStatus === 'error' ? '$(error)' : '$(warning)';
        parts.push(`${icon} analyze:${_analyzeStatus}`);
    }
    if (_simulateStatus !== 'idle') {
        const icon = _simulateStatus === 'completed' ? '$(check)' : _simulateStatus === 'error' ? '$(error)' : '$(warning)';
        parts.push(`${icon} sim:${_simulateStatus}`);
    }
    statusBarItem.text = parts.join(' | ');
}

function _setAnalyzeStatus(context: vscode.ExtensionContext, status: string): void {
    _analyzeStatus = status;
    setAnalyzeStatus(context, status);
    // 分析依赖变为 outdated/error/idle 时，编译仿真也同步
    if (status === 'outdated' || status === 'error' || status === 'idle') {
        _setSimulateStatus(context, status);
    }
    _updateStatusBar();
}

function _setSimulateStatus(context: vscode.ExtensionContext, status: string): void {
    _simulateStatus = status;
    setSimulateStatus(context, status);
    _updateStatusBar();
}

function _fileHash(filepath: string): string {
    try {
        const data = fs.readFileSync(filepath);
        return crypto.createHash('md5').update(data).digest('hex');
    } catch {
        return '';
    }
}

function _computeDepHashes(result: DependencyResult): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const f of result.files) {
        hashes[f] = _fileHash(f);
    }
    return hashes;
}

function _saveDepFileHashes(context: vscode.ExtensionContext, result?: DependencyResult): void {
    const depResult = result || treeProvider.analyzeResult;
    if (depResult) {
        _lastDepFileHashes = _computeDepHashes(depResult);
    }
}

function _checkDepFilesChanged(context: vscode.ExtensionContext): void {
    const depResult = treeProvider.analyzeResult;
    if (!depResult || _simulateStatus !== 'completed') { return; }

    const currentHashes = _computeDepHashes(depResult);
    let changed = false;

    // 检查文件列表变化
    const currentFiles = new Set(depResult.files);
    const lastFiles = new Set(Object.keys(_lastDepFileHashes));
    if (currentFiles.size !== lastFiles.size || ![...currentFiles].every(f => lastFiles.has(f))) {
        changed = true;
    } else {
        // 检查内容变化
        for (const f of depResult.files) {
            if (_lastDepFileHashes[f] !== currentHashes[f]) {
                changed = true;
                break;
            }
        }
    }

    if (changed) {
        _setSimulateStatus(context, 'outdated');
        vscode.window.showInformationMessage('Dependency files changed. Simulation marked as outdated.');
    }
    _lastDepFileHashes = currentHashes;
}

function _markOutdatedIfCompleted(context: vscode.ExtensionContext): void {
    if (_simulateStatus === 'completed') {
        _setSimulateStatus(context, 'outdated');
    }
    if (_analyzeStatus === 'completed') {
        _setAnalyzeStatus(context, 'outdated');
    }
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
    return DEFAULT_VIEWERS[settings.waveViewer] || DEFAULT_VIEWERS.builtin;
}

function _isSimulatorReady(simulator: SimulatorConfig): boolean {
    return Boolean(simulator.compileCmd?.trim() && simulator.runCmd?.trim());
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
    const allModules = new Map<string, Array<{ file: string; line: number }>>();

    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) { continue; }
        const dirModules: string[] = [];
        for (const vfile of listVerilogFiles(searchDir)) {
            try {
                const content = preprocessVerilog(removeComments(readText(vfile)));
                const lines = content.split('\n');
                let inBlockComment = false;
                for (let lineNo = 0; lineNo < lines.length; lineNo++) {
                    let stripped = lines[lineNo].trim();
                    while (true) {
                        if (inBlockComment) {
                            const endIdx = stripped.indexOf('*/');
                            if (endIdx === -1) {
                                stripped = '';
                                break;
                            }
                            inBlockComment = false;
                            stripped = stripped.substring(endIdx + 2);
                        } else {
                            const slIdx = stripped.indexOf('//');
                            const bsIdx = stripped.indexOf('/*');
                            if (slIdx !== -1 && (bsIdx === -1 || slIdx < bsIdx)) {
                                stripped = stripped.substring(0, slIdx);
                                break;
                            } else if (bsIdx !== -1) {
                                inBlockComment = true;
                                stripped = stripped.substring(0, bsIdx);
                            } else {
                                break;
                            }
                        }
                    }
                    MODULE_DECL_RE.lastIndex = 0;
                    let match: RegExpExecArray | null;
                    while ((match = MODULE_DECL_RE.exec(stripped)) !== null) {
                        const modName = match[1];
                        if (!allModules.has(modName)) {
                            allModules.set(modName, []);
                        }
                        allModules.get(modName)!.push({ file: vfile, line: lineNo + 1 });
                        if (!(modName in allModuleFiles)) {
                            allModuleFiles[modName] = vfile;
                        }
                        if (!dirModules.includes(modName)) {
                            dirModules.push(modName);
                        }
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
    const duplicatesWithLines: Record<string, Array<{ file: string; line: number }>> = {};
    for (const [modName, entries] of allModules.entries()) {
        const seenFiles = new Set<string>();
        const uniqueEntries: Array<{ file: string; line: number }> = [];
        for (const entry of entries) {
            if (!seenFiles.has(entry.file)) {
                seenFiles.add(entry.file);
                uniqueEntries.push(entry);
            }
        }
        if (uniqueEntries.length > 1) {
            duplicates[modName] = uniqueEntries.map(e => e.file);
            duplicatesWithLines[modName] = uniqueEntries;
        }
    }

    // 只从工作区目录选取的模块列表
    const workspaceModules = modulesByDir[root] || [];

    return {
        root,
        libDirs,
        totalModules: allModules.size,
        modules: Array.from(allModules.keys()).sort(),
        workspaceModules,
        modulesByDir,
        moduleFiles: allModuleFiles,
        duplicates,
        duplicatesWithLines,
    };
}

async function cmdScanModules(context: vscode.ExtensionContext): Promise<ModuleScanResult | null> {
    const root = getWorkspaceRoot();
    if (!root) { return null; }

    const settings = getSettings();
    statusBarItem.text = '$(sync~spin) VeriFlow: scanning...';

    const result = _scanModulesInternal(root, settings.libDirs);
    treeProvider.setScanResult(result);
    tbPanelProvider.setModuleMap(result.moduleFiles);

    // 输出重复模块详细日志
    if (result.duplicatesWithLines && Object.keys(result.duplicatesWithLines).length > 0) {
        for (const [modName, entries] of Object.entries(result.duplicatesWithLines)) {
            for (const entry of entries) {
                output.appendWarning(`  Module ${modName} defined in: ${entry.file}:${entry.line}`);
            }
        }
    }

    statusBarItem.text = `$(circuit-board) VeriFlow: ${result.totalModules} modules`;
    return result;
}

async function cmdInstantiateModule(context: vscode.ExtensionContext): Promise<void> {
    if (!getWorkspaceRoot()) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
    }
    const result = await cmdScanModules(context);
    if (result) {
        await showModuleInstantiationPicker(result);
    }
}

async function cmdSelectTop(context: vscode.ExtensionContext): Promise<void> {
    // 只从工作区目录的模块中选取
    const workspaceModules = treeProvider.getWorkspaceModuleNames();
    if (workspaceModules.length === 0) {
        vscode.window.showWarningMessage('No modules found in workspace. Add .v/.sv files or configure veriflow.libDirs, then scan again.');
        return;
    }
    const selected = await vscode.window.showQuickPick(workspaceModules, {
        placeHolder: 'Select top module for simulation (workspace only)',
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

    // 检查文件变动
    _checkDepFilesChanged(context);

    const settings = getSettings();

    output.clear();
    output.show();
    output.appendInfo(`Analyzing: top=${topModule}, root=${root}`);
    statusBarItem.text = '$(search) VeriFlow: analyzing...';

    const result = await _resolveDependencies(context, root, settings, topModule);
    treeProvider.setAnalyzeResult(result);

    // 保存结果和状态
    await setDependencyResult(context, result);
    _saveDepFileHashes(context, result);

    const ambiguousNames = Object.keys(result.ambiguousModules);
    if (result.missingModules.length === 0 && ambiguousNames.length === 0) {
        output.appendSuccess(`Analysis complete: ${result.files.length} file(s).`);
        result.files.forEach(f => output.appendLine(`  ${f}`));
        _setAnalyzeStatus(context, 'completed');
    } else {
        if (result.missingModules.length > 0) {
            output.appendError(`Missing modules: ${result.missingModules.join(', ')}`);
        }
        for (const name of ambiguousNames) {
            output.appendError(
                `Ambiguous module ${name}: ${result.ambiguousModules[name].join(', ')}`
            );
        }
        _setAnalyzeStatus(context, 'error');
    }

    // 如果有挂起的仿真/波形请求，继续执行
    if (_pendingSimulateAfterAnalyze) {
        _pendingSimulateAfterAnalyze = false;
        if (result.missingModules.length === 0 && ambiguousNames.length === 0) {
            await cmdSimulate(context);
        }
        return;
    }
    if (_pendingWaveAfterAnalyze) {
        _pendingWaveAfterAnalyze = false;
        if (result.missingModules.length === 0 && ambiguousNames.length === 0) {
            _pendingWaveAfterSimulate = true;
            await cmdSimulate(context);
        }
        return;
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

    // 检查文件变动
    _checkDepFilesChanged(context);

    // 检查分析依赖状态
    if (_analyzeStatus !== 'completed') {
        output.appendInfo(`Analyze status is ${_analyzeStatus}; running analyze -> simulate.`);
        _pendingSimulateAfterAnalyze = true;
        await cmdAnalyze(context);
        return;
    }

    const settings = getSettings();
    const simulator = _resolveSimulator(settings);
    if (!_isSimulatorReady(simulator)) {
        output.show(true);
        output.appendError(`Simulator "${settings.simulator}" is missing compile or run command. Check VeriFlow settings.`);
        vscode.window.showErrorMessage(`VeriFlow simulator "${settings.simulator}" is missing compile or run command.`);
        _setSimulateStatus(context, 'error');
        return;
    }

    output.clear();
    output.show(true);
    output.appendInfo('========================================');
    output.appendInfo(`Simulation: ${topModule}`);
    output.appendInfo(`Simulator: ${simulator.name}`);
    output.appendInfo(`Root: ${root}`);
    output.appendInfo('========================================');
    statusBarItem.text = '$(run) VeriFlow: simulating...';

    const depResult = await _resolveDependencies(context, root, settings, topModule);
    const ambiguousNames = Object.keys(depResult.ambiguousModules);
    if (depResult.missingModules.length > 0 || ambiguousNames.length > 0) {
        if (depResult.missingModules.length > 0) {
            output.appendError(`Missing modules: ${depResult.missingModules.join(', ')}`);
        }
        for (const name of ambiguousNames) {
            output.appendError(
                `Ambiguous module ${name}: ${depResult.ambiguousModules[name].join(', ')}`
            );
        }
        _setAnalyzeStatus(context, 'error');
        return;
    }

    output.appendInfo(`Resolved ${depResult.files.length} file(s)`);
    output.appendInfo('Running compile -> simulate.');
    output.appendLine('');
    const outFile = path.join(root, `${topModule}.out`);

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
        _setSimulateStatus(context, 'completed');
    } else {
        output.appendError(`Simulation FAILED (exit=${result.exitCode})`);
        for (const entry of result.logEntries) {
            if (entry.level === 'ERROR') {
                output.appendError(entry.message);
            }
        }
        _setSimulateStatus(context, 'error');
    }
    output.show();

    // 如果有挂起的波形请求，继续执行
    if (_pendingWaveAfterSimulate) {
        _pendingWaveAfterSimulate = false;
        if (result.success) {
            await _doOpenWave(context, root, topModule, settings);
        }
    }
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

    // 检查文件变动
    _checkDepFilesChanged(context);

    const settings = getSettings();
    const waveFile = path.join(root, settings.waveFileTemplate.replace('{top_module}', topModule));

    // 检查分析依赖状态
    if (_analyzeStatus !== 'completed') {
        output.appendInfo('Analyze is not complete; running analyze -> simulate -> open wave.');
        _pendingWaveAfterAnalyze = true;
        await cmdAnalyze(context);
        return;
    }

    // 检查编译仿真状态
    if (_simulateStatus !== 'completed') {
        output.appendInfo('Simulation is not complete; running simulate -> open wave.');
        _pendingWaveAfterSimulate = true;
        await cmdSimulate(context);
        return;
    }

    // 都已完成
    if (fs.existsSync(waveFile)) {
        await _doOpenWave(context, root, topModule, settings);
        return;
    }

    // 波形文件不存在，运行仿真
    output.appendWarning(`Wave file not found: ${waveFile}`);
    output.appendInfo('Running simulate -> open wave to generate waveform first.');
    _pendingWaveAfterSimulate = true;
    await cmdSimulate(context);
}

async function cmdOpenVcdViewer(uri?: vscode.Uri): Promise<void> {
    let target = uri;
    if (!target) {
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'VCD waveform': ['vcd'] },
            title: 'Open VCD in VeriFlow Viewer',
        });
        target = selected?.[0];
    }

    if (!target) {
        return;
    }
    if (path.extname(target.fsPath).toLowerCase() !== '.vcd') {
        vscode.window.showWarningMessage('VeriFlow built-in waveform viewer currently supports .vcd files.');
        return;
    }

    await vscode.commands.executeCommand(
        'vscode.openWith',
        target,
        WaveformEditorProvider.viewType
    );
}

async function _doOpenWave(context: vscode.ExtensionContext, root: string, topModule: string, settings: ExtensionSettings): Promise<void> {
    const waveFile = path.join(root, settings.waveFileTemplate.replace('{top_module}', topModule));
    const viewer = _resolveViewer(settings);

    if (!fs.existsSync(waveFile)) {
        output.appendError(`Wave file not found: ${waveFile}`);
        return;
    }

    if (viewer.name === 'builtin') {
        output.appendInfo(`Opening built-in waveform viewer: ${waveFile}`);
        await vscode.commands.executeCommand(
            'vscode.openWith',
            vscode.Uri.file(waveFile),
            WaveformEditorProvider.viewType
        );
        output.appendSuccess(`Opened built-in waveform viewer: ${waveFile}`);
        return;
    }

    output.appendInfo(`Opening ${viewer.name}: ${waveFile}`);
    try {
        simRunner.openWave(waveFile, viewer);
        output.appendSuccess(`Opened ${viewer.name}: ${waveFile}`);
    } catch (err: any) {
        output.appendError(`Failed to open ${viewer.name}: ${err.message}`);
    }
}
