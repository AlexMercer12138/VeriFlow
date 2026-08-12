import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
    getWorkspaceRoot, getTopModule, setTopModule, resolveTopModuleSelection,
    getSettings, ExtensionSettings,
    getAnalyzeStatus, setAnalyzeStatus, getSimulateStatus, setSimulateStatus,
    getDependencyResult, setDependencyResult,
} from './config';
import type { TopModuleSelection } from './config';
import { ModuleTreeProvider } from './moduleTreeProvider';
import { showModuleInstantiationPicker } from './moduleInstantiationCommand';
import { TestbenchPanelProvider } from './testbenchPanel';
import { WaveformEditorProvider } from './waveformEditorProvider';
import { ArchDesignEditorProvider } from './archDesign/archDesignEditorProvider';
import {
    SchematicEditorProvider,
    SchematicNavigationRegistry,
} from './schematic';
import * as output from './output';
import {
    DependencyAnalyzer, SimulationRunner,
    ModuleScanResult, ModuleDefinitionEntry, DependencyResult,
    SimulatorConfig, WaveViewerConfig, formatDuplicateSummary,
    HdlParserClient, createHdlParserClient, WorkspaceHdlIndex,
} from './core';
import type {
    HdlDefinitionSummary,
    WorkspaceHdlIncludeWatchContext,
} from './core';
import {
    canonicalizeSourceUri,
    isSourceUriWithinRoot,
} from './core/hdl/preprocessor';
import { WorkspaceIndexStore } from './core/hdl/workspaceIndexStore';
import { relativeDisplayPath } from './core/pathStyle';

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

type HdlTopSelectionPersistenceChain = {
    lifecycleGeneration: number;
    rootGeneration: number;
    rootIdentity: string | undefined;
    pending: number;
    rollbackBaseline: TopModuleSelection | undefined;
};

let treeProvider: ModuleTreeProvider;
let tbPanelProvider: TestbenchPanelProvider;
let statusBarItem: vscode.StatusBarItem;
let simulateProcess: child_process.ChildProcess | null = null;
let depAnalyzer: DependencyAnalyzer | undefined;
const simRunner = new SimulationRunner();
let hdlParser: HdlParserClient | undefined;
let hdlParserExtensionPath: string | undefined;
let hdlIndex: WorkspaceHdlIndex | undefined;
let hdlIndexLoad: Promise<void> | undefined;
let hdlIndexIdentity: string | undefined;
let hdlIndexGeneration = 0;
let hdlOperationTail: Promise<void> = Promise.resolve();
let hdlTopPersistenceTail: Promise<void> = Promise.resolve();
let hdlTopPersistencePending = 0;
let hdlTopSelectionPersistenceChain: HdlTopSelectionPersistenceChain | undefined;
let hdlDependencyPersistenceTail: Promise<void> = Promise.resolve();
type HdlIndexPreparation = {
    analyzer: DependencyAnalyzer;
    index: WorkspaceHdlIndex;
    indexGeneration: number;
    rootIdentity: string;
};
let hdlPreparationInFlight: {
    identity: string;
    promise: Promise<HdlIndexPreparation>;
} | undefined;
type SchematicIndexEntry = {
    identity: string;
    lifecycleGeneration: number;
    settingsGeneration: number;
    rootUris: string[];
    defines: Record<string, string | true>;
    index: WorkspaceHdlIndex;
    load: Promise<void>;
    abortController: AbortController;
    ready: boolean;
    preparation?: Promise<WorkspaceHdlIndex>;
    watchers: Map<string, vscode.FileSystemWatcher>;
    pendingEvents: Map<string, HdlWatchEvent>;
    flushScheduled: boolean;
    updateTail: Promise<void>;
    owners: Set<object>;
    liveWatchSessions: Map<object, {
        parseToken: object;
        uris: Set<string>;
    }>;
};
const schematicIndexRegistry = new Map<string, SchematicIndexEntry>();
const schematicIndexOwners = new Map<object, SchematicIndexEntry>();
const schematicIndexRetirements = new Map<string, Promise<void>>();
const schematicIndexPreparationTails = new Set<Promise<void>>();
const schematicIndexUpdateTails = new Set<Promise<void>>();
const schematicIndexInvalidationListeners = new Set<(
    index?: WorkspaceHdlIndex
) => void>();
type HdlScanOwnership = {
    lifecycleGeneration: number;
    rootGeneration: number;
    settingsGeneration: number;
    presentationGeneration: number;
    rootIdentity: string;
};
type HdlScanPresentation = HdlScanOwnership & {
    result: ModuleScanResult;
    indexGeneration: number;
    index: WorkspaceHdlIndex;
};
type HdlScanOperation = HdlScanOwnership & {
    identity: string;
    promise: Promise<HdlScanPresentation | null>;
};
let hdlScanInFlight: HdlScanOperation | undefined;
let hdlPresentationGeneration = 0;
let hdlPresentationRootIdentity: string | undefined;
let hdlRootGeneration = 0;
let hdlWorkflowGeneration = 0;
let hdlTopIntentVersion = 0;
let hdlInstantiationIntentVersion = 0;
let hdlLifecycleGeneration = 0;
let hdlStopping = false;
let hdlAbortController = new AbortController();
let hdlActiveContext: vscode.ExtensionContext | undefined;
let hdlLastNonScanningStatusText = '$(circuit-board) VeriFlow';

type HdlWatchEvent = {
    uri: vscode.Uri;
    remove: boolean;
    promise: Promise<void>;
    resolve(): void;
};

type HdlWatchRegistry = {
    version: number;
    lifecycleGeneration: number;
    settingsGeneration: number;
    rootIdentity: string;
    indexGeneration: number;
    index: WorkspaceHdlIndex | undefined;
    watchers: vscode.FileSystemWatcher[];
    watcherPatternKeys: Set<string>;
    provisionalIncludeUris: Set<string>;
    pendingEvents: Map<string, HdlWatchEvent>;
    flushScheduled: boolean;
};

let hdlWatchRegistry: HdlWatchRegistry | undefined;
let hdlWatchRegistryVersion = 0;
let hdlWatchSettingsGeneration = 0;

const HDL_PARSER_FINGERPRINT = 'tree-sitter-systemverilog-0.4.0';
const HDL_WATCH_GLOB = '**/*.{v,sv,vh,svh}';

class HdlIndexPreparationInvalidatedError extends Error {}
class HdlWatchPlanReconciliationError extends Error {
    constructor(error: unknown) {
        super(error instanceof Error ? error.message : String(error));
        this.name = 'HdlWatchPlanReconciliationError';
    }
}
class HdlStoppingError extends Error {
    constructor() {
        super('HDL lifecycle is stopping');
        this.name = 'HdlStoppingError';
    }
}

// 状态管理
let _analyzeStatus: string = 'idle';
let _simulateStatus: string = 'idle';
let _lastDepFileHashes: Record<string, string> = {};
let _pendingSimulateAfterAnalyze = false;
let _pendingWaveAfterSimulate = false;
let _pendingWaveAfterAnalyze = false;

export function activate(context: vscode.ExtensionContext): void {
    _resetSchematicIndexes();
    hdlStopping = false;
    hdlLifecycleGeneration++;
    hdlActiveContext = context;
    hdlAbortController = new AbortController();
    if (hdlParser && hdlParserExtensionPath !== context.extensionPath) {
        throw new Error(
            'HDL parser belongs to a different extension path; call deactivate() before reactivating'
        );
    }
    treeProvider = new ModuleTreeProvider();
    tbPanelProvider = new TestbenchPanelProvider(
        context,
        () => hdlStopping ? undefined : hdlIndex
    );

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
    const archDesignEditorProvider = new ArchDesignEditorProvider(context, {
        getIndex: (document, owner) => _getSchematicIndex(
            context,
            document.uri,
            owner
        ),
        releaseIndex: owner => _releaseSchematicIndex(owner),
        onDidInvalidate: listener => {
            schematicIndexInvalidationListeners.add(listener);
            return {
                dispose: () => schematicIndexInvalidationListeners.delete(listener),
            };
        },
    });
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            ArchDesignEditorProvider.viewType,
            archDesignEditorProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );
    const schematicNavigationRegistry = new SchematicNavigationRegistry();
    const schematicEditorProvider = new SchematicEditorProvider(
        context,
        schematicNavigationRegistry,
        {
            getIndex: (document, owner) => _getSchematicIndex(
                context,
                document.uri,
                owner
            ),
            releaseIndex: owner => _releaseSchematicIndex(owner),
            onDidInvalidate: listener => {
                schematicIndexInvalidationListeners.add(listener);
                return {
                    dispose: () => schematicIndexInvalidationListeners.delete(listener),
                };
            },
        }
    );
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            SchematicEditorProvider.viewType,
            schematicEditorProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: true,
            }
        )
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(circuit-board) VeriFlow';
    hdlLastNonScanningStatusText = statusBarItem.text;
    statusBarItem.tooltip = 'VeriFlow: Verilog Simulation Manager';
    statusBarItem.command = 'veriflow.showOutput';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    const commandUri = (value: unknown): vscode.Uri | undefined =>
        value instanceof vscode.Uri ? value : undefined;
    const cmds: Array<[string, (...args: unknown[]) => unknown]> = [
        ['veriflow.selectTop', () => cmdSelectTop(context)],
        ['veriflow.analyze', () => cmdAnalyze(context)],
        ['veriflow.simulate', () => cmdSimulate(context)],
        ['veriflow.openWave', () => cmdOpenWave(context)],
        ['veriflow.openVcdViewer', (uri?: unknown) => cmdOpenVcdViewer(
            commandUri(uri)
        )],
        ['veriflow.openSchematic', (uri?: unknown) => cmdOpenSchematic(
            commandUri(uri)
        )],
        ['veriflow.openSchematicFromExplorer', (uri?: unknown) => cmdOpenSchematic(
            commandUri(uri)
        )],
        ['veriflow.scanModules', () => cmdScanModules(context)],
        ['veriflow.instantiateModule', () => cmdInstantiateModule(context)],
        ['veriflow.showOutput', () => { if (!hdlStopping) { output.show(); } }],
    ];
    for (const [name, fn] of cmds) {
        context.subscriptions.push(vscode.commands.registerCommand(name, fn));
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (hdlStopping) { return; }
            const definesChanged = e.affectsConfiguration('veriflow.defines');
            const rootsChanged = e.affectsConfiguration('veriflow.libDirs');
            if (definesChanged || rootsChanged) {
                hdlWatchSettingsGeneration++;
                _resetSchematicIndexes(true);
                try {
                    _reconcileHdlWatchersForCurrentRoots(context);
                } catch {
                    // The rescan below retries watcher construction after invalidation.
                }
            }
            if (definesChanged) {
                hdlParser?.clearCache();
            }
            if (definesChanged || rootsChanged) {
                _invalidateDependencyPresentation(context);
            }
            if (rootsChanged) {
                _invalidateChangedHdlRootIdentity(context);
            }
            if (definesChanged || rootsChanged) {
                await _scanModulesWithErrorReporting(context);
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            if (hdlStopping) { return; }
            hdlWatchSettingsGeneration++;
            _resetSchematicIndexes(true);
            try {
                _reconcileHdlWatchersForCurrentRoots(context);
            } catch {
                // The rescan below retries watcher construction after invalidation.
            }
            _invalidateDependencyPresentation(context);
            _invalidateChangedHdlRootIdentity(context, true);
            await _scanModulesWithErrorReporting(context);
        })
    );

    // 文件系统监视器：检测工作区文件变动
    _reconcileHdlWatchersForCurrentRoots(context);
    const watcherLifecycle = hdlLifecycleGeneration;
    context.subscriptions.push({
        dispose: () => {
            if (watcherLifecycle === hdlLifecycleGeneration) {
                _disposeHdlWatchRegistry();
            }
        },
    });

    // 窗口焦点变化检测
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => {
            if (hdlStopping) { return; }
            if (e.focused) {
                _checkDepFilesChanged(context);
            } else {
                _saveDepFileHashes(context);
            }
        })
    );

    const savedTop = _coerceTopSelection(getTopModule(context));
    if (savedTop?.definitionKey) { treeProvider.topModule = savedTop; }

    // 恢复状态
    _restoreState(context);

    void _scanModulesWithErrorReporting(context);
}

export function getHdlParser(context: vscode.ExtensionContext): HdlParserClient {
    if (hdlStopping) {
        throw new HdlStoppingError();
    }
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
    const isWindowsDrivePath = /^[A-Za-z]:[\\/]/.test(value);
    const isUncPath = value.startsWith('\\\\');
    if (isWindowsDrivePath || isUncPath) {
        if (base.scheme === 'file') {
            return vscode.Uri.file(value);
        }
        const normalized = value.replace(/\\/g, '/');
        return base.with({ path: isWindowsDrivePath ? `/${normalized}` : normalized });
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

function _dependencyRootUris(
    root: string,
    libDirs: string[],
    rootUri?: vscode.Uri
): string[] {
    const workspaceRoot = rootUri
        ?? vscode.workspace.workspaceFolders?.[0]?.uri
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

function _isCurrentHdlLifecycle(generation: number): boolean {
    return !hdlStopping && generation === hdlLifecycleGeneration;
}

function _throwIfHdlLifecycleStopped(generation: number): void {
    if (!_isCurrentHdlLifecycle(generation)) {
        throw new HdlStoppingError();
    }
}

async function _findHdlFiles(
    root: vscode.Uri,
    files: string[],
    lifecycleGeneration: number
): Promise<void> {
    _throwIfHdlLifecycleStopped(lifecycleGeneration);
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
        return;
    }
    entries.sort(([left], [right]) => left.localeCompare(right));
    for (const [name, fileType] of entries) {
        _throwIfHdlLifecycleStopped(lifecycleGeneration);
        const uri = vscode.Uri.joinPath(root, name);
        if ((fileType & vscode.FileType.Directory) !== 0) {
            if (!name.startsWith('.')) {
                await _findHdlFiles(uri, files, lifecycleGeneration);
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
    if (hdlStopping) {
        throw new HdlStoppingError();
    }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const knownHdlUris = new Set<string>();
    const rootUris: vscode.Uri[] = [];
    const store = new WorkspaceIndexStore(context.workspaceState);
    const includeCandidates = (fromUri: string, includePath: string): string[] => {
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
        return [...new Set(candidates.map(candidate => candidate.toString()))];
    };
    const index = new WorkspaceHdlIndex({
        parser: getHdlParser(context),
        store,
        parserFingerprint: `${HDL_PARSER_FINGERPRINT}:${crypto.createHash('sha256')
            .update(rootIdentity)
            .digest('hex')}`,
        defines,
        async findFiles(roots: string[]): Promise<string[]> {
            _throwIfHdlLifecycleStopped(lifecycleGeneration);
            knownHdlUris.clear();
            rootUris.splice(0, rootUris.length, ...roots.map(root => vscode.Uri.parse(root)));
            const files: string[] = [];
            for (const root of rootUris) {
                await _findHdlFiles(root, files, lifecycleGeneration);
            }
            _throwIfHdlLifecycleStopped(lifecycleGeneration);
            for (const uri of files) {
                knownHdlUris.add(uri);
            }
            return [...knownHdlUris].sort();
        },
        async readFile(uri: string) {
            _throwIfHdlLifecycleStopped(lifecycleGeneration);
            const resource = vscode.Uri.parse(uri);
            const [bytes, stat] = await Promise.all([
                vscode.workspace.fs.readFile(resource),
                vscode.workspace.fs.stat(resource),
            ]);
            _throwIfHdlLifecycleStopped(lifecycleGeneration);
            return {
                text: Buffer.from(bytes).toString('utf8'),
                version: stat.mtime,
                mtimeMs: stat.mtime,
                size: stat.size,
            };
        },
        includeCandidates,
        onIncludeWatchUrisDiscovered(
            uris: string[],
            watchContext?: WorkspaceHdlIncludeWatchContext
        ): void {
            if (watchContext) {
                _recordSchematicLiveIncludeWatchUris(index, uris, watchContext);
                return;
            }
            _addProvisionalHdlWatchers(
                context,
                index,
                rootUris.map(root => root.toString()),
                uris
            );
        },
        async resolveInclude(
            fromUri: string,
            includePath: string,
            candidates = includeCandidates(fromUri, includePath)
        ) {
            _throwIfHdlLifecycleStopped(lifecycleGeneration);
            const seen = new Set<string>();
            for (const candidateValue of candidates) {
                _throwIfHdlLifecycleStopped(lifecycleGeneration);
                const candidate = vscode.Uri.parse(candidateValue);
                const exists = !seen.has(candidateValue) && await _isFile(candidate);
                _throwIfHdlLifecycleStopped(lifecycleGeneration);
                if (exists) {
                    return candidateValue;
                }
                seen.add(candidateValue);
            }
            return undefined;
        },
    });
    return index;
}

async function _getDependencyAnalyzer(
    context: vscode.ExtensionContext,
    rootUris: string[],
    defines: Record<string, string | true>
): Promise<DependencyAnalyzer> {
    if (hdlStopping) {
        throw new HdlStoppingError();
    }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const signal = hdlAbortController.signal;
    const rootIdentity = JSON.stringify(rootUris);
    if (hdlIndex && hdlIndexIdentity !== rootIdentity) {
        _resetDependencyIndex();
    }
    let index = hdlIndex;
    if (!index) {
        index = _createWorkspaceHdlIndex(context, defines, rootIdentity);
        const analyzer = new DependencyAnalyzer(index);
        try {
            _reconcileHdlWatchers(context, rootUris, index);
        } catch (error) {
            index.dispose();
            throw error;
        }
        hdlIndex = index;
        hdlIndexIdentity = rootIdentity;
        depAnalyzer = analyzer;
        hdlIndexLoad = index.load();
    }
    const analyzer = depAnalyzer!;
    const load = hdlIndexLoad!;
    const generation = hdlIndexGeneration;
    try {
        await _finishDependencyIndexPreparation(
            index,
            analyzer,
            load,
            rootUris,
            defines,
            signal,
            lifecycleGeneration
        );
        if (!_isCurrentHdlLifecycle(lifecycleGeneration)) {
            throw new HdlStoppingError();
        }
        if (generation !== hdlIndexGeneration
            || hdlIndex !== index
            || hdlIndexIdentity !== rootIdentity) {
            throw new HdlIndexPreparationInvalidatedError();
        }
        return analyzer;
    } catch (error) {
        if (!hdlStopping && generation === hdlIndexGeneration && hdlIndex === index) {
            _resetDependencyIndex();
        }
        throw error;
    }
}

async function _getSchematicIndex(
    context: vscode.ExtensionContext,
    resource: vscode.Uri,
    owner?: object
): Promise<WorkspaceHdlIndex | undefined> {
    const settings = getSettings(resource);
    const resourceRoot = vscode.workspace.getWorkspaceFolder(resource)?.uri
        ?? resource.with({
            path: path.posix.dirname(resource.path),
            query: '',
            fragment: '',
        });
    const rootUris = _dependencyRootUris(
        resourceRoot.fsPath,
        settings.libDirs,
        resourceRoot
    );
    const rootIdentity = JSON.stringify(rootUris);
    const defines = _filterHdlDefines(settings.defines);
    const identity = JSON.stringify([
        rootUris,
        Object.entries(defines).sort(([left], [right]) => left.localeCompare(right)),
    ]);
    const settingsGeneration = hdlWatchSettingsGeneration;
    const retirement = schematicIndexRetirements.get(identity);
    if (retirement) {
        await retirement;
        if (hdlStopping || settingsGeneration !== hdlWatchSettingsGeneration) {
            return undefined;
        }
    }
    let entry = schematicIndexRegistry.get(identity);
    if (!entry) {
        const index = _createWorkspaceHdlIndex(context, defines, rootIdentity);
        entry = {
            identity,
            lifecycleGeneration: hdlLifecycleGeneration,
            settingsGeneration: hdlWatchSettingsGeneration,
            rootUris,
            defines,
            index,
            load: index.load(),
            abortController: new AbortController(),
            ready: false,
            watchers: new Map(),
            pendingEvents: new Map(),
            flushScheduled: false,
            updateTail: Promise.resolve(),
            owners: new Set(),
            liveWatchSessions: new Map(),
        };
        schematicIndexRegistry.set(identity, entry);
        try {
            _reconcileSchematicIndexWatchers(entry);
        } catch {
            schematicIndexRegistry.delete(identity);
            _disposeSchematicIndexEntry(entry);
            return undefined;
        }
    }
    if (owner) {
        _acquireSchematicIndex(entry, owner);
    }
    if (entry.ready) {
        try {
            _throwIfSchematicIndexInvalidated(entry);
            return entry.index;
        } catch {
            return undefined;
        }
    }
    if (entry.preparation) {
        try {
            return await entry.preparation;
        } catch {
            return undefined;
        }
    }
    const preparation = (async (): Promise<WorkspaceHdlIndex> => {
        await entry.load;
        _throwIfSchematicIndexInvalidated(entry);
        await entry.index.updateConfiguration(entry.defines);
        _throwIfSchematicIndexInvalidated(entry);
        await entry.index.scan(entry.rootUris, entry.abortController.signal);
        _throwIfSchematicIndexInvalidated(entry);
        entry.ready = true;
        _reconcileSchematicIndexWatchers(entry);
        return entry.index;
    })();
    entry.preparation = preparation;
    const trackedPreparation = preparation.then(
        () => undefined,
        () => undefined
    );
    schematicIndexPreparationTails.add(trackedPreparation);
    void trackedPreparation.then(() =>
        schematicIndexPreparationTails.delete(trackedPreparation)
    );
    const clearPreparation = (): void => {
        if (entry.preparation === preparation) {
            entry.preparation = undefined;
        }
    };
    try {
        const index = await preparation;
        clearPreparation();
        return index;
    } catch {
        clearPreparation();
        if (schematicIndexRegistry.get(identity) === entry) {
            schematicIndexRegistry.delete(identity);
            _retireSchematicIndexEntry(entry);
        }
        return undefined;
    }
}

function _throwIfSchematicIndexInvalidated(entry: SchematicIndexEntry): void {
    if (hdlStopping
        || entry.lifecycleGeneration !== hdlLifecycleGeneration
        || entry.settingsGeneration !== hdlWatchSettingsGeneration
        || schematicIndexRegistry.get(entry.identity) !== entry) {
        throw new HdlIndexPreparationInvalidatedError();
    }
}

function _resetSchematicIndexes(notify = false): void {
    const entries = [...schematicIndexRegistry.values()];
    schematicIndexRegistry.clear();
    for (const entry of entries) {
        _retireSchematicIndexEntry(entry);
    }
    if (notify) {
        _emitSchematicIndexInvalidation();
    }
}

function _isCurrentSchematicIndexEntry(entry: SchematicIndexEntry): boolean {
    return !hdlStopping
        && entry.lifecycleGeneration === hdlLifecycleGeneration
        && entry.settingsGeneration === hdlWatchSettingsGeneration
        && schematicIndexRegistry.get(entry.identity) === entry;
}

function _disposeSchematicIndexEntry(entry: SchematicIndexEntry): void {
    entry.abortController.abort();
    for (const watcher of entry.watchers.values()) {
        watcher.dispose();
    }
    entry.watchers.clear();
    for (const owner of entry.owners) {
        if (schematicIndexOwners.get(owner) === entry) {
            schematicIndexOwners.delete(owner);
        }
    }
    entry.owners.clear();
    entry.liveWatchSessions.clear();
    for (const event of entry.pendingEvents.values()) {
        event.resolve();
    }
    entry.pendingEvents.clear();
    entry.index.dispose();
}

function _retireSchematicIndexEntry(entry: SchematicIndexEntry): void {
    const previousRetirement = schematicIndexRetirements.get(entry.identity);
    const ownRetirement = Promise.all([
        entry.preparation?.catch(() => undefined) ?? Promise.resolve(),
        entry.updateTail,
    ]).then(() => undefined);
    const retirement = previousRetirement
        ? Promise.all([previousRetirement, ownRetirement]).then(() => undefined)
        : ownRetirement;
    schematicIndexRetirements.set(entry.identity, retirement);
    void retirement.then(() => {
        if (schematicIndexRetirements.get(entry.identity) === retirement) {
            schematicIndexRetirements.delete(entry.identity);
        }
    });
    _disposeSchematicIndexEntry(entry);
}

function _acquireSchematicIndex(entry: SchematicIndexEntry, owner: object): void {
    const previous = schematicIndexOwners.get(owner);
    if (previous === entry) {
        return;
    }
    if (previous) {
        previous.owners.delete(owner);
        previous.liveWatchSessions.delete(owner);
        if (previous.owners.size === 0
            && schematicIndexRegistry.get(previous.identity) === previous) {
            schematicIndexRegistry.delete(previous.identity);
            _retireSchematicIndexEntry(previous);
        } else if (_isCurrentSchematicIndexEntry(previous)) {
            _reconcileSchematicIndexWatchers(previous);
        }
    }
    entry.owners.add(owner);
    schematicIndexOwners.set(owner, entry);
}

function _releaseSchematicIndex(owner: object): void {
    const entry = schematicIndexOwners.get(owner);
    if (!entry) {
        return;
    }
    schematicIndexOwners.delete(owner);
    entry.owners.delete(owner);
    entry.liveWatchSessions.delete(owner);
    if (entry.owners.size === 0
        && schematicIndexRegistry.get(entry.identity) === entry) {
        schematicIndexRegistry.delete(entry.identity);
        _retireSchematicIndexEntry(entry);
    } else if (_isCurrentSchematicIndexEntry(entry)) {
        _reconcileSchematicIndexWatchers(entry);
    }
}

function _notifySchematicIndexInvalidated(entry: SchematicIndexEntry): void {
    if (!_isCurrentSchematicIndexEntry(entry)) {
        return;
    }
    _emitSchematicIndexInvalidation(entry.index);
}

function _emitSchematicIndexInvalidation(index?: WorkspaceHdlIndex): void {
    for (const listener of [...schematicIndexInvalidationListeners]) {
        try {
            listener(index);
        } catch {
            // One panel must not prevent other open schematics from refreshing.
        }
    }
}

function _addSchematicIndexWatcher(
    entry: SchematicIndexEntry,
    patternValue: HdlWatchPatternValue
): void {
    const patternKey = _hdlWatchPatternKey(patternValue);
    if (entry.watchers.has(patternKey)) {
        return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(patternValue.base, patternValue.pattern)
    );
    try {
        watcher.onDidChange(uri => _queueSchematicIndexWatchEvent(entry, uri, false));
        watcher.onDidCreate(uri => _queueSchematicIndexWatchEvent(entry, uri, false));
        watcher.onDidDelete(uri => _queueSchematicIndexWatchEvent(entry, uri, true));
    } catch (error) {
        watcher.dispose();
        throw error;
    }
    entry.watchers.set(patternKey, watcher);
}

function _schematicLiveWatchUris(entry: SchematicIndexEntry): Set<string> {
    const uris = new Set<string>();
    for (const session of entry.liveWatchSessions.values()) {
        for (const uri of session.uris) {
            uris.add(uri);
        }
    }
    return uris;
}

function _recordSchematicLiveIncludeWatchUris(
    index: WorkspaceHdlIndex,
    uriValues: string[],
    context: WorkspaceHdlIncludeWatchContext
): void {
    const entry = schematicIndexOwners.get(context.owner);
    if (!entry || entry.index !== index || !_isCurrentSchematicIndexEntry(entry)) {
        return;
    }
    if (context.reset) {
        entry.liveWatchSessions.set(context.owner, {
            parseToken: context.parseToken,
            uris: new Set(),
        });
        _reconcileSchematicIndexWatchers(entry);
        return;
    }
    const session = entry.liveWatchSessions.get(context.owner);
    if (!session || session.parseToken !== context.parseToken) {
        return;
    }
    let changed = false;
    const canonicalUriValues = uriValues.map(uriValue => canonicalizeSourceUri(uriValue));
    for (const uriValue of [...new Set(canonicalUriValues)].sort()) {
        const uri = vscode.Uri.parse(uriValue);
        const coveredByBroadWatcher = _isHdlUri(uri) && entry.rootUris.some(rootUri =>
            isSourceUriWithinRoot(uriValue, rootUri)
        );
        if (!coveredByBroadWatcher
            && _exactHdlWatchPattern(uriValue)
            && !session.uris.has(uriValue)) {
            session.uris.add(uriValue);
            changed = true;
        }
    }
    if (changed) {
        _reconcileSchematicIndexWatchers(entry);
    }
}

function _reconcileSchematicIndexWatchers(entry: SchematicIndexEntry): void {
    _throwIfSchematicIndexInvalidated(entry);
    const patternValues: HdlWatchPatternValue[] = entry.rootUris.map(root => ({
        base: vscode.Uri.parse(root),
        pattern: HDL_WATCH_GLOB,
    }));
    for (const uriValue of _schematicLiveWatchUris(entry)) {
        const patternValue = _exactHdlWatchPattern(uriValue);
        if (patternValue) {
            patternValues.push(patternValue);
        }
    }
    if (entry.ready) {
        const plan = entry.index.getWatchPlan(entry.rootUris);
        for (const uriValue of [
            ...plan.resolvedExternalIncludeUris,
            ...plan.unresolvedExternalCandidateUris,
        ]) {
            const patternValue = _exactHdlWatchPattern(uriValue);
            if (patternValue) {
                patternValues.push(patternValue);
            }
        }
    }
    const desiredPatternKeys = new Set(patternValues.map(_hdlWatchPatternKey));
    for (const patternValue of patternValues) {
        _addSchematicIndexWatcher(entry, patternValue);
    }
    if (entry.ready) {
        for (const [patternKey, watcher] of entry.watchers) {
            if (!desiredPatternKeys.has(patternKey)) {
                watcher.dispose();
                entry.watchers.delete(patternKey);
            }
        }
    }
}

async function _refreshSchematicIndexEntry(
    entry: SchematicIndexEntry,
    uri: vscode.Uri,
    remove: boolean
): Promise<void> {
    if (entry.preparation) {
        await entry.preparation;
    }
    _throwIfSchematicIndexInvalidated(entry);
    const uriValue = uri.toString();
    const canonicalUriValue = canonicalizeSourceUri(uriValue);
    const liveWatched = _schematicLiveWatchUris(entry).has(canonicalUriValue);
    const indexed = (_isHdlUri(uri) && entry.rootUris.some(rootUri =>
        isSourceUriWithinRoot(uriValue, rootUri)
    )) || entry.index.getFile(uriValue) !== undefined
        || entry.index.getDependentsOfInclude(uriValue).length > 0;
    let transientLiveRefresh = liveWatched && !indexed;
    if (transientLiveRefresh) {
        const plan = entry.index.getWatchPlan(entry.rootUris);
        const diskWatchUris = new Set([
            ...plan.resolvedExternalIncludeUris,
            ...plan.unresolvedExternalCandidateUris,
        ].map(candidate => canonicalizeSourceUri(candidate)));
        transientLiveRefresh = !diskWatchUris.has(canonicalUriValue);
    }
    let admitted = indexed || liveWatched;
    if (!admitted && !remove) {
        admitted = await entry.index.canResolveUnresolvedInclude(
            uriValue,
            entry.abortController.signal
        );
        _throwIfSchematicIndexInvalidated(entry);
    }
    if (!admitted) {
        return;
    }
    try {
        if (remove) {
            await entry.index.removeUri(uriValue);
        } else {
            await entry.index.refreshUri(
                uriValue,
                entry.abortController.signal,
                transientLiveRefresh ? 'transient' : 'persistent'
            );
        }
    } catch {
        _throwIfSchematicIndexInvalidated(entry);
        await entry.index.scan(entry.rootUris, entry.abortController.signal);
    }
    _throwIfSchematicIndexInvalidated(entry);
    _reconcileSchematicIndexWatchers(entry);
    _notifySchematicIndexInvalidated(entry);
}

async function _flushSchematicIndexWatchEvents(entry: SchematicIndexEntry): Promise<void> {
    entry.flushScheduled = false;
    const events = [...entry.pendingEvents.values()];
    entry.pendingEvents.clear();
    const work = entry.updateTail.then(async () => {
        for (const event of events) {
            try {
                if (_isCurrentSchematicIndexEntry(entry)) {
                    await _refreshSchematicIndexEntry(entry, event.uri, event.remove);
                }
            } catch (error) {
                if (_isCurrentSchematicIndexEntry(entry)) {
                    output.appendError(
                        `Schematic HDL index refresh failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                }
            } finally {
                event.resolve();
            }
        }
    });
    const trackedWork = work.catch(() => undefined);
    entry.updateTail = trackedWork;
    schematicIndexUpdateTails.add(trackedWork);
    void trackedWork.then(() => schematicIndexUpdateTails.delete(trackedWork));
    await work;
}

function _queueSchematicIndexWatchEvent(
    entry: SchematicIndexEntry,
    uri: vscode.Uri,
    remove: boolean
): Promise<void> {
    if (!_isCurrentSchematicIndexEntry(entry)) {
        return Promise.resolve();
    }
    const key = uri.toString();
    const pending = entry.pendingEvents.get(key);
    if (pending) {
        pending.remove = remove;
        return pending.promise;
    }
    let resolve!: () => void;
    const event: HdlWatchEvent = {
        uri,
        remove,
        promise: new Promise<void>(settled => { resolve = settled; }),
        resolve: () => resolve(),
    };
    entry.pendingEvents.set(key, event);
    if (!entry.flushScheduled) {
        entry.flushScheduled = true;
        queueMicrotask(() => { void _flushSchematicIndexWatchEvents(entry); });
    }
    return event.promise;
}

function _resetDependencyIndex(): void {
    const index = hdlIndex;
    hdlIndex = undefined;
    hdlIndexLoad = undefined;
    hdlIndexIdentity = undefined;
    depAnalyzer = undefined;
    hdlIndexGeneration++;
    index?.dispose();
    tbPanelProvider?.refreshModules();
    if (hdlStopping) {
        _disposeHdlWatchRegistry();
    } else if (hdlActiveContext) {
        try {
            _reconcileHdlWatchersForCurrentRoots(hdlActiveContext);
        } catch {
            // Reset must complete; the next index preparation retries watcher construction.
        }
    }
}

function _runDependencyOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (hdlStopping) {
        return Promise.reject(new HdlStoppingError());
    }
    const result = hdlOperationTail.then(operation);
    hdlOperationTail = result.then(() => undefined, () => undefined);
    return result;
}

function _persistTopModule(
    context: vscode.ExtensionContext,
    selection: TopModuleSelection | undefined
): Promise<void> {
    if (hdlStopping) {
        return Promise.resolve();
    }
    hdlTopPersistencePending++;
    const result = hdlTopPersistenceTail.then(() => setTopModule(context, selection));
    hdlTopPersistenceTail = result.then(() => undefined, () => undefined);
    void result.then(
        () => { hdlTopPersistencePending--; },
        () => { hdlTopPersistencePending--; }
    );
    return result;
}

function _hasTopSelectionPersistenceOwnership(
    chain: HdlTopSelectionPersistenceChain | undefined,
    lifecycleGeneration: number,
    rootGeneration: number,
    rootIdentity: string | undefined
): chain is HdlTopSelectionPersistenceChain {
    return Boolean(chain
        && chain.lifecycleGeneration === lifecycleGeneration
        && chain.rootGeneration === rootGeneration
        && chain.rootIdentity === rootIdentity);
}

function _persistTopSelection(
    context: vscode.ExtensionContext,
    selection: TopModuleSelection | undefined,
    rollbackBaseline: TopModuleSelection | undefined,
    lifecycleGeneration: number,
    rootGeneration: number,
    rootIdentity: string | undefined
): Promise<void> {
    const currentChain = hdlTopSelectionPersistenceChain;
    const chain = _hasTopSelectionPersistenceOwnership(
        currentChain,
        lifecycleGeneration,
        rootGeneration,
        rootIdentity
    ) ? currentChain : {
            lifecycleGeneration,
            rootGeneration,
            rootIdentity,
            pending: 0,
            rollbackBaseline,
        };
    hdlTopSelectionPersistenceChain = chain;
    chain.pending++;
    const result = _persistTopModule(context, selection);
    const settle = (): void => {
        chain.pending--;
        if (chain.pending === 0 && hdlTopSelectionPersistenceChain === chain) {
            hdlTopSelectionPersistenceChain = undefined;
        }
    };
    void result.then(
        settle,
        settle
    );
    return result;
}

function _clearPersistedTopModule(context: vscode.ExtensionContext): void {
    void _persistTopModule(context, undefined).catch(error => {
        output.appendError(
            `Failed to clear persisted top module: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    });
}

function _persistDependencyResult(
    context: vscode.ExtensionContext,
    result: DependencyResult | null
): Promise<void> {
    if (hdlStopping) {
        return Promise.resolve();
    }
    const persistence = hdlDependencyPersistenceTail.then(
        () => setDependencyResult(context, result)
    );
    hdlDependencyPersistenceTail = persistence.then(() => undefined, () => undefined);
    return persistence;
}

function _clearPersistedDependencyResult(context: vscode.ExtensionContext): void {
    void _persistDependencyResult(context, null).catch(error => {
        output.appendError(
            `Failed to clear persisted dependency result: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    });
}

function _prepareDependencyAnalyzer(
    context: vscode.ExtensionContext,
    rootUris: string[],
    defines: Record<string, string | true>
): Promise<HdlIndexPreparation> {
    if (hdlStopping) {
        return Promise.reject(new HdlStoppingError());
    }
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
            const analyzer = await _getDependencyAnalyzer(context, rootUris, defines);
            const index = hdlIndex;
            const rootIdentity = JSON.stringify(rootUris);
            const indexGeneration = hdlIndexGeneration;
            if (!index || hdlIndexIdentity !== rootIdentity) {
                throw new HdlIndexPreparationInvalidatedError();
            }
            return { analyzer, index, indexGeneration, rootIdentity };
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
    if (hdlStopping) {
        return Promise.reject(new HdlStoppingError());
    }
    const rootUris = _dependencyRootUris(root, settings.libDirs);
    const defines = _filterHdlDefines(settings.defines);
    const preparation = _prepareDependencyAnalyzer(context, rootUris, defines);
    return _runDependencyOperation(async () => {
        const { analyzer } = await preparation;
        if (hdlStopping) {
            throw new HdlStoppingError();
        }
        try {
            const result = await analyzer.resolve(topDefinitionKeyOrName);
            if (hdlStopping) {
                throw new HdlStoppingError();
            }
            return result;
        } catch (error) {
            if (!hdlStopping) {
                _resetDependencyIndex();
            }
            throw error;
        }
    });
}

async function _finishDependencyIndexPreparation(
    index: WorkspaceHdlIndex,
    analyzer: DependencyAnalyzer,
    load: Promise<void>,
    rootUris: string[],
    defines: Record<string, string | true>,
    signal: AbortSignal,
    lifecycleGeneration: number
): Promise<DependencyAnalyzer> {
    await load;
    _throwIfHdlLifecycleStopped(lifecycleGeneration);
    await index.updateConfiguration(defines);
    _throwIfHdlLifecycleStopped(lifecycleGeneration);
    await index.scan(rootUris, signal);
    _throwIfHdlLifecycleStopped(lifecycleGeneration);
    return analyzer;
}

async function _drainHdlWork(): Promise<void> {
    while (true) {
        const operationTail = hdlOperationTail;
        const topPersistenceTail = hdlTopPersistenceTail;
        const dependencyPersistenceTail = hdlDependencyPersistenceTail;
        const schematicPreparationTails = [...schematicIndexPreparationTails];
        const schematicUpdateTails = [...schematicIndexUpdateTails];
        await Promise.all([
            operationTail,
            topPersistenceTail,
            dependencyPersistenceTail,
            ...schematicPreparationTails,
            ...schematicUpdateTails,
        ]);
        if (operationTail === hdlOperationTail
            && topPersistenceTail === hdlTopPersistenceTail
            && dependencyPersistenceTail === hdlDependencyPersistenceTail
            && schematicIndexPreparationTails.size === 0
            && schematicIndexUpdateTails.size === 0) {
            return;
        }
    }
}

export async function deactivate(): Promise<void> {
    hdlStopping = true;
    hdlLifecycleGeneration++;
    hdlPresentationGeneration++;
    hdlWorkflowGeneration++;
    hdlTopIntentVersion++;
    hdlInstantiationIntentVersion++;
    hdlAbortController.abort();
    _resetSchematicIndexes();
    tbPanelProvider?.dispose();
    hdlPreparationInFlight = undefined;
    hdlScanInFlight = undefined;
    hdlPresentationRootIdentity = undefined;
    _pendingSimulateAfterAnalyze = false;
    _pendingWaveAfterAnalyze = false;
    _pendingWaveAfterSimulate = false;
    _resetDependencyIndex();
    if (simulateProcess) {
        simulateProcess.kill();
        simulateProcess = null;
    }
    await _drainHdlWork();
    hdlOperationTail = Promise.resolve();
    hdlTopPersistenceTail = Promise.resolve();
    hdlTopPersistencePending = 0;
    hdlTopSelectionPersistenceChain = undefined;
    hdlDependencyPersistenceTail = Promise.resolve();
    const parser = hdlParser;
    hdlParser = undefined;
    hdlParserExtensionPath = undefined;
    try {
        await parser?.dispose();
    } finally {
        hdlActiveContext = undefined;
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
    if (hdlStopping) { return; }
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
    if (hdlStopping) { return; }
    _analyzeStatus = status;
    setAnalyzeStatus(context, status);
    // 分析依赖变为 outdated/error/idle 时，编译仿真也同步
    if (status === 'outdated' || status === 'error' || status === 'idle') {
        _setSimulateStatus(context, status);
    }
    _updateStatusBar();
}

function _setSimulateStatus(context: vscode.ExtensionContext, status: string): void {
    if (hdlStopping) { return; }
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

function _duplicateModuleGroups(
    definitions: HdlDefinitionSummary[]
): Array<{ name: string; definitions: HdlDefinitionSummary[] }> {
    const byName = new Map<string, HdlDefinitionSummary[]>();
    for (const definition of definitions) {
        const matches = byName.get(definition.name) ?? [];
        matches.push(definition);
        byName.set(definition.name, matches);
    }
    return [...byName.entries()]
        .filter(([, matches]) => matches.length > 1)
        .map(([name, matches]) => ({ name, definitions: matches }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

function _invalidateDependencyPresentation(context: vscode.ExtensionContext): void {
    if (hdlStopping) { return; }
    hdlWorkflowGeneration++;
    _markOutdatedIfCompleted(context);
    treeProvider.setAnalyzeResult(null);
    _clearPersistedDependencyResult(context);
    _lastDepFileHashes = {};
    _pendingSimulateAfterAnalyze = false;
    _pendingWaveAfterAnalyze = false;
    _pendingWaveAfterSimulate = false;
}

function _isCurrentHdlWorkflow(generation: number): boolean {
    return !hdlStopping && generation === hdlWorkflowGeneration;
}

function _isCurrentHdlCommand(
    lifecycleGeneration: number,
    workflowGeneration: number
): boolean {
    return _isCurrentHdlLifecycle(lifecycleGeneration)
        && _isCurrentHdlWorkflow(workflowGeneration);
}

function _isCurrentHdlPresentation(
    generation: number,
    rootIdentity: string | undefined,
    index: WorkspaceHdlIndex | undefined
): boolean {
    return !hdlStopping
        && generation === hdlPresentationGeneration
        && rootIdentity === hdlPresentationRootIdentity
        && index === hdlIndex;
}

function _isCurrentHdlScanOwnership(ownership: HdlScanOwnership): boolean {
    return _isCurrentHdlLifecycle(ownership.lifecycleGeneration)
        && ownership.rootGeneration === hdlRootGeneration
        && ownership.settingsGeneration === hdlWatchSettingsGeneration
        && ownership.presentationGeneration === hdlPresentationGeneration
        && ownership.rootIdentity === _currentHdlRootIdentity();
}

function _isCurrentHdlScanPresentation(presentation: HdlScanPresentation): boolean {
    return _isCurrentHdlScanOwnership(presentation)
        && presentation.rootIdentity === hdlPresentationRootIdentity
        && presentation.indexGeneration === hdlIndexGeneration
        && presentation.index === hdlIndex;
}

function _sameHdlScanOwnership(
    left: HdlScanOwnership,
    right: HdlScanOwnership
): boolean {
    return left.lifecycleGeneration === right.lifecycleGeneration
        && left.rootGeneration === right.rootGeneration
        && left.settingsGeneration === right.settingsGeneration
        && left.presentationGeneration === right.presentationGeneration
        && left.rootIdentity === right.rootIdentity;
}

function _isCurrentTopInvocation(
    intentVersion: number,
    lifecycleGeneration: number
): boolean {
    return intentVersion === hdlTopIntentVersion
        && _isCurrentHdlLifecycle(lifecycleGeneration);
}

function _isCurrentTopPresentation(
    intentVersion: number,
    lifecycleGeneration: number,
    presentationGeneration: number,
    rootIdentity: string | undefined,
    index: WorkspaceHdlIndex | undefined
): boolean {
    return _isCurrentTopInvocation(intentVersion, lifecycleGeneration)
        && _isCurrentHdlPresentation(presentationGeneration, rootIdentity, index);
}

function _isCurrentTopIntent(
    intentVersion: number,
    lifecycleGeneration: number,
    presentationGeneration: number,
    rootIdentity: string | undefined,
    index: WorkspaceHdlIndex | undefined,
    definitionKey: string
): boolean {
    if (!_isCurrentTopPresentation(
        intentVersion,
        lifecycleGeneration,
        presentationGeneration,
        rootIdentity,
        index
    )
        || index?.getDefinition(definitionKey) === undefined) {
        return false;
    }
    return treeProvider.getWorkspaceDefinitions().some(definition =>
        definition.workspace && definition.key === definitionKey
    );
}

function _isCurrentInstantiationInvocation(
    intentVersion: number,
    lifecycleGeneration: number
): boolean {
    return intentVersion === hdlInstantiationIntentVersion
        && _isCurrentHdlLifecycle(lifecycleGeneration);
}

function _isCurrentInstantiationPresentation(
    intentVersion: number,
    lifecycleGeneration: number,
    rootGeneration: number,
    settingsGeneration: number,
    rootIdentity: string,
    scan: HdlScanOperation,
    presentation: HdlScanPresentation
): boolean {
    return _isCurrentInstantiationInvocation(intentVersion, lifecycleGeneration)
        && rootGeneration === hdlRootGeneration
        && settingsGeneration === hdlWatchSettingsGeneration
        && rootIdentity === _currentHdlRootIdentity()
        && _sameHdlScanOwnership(scan, presentation)
        && _isCurrentHdlScanPresentation(presentation);
}

function _currentHdlRootIdentity(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) {
        return undefined;
    }
    return JSON.stringify(_dependencyRootUris(root, getSettings().libDirs));
}

function _hasCurrentHdlWatchOwnership(registry: HdlWatchRegistry): boolean {
    return _isCurrentHdlLifecycle(registry.lifecycleGeneration)
        && registry.settingsGeneration === hdlWatchSettingsGeneration
        && registry.rootIdentity === _currentHdlRootIdentity()
        && registry.indexGeneration === hdlIndexGeneration
        && registry.index === hdlIndex;
}

function _isCurrentHdlWatchRegistry(registry: HdlWatchRegistry): boolean {
    return registry === hdlWatchRegistry
        && registry.version === hdlWatchRegistryVersion
        && _hasCurrentHdlWatchOwnership(registry);
}

function _sameHdlWatchOwnership(
    left: HdlWatchRegistry,
    right: HdlWatchRegistry
): boolean {
    return left.lifecycleGeneration === right.lifecycleGeneration
        && left.rootIdentity === right.rootIdentity
        && left.indexGeneration === right.indexGeneration
        && left.index === right.index;
}

function _disposeHdlWatchRegistry(): void {
    hdlWatchRegistryVersion++;
    const registry = hdlWatchRegistry;
    hdlWatchRegistry = undefined;
    if (!registry) {
        return;
    }
    for (const watcher of registry.watchers) {
        watcher.dispose();
    }
    for (const event of registry.pendingEvents.values()) {
        event.resolve();
    }
    registry.pendingEvents.clear();
}

async function _flushHdlWatchEvents(
    context: vscode.ExtensionContext,
    registry: HdlWatchRegistry
): Promise<void> {
    registry.flushScheduled = false;
    const events = [...registry.pendingEvents.values()];
    registry.pendingEvents.clear();
    for (const event of events) {
        try {
            if (_hasCurrentHdlWatchOwnership(registry)) {
                await _refreshIndexedUriWithErrorReporting(
                    context,
                    event.uri,
                    event.remove,
                    registry
                );
            } else {
                await _requeueHdlWatchEvent(
                    context,
                    registry,
                    event.uri,
                    event.remove
                );
            }
        } finally {
            event.resolve();
        }
    }
}

function _queueHdlWatchEvent(
    context: vscode.ExtensionContext,
    registry: HdlWatchRegistry,
    uri: vscode.Uri,
    remove: boolean
): Promise<void> {
    if (!_isCurrentHdlWatchRegistry(registry)) {
        return Promise.resolve();
    }
    const key = uri.toString();
    const pending = registry.pendingEvents.get(key);
    if (pending) {
        pending.remove = remove;
        return pending.promise;
    }
    let resolve!: () => void;
    const event: HdlWatchEvent = {
        uri,
        remove,
        promise: new Promise<void>(settled => { resolve = settled; }),
        resolve: () => resolve(),
    };
    registry.pendingEvents.set(key, event);
    if (!registry.flushScheduled) {
        registry.flushScheduled = true;
        queueMicrotask(() => { void _flushHdlWatchEvents(context, registry); });
    }
    return event.promise;
}

function _requeueHdlWatchEvent(
    context: vscode.ExtensionContext,
    staleRegistry: HdlWatchRegistry,
    uri: vscode.Uri,
    remove: boolean
): Promise<void> {
    const currentRegistry = hdlWatchRegistry;
    if (!currentRegistry
        || currentRegistry === staleRegistry
        || !_isCurrentHdlWatchRegistry(currentRegistry)) {
        return Promise.resolve();
    }
    return _queueHdlWatchEvent(context, currentRegistry, uri, remove);
}

type HdlWatchPatternValue = { base: vscode.Uri; pattern: string };

function _hdlWatchPatternKey(patternValue: HdlWatchPatternValue): string {
    return `${patternValue.base.toString()}\0${patternValue.pattern}`;
}

function _exactHdlWatchPattern(uriValue: string): HdlWatchPatternValue | undefined {
    const uri = vscode.Uri.parse(uriValue);
    const filename = path.posix.basename(uri.path);
    return filename ? {
        base: uri.with({ path: path.posix.dirname(uri.path) }),
        pattern: filename.replace(/([*?{}[\]])/g, '[$1]'),
    } : undefined;
}

function _addHdlWatcher(
    context: vscode.ExtensionContext,
    registry: HdlWatchRegistry,
    patternValue: HdlWatchPatternValue
): void {
    const patternKey = _hdlWatchPatternKey(patternValue);
    if (registry.watcherPatternKeys.has(patternKey)) {
        return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(patternValue.base, patternValue.pattern)
    );
    try {
        watcher.onDidChange(uri => _queueHdlWatchEvent(context, registry, uri, false));
        watcher.onDidCreate(uri => _queueHdlWatchEvent(context, registry, uri, false));
        watcher.onDidDelete(uri => _queueHdlWatchEvent(context, registry, uri, true));
    } catch (error) {
        watcher.dispose();
        throw error;
    }
    registry.watchers.push(watcher);
    registry.watcherPatternKeys.add(patternKey);
}

function _addProvisionalHdlWatchers(
    context: vscode.ExtensionContext,
    index: WorkspaceHdlIndex,
    rootUris: string[],
    uriValues: string[]
): void {
    const registry = hdlWatchRegistry;
    const ownsGlobalRegistry = registry?.index === index
        && registry.rootIdentity === JSON.stringify(rootUris)
        && _isCurrentHdlWatchRegistry(registry);
    const schematicEntry = [...schematicIndexRegistry.values()].find(candidate =>
        candidate.index === index
        && candidate.rootUris.length === rootUris.length
        && candidate.rootUris.every((root, position) => root === rootUris[position])
        && _isCurrentSchematicIndexEntry(candidate)
    );
    for (const uriValue of [...new Set(uriValues)].sort()) {
        const uri = vscode.Uri.parse(uriValue);
        const coveredByBroadWatcher = _isHdlUri(uri) && rootUris.some(rootUri =>
            isSourceUriWithinRoot(uriValue, rootUri)
        );
        if (coveredByBroadWatcher) {
            continue;
        }
        const patternValue = _exactHdlWatchPattern(uriValue);
        if (patternValue) {
            if (ownsGlobalRegistry && registry) {
                _addHdlWatcher(context, registry, patternValue);
                registry.provisionalIncludeUris.add(uriValue);
            }
            if (schematicEntry) {
                _addSchematicIndexWatcher(schematicEntry, patternValue);
            }
        }
    }
}

function _reconcileHdlWatchers(
    context: vscode.ExtensionContext,
    rootUris: string[],
    index: WorkspaceHdlIndex | undefined
): void {
    if (hdlStopping || rootUris.length === 0) {
        _disposeHdlWatchRegistry();
        return;
    }
    const rootIdentity = JSON.stringify(rootUris);
    const patternValues: HdlWatchPatternValue[] = rootUris.map(root => ({
        base: vscode.Uri.parse(root),
        pattern: HDL_WATCH_GLOB,
    }));
    if (index) {
        const plan = index.getWatchPlan(rootUris);
        for (const uriValue of [
            ...plan.resolvedExternalIncludeUris,
            ...plan.unresolvedExternalCandidateUris,
        ]) {
            const patternValue = _exactHdlWatchPattern(uriValue);
            if (patternValue) {
                patternValues.push(patternValue);
            }
        }
    }
    const uniquePatterns = new Map<string, HdlWatchPatternValue>();
    for (const patternValue of patternValues) {
        uniquePatterns.set(_hdlWatchPatternKey(patternValue), patternValue);
    }
    const registry: HdlWatchRegistry = {
        version: hdlWatchRegistryVersion + 1,
        lifecycleGeneration: hdlLifecycleGeneration,
        settingsGeneration: hdlWatchSettingsGeneration,
        rootIdentity,
        indexGeneration: hdlIndexGeneration,
        index,
        watchers: [],
        watcherPatternKeys: new Set(),
        provisionalIncludeUris: new Set(),
        pendingEvents: new Map(),
        flushScheduled: false,
    };
    try {
        for (const patternValue of uniquePatterns.values()) {
            _addHdlWatcher(context, registry, patternValue);
        }
    } catch (error) {
        for (const watcher of registry.watchers) {
            watcher.dispose();
        }
        throw error;
    }
    const previous = hdlWatchRegistry;
    hdlWatchRegistryVersion = registry.version;
    hdlWatchRegistry = registry;
    if (previous) {
        for (const watcher of previous.watchers) {
            watcher.dispose();
        }
        if (_sameHdlWatchOwnership(previous, registry)) {
            for (const [key, event] of previous.pendingEvents) {
                registry.pendingEvents.set(key, event);
            }
            if (registry.pendingEvents.size > 0) {
                registry.flushScheduled = true;
                queueMicrotask(() => { void _flushHdlWatchEvents(context, registry); });
            }
        } else {
            for (const event of previous.pendingEvents.values()) {
                event.resolve();
            }
        }
        previous.pendingEvents.clear();
    }
}

function _reconcileHdlWatchersForCurrentRoots(context: vscode.ExtensionContext): void {
    const root = getWorkspaceRoot();
    if (!root) {
        _disposeHdlWatchRegistry();
        return;
    }
    const rootUris = _dependencyRootUris(root, getSettings().libDirs);
    const rootIdentity = JSON.stringify(rootUris);
    _reconcileHdlWatchers(
        context,
        rootUris,
        hdlIndexIdentity === rootIdentity ? hdlIndex : undefined
    );
}

function _clearHdlPresentation(
    context: vscode.ExtensionContext,
    preserveTopSelection = false
): void {
    if (hdlStopping) { return; }
    treeProvider.setScanResult(null);
    treeProvider.setAnalyzeResult(null);
    tbPanelProvider.refreshModules();
    if (!preserveTopSelection) {
        treeProvider.topModule = undefined;
        _clearPersistedTopModule(context);
    }
    _clearPersistedDependencyResult(context);
    _lastDepFileHashes = {};
    output.clear();
    _updateStatusBar();
}

function _invalidateChangedHdlRootIdentity(
    context: vscode.ExtensionContext,
    force = false
): void {
    if (hdlStopping) { return; }
    const nextIdentity = _currentHdlRootIdentity();
    const presentationChanged = hdlPresentationRootIdentity !== undefined
        && hdlPresentationRootIdentity !== nextIdentity;
    const indexChanged = hdlIndexIdentity !== undefined
        && hdlIndexIdentity !== nextIdentity;
    if (!force && !presentationChanged && !indexChanged) {
        return;
    }
    hdlRootGeneration++;
    hdlPresentationGeneration++;
    hdlPreparationInFlight = undefined;
    hdlScanInFlight = undefined;
    hdlPresentationRootIdentity = undefined;
    _resetDependencyIndex();
    _clearHdlPresentation(context);
}

function _definitionEntry(
    definition: HdlDefinitionSummary,
    workspaceRootUri: string
): ModuleDefinitionEntry {
    const resource = vscode.Uri.parse(definition.uri);
    return {
        key: definition.key,
        name: definition.name,
        uri: definition.uri,
        filepath: resource.fsPath || resource.path || definition.uri,
        line: definition.declarationLine,
        workspace: isSourceUriWithinRoot(definition.uri, workspaceRootUri),
    };
}

function _setRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(record, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

function _deriveModuleScanResult(
    index: WorkspaceHdlIndex,
    root: string,
    libDirs: string[],
    rootUris: string[]
): {
    result: ModuleScanResult;
    duplicateGroups: Array<{ name: string; definitions: HdlDefinitionSummary[] }>;
} {
    const indexedDefinitions = index.getAllDefinitions('module');
    const definitions = indexedDefinitions.map(
        definition => _definitionEntry(definition, rootUris[0])
    );
    const duplicateGroups = _duplicateModuleGroups(indexedDefinitions);
    const duplicates: Record<string, string[]> = {};
    const duplicatesWithLines: Record<string, Array<{ file: string; line: number }>> = {};
    for (const group of duplicateGroups) {
        _setRecordValue(
            duplicates,
            group.name,
            group.definitions.map(definition => definition.uri)
        );
        _setRecordValue(duplicatesWithLines, group.name, group.definitions.map(definition => ({
            file: vscode.Uri.parse(definition.uri).fsPath || definition.uri,
            line: definition.declarationLine,
        })));
    }
    const modules = [...new Set(definitions.map(definition => definition.name))].sort();
    const workspaceModules = [...new Set(definitions
        .filter(definition => definition.workspace)
        .map(definition => definition.name))].sort();
    return {
        result: {
            root,
            libDirs: [...libDirs],
            totalModules: modules.length,
            modules,
            workspaceModules,
            definitions,
            duplicates,
            duplicatesWithLines,
        },
        duplicateGroups,
    };
}

function _coerceTopSelection(value: unknown): TopModuleSelection | undefined {
    if (typeof value === 'string') {
        return value ? { definitionKey: value, name: value } : undefined;
    }
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const selection = value as Partial<TopModuleSelection>;
    return typeof selection.definitionKey === 'string'
        && typeof selection.name === 'string'
        ? { definitionKey: selection.definitionKey, name: selection.name }
        : undefined;
}

function _sameTopSelection(
    left: TopModuleSelection | undefined,
    right: TopModuleSelection | undefined
): boolean {
    return left?.definitionKey === right?.definitionKey && left?.name === right?.name;
}

async function _presentScanResult(
    context: vscode.ExtensionContext,
    result: ModuleScanResult,
    duplicateGroups: Array<{ name: string; definitions: HdlDefinitionSummary[] }>,
    generation: number,
    rootUris: string[]
): Promise<void> {
    if (generation !== hdlPresentationGeneration) {
        return;
    }
    const rootIdentity = JSON.stringify(rootUris);
    try {
        _reconcileHdlWatchers(context, rootUris, hdlIndex);
    } catch (error) {
        throw new HdlWatchPlanReconciliationError(error);
    }
    treeProvider.setScanResult(result);
    tbPanelProvider.refreshModules();
    hdlPresentationRootIdentity = rootIdentity;

    const stored = hdlTopPersistencePending > 0
        ? _coerceTopSelection(treeProvider.topModule)
        : _coerceTopSelection(getTopModule(context));
    const selection = resolveTopModuleSelection(stored, result.definitions);
    treeProvider.topModule = selection;

    const summary = formatDuplicateSummary(duplicateGroups);
    if (summary.outputLines.length > 0) {
        output.appendWarning([
            'Duplicate module definitions:',
            ...summary.outputLines,
        ].join('\n'));
        statusBarItem.text = summary.statusText;
    } else {
        statusBarItem.text = `$(circuit-board) VeriFlow: ${result.totalModules} modules`;
    }
    if (!_sameTopSelection(stored, selection)) {
        await _persistTopModule(context, selection);
    }
}

async function _scanModulesFromIndex(
    context: vscode.ExtensionContext,
    root: string,
    settings: ExtensionSettings,
    rootUris: string[],
    ownership: HdlScanOwnership
): Promise<HdlScanPresentation | null> {
    const lifecycleGeneration = ownership.lifecycleGeneration;
    const scanningStatus = '$(sync~spin) VeriFlow: scanning...';
    if (statusBarItem.text !== scanningStatus) {
        hdlLastNonScanningStatusText = statusBarItem.text;
    }
    const statusBeforeScan = hdlLastNonScanningStatusText;
    const restoreStatus = (): void => {
        if (_isCurrentHdlLifecycle(lifecycleGeneration)
            && ownership.presentationGeneration === hdlPresentationGeneration
            && statusBarItem.text === scanningStatus) {
            statusBarItem.text = statusBeforeScan;
        }
    };
    statusBarItem.text = scanningStatus;
    const preparation = _prepareDependencyAnalyzer(
        context,
        rootUris,
        _filterHdlDefines(settings.defines)
    );
    return _runDependencyOperation(async () => {
        try {
            const prepared = await preparation;
            const { index, indexGeneration } = prepared;
            if (hdlStopping) {
                return null;
            }
            if (!_isCurrentHdlScanOwnership(ownership)) {
                return null;
            }
            const derived = _deriveModuleScanResult(index, root, settings.libDirs, rootUris);
            await _presentScanResult(
                context,
                derived.result,
                derived.duplicateGroups,
                ownership.presentationGeneration,
                rootUris
            );
            const presentation = {
                ...ownership,
                result: derived.result,
                indexGeneration,
                index,
            };
            return _isCurrentHdlScanPresentation(presentation) ? presentation : null;
        } catch (error) {
            if (error instanceof HdlIndexPreparationInvalidatedError
                || error instanceof HdlStoppingError
                || hdlStopping) {
                return null;
            }
            if (error instanceof HdlWatchPlanReconciliationError
                && ownership.presentationGeneration === hdlPresentationGeneration) {
                hdlPresentationGeneration++;
                hdlPresentationRootIdentity = undefined;
                _resetDependencyIndex();
                _clearHdlPresentation(context, true);
            }
            throw error;
        } finally {
            restoreStatus();
        }
    });
}

async function _scanModulesWithErrorReporting(
    context: vscode.ExtensionContext
): Promise<ModuleScanResult | null> {
    if (hdlStopping) { return null; }
    try {
        return await cmdScanModules(context);
    } catch (error) {
        if (hdlStopping || error instanceof HdlStoppingError) { return null; }
        output.appendError(
            `HDL module scan failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

async function _refreshIndexedUri(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    remove: boolean,
    watcherRegistry?: HdlWatchRegistry
): Promise<void> {
    if (hdlStopping) {
        return;
    }
    if (watcherRegistry && !_hasCurrentHdlWatchOwnership(watcherRegistry)) {
        await _requeueHdlWatchEvent(context, watcherRegistry, uri, remove);
        return;
    }
    if (watcherRegistry && !watcherRegistry.index) {
        await _scanModulesWithErrorReporting(context);
        return;
    }
    const root = getWorkspaceRoot();
    if (!root) {
        return;
    }
    const settings = getSettings();
    const rootUris = _dependencyRootUris(root, settings.libDirs);
    const rootIdentity = JSON.stringify(rootUris);
    const uriValue = uri.toString();
    const currentIndex = hdlIndexIdentity === rootIdentity ? hdlIndex : undefined;
    let admitted = rootUris.some(rootUri =>
        isSourceUriWithinRoot(uriValue, rootUri)
    ) || currentIndex?.getFile(uriValue) !== undefined
        || (currentIndex?.getDependentsOfInclude(uriValue).length ?? 0) > 0
        || watcherRegistry?.provisionalIncludeUris.has(uriValue) === true;
    if (!admitted && !remove && currentIndex) {
        admitted = await currentIndex.canResolveUnresolvedInclude(
            uriValue,
            hdlAbortController.signal
        );
        if (hdlStopping) {
            return;
        }
        if (watcherRegistry && !_hasCurrentHdlWatchOwnership(watcherRegistry)) {
            await _requeueHdlWatchEvent(context, watcherRegistry, uri, remove);
            return;
        }
        if (currentIndex !== hdlIndex
            || hdlIndexIdentity !== rootIdentity) {
            return;
        }
    }
    if (!admitted) {
        return;
    }
    if (watcherRegistry && !_hasCurrentHdlWatchOwnership(watcherRegistry)) {
        return;
    }
    _invalidateDependencyPresentation(context);
    const defines = _filterHdlDefines(settings.defines);
    const generation = ++hdlPresentationGeneration;
    await _runDependencyOperation(async () => {
        const requeueIfStale = (): boolean => {
            if (!watcherRegistry || _hasCurrentHdlWatchOwnership(watcherRegistry)) {
                return false;
            }
            void _requeueHdlWatchEvent(context, watcherRegistry, uri, remove);
            return true;
        };
        if (hdlStopping || requeueIfStale()) {
            return;
        }
        try {
            let index = hdlIndex;
            if (!index || hdlIndexIdentity !== rootIdentity) {
                await _getDependencyAnalyzer(context, rootUris, defines);
                if (hdlStopping || requeueIfStale()) {
                    return;
                }
                index = hdlIndex;
            } else {
                await hdlIndexLoad;
                if (hdlStopping || requeueIfStale()) {
                    return;
                }
                await index.updateConfiguration(defines);
                if (hdlStopping || requeueIfStale()) {
                    return;
                }
                if (remove) {
                    await index.removeUri(uriValue);
                } else {
                    await index.refreshUri(uriValue);
                }
                if (hdlStopping || requeueIfStale()) {
                    return;
                }
            }
            if (!index) {
                return;
            }
            if (hdlStopping || requeueIfStale()) {
                return;
            }
            const derived = _deriveModuleScanResult(index, root, settings.libDirs, rootUris);
            await _presentScanResult(
                context,
                derived.result,
                derived.duplicateGroups,
                generation,
                rootUris
            );
            requeueIfStale();
        } catch (error) {
            if (hdlStopping || error instanceof HdlStoppingError) { return; }
            _resetDependencyIndex();
            throw error;
        }
    });
}

async function _refreshIndexedUriWithErrorReporting(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    remove: boolean,
    watcherRegistry?: HdlWatchRegistry
): Promise<void> {
    if (hdlStopping) {
        return;
    }
    if (watcherRegistry && !_hasCurrentHdlWatchOwnership(watcherRegistry)) {
        await _requeueHdlWatchEvent(context, watcherRegistry, uri, remove);
        return;
    }
    try {
        await _refreshIndexedUri(context, uri, remove, watcherRegistry);
    } catch (error) {
        if (hdlStopping || error instanceof HdlStoppingError) { return; }
        output.appendError(
            `HDL index update failed for ${uri.toString()}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

function _startModuleScan(context: vscode.ExtensionContext): HdlScanOperation | undefined {
    if (hdlStopping) { return undefined; }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const rootGeneration = hdlRootGeneration;
    const settingsGeneration = hdlWatchSettingsGeneration;
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }

    const settings = getSettings();
    const rootUris = _dependencyRootUris(root, settings.libDirs);
    const rootIdentity = JSON.stringify(rootUris);
    const identity = JSON.stringify([
        rootUris,
        Object.entries(_filterHdlDefines(settings.defines))
            .sort(([left], [right]) => left.localeCompare(right)),
    ]);
    if (hdlScanInFlight?.identity === identity
        && _isCurrentHdlScanOwnership(hdlScanInFlight)) {
        return hdlScanInFlight;
    }
    const ownership: HdlScanOwnership = {
        lifecycleGeneration,
        rootGeneration,
        settingsGeneration,
        presentationGeneration: ++hdlPresentationGeneration,
        rootIdentity,
    };
    const scan = {
        ...ownership,
        identity,
        promise: _scanModulesFromIndex(context, root, settings, rootUris, ownership),
    };
    hdlScanInFlight = scan;
    const clear = (): void => {
        if (hdlScanInFlight === scan) {
            hdlScanInFlight = undefined;
        }
    };
    void scan.promise.then(clear, clear);
    return scan;
}

async function cmdScanModules(context: vscode.ExtensionContext): Promise<ModuleScanResult | null> {
    const lifecycleGeneration = hdlLifecycleGeneration;
    const scan = _startModuleScan(context);
    if (!scan) { return null; }
    const presentation = await scan.promise;
    return _isCurrentHdlLifecycle(lifecycleGeneration)
        ? presentation?.result ?? null
        : null;
}

async function cmdInstantiateModule(context: vscode.ExtensionContext): Promise<void> {
    const intentVersion = ++hdlInstantiationIntentVersion;
    if (hdlStopping) { return; }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const rootGeneration = hdlRootGeneration;
    const settingsGeneration = hdlWatchSettingsGeneration;
    const root = getWorkspaceRoot();
    if (!root) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
    }
    const rootIdentity = _currentHdlRootIdentity();
    const scan = _startModuleScan(context);
    if (!rootIdentity
        || !scan
        || scan.lifecycleGeneration !== lifecycleGeneration
        || scan.rootGeneration !== rootGeneration
        || scan.settingsGeneration !== settingsGeneration
        || scan.rootIdentity !== rootIdentity) {
        return;
    }
    const presentation = await scan.promise;
    if (!presentation || !_isCurrentInstantiationPresentation(
        intentVersion,
        lifecycleGeneration,
        rootGeneration,
        settingsGeneration,
        rootIdentity,
        scan,
        presentation
    )) {
        return;
    }
    const index = presentation.index;
    const isCurrent = (): boolean => _isCurrentInstantiationPresentation(
        intentVersion,
        lifecycleGeneration,
        rootGeneration,
        settingsGeneration,
        rootIdentity,
        scan,
        presentation
    );
    if (!isCurrent()) { return; }
    await showModuleInstantiationPicker(
        () => isCurrent() ? index : undefined,
        isCurrent,
        root
    );
}

async function cmdSelectTop(context: vscode.ExtensionContext): Promise<void> {
    if (hdlStopping) { return; }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const rootGeneration = hdlRootGeneration;
    const intentVersion = ++hdlTopIntentVersion;
    const rootIdentityAtEntry = _currentHdlRootIdentity();
    const selectionPersistenceChainAtEntry = hdlTopSelectionPersistenceChain;
    const hadPendingTopSelectionAtEntry = _hasTopSelectionPersistenceOwnership(
        selectionPersistenceChainAtEntry,
        lifecycleGeneration,
        rootGeneration,
        rootIdentityAtEntry
    ) && selectionPersistenceChainAtEntry.pending > 0;
    const persistedSelectionAtEntry = hadPendingTopSelectionAtEntry
        ? selectionPersistenceChainAtEntry.rollbackBaseline
        : _coerceTopSelection(getTopModule(context));
    await cmdScanModules(context);
    if (!_isCurrentTopInvocation(intentVersion, lifecycleGeneration)) { return; }
    const generation = hdlPresentationGeneration;
    const rootIdentity = hdlPresentationRootIdentity;
    const index = hdlIndex;
    // 只从工作区目录的模块中选取
    const definitions = treeProvider.getWorkspaceDefinitions();
    if (definitions.length === 0) {
        vscode.window.showWarningMessage('No modules found in workspace. Add .v/.sv files or configure veriflow.libDirs, then scan again.');
        return;
    }
    const counts = new Map<string, number>();
    for (const definition of definitions) {
        counts.set(definition.name, (counts.get(definition.name) ?? 0) + 1);
    }
    const choices = definitions.map(definition => ({
        label: definition.name,
        description: (counts.get(definition.name) ?? 0) > 1
            ? relativeDisplayPath(getWorkspaceRoot()!, definition.filepath)
            : undefined,
        definitionKey: definition.key,
        name: definition.name,
    }));
    const selected = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select top module for simulation (workspace only)',
        matchOnDescription: true,
    });
    if (!_isCurrentTopPresentation(
        intentVersion,
        lifecycleGeneration,
        generation,
        rootIdentity,
        index
    )) {
        return;
    }
    if (!selected) {
        if (!hadPendingTopSelectionAtEntry) {
            return;
        }
        const baseline = resolveTopModuleSelection(
            persistedSelectionAtEntry,
            treeProvider.getWorkspaceDefinitions()
        );
        if (!_isCurrentTopPresentation(
            intentVersion,
            lifecycleGeneration,
            generation,
            rootIdentity,
            index
        )) {
            return;
        }
        treeProvider.topModule = baseline;
        try {
            await _persistTopSelection(
                context,
                baseline,
                persistedSelectionAtEntry,
                lifecycleGeneration,
                rootGeneration,
                rootIdentity
            );
        } catch (error) {
            if (_isCurrentTopPresentation(
                intentVersion,
                lifecycleGeneration,
                generation,
                rootIdentity,
                index
            )
                && _sameTopSelection(_coerceTopSelection(treeProvider.topModule), baseline)) {
                treeProvider.topModule = resolveTopModuleSelection(
                    _coerceTopSelection(getTopModule(context)),
                    treeProvider.getWorkspaceDefinitions()
                );
            }
            throw error;
        }
        if (!_isCurrentTopPresentation(
            intentVersion,
            lifecycleGeneration,
            generation,
            rootIdentity,
            index
        )) {
            await hdlTopPersistenceTail;
            return;
        }
        treeProvider.topModule = baseline;
        return;
    }
    const definition = index?.getDefinition(selected.definitionKey);
    const workspaceDefinition = treeProvider.getWorkspaceDefinitions().find(candidate =>
        candidate.workspace && candidate.key === definition?.key
    );
    if (!definition || !workspaceDefinition) {
        return;
    }
    const selection: TopModuleSelection = {
        definitionKey: definition.key,
        name: definition.name,
    };
    if (!_isCurrentTopIntent(
        intentVersion,
        lifecycleGeneration,
        generation,
        rootIdentity,
        index,
        selection.definitionKey
    )) {
        return;
    }
    treeProvider.topModule = selection;
    try {
        await _persistTopSelection(
            context,
            selection,
            persistedSelectionAtEntry,
            lifecycleGeneration,
            rootGeneration,
            rootIdentity
        );
    } catch (error) {
        if (_isCurrentTopIntent(
            intentVersion,
            lifecycleGeneration,
            generation,
            rootIdentity,
            index,
            selection.definitionKey
        )
            && _sameTopSelection(_coerceTopSelection(treeProvider.topModule), selection)) {
            treeProvider.topModule = resolveTopModuleSelection(
                _coerceTopSelection(getTopModule(context)),
                treeProvider.getWorkspaceDefinitions()
            );
        }
        throw error;
    }
    if (!_isCurrentTopIntent(
        intentVersion,
        lifecycleGeneration,
        generation,
        rootIdentity,
        index,
        selection.definitionKey
    )) {
        await hdlTopPersistenceTail;
        return;
    }
    treeProvider.topModule = selection;
    output.appendInfo(`Top module: ${selection.name}`);
}

async function cmdAnalyze(context: vscode.ExtensionContext): Promise<void> {
    if (hdlStopping) { return; }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const root = getWorkspaceRoot();
    if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
    const workflowGeneration = hdlWorkflowGeneration;

    let topSelection = _coerceTopSelection(treeProvider.topModule);
    if (!topSelection) {
        await cmdSelectTop(context);
        if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }
        topSelection = _coerceTopSelection(treeProvider.topModule);
    }
    if (!topSelection) { vscode.window.showWarningMessage('Please select a top module.'); return; }
    const topModule = topSelection.name;

    // 检查文件变动
    _checkDepFilesChanged(context);

    const settings = getSettings();

    output.clear();
    output.show();
    output.appendInfo(`Analyzing: top=${topModule}, root=${root}`);
    statusBarItem.text = '$(search) VeriFlow: analyzing...';

    let result: DependencyResult;
    try {
        result = await _resolveDependencies(
            context,
            root,
            settings,
            topSelection.definitionKey
        );
    } catch (error) {
        if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }
        throw error;
    }
    if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }

    // 保存结果和状态
    await _persistDependencyResult(context, result);
    if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) {
        await hdlDependencyPersistenceTail;
        return;
    }
    treeProvider.setAnalyzeResult(result);
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
    if (hdlStopping) { return; }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const root = getWorkspaceRoot();
    if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
    const workflowGeneration = hdlWorkflowGeneration;

    let topSelection = _coerceTopSelection(treeProvider.topModule);
    if (!topSelection) {
        await cmdSelectTop(context);
        if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }
        topSelection = _coerceTopSelection(treeProvider.topModule);
    }
    if (!topSelection) { vscode.window.showWarningMessage('Please select a top module.'); return; }
    const topModule = topSelection.name;

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

    let depResult: DependencyResult;
    try {
        depResult = await _resolveDependencies(
            context,
            root,
            settings,
            topSelection.definitionKey
        );
    } catch (error) {
        if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }
        throw error;
    }
    if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }
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

    if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }
    const result = await Promise.resolve(simRunner.compileAndRun(
        depResult.files, outFile, simulator, root, topModule
    ));
    if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }

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
        if (result.success && _isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) {
            await _doOpenWave(context, root, topModule, settings, lifecycleGeneration);
        }
    }
}

async function cmdOpenWave(context: vscode.ExtensionContext): Promise<void> {
    if (hdlStopping) { return; }
    const lifecycleGeneration = hdlLifecycleGeneration;
    const root = getWorkspaceRoot();
    if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
    const workflowGeneration = hdlWorkflowGeneration;

    let topSelection = _coerceTopSelection(treeProvider.topModule);
    if (!topSelection) {
        await cmdSelectTop(context);
        if (!_isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) { return; }
        topSelection = _coerceTopSelection(treeProvider.topModule);
    }
    if (!topSelection) { vscode.window.showWarningMessage('Please select a top module.'); return; }
    const topModule = topSelection.name;

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
    if (fs.existsSync(waveFile)
        && _isCurrentHdlCommand(lifecycleGeneration, workflowGeneration)) {
        await _doOpenWave(context, root, topModule, settings, lifecycleGeneration);
        return;
    }

    // 波形文件不存在，运行仿真
    output.appendWarning(`Wave file not found: ${waveFile}`);
    output.appendInfo('Running simulate -> open wave to generate waveform first.');
    _pendingWaveAfterSimulate = true;
    await cmdSimulate(context);
}

async function cmdOpenVcdViewer(uri?: vscode.Uri): Promise<void> {
    if (hdlStopping) { return; }
    const lifecycleGeneration = hdlLifecycleGeneration;
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
        if (!_isCurrentHdlLifecycle(lifecycleGeneration)) { return; }
    }

    if (!target || !_isCurrentHdlLifecycle(lifecycleGeneration)) {
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

async function cmdOpenSchematic(uri?: vscode.Uri): Promise<void> {
    if (hdlStopping) { return; }
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const extension = target ? path.posix.extname(target.path).toLowerCase() : '';
    if (!target || (extension !== '.v' && extension !== '.sv')) {
        vscode.window.showWarningMessage('Open a Verilog or SystemVerilog file first.');
        return;
    }
    await vscode.commands.executeCommand(
        'vscode.openWith',
        target,
        SchematicEditorProvider.viewType
    );
}

async function _doOpenWave(
    context: vscode.ExtensionContext,
    root: string,
    topModule: string,
    settings: ExtensionSettings,
    lifecycleGeneration: number
): Promise<void> {
    if (!_isCurrentHdlLifecycle(lifecycleGeneration)) { return; }
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
        if (!_isCurrentHdlLifecycle(lifecycleGeneration)) { return; }
        output.appendSuccess(`Opened built-in waveform viewer: ${waveFile}`);
        return;
    }

    output.appendInfo(`Opening ${viewer.name}: ${waveFile}`);
    try {
        simRunner.openWave(waveFile, viewer);
        output.appendSuccess(`Opened ${viewer.name}: ${waveFile}`);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendError(`Failed to open ${viewer.name}: ${message}`);
    }
}
