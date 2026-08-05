import * as assert from 'assert';
import Module = require('module');
import * as path from 'path';

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
    settings: Settings;
    hooks: IndexHooks;
    folder: { uri: FakeUri };
    analyze(): Promise<void>;
    dispose(): Promise<void>;
};

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

function createExtensionHarness(hooks: IndexHooks = {}): ExtensionHarness {
    const events: string[] = [];
    const existingUris = new Set<string>();
    const settings = defaultSettings();
    const folder = { uri: FakeUri.parse('file:///workspace') };
    const commands = new Map<string, () => Promise<void>>();
    const disposable = { dispose(): void {} };
    const workspaceState = new Map<string, unknown>();
    const context = {
        extensionPath: path.join('D:', 'Extensions', 'VeriFlow'),
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
        constructor(private readonly index: FakeWorkspaceHdlIndex) {}

        resolve(top: string) {
            events.push(`resolve:${Object.keys(this.index.currentDefines).sort().join('+')}`);
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
        setScanResult(): void {}
        setAnalyzeResult(result: unknown): void { this.analyzeResult = result; }
        getWorkspaceModuleNames(): string[] { return ['top']; }
    }

    class FakeTestbenchPanelProvider {
        static readonly viewType = 'veriflow.testbench';
        setBeforeGenerate(): void {}
        setOnVisible(): void {}
        setModuleMap(): void {}
    }

    FakeWorkspaceHdlIndex.instances = [];
    const vscodeStub = {
        Uri: FakeUri,
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
                async readDirectory(): Promise<[string, number][]> { return []; },
                async readFile(): Promise<Uint8Array> { return new Uint8Array(); },
                async stat(uri: FakeUri): Promise<{ type: number; mtime: number; size: number }> {
                    if (existingUris.has(uri.toString())) {
                        return { type: 1, mtime: 1, size: 1 };
                    }
                    throw new Error(`not found: ${uri.toString()}`);
                },
            },
            onDidChangeConfiguration: () => disposable,
            onDidChangeWorkspaceFolders: () => disposable,
            createFileSystemWatcher: () => ({
                ...disposable,
                onDidChange(): void {},
                onDidCreate(): void {},
                onDidDelete(): void {},
            }),
        },
    };
    const configStub = {
        getWorkspaceRoot: () => folder.uri.fsPath,
        getTopModule: () => 'top',
        setTopModule: async () => undefined,
        getSettings: () => ({ ...settings, libDirs: [...settings.libDirs], defines: { ...settings.defines } }),
        getAnalyzeStatus: () => 'idle',
        setAnalyzeStatus: async () => undefined,
        getSimulateStatus: () => 'idle',
        setSimulateStatus: async () => undefined,
        getDependencyResult: () => null,
        setDependencyResult: async () => undefined,
    };
    const coreStub = {
        DependencyAnalyzer: FakeDependencyAnalyzer,
        WorkspaceHdlIndex: class extends FakeWorkspaceHdlIndex {
            constructor(options: IndexOptions) { super(options, hooks, events); }
        },
        SimulationRunner: class {},
        LogParser: class {},
        MODULE_DECL_RE: /module\s+([A-Za-z_$][\w$]*)/g,
        listVerilogFiles: () => [],
        readText: () => '',
        preprocessVerilog: (value: string) => value,
        removeComments: (value: string) => value,
        createHdlParserClient: () => new FakeParserClient(),
        HdlParserClient: FakeParserClient,
    };
    const dependencyStubs: Record<string, unknown> = {
        './config': configStub,
        './core': coreStub,
        './core/hdl/workspaceIndexStore': { WorkspaceIndexStore: class {} },
        './moduleTreeProvider': { ModuleTreeProvider: FakeModuleTreeProvider },
        './moduleInstantiationCommand': { showModuleInstantiationPicker: async () => undefined },
        './testbenchPanel': { TestbenchPanelProvider: FakeTestbenchPanelProvider },
        './waveformEditorProvider': {
            WaveformEditorProvider: class { static readonly viewType = 'veriflow.waveformEditor'; },
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
    moduleLoader._load = originalLoad;

    return {
        events,
        existingUris,
        settings,
        hooks,
        folder,
        analyze: () => commands.get('veriflow.analyze')!(),
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
