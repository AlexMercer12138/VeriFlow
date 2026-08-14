import * as assert from 'assert';
import Module = require('module');
import * as path from 'path';

import {
    createHdlParserClient,
    HdlParserClient,
    WorkspaceHdlIndex as RealWorkspaceHdlIndex,
} from '../core/hdl';

type Defines = Record<string, string | boolean>;

type Settings = {
    libDirs: string[];
    defines: Defines;
    simulator: string;
    waveViewer: string;
    simulatorCompileCmd: string;
    simulatorRunCmd: string;
    waveViewerCmd: string;
    waveFileTemplate: string;
    testbenchOutputDir: string;
};

type IndexOptions = {
    parserFingerprint: string;
    findFiles(roots: string[]): Promise<string[]>;
    readFile(uri: string): Promise<unknown>;
    includeCandidates(fromUri: string, includePath: string): string[];
    resolveInclude(fromUri: string, includePath: string): Promise<string | undefined>;
};

type IndexHooks = {
    load?(index: FakeWorkspaceHdlIndex): Promise<void> | void;
    update?(defines: Record<string, string | true>, index: FakeWorkspaceHdlIndex): Promise<void> | void;
    scan?(roots: string[], index: FakeWorkspaceHdlIndex): Promise<void> | void;
};

class FakeUri {
    private constructor(
        readonly scheme: string,
        readonly authority: string,
        readonly path: string
    ) {}

    static parse(value: string): FakeUri {
        const parsed = new URL(value);
        return new FakeUri(
            parsed.protocol.slice(0, -1),
            parsed.host,
            decodeURIComponent(parsed.pathname)
        );
    }

    static file(value: string): FakeUri {
        let normalized = value.replace(/\\/g, '/');
        if (normalized.startsWith('//')) {
            const [authority, ...segments] = normalized.slice(2).split('/');
            return new FakeUri(
                'file',
                authority,
                path.posix.normalize(`/${segments.join('/')}`)
            );
        }
        if (/^[A-Za-z]:\//.test(normalized)) {
            normalized = `/${normalized}`;
        } else if (!normalized.startsWith('/')) {
            normalized = `/${normalized}`;
        }
        return new FakeUri('file', '', path.posix.normalize(normalized));
    }

    static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
        return new FakeUri(
            base.scheme,
            base.authority,
            path.posix.normalize(path.posix.join(base.path, ...segments))
        );
    }

    with(change: { path?: string }): FakeUri {
        return new FakeUri(
            this.scheme,
            this.authority,
            change.path ?? this.path
        );
    }

    get fsPath(): string {
        if (this.scheme === 'file' && /^\/[A-Za-z]:\//.test(this.path)) {
            return this.path.slice(1).replace(/\//g, '\\');
        }
        return this.path;
    }

    toString(): string {
        return `${this.scheme}://${this.authority}${this.path}`;
    }
}

class FakeRelativePattern {
    constructor(readonly baseUri: FakeUri, readonly pattern: string) {}
}

class FakeWorkspaceHdlIndex {
    static instances: FakeWorkspaceHdlIndex[] = [];

    readonly events: string[];
    readonly scannedRoots: string[][] = [];
    disposed = false;
    currentDefines: Record<string, string | true> = {};
    private tail = Promise.resolve();

    constructor(
        readonly options: IndexOptions,
        private readonly hooks: IndexHooks,
        events: string[]
    ) {
        this.events = events;
        FakeWorkspaceHdlIndex.instances.push(this);
    }

    load(): Promise<void> {
        return this.enqueue(async () => {
            this.events.push('load');
            await this.hooks.load?.(this);
        });
    }

    updateConfiguration(defines: Record<string, string | true>): Promise<void> {
        return this.enqueue(async () => {
            this.currentDefines = { ...defines };
            this.events.push(`update:${Object.keys(defines).sort().join('+')}`);
            await this.hooks.update?.(defines, this);
        });
    }

    scan(roots: string[]): Promise<void> {
        return this.enqueue(async () => {
            this.scannedRoots.push([...roots]);
            this.events.push(`scan:${Object.keys(this.currentDefines).sort().join('+')}`);
            await this.hooks.scan?.(roots, this);
            await this.options.findFiles(roots);
        });
    }

    getDefinition(): undefined {
        return undefined;
    }

    findDefinitions(name: string): Array<{ key: string; kind: 'module'; name: string }> {
        return [{ key: `module:${name}`, kind: 'module', name }];
    }

    getWatchPlan(): {
        resolvedExternalIncludeUris: string[];
        unresolvedExternalCandidateUris: string[];
    } {
        return {
            resolvedExternalIncludeUris: [],
            unresolvedExternalCandidateUris: [],
        };
    }

    dispose(): void {
        this.disposed = true;
        this.events.push('dispose-index');
    }

    private enqueue(operation: () => Promise<void>): Promise<void> {
        const result = this.tail.then(operation);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}

type ExtensionHarness = {
    events: string[];
    existingUris: Set<string>;
    files: Map<string, string>;
    settings: Settings;
    hooks: IndexHooks;
    folder: { uri: FakeUri };
    analyze(): Promise<void>;
    scan(): Promise<void>;
    setFile(uri: string, text: string): void;
    setNextCommitGate(gate: ScanGate): void;
    failNextExactWatcher(filename: string, error: Error): void;
    fireWatchEvent(kind: WatchEventKind, uri: string): Promise<void>;
    getScanResult(): ModuleScanResult | null;
    getRealIndex(): RealWorkspaceHdlIndex | undefined;
    dispose(): Promise<void>;
};

type ScanGate = {
    started: Promise<void>;
    markStarted(): void;
    release: Promise<void>;
    allow(): void;
};

type WatchEventKind = 'change' | 'create' | 'delete';

type WatcherRecord = {
    pattern: string | FakeRelativePattern;
    disposed: boolean;
    listeners: Partial<Record<WatchEventKind, (uri: FakeUri) => unknown>>;
};

type ModuleScanResult = {
    definitions: Array<{ name: string }>;
};

function createScanGate(): ScanGate {
    let markStarted!: () => void;
    let allow!: () => void;
    return {
        started: new Promise<void>(resolve => { markStarted = resolve; }),
        markStarted,
        release: new Promise<void>(resolve => { allow = resolve; }),
        allow,
    };
}

function defaultSettings(): Settings {
    return {
        libDirs: [],
        defines: {},
        simulator: 'iverilog',
        waveViewer: 'builtin',
        simulatorCompileCmd: '',
        simulatorRunCmd: '',
        waveViewerCmd: '',
        waveFileTemplate: '{top_module}.vcd',
        testbenchOutputDir: '.',
    };
}

function createExtensionHarness(
    hooks: IndexHooks = {},
    useRealIndex = false
): ExtensionHarness {
    const events: string[] = [];
    const existingUris = new Set<string>();
    const files = new Map<string, string>();
    const fileVersions = new Map<string, number>();
    const settings = defaultSettings();
    const folder = { uri: FakeUri.parse('file:///workspace') };
    const commands = new Map<string, () => Promise<void>>();
    const disposable = { dispose(): void {} };
    const workspaceState = new Map<string, unknown>();
    const watcherRecords: WatcherRecord[] = [];
    const realIndexes: RealWorkspaceHdlIndex[] = [];
    let nextCommitGate: ScanGate | undefined;
    let nextExactWatcherFailure: { filename: string; error: Error } | undefined;
    let latestScanResult: ModuleScanResult | null = null;
    let workspaceReady = false;
    const context = {
        extensionPath: useRealIndex
            ? path.resolve(__dirname, '..', '..')
            : path.join('D:', 'Extensions', 'VeriFlow'),
        subscriptions: [] as unknown[],
        workspaceState: {
            get<T>(key: string, fallback?: T): T | undefined {
                return workspaceState.has(key) ? workspaceState.get(key) as T : fallback;
            },
            async update(key: string, value: unknown): Promise<void> {
                workspaceState.set(key, value);
            },
        },
    };

    class FakeParserClient {
        clearCache(): void {}
        async dispose(): Promise<void> { events.push('dispose-parser'); }
    }

    class FakeDependencyAnalyzer {
        constructor(private readonly index: FakeWorkspaceHdlIndex | RealWorkspaceHdlIndex) {}

        resolve(top: string) {
            const defines = this.index instanceof FakeWorkspaceHdlIndex
                ? this.index.currentDefines
                : {};
            events.push(`resolve:${Object.keys(defines).sort().join('+')}`);
            return {
                topModule: top.replace(/^module:/, ''),
                topDefinitionKey: top,
                files: [],
                missingModules: [],
                ambiguousModules: {},
                moduleMap: {},
                depGraph: {},
            };
        }
    }

    class FakeModuleTreeProvider {
        topModule = '';
        analyzeResult: unknown;
        setScanResult(result: ModuleScanResult | null): void { latestScanResult = result; }
        setAnalyzeResult(result: unknown): void { this.analyzeResult = result; }
        getWorkspaceModuleNames(): string[] { return ['top']; }
    }

    class FakeTestbenchPanelProvider {
        static readonly viewType = 'veriflow.testbench';
        setBeforeGenerate(): void {}
        setOnVisible(): void {}
        refreshModules(): void {}
        dispose(): void {}
    }

    class MemoryWorkspaceIndexStore {
        load(): undefined { return undefined; }
        async stage(): Promise<void> {
            events.push('stage-index');
            const gate = nextCommitGate;
            nextCommitGate = undefined;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
        }
        async save(): Promise<void> { events.push('save-index'); }
        async discardStaged(): Promise<void> { events.push('discard-staged-index'); }
    }

    const setFile = (uri: string, text: string): void => {
        files.set(uri, text);
        existingUris.add(uri);
        fileVersions.set(uri, (fileVersions.get(uri) ?? 0) + 1);
    };

    const readDirectory = (directory: FakeUri): [string, number][] => {
        const entries = new Map<string, number>();
        const prefix = directory.path.endsWith('/') ? directory.path : `${directory.path}/`;
        for (const uriValue of files.keys()) {
            const uri = FakeUri.parse(uriValue);
            if (uri.scheme !== directory.scheme
                || uri.authority !== directory.authority
                || !uri.path.startsWith(prefix)) {
                continue;
            }
            const relative = uri.path.slice(prefix.length);
            if (!relative) {
                continue;
            }
            const [name, ...rest] = relative.split('/');
            entries.set(name, rest.length === 0 ? 1 : 2);
        }
        return [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));
    };

    const watcherMatches = (record: WatcherRecord, uri: FakeUri): boolean => {
        if (typeof record.pattern === 'string') {
            return record.pattern === '**/*.ad'
                && path.posix.extname(uri.path) === '.ad';
        }
        const basePath = path.posix.normalize(record.pattern.baseUri.path);
        const uriPath = path.posix.normalize(uri.path);
        const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
        if (record.pattern.baseUri.scheme !== uri.scheme
            || record.pattern.baseUri.authority !== uri.authority
            || (uriPath !== basePath && !uriPath.startsWith(prefix))) {
            return false;
        }
        const relative = uriPath === basePath ? '' : uriPath.slice(prefix.length);
        if (record.pattern.pattern === '**/*.{v,sv,vh,svh}') {
            return ['.v', '.sv', '.vh', '.svh'].includes(
                path.posix.extname(relative).toLowerCase()
            );
        }
        const literal = record.pattern.pattern
            .replace(/\[\[]/g, '[')
            .replace(/\[\]]/g, ']')
            .replace(/\[([*?{}])\]/g, '$1');
        return relative === literal;
    };

    FakeWorkspaceHdlIndex.instances = [];
    const vscodeStub = {
        Uri: FakeUri,
        RelativePattern: FakeRelativePattern,
        FileType: { File: 1, Directory: 2 },
        StatusBarAlignment: { Left: 1 },
        window: {
            createTreeView: () => ({ ...disposable, onDidChangeVisibility(): void {} }),
            registerWebviewViewProvider: () => disposable,
            registerCustomEditorProvider: () => disposable,
            createStatusBarItem: () => ({ ...disposable, show(): void {}, text: '' }),
            onDidChangeWindowState: () => disposable,
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showQuickPick: async () => undefined,
        },
        commands: {
            registerCommand(name: string, command: () => Promise<void>) {
                commands.set(name, command);
                return disposable;
            },
        },
        workspace: {
            workspaceFolders: [folder],
            fs: {
                async readDirectory(uri: FakeUri): Promise<[string, number][]> {
                    return readDirectory(uri);
                },
                async readFile(uri: FakeUri): Promise<Uint8Array> {
                    const text = files.get(uri.toString());
                    if (text === undefined) {
                        throw new Error(`not found: ${uri.toString()}`);
                    }
                    events.push(`read:${uri.toString()}:${fileVersions.get(uri.toString()) ?? 1}`);
                    return Buffer.from(text);
                },
                async stat(uri: FakeUri): Promise<{ type: number; mtime: number; size: number }> {
                    const uriValue = uri.toString();
                    if (existingUris.has(uriValue)) {
                        return {
                            type: 1,
                            mtime: fileVersions.get(uriValue) ?? 1,
                            size: Buffer.byteLength(files.get(uriValue) ?? ''),
                        };
                    }
                    throw new Error(`not found: ${uriValue}`);
                },
            },
            onDidChangeConfiguration: () => disposable,
            onDidChangeWorkspaceFolders: () => disposable,
            createFileSystemWatcher(pattern: string | FakeRelativePattern) {
                if (typeof pattern !== 'string'
                    && nextExactWatcherFailure?.filename === pattern.pattern) {
                    const error = nextExactWatcherFailure.error;
                    nextExactWatcherFailure = undefined;
                    throw error;
                }
                const record: WatcherRecord = {
                    pattern,
                    disposed: false,
                    listeners: {},
                };
                watcherRecords.push(record);
                return {
                    dispose(): void { record.disposed = true; },
                    onDidChange(listener: (uri: FakeUri) => unknown): void {
                        record.listeners.change = listener;
                    },
                    onDidCreate(listener: (uri: FakeUri) => unknown): void {
                        record.listeners.create = listener;
                    },
                    onDidDelete(listener: (uri: FakeUri) => unknown): void {
                        record.listeners.delete = listener;
                    },
                };
            },
        },
    };
    const configStub = {
        getWorkspaceRoot: () => workspaceReady ? folder.uri.fsPath : undefined,
        getTopModule: () => 'top',
        setTopModule: async () => undefined,
        getSettings: () => ({ ...settings, libDirs: [...settings.libDirs], defines: { ...settings.defines } }),
        getAnalyzeStatus: () => 'idle',
        setAnalyzeStatus: async () => undefined,
        getSimulateStatus: () => 'idle',
        setSimulateStatus: async () => undefined,
        getDependencyResult: () => null,
        setDependencyResult: async () => undefined,
        resolveTopModuleSelection: (
            stored: { definitionKey: string; name: string } | undefined,
            definitions: Array<{ key: string; name: string }>
        ) => {
            if (!stored) {
                return undefined;
            }
            const selected = definitions.find(definition =>
                definition.key === stored.definitionKey
            ) ?? definitions.find(definition => definition.name === stored.name);
            return selected
                ? { definitionKey: selected.key, name: selected.name }
                : undefined;
        },
    };
    class TrackingRealWorkspaceHdlIndex extends RealWorkspaceHdlIndex {
        constructor(options: ConstructorParameters<typeof RealWorkspaceHdlIndex>[0]) {
            super(options);
            realIndexes.push(this);
        }
    }
    const coreStub = {
        DependencyAnalyzer: FakeDependencyAnalyzer,
        WorkspaceHdlIndex: useRealIndex
            ? TrackingRealWorkspaceHdlIndex
            : class extends FakeWorkspaceHdlIndex {
                constructor(options: IndexOptions) { super(options, hooks, events); }
            },
        SimulationRunner: class {},
        LogParser: class {},
        formatDuplicateSummary: () => ({ outputLines: [], statusText: '' }),
        listVerilogFiles: () => [],
        readText: () => '',
        preprocessVerilog: (value: string) => value,
        removeComments: (value: string) => value,
        createHdlParserClient: useRealIndex
            ? createHdlParserClient
            : () => new FakeParserClient(),
        HdlParserClient: useRealIndex ? HdlParserClient : FakeParserClient,
    };
    const dependencyStubs: Record<string, unknown> = {
        './config': configStub,
        './core': coreStub,
        './core/hdl/workspaceIndexStore': {
            WorkspaceIndexStore: useRealIndex ? MemoryWorkspaceIndexStore : class {},
        },
        './moduleTreeProvider': { ModuleTreeProvider: FakeModuleTreeProvider },
        './moduleInstantiationCommand': { showModuleInstantiationPicker: async () => undefined },
        './testbenchPanel': { TestbenchPanelProvider: FakeTestbenchPanelProvider },
        './waveformEditorProvider': {
            WaveformEditorProvider: class { static readonly viewType = 'veriflow.waveformEditor'; },
        },
        './archDesign/archDesignEditorProvider': {
            ArchDesignEditorProvider: class {
                static readonly viewType = 'veriflow.archDesignEditor';
                async validate(): Promise<void> {}
                async exportRtl(): Promise<void> {}
            },
        },
        './archDesign/archDesignTreeProvider': {
            ArchDesignTreeProvider: class {
                refresh(): void {}
                dispose(): void {}
            },
        },
        './output': {
            appendError(): void {}, appendInfo(): void {}, appendLine(): void {},
            appendSuccess(): void {}, appendWarning(): void {}, clear(): void {},
            dispose(): void {}, show(): void {},
        },
    };

    const moduleLoader = Module as typeof Module & {
        _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function loadWithStubs(
        request: string,
        parent: NodeModule | undefined,
        isMain: boolean
    ): unknown {
        if (request === 'vscode') {
            return vscodeStub;
        }
        if (Object.prototype.hasOwnProperty.call(dependencyStubs, request)) {
            return dependencyStubs[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    const extension = require('../extension') as {
        activate(contextValue: unknown): void;
        deactivate(): Promise<void>;
    };
    extension.activate(context);
    workspaceReady = true;
    moduleLoader._load = originalLoad;

    return {
        events,
        existingUris,
        files,
        settings,
        hooks,
        folder,
        analyze: () => commands.get('veriflow.analyze')!(),
        scan: () => commands.get('veriflow.scanModules')!(),
        setFile,
        setNextCommitGate(gate: ScanGate): void { nextCommitGate = gate; },
        failNextExactWatcher(filename: string, error: Error): void {
            nextExactWatcherFailure = { filename, error };
        },
        async fireWatchEvent(kind: WatchEventKind, uriValue: string): Promise<void> {
            const uri = FakeUri.parse(uriValue);
            const matching = watcherRecords.filter(record =>
                !record.disposed && watcherMatches(record, uri)
            );
            await Promise.all(matching.map(record =>
                Promise.resolve(record.listeners[kind]?.(uri))
            ));
            await new Promise<void>(resolve => setImmediate(resolve));
        },
        getScanResult: () => latestScanResult,
        getRealIndex: () => realIndexes.at(-1),
        async dispose(): Promise<void> {
            await extension.deactivate();
            delete require.cache[require.resolve('../extension')];
        },
    };
}

async function testDependencyPreparationIsSingleFlight(): Promise<void> {
    let releaseFirstUpdate!: () => void;
    let firstUpdateStarted!: () => void;
    const firstUpdate = new Promise<void>(resolve => { firstUpdateStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseFirstUpdate = resolve; });
    const harness = createExtensionHarness({
        async update(defines) {
            if (defines.A === true) {
                firstUpdateStarted();
                await release;
            }
        },
    });
    try {
        harness.settings.defines = { A: true };
        const first = harness.analyze();
        await firstUpdate;
        harness.settings.defines = { B: true };
        const second = harness.analyze();
        releaseFirstUpdate();
        await Promise.all([first, second]);

        assert.deepStrictEqual(
            harness.events.filter(event => /^(update|scan|resolve):/.test(event)),
            ['update:A', 'scan:A', 'resolve:A', 'update:B', 'scan:B', 'resolve:B']
        );
    } finally {
        await harness.dispose();
    }
}

async function testConcurrentMatchingPreparationIsShared(): Promise<void> {
    let releaseFirstScan!: () => void;
    let firstScanStarted!: () => void;
    const firstScan = new Promise<void>(resolve => { firstScanStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseFirstScan = resolve; });
    let scanCount = 0;
    const harness = createExtensionHarness({
        async scan() {
            scanCount++;
            if (scanCount === 1) {
                firstScanStarted();
                await release;
            }
        },
    });
    try {
        harness.settings.defines = { SAME: true };
        const first = harness.analyze();
        await firstScan;
        const second = harness.analyze();
        releaseFirstScan();
        await Promise.all([first, second]);

        assert.strictEqual(scanCount, 1);
        assert.strictEqual(
            harness.events.filter(event => event === 'resolve:SAME').length,
            2
        );

        await harness.analyze();
        assert.strictEqual(scanCount, 2);
        assert.strictEqual(
            harness.events.filter(event => event === 'resolve:SAME').length,
            3
        );
    } finally {
        await harness.dispose();
    }
}

async function testRejectedIndexLoadCanRetry(): Promise<void> {
    let loadNumber = 0;
    const harness = createExtensionHarness({
        load() {
            loadNumber++;
            if (loadNumber === 1) {
                throw new Error('load failed once');
            }
        },
    });
    try {
        await assert.rejects(harness.analyze(), /load failed once/);
        await harness.analyze();
        assert.strictEqual(FakeWorkspaceHdlIndex.instances.length, 2);
    } finally {
        await harness.dispose();
    }
}

async function testRootIdentityControlsIndexLifetime(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.settings.libDirs = ['/lib-a', '/lib-b'];
        await harness.analyze();
        const first = FakeWorkspaceHdlIndex.instances[0];

        harness.settings.libDirs = ['/lib-b', '/lib-a'];
        await harness.analyze();
        const second = FakeWorkspaceHdlIndex.instances[1];
        assert.strictEqual(FakeWorkspaceHdlIndex.instances.length, 2);
        assert.strictEqual(first.disposed, true);
        assert.notStrictEqual(
            first.options.parserFingerprint,
            second.options.parserFingerprint
        );

        harness.folder.uri = FakeUri.parse('file:///workspace-b');
        await harness.analyze();
        const third = FakeWorkspaceHdlIndex.instances[2];
        assert.strictEqual(FakeWorkspaceHdlIndex.instances.length, 3);
        assert.strictEqual(second.disposed, true);
        assert.notStrictEqual(
            second.options.parserFingerprint,
            third.options.parserFingerprint
        );

        harness.settings.libDirs = ['/lib-b'];
        await harness.analyze();
        assert.strictEqual(FakeWorkspaceHdlIndex.instances.length, 4);
        assert.strictEqual(third.disposed, true);
    } finally {
        await harness.dispose();
    }
}

async function testLibDirOrderControlsIncludePriority(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.settings.libDirs = ['z-lib', 'a-lib'];
        harness.existingUris.add('file:///workspace/z-lib/defs.svh');
        harness.existingUris.add('file:///workspace/a-lib/defs.svh');
        await harness.analyze();

        const resolved = await FakeWorkspaceHdlIndex.instances[0].options.resolveInclude(
            'file:///workspace/src/top.sv',
            'defs.svh'
        );
        assert.strictEqual(resolved, 'file:///workspace/z-lib/defs.svh');
        assert.deepStrictEqual(FakeWorkspaceHdlIndex.instances[0].scannedRoots[0], [
            'file:///workspace',
            'file:///workspace/z-lib',
            'file:///workspace/a-lib',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function testNonFileWorkspaceRootsPreserveUriIdentity(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.folder.uri = FakeUri.parse(
            'vscode-remote://ssh-remote+build/workspace/project'
        );
        harness.settings.libDirs = ['../shared'];
        await harness.analyze();

        assert.deepStrictEqual(FakeWorkspaceHdlIndex.instances[0].scannedRoots[0], [
            'vscode-remote://ssh-remote+build/workspace/project',
            'vscode-remote://ssh-remote+build/workspace/shared',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function testRemoteAbsoluteLibDirPreservesWorkspaceAuthority(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.folder.uri = FakeUri.parse('vscode-remote://ssh-host/workspace/project');
        harness.settings.libDirs = ['/opt/hdl'];
        await harness.analyze();

        assert.deepStrictEqual(FakeWorkspaceHdlIndex.instances[0].scannedRoots[0], [
            'vscode-remote://ssh-host/workspace/project',
            'vscode-remote://ssh-host/opt/hdl',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function testRemoteWindowsAbsoluteLibDirPreservesWorkspaceAuthority(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.folder.uri = FakeUri.parse('vscode-remote://ssh-win/C:/workspace/project');
        harness.settings.libDirs = ['C:\\sdk\\hdl'];
        await harness.analyze();

        assert.deepStrictEqual(FakeWorkspaceHdlIndex.instances[0].scannedRoots[0], [
            'vscode-remote://ssh-win/C:/workspace/project',
            'vscode-remote://ssh-win/C:/sdk/hdl',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function assertAbsoluteIncludeResolution(
    includePath: string,
    expectedUri: string
): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.existingUris.add(expectedUri);
        await harness.analyze();
        const resolved = await FakeWorkspaceHdlIndex.instances[0].options.resolveInclude(
            'file:///workspace/src/top.sv',
            includePath
        );
        assert.strictEqual(resolved, expectedUri);
    } finally {
        await harness.dispose();
    }
}

async function testWindowsAbsoluteInclude(): Promise<void> {
    await assertAbsoluteIncludeResolution(
        'C:\\sdk\\include\\defs.svh',
        'file:///C:/sdk/include/defs.svh'
    );
}

async function testLocalUncAbsoluteInclude(): Promise<void> {
    await assertAbsoluteIncludeResolution(
        '\\\\server\\share\\defs.svh',
        'file://server/share/defs.svh'
    );
}

async function testPosixAbsoluteInclude(): Promise<void> {
    await assertAbsoluteIncludeResolution(
        '/opt/sdk/include/defs.svh',
        'file:///opt/sdk/include/defs.svh'
    );
}

async function testAbsoluteUriInclude(): Promise<void> {
    await assertAbsoluteIncludeResolution(
        'vscode-remote://ssh-remote+build/sdk/defs.svh',
        'vscode-remote://ssh-remote+build/sdk/defs.svh'
    );
}

async function testRemotePosixAbsoluteInclude(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.folder.uri = FakeUri.parse('vscode-remote://ssh-host/workspace/project');
        harness.existingUris.add('vscode-remote://ssh-host/opt/defs.svh');
        await harness.analyze();
        const resolved = await FakeWorkspaceHdlIndex.instances[0].options.resolveInclude(
            'vscode-remote://ssh-host/workspace/project/src/top.sv',
            '/opt/defs.svh'
        );
        assert.strictEqual(resolved, 'vscode-remote://ssh-host/opt/defs.svh');
    } finally {
        await harness.dispose();
    }
}

async function testRemoteWindowsAbsoluteInclude(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.folder.uri = FakeUri.parse('vscode-remote://ssh-win/C:/workspace/project');
        harness.existingUris.add('vscode-remote://ssh-win/C:/sdk/include/defs.svh');
        await harness.analyze();
        const resolved = await FakeWorkspaceHdlIndex.instances[0].options.resolveInclude(
            'vscode-remote://ssh-win/C:/workspace/project/src/top.sv',
            'C:\\sdk\\include\\defs.svh'
        );
        assert.strictEqual(resolved, 'vscode-remote://ssh-win/C:/sdk/include/defs.svh');
    } finally {
        await harness.dispose();
    }
}

async function testRemoteUncAbsoluteInclude(): Promise<void> {
    const harness = createExtensionHarness();
    try {
        harness.folder.uri = FakeUri.parse('vscode-remote://ssh-win/C:/workspace/project');
        harness.existingUris.add('vscode-remote://ssh-win//server/share/defs.svh');
        await harness.analyze();
        const resolved = await FakeWorkspaceHdlIndex.instances[0].options.resolveInclude(
            'vscode-remote://ssh-win/C:/workspace/project/src/top.sv',
            '\\\\server\\share\\defs.svh'
        );
        assert.strictEqual(resolved, 'vscode-remote://ssh-win//server/share/defs.svh');
    } finally {
        await harness.dispose();
    }
}

async function testProvisionalIncludeWatchersCoverInitialScanWindow(): Promise<void> {
    const topUri = 'file:///workspace/top.sv';
    const localIncludeUri = 'file:///workspace/ports.inc';
    const externalCandidateUri = 'file:///external/includes/future.inc';
    const harness = createExtensionHarness({}, true);
    const commitGate = createScanGate();
    try {
        harness.settings.libDirs = ['/external/includes'];
        harness.setFile(topUri, [
            'module top(',
            '`include "ports.inc"',
            ');',
            'endmodule',
            '`include "future.inc"',
        ].join('\n'));
        harness.setFile(localIncludeUri, 'input logic old_port');
        harness.setNextCommitGate(commitGate);

        const scan = harness.scan();
        await commitGate.started;
        assert.ok(harness.events.includes(`read:${localIncludeUri}:1`));

        harness.setFile(localIncludeUri, 'input logic new_port');
        harness.setFile(externalCandidateUri, '`define FUTURE_INCLUDE 1');
        const localChange = harness.fireWatchEvent('change', localIncludeUri);
        const externalCreate = harness.fireWatchEvent('create', externalCandidateUri);
        await new Promise<void>(resolve => setImmediate(resolve));

        commitGate.allow();
        await Promise.all([scan, localChange, externalCreate]);

        const top = harness.getRealIndex()?.findDefinitions('top', 'module').at(0);
        assert.deepStrictEqual(top?.ports.map(port => port.name), ['new_port']);
        assert.ok(harness.events.includes(`read:${localIncludeUri}:2`));
        assert.ok(harness.events.includes(`read:${externalCandidateUri}:1`));
        assert.deepStrictEqual(
            harness.getRealIndex()?.getDependentsOfInclude(externalCandidateUri),
            [topUri]
        );
    } finally {
        commitGate.allow();
        await harness.dispose();
    }
}

async function testProvisionalResolvedExternalWatcherAdmitsPreCommitChange(): Promise<void> {
    const topUri = 'file:///workspace/top.sv';
    const externalIncludeUri = 'file:///outside/ports.inc';
    const harness = createExtensionHarness({}, true);
    const commitGate = createScanGate();
    try {
        harness.setFile(topUri, [
            'module top(',
            `\`include "${externalIncludeUri}"`,
            ');',
            'endmodule',
        ].join('\n'));
        harness.setFile(externalIncludeUri, 'input logic old_external_port');
        harness.setNextCommitGate(commitGate);

        const scan = harness.scan();
        await commitGate.started;
        assert.ok(harness.events.includes(`read:${externalIncludeUri}:1`));

        harness.setFile(externalIncludeUri, 'input logic new_external_port');
        const externalChange = harness.fireWatchEvent('change', externalIncludeUri);
        await new Promise<void>(resolve => setImmediate(resolve));
        commitGate.allow();
        await Promise.all([scan, externalChange]);

        const top = harness.getRealIndex()?.findDefinitions('top', 'module').at(0);
        assert.deepStrictEqual(
            top?.ports.map(port => port.name),
            ['new_external_port']
        );
        assert.ok(harness.events.includes(`read:${externalIncludeUri}:2`));
    } finally {
        commitGate.allow();
        await harness.dispose();
    }
}

async function testProvisionalWatcherFailureDisposesCandidateAndRetries(): Promise<void> {
    const topUri = 'file:///workspace/top.sv';
    const localIncludeUri = 'file:///workspace/ports.inc';
    const harness = createExtensionHarness({}, true);
    try {
        harness.setFile(topUri, [
            'module top(',
            '`include "ports.inc"',
            ');',
            'endmodule',
        ].join('\n'));
        harness.setFile(localIncludeUri, 'input logic recovered_port');
        harness.failNextExactWatcher(
            'ports.inc',
            new Error('provisional watcher construction failed')
        );

        await assert.rejects(
            harness.scan(),
            /provisional watcher construction failed/
        );
        assert.ok(!harness.events.includes('stage-index'));
        const failedIndex = harness.getRealIndex()!;
        assert.strictEqual(harness.getScanResult(), null);
        await assert.rejects(
            failedIndex.scan(['file:///workspace']),
            /disposed/
        );

        await harness.scan();
        assert.notStrictEqual(harness.getRealIndex(), failedIndex);
        const top = harness.getRealIndex()?.findDefinitions('top', 'module').at(0);
        assert.deepStrictEqual(top?.ports.map(port => port.name), ['recovered_port']);
    } finally {
        await harness.dispose();
    }
}

async function testAbsoluteIncludeReviewCases(): Promise<void> {
    const tests: Array<[string, () => Promise<void>]> = [
        ['Windows absolute include', testWindowsAbsoluteInclude],
        ['local UNC absolute include', testLocalUncAbsoluteInclude],
        ['POSIX absolute include', testPosixAbsoluteInclude],
        ['absolute URI include', testAbsoluteUriInclude],
        ['remote POSIX absolute include', testRemotePosixAbsoluteInclude],
        ['remote Windows absolute include', testRemoteWindowsAbsoluteInclude],
        ['remote UNC absolute include', testRemoteUncAbsoluteInclude],
    ];
    const failures: string[] = [];
    for (const [name, test] of tests) {
        try {
            await test();
        } catch (error) {
            failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (failures.length > 0) {
        assert.fail(failures.join('\n'));
    }
}

async function main(): Promise<void> {
    await testRejectedIndexLoadCanRetry();
    await testProvisionalWatcherFailureDisposesCandidateAndRetries();
    await testProvisionalResolvedExternalWatcherAdmitsPreCommitChange();
    await testProvisionalIncludeWatchersCoverInitialScanWindow();
    await testDependencyPreparationIsSingleFlight();
    await testConcurrentMatchingPreparationIsShared();
    await testLibDirOrderControlsIncludePriority();
    await testRootIdentityControlsIndexLifetime();
    await testNonFileWorkspaceRootsPreserveUriIdentity();
    await testRemoteAbsoluteLibDirPreservesWorkspaceAuthority();
    await testRemoteWindowsAbsoluteLibDirPreservesWorkspaceAuthority();
    await testAbsoluteIncludeReviewCases();
    console.log('extension dependency index tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
