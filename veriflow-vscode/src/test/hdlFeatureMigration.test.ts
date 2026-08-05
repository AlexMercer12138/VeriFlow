import * as assert from 'assert';
import * as fs from 'fs';
import Module = require('module');
import * as path from 'path';

type Definition = {
    key: string;
    kind: 'module';
    name: string;
    uri: string;
    declarationStart: number;
    declarationLine: number;
    parameters: unknown[];
    ports: unknown[];
    dependencies: string[];
    modelFingerprint: string;
};

type ModuleDefinitionEntry = {
    key: string;
    name: string;
    uri: string;
    filepath: string;
    line: number;
    workspace: boolean;
};

type TopModuleSelection = { definitionKey: string; name: string };

const extensionRoot = path.resolve(__dirname, '..', '..');

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1000);
            }),
        ]);
    } finally {
        if (timer) { clearTimeout(timer); }
    }
}

function withModuleStubs<T>(
    stubs: Record<string, unknown>,
    load: () => T
): T {
    const moduleLoader = Module as typeof Module & {
        _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function loadWithStubs(
        request: string,
        parent: NodeModule | undefined,
        isMain: boolean
    ): unknown {
        if (Object.prototype.hasOwnProperty.call(stubs, request)) {
            return stubs[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return load();
    } finally {
        moduleLoader._load = originalLoad;
    }
}

function testExtensionNoLongerContainsLegacyModuleScanner(): void {
    const source = fs.readFileSync(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
    assert.ok(source.includes('new WorkspaceHdlIndex'));
    assert.ok(!source.includes('MODULE_DECL_RE'));
    assert.ok(!source.includes('_scanModulesInternal'));
}

function testDuplicateSummaryIsMergedAndHasNoPopup(): void {
    const runtime = require('../core/types') as {
        formatDuplicateSummary?: (
            groups: Array<{ name: string; definitions: Definition[] }>
        ) => {
            outputLines: string[];
            statusText: string;
            popupMessage: string | undefined;
        };
    };
    assert.strictEqual(typeof runtime.formatDuplicateSummary, 'function');

    const a: Definition = {
        key: 'module:file:///workspace/a/alu.sv:0',
        kind: 'module',
        name: 'alu',
        uri: 'file:///workspace/a/alu.sv',
        declarationStart: 0,
        declarationLine: 1,
        parameters: [],
        ports: [],
        dependencies: [],
        modelFingerprint: 'a',
    };
    const b: Definition = {
        ...a,
        key: 'module:file:///workspace/b/alu.sv:40',
        uri: 'file:///workspace/b/alu.sv',
        declarationStart: 40,
        declarationLine: 3,
        modelFingerprint: 'b',
    };
    const summary = runtime.formatDuplicateSummary!([
        { name: 'alu', definitions: [a, b] },
    ]);

    assert.ok(summary.outputLines.some(line => line.includes('alu') && line.includes(a.uri)));
    assert.ok(summary.outputLines.some(line => line.includes('alu') && line.includes(b.uri)));
    assert.strictEqual(summary.statusText, '$(warning) VeriFlow: 1 duplicate module name');
    assert.strictEqual(summary.popupMessage, undefined);
}

function testModuleTreeKeepsEveryExactDefinition(): void {
    class FakeUri {
        private constructor(readonly value: string, readonly fsPath: string) {}
        static parse(value: string): FakeUri {
            const parsed = new URL(value);
            const filepath = decodeURIComponent(parsed.pathname)
                .replace(/^\/([A-Za-z]:\/)/, '$1')
                .replace(/\//g, path.sep);
            return new FakeUri(value, filepath);
        }
        static file(filepath: string): FakeUri {
            const normalized = filepath.replace(/\\/g, '/');
            const uriPath = /^[A-Za-z]:\//.test(normalized)
                ? `/${normalized}`
                : normalized.startsWith('/') ? normalized : `/${normalized}`;
            return new FakeUri(`file://${uriPath}`, filepath);
        }
        toString(): string { return this.value; }
    }
    class FakeTreeItem {
        description?: string;
        tooltip?: string;
        command?: unknown;
        iconPath?: unknown;
        contextValue?: string;
        resourceUri?: unknown;
        constructor(readonly label: string, readonly collapsibleState: number) {}
    }
    const vscodeStub = {
        TreeItem: FakeTreeItem,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class { constructor(readonly id: string, readonly color?: unknown) {} },
        ThemeColor: class { constructor(readonly id: string) {} },
        Uri: FakeUri,
        EventEmitter: class {
            readonly event = (): void => {};
            fire(): void {}
        },
    };
    delete require.cache[require.resolve('../moduleTreeProvider')];
    const { ModuleTreeProvider } = withModuleStubs(
        { vscode: vscodeStub },
        () => require('../moduleTreeProvider') as {
            ModuleTreeProvider: new () => {
                setScanResult(result: unknown): void;
                setAnalyzeResult(result: unknown): void;
                getChildren(element?: unknown): unknown[];
            };
        }
    );

    const root = path.join('C:', 'workspace');
    const definitions: ModuleDefinitionEntry[] = [
        {
            key: 'module:file:///C:/workspace/rtl/alu.sv:0',
            name: 'alu',
            uri: 'file:///C:/workspace/rtl/alu.sv',
            filepath: path.join(root, 'rtl', 'alu.sv'),
            line: 1,
            workspace: true,
        },
        {
            key: 'module:file:///C:/workspace/ip/alu.sv:0',
            name: 'alu',
            uri: 'file:///C:/workspace/ip/alu.sv',
            filepath: path.join(root, 'ip', 'alu.sv'),
            line: 1,
            workspace: true,
        },
    ];
    const provider = new ModuleTreeProvider();
    provider.setScanResult({
        root,
        libDirs: [],
        totalModules: 1,
        modules: ['alu'],
        workspaceModules: ['alu'],
        definitions,
        duplicates: { alu: definitions.map(definition => definition.uri) },
        modulesByDir: { [root]: ['alu'] },
        moduleFiles: { alu: definitions[0].filepath },
    });

    const roots = provider.getChildren();
    const allModules = roots.find(item => String((item as { label: unknown }).label).startsWith('All Modules')) as {
        children: unknown[];
    };
    const visit = (items: unknown[]): Array<Record<string, unknown>> => items.flatMap(item => {
        const value = item as Record<string, unknown> & { children?: unknown[] };
        return [value, ...visit(value.children ?? [])];
    });
    const moduleItems = visit(allModules.children)
        .filter(item => item.itemType === 'libModule');

    assert.strictEqual(moduleItems.length, 2);
    assert.deepStrictEqual(
        moduleItems.map(item => item.description).sort(),
        [path.join('ip', 'alu.sv'), path.join('rtl', 'alu.sv')]
    );
    assert.deepStrictEqual(
        moduleItems.map(item => item.fileUri).sort(),
        definitions.map(definition => definition.uri).sort()
    );

    const dependencyLocations = {
        remote: 'vscode-remote://ssh-host/workspace/rtl/remote.sv',
        windows: 'C:\\rtl\\windows.sv',
        posix: '/opt/rtl/posix.sv',
    };
    provider.setAnalyzeResult({
        topModule: 'remote',
        topDefinitionKey: 'module:remote',
        files: Object.values(dependencyLocations),
        missingModules: [],
        ambiguousModules: {},
        moduleMap: dependencyLocations,
        depGraph: {
            remote: ['windows', 'posix'],
            windows: [],
            posix: [],
        },
    });
    const dependencyItems = visit(provider.getChildren())
        .filter(item => item.itemType === 'depBranch' || item.itemType === 'depModule');
    const commandUri = (moduleName: string): string => {
        const item = dependencyItems.find(candidate => candidate.moduleName === moduleName);
        const command = item?.command as { arguments?: FakeUri[] } | undefined;
        return command?.arguments?.[0]?.toString() ?? '';
    };
    assert.strictEqual(commandUri('remote'), dependencyLocations.remote);
    assert.strictEqual(commandUri('windows'), 'file:///C:/rtl/windows.sv');
    assert.strictEqual(commandUri('posix'), 'file:///opt/rtl/posix.sv');
}

async function testTopSelectionUsesExactIdentityAndMigratesLegacyNames(): Promise<void> {
    const values = new Map<string, unknown>();
    const vscodeStub = { workspace: {} };
    delete require.cache[require.resolve('../config')];
    const config = withModuleStubs(
        { vscode: vscodeStub },
        () => require('../config') as {
            getTopModule(context: unknown): TopModuleSelection | undefined;
            setTopModule(context: unknown, selection: TopModuleSelection | undefined): Promise<void>;
            resolveTopModuleSelection?(
                stored: TopModuleSelection | undefined,
                definitions: ModuleDefinitionEntry[]
            ): TopModuleSelection | undefined;
        }
    );
    const context = {
        workspaceState: {
            get<T>(key: string, fallback?: T): T | undefined {
                return values.has(key) ? values.get(key) as T : fallback;
            },
            async update(key: string, value: unknown): Promise<void> {
                values.set(key, value);
            },
        },
    };
    values.set('veriflow.topModule', 'alu');
    const legacy = config.getTopModule(context);
    assert.deepStrictEqual(legacy, { definitionKey: '', name: 'alu' });
    assert.strictEqual(typeof config.resolveTopModuleSelection, 'function');

    const definitions: ModuleDefinitionEntry[] = [
        {
            key: 'module:file:///workspace/rtl/alu.sv:0',
            name: 'alu',
            uri: 'file:///workspace/rtl/alu.sv',
            filepath: '/workspace/rtl/alu.sv',
            line: 1,
            workspace: true,
        },
    ];
    const migrated = config.resolveTopModuleSelection!(legacy, definitions);
    assert.deepStrictEqual(migrated, {
        definitionKey: definitions[0].key,
        name: 'alu',
    });
    await config.setTopModule(context, migrated);
    assert.deepStrictEqual(values.get('veriflow.topModule'), migrated);

    assert.strictEqual(
        config.resolveTopModuleSelection!(legacy, [
            definitions[0],
            { ...definitions[0], key: 'module:file:///workspace/ip/alu.sv:0' },
        ]),
        undefined
    );
}

class FakeUri {
    private constructor(
        readonly scheme: string,
        readonly authority: string,
        readonly path: string
    ) {}
    static parse(value: string): FakeUri {
        const parsed = new URL(value);
        return new FakeUri(parsed.protocol.slice(0, -1), parsed.host, decodeURIComponent(parsed.pathname));
    }
    static file(filepath: string): FakeUri {
        let normalized = filepath.replace(/\\/g, '/');
        if (!normalized.startsWith('/')) { normalized = `/${normalized}`; }
        return new FakeUri('file', '', path.posix.normalize(normalized));
    }
    static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
        return new FakeUri(base.scheme, base.authority, path.posix.normalize(path.posix.join(base.path, ...segments)));
    }
    with(change: { path?: string }): FakeUri {
        return new FakeUri(this.scheme, this.authority, change.path ?? this.path);
    }
    get fsPath(): string {
        return this.scheme === 'file' && /^\/[A-Za-z]:\//.test(this.path)
            ? this.path.slice(1).replace(/\//g, '\\')
            : this.path;
    }
    toString(): string { return `${this.scheme}://${this.authority}${this.path}`; }
}

class FakeRelativePattern {
    constructor(readonly baseUri: FakeUri, readonly pattern: string) {}
}

async function testScanWatcherAndConfigUseOneExactIndex(): Promise<void> {
    const workspaceRootUri = 'file:///D:/Software/VeriFlow';
    const indexedWorkspaceRootUri = process.platform === 'win32'
        ? 'file:///d:/software/veriflow'
        : workspaceRootUri;
    const workspaceDefinition: Definition = {
        key: `module:${indexedWorkspaceRootUri}/rtl/alu.sv:0`,
        kind: 'module',
        name: 'alu',
        uri: `${indexedWorkspaceRootUri}/rtl/alu.sv`,
        declarationStart: 0,
        declarationLine: 1,
        parameters: [], ports: [], dependencies: [], modelFingerprint: 'workspace',
    };
    const libraryDefinition: Definition = {
        ...workspaceDefinition,
        key: 'module:file:///A-library/alu.sv:0',
        uri: 'file:///A-library/alu.sv',
        modelFingerprint: 'library',
    };
    const secondWorkspaceDefinition: Definition = {
        ...workspaceDefinition,
        key: `module:${indexedWorkspaceRootUri}/ip/alu.sv:0`,
        uri: `${indexedWorkspaceRootUri}/ip/alu.sv`,
        modelFingerprint: 'workspace-ip',
    };
    const topDefinition: Definition = {
        ...workspaceDefinition,
        key: `module:${indexedWorkspaceRootUri}/top.sv:0`,
        name: 'top',
        uri: `${indexedWorkspaceRootUri}/top.sv`,
        modelFingerprint: 'top',
    };
    const prototypeNamedDefinition: Definition = {
        ...workspaceDefinition,
        key: `module:${indexedWorkspaceRootUri}/prototype_named.sv:0`,
        name: '__proto__',
        uri: `${indexedWorkspaceRootUri}/prototype_named.sv`,
        modelFingerprint: 'prototype-named',
    };
    const unconfiguredWorkspaceUri = 'file:///B-workspace/mixed.sv';
    const unconfiguredWorkspaceDefinitions: Definition[] = [{
        ...workspaceDefinition,
        key: `module:${unconfiguredWorkspaceUri}:0`,
        name: 'rogue',
        uri: unconfiguredWorkspaceUri,
        modelFingerprint: 'rogue',
    }, {
        ...topDefinition,
        key: `module:${unconfiguredWorkspaceUri}:40`,
        uri: unconfiguredWorkspaceUri,
        declarationStart: 40,
        declarationLine: 3,
        modelFingerprint: 'rogue-top',
    }];
    const indexedExternalIncludeUri = 'file:///external/generated/defs.svh';
    const metacharExternalIncludeUri = 'file:///external/generated/defs[0].svh';
    const externalNonstandardIncludeUri = 'file:///external/generated/defs.inc';
    const localNonstandardIncludeUri = `${workspaceRootUri}/generated/local.inc`;
    const conditionalNonstandardIncludeUri = 'file:///external/generated/conditional.inc';
    const rogueNonstandardIncludeUri = 'file:///external/generated/rogue.inc';
    const unresolvedExternalIncludeUri = 'file:///B-workspace/shared/defs.svh';
    const racingUnresolvedIncludeUri = 'file:///B-workspace/shared/racing.svh';
    const rogueExternalUri = 'file:///B-workspace/rogue.sv';
    const definitions = [
        workspaceDefinition,
        secondWorkspaceDefinition,
        libraryDefinition,
        topDefinition,
        prototypeNamedDefinition,
    ];
    const events: string[] = [];
    const warnings: string[] = [];
    const popupWarnings: string[] = [];
    const resolvedDefinitionKeys: string[] = [];
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const scanGates = new Map<string, {
        started: Promise<void>;
        markStarted(): void;
        release: Promise<void>;
        allow(): void;
    }>();
    const failedScanRoots = new Set<string>();
    const failedScanDefines = new Set<string>();
    const createScanGate = () => {
        let markStarted!: () => void;
        let allow!: () => void;
        return {
            started: new Promise<void>(resolve => { markStarted = resolve; }),
            markStarted,
            release: new Promise<void>(resolve => { allow = resolve; }),
            allow,
        };
    };
    let nextResolveGate: ReturnType<typeof createScanGate> | undefined;
    let nextScanGate: ReturnType<typeof createScanGate> | undefined;
    let nextRunnerGate: ReturnType<typeof createScanGate> | undefined;
    let nextQuickPickGate: ReturnType<typeof createScanGate> | undefined;
    const queuedQuickPickGates: Array<ReturnType<typeof createScanGate>> = [];
    let nextOpenDialogGate: ReturnType<typeof createScanGate> | undefined;
    let nextUnresolvedProbeGate: ReturnType<typeof createScanGate> | undefined;
    let pendingWatcherConstructionError: {
        remainingSuccessfulConstructions: number;
        remainingFailures?: number;
        error: Error;
    } | undefined;
    let nextTopPersistenceGate: ReturnType<typeof createScanGate> | undefined;
    let nextTopPersistenceError: Error | undefined;
    let nextDependencyPersistenceGate: ReturnType<typeof createScanGate> | undefined;
    let nextDependencyPersistenceError: Error | undefined;
    let nextDependencyResultTag: string | undefined;
    let deferredQuickPickSelection: {
        label: string;
        description?: string;
        definitionKey?: string;
        name?: string;
    } | undefined;
    let deferredOpenDialogSelection: FakeUri[] | undefined;
    let runnerCalls = 0;
    type WatchEventKind = 'change' | 'create' | 'delete';
    type WatcherRecord = {
        pattern: string | FakeRelativePattern;
        disposed: boolean;
        listeners: Partial<Record<WatchEventKind, (uri: FakeUri) => unknown>>;
        dispose(): void;
    };
    const watcherRecords: WatcherRecord[] = [];
    let configListener: ((event: { affectsConfiguration(section: string): boolean }) => unknown) | undefined;
    let workspaceFoldersListener: (() => unknown) | undefined;
    let lastScanResult: {
        definitions: ModuleDefinitionEntry[];
        moduleFiles: Record<string, string>;
        libDirs?: string[];
    } | undefined;
    let testbenchModuleMap: Record<string, string> = {};
    let persistedDependencyResult: unknown = null;
    let presentedAnalyzeResult: unknown = null;
    let presentedTop: TopModuleSelection | undefined;
    let analyzeStatus = 'idle';
    let simulateStatus = 'idle';
    let outputClearCount = 0;
    let outputShowCount = 0;
    let treeWriteCount = 0;
    let statusWriteCount = 0;
    let parserCreateCalls = 0;
    let workspaceSourceRevision = 1;
    const executedCommands: Array<{ name: string; args: unknown[] }> = [];
    const presentedLibDirs: string[][] = [];
    let quickPickItems: Array<{ label: string; description?: string }> = [];
    let quickPickCallCount = 0;
    let statusText = '';
    let derivedDefinesKey = '';
    let presentedDefinesKey = '';
    const status = {
        get text(): string { return statusText; },
        set text(value: string) { statusText = value; statusWriteCount++; },
        tooltip: '', command: '', show(): void {}, dispose(): void {},
    };
    const disposable = { dispose(): void {} };
    const folder = { uri: FakeUri.parse(workspaceRootUri) };
    const workspaceFolders = [folder, { uri: FakeUri.parse('file:///B-workspace') }];
    const normalizedWatchPath = (value: string): string => process.platform === 'win32'
        ? value.toLowerCase()
        : value;
    const isWithinBase = (uri: FakeUri, base: FakeUri): boolean => {
        if (uri.scheme !== base.scheme || uri.authority !== base.authority) {
            return false;
        }
        const uriPath = normalizedWatchPath(path.posix.normalize(uri.path));
        const basePath = normalizedWatchPath(path.posix.normalize(base.path));
        return uriPath === basePath || uriPath.startsWith(
            basePath.endsWith('/') ? basePath : `${basePath}/`
        );
    };
    const watcherMatches = (record: WatcherRecord, uri: FakeUri): boolean => {
        if (typeof record.pattern === 'string') {
            return workspaceFolders.some(workspaceFolder =>
                isWithinBase(uri, workspaceFolder.uri)
            ) && ['.v', '.sv', '.vh', '.svh'].includes(
                path.posix.extname(uri.path).toLowerCase()
            );
        }
        const { baseUri, pattern: watchPattern } = record.pattern;
        if (!isWithinBase(uri, baseUri)) {
            return false;
        }
        const basePath = normalizedWatchPath(path.posix.normalize(baseUri.path));
        const uriPath = normalizedWatchPath(path.posix.normalize(uri.path));
        const relative = uriPath === basePath
            ? ''
            : uriPath.slice((basePath.endsWith('/') ? basePath : `${basePath}/`).length);
        if (watchPattern === '**/*.{v,sv,vh,svh}') {
            return ['.v', '.sv', '.vh', '.svh'].includes(
                path.posix.extname(relative).toLowerCase()
            );
        }
        const literalPattern = watchPattern
            .replace(/\[\[]/g, '[')
            .replace(/\[\]\]/g, ']')
            .replace(/\[([*?{}])\]/g, '$1');
        return relative === normalizedWatchPath(literalPattern);
    };
    const fireWatcherRecord = async (
        record: WatcherRecord,
        kind: WatchEventKind,
        uri: FakeUri
    ): Promise<void> => {
        await Promise.resolve(record.listeners[kind]?.(uri));
        await new Promise<void>(resolve => setImmediate(resolve));
    };
    const fireHdlWatchEvent = async (
        kind: WatchEventKind,
        uriValue: string
    ): Promise<void> => {
        const uri = FakeUri.parse(uriValue);
        const matching = watcherRecords.filter(record =>
            !record.disposed && watcherMatches(record, uri)
        );
        await Promise.all(matching.map(record => fireWatcherRecord(record, kind, uri)));
        await new Promise<void>(resolve => setImmediate(resolve));
    };
    const settings = {
        libDirs: ['/A-library'], defines: {} as Record<string, string | boolean>,
        simulator: 'iverilog', waveViewer: 'builtin', simulatorCompileCmd: '',
        simulatorRunCmd: '', waveViewerCmd: '', waveFileTemplate: '{top_module}.vcd',
        testbenchOutputDir: '.',
    };
    let storedTop: TopModuleSelection | undefined = { definitionKey: '', name: 'top' };

    class FakeIndex {
        static instances: FakeIndex[] = [];
        readonly scannedRoots: string[][] = [];
        readonly definitions = [...definitions];
        readonly indexedUris = new Set([
            ...definitions.map(definition => definition.uri),
            indexedExternalIncludeUri,
            metacharExternalIncludeUri,
        ]);
        disposed = false;
        workspaceIndexedRevision = 0;
        currentDefinesKey = '';
        constructor(readonly options: unknown) { FakeIndex.instances.push(this); }
        async load(): Promise<void> { events.push('load'); }
        async updateConfiguration(defines: Record<string, string | true>): Promise<void> {
            this.currentDefinesKey = Object.keys(defines).sort().join('+');
            events.push(`update:${this.currentDefinesKey}`);
        }
        async scan(roots: string[]): Promise<void> {
            this.scannedRoots.push([...roots]);
            events.push('scan');
            const workspaceRevisionAtRead = workspaceSourceRevision;
            const gate = nextScanGate ?? roots.map(root => scanGates.get(root)).find(Boolean);
            nextScanGate = undefined;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
            if (failedScanRoots.has(JSON.stringify(roots))) {
                throw new Error(`scan failed: ${JSON.stringify(roots)}`);
            }
            if (failedScanDefines.has(this.currentDefinesKey)) {
                throw new Error(`scan failed for defines: ${this.currentDefinesKey}`);
            }
            this.workspaceIndexedRevision = workspaceRevisionAtRead;
            events.push(`scan-commit:${workspaceRevisionAtRead}`);
        }
        async refreshUri(uri: string): Promise<void> {
            events.push(`refresh:${uri}`);
            events.push(`refresh-defines:${this.currentDefinesKey}:${uri}`);
            this.indexedUris.add(uri);
            if (uri === workspaceDefinition.uri) {
                this.workspaceIndexedRevision = workspaceSourceRevision;
                events.push(`refresh-revision:${workspaceSourceRevision}`);
            }
            if (uri === unresolvedExternalIncludeUri) {
                events.push(`refresh-owner:${topDefinition.uri}`);
            }
            if ([
                externalNonstandardIncludeUri,
                localNonstandardIncludeUri,
                conditionalNonstandardIncludeUri,
            ].includes(uri)) {
                events.push(`refresh-owner:${topDefinition.uri}`);
            }
            if (uri === unconfiguredWorkspaceUri) {
                this.definitions.push(...unconfiguredWorkspaceDefinitions);
            }
            if (uri === topDefinition.uri
                && !this.definitions.some(definition => definition.key === topDefinition.key)) {
                this.definitions.push(topDefinition);
            }
        }
        async removeUri(uri: string): Promise<void> {
            events.push(`remove:${uri}`);
            if ([externalNonstandardIncludeUri, localNonstandardIncludeUri].includes(uri)) {
                events.push(`remove-owner:${topDefinition.uri}`);
            }
            this.indexedUris.delete(uri);
            const retained = this.definitions.filter(definition => definition.uri !== uri);
            this.definitions.splice(0, this.definitions.length, ...retained);
        }
        getFile(uri: string): object | undefined {
            return this.indexedUris.has(uri) ? {} : undefined;
        }
        getDependentsOfInclude(uri: string): string[] {
            const isConditionalInclude = uri === conditionalNonstandardIncludeUri
                && this.currentDefinesKey === 'WATCHER_CONSTRUCTION_FAILURE';
            return [externalNonstandardIncludeUri, localNonstandardIncludeUri].includes(uri)
                || isConditionalInclude
                ? [topDefinition.uri]
                : [];
        }
        async canResolveUnresolvedInclude(uri: string): Promise<boolean> {
            events.push(`probe-unresolved:${this.currentDefinesKey}:${uri}`);
            const gate = nextUnresolvedProbeGate;
            nextUnresolvedProbeGate = undefined;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
            return uri === unresolvedExternalIncludeUri
                || uri === racingUnresolvedIncludeUri;
        }
        getWatchPlan(): {
            resolvedExternalIncludeUris: string[];
            unresolvedExternalCandidateUris: string[];
        } {
            const conditionalIncludeUris = this.currentDefinesKey
                === 'WATCHER_CONSTRUCTION_FAILURE'
                ? [conditionalNonstandardIncludeUri]
                : [];
            return {
                resolvedExternalIncludeUris: [
                    indexedExternalIncludeUri,
                    metacharExternalIncludeUri,
                    externalNonstandardIncludeUri,
                    localNonstandardIncludeUri,
                    ...conditionalIncludeUris,
                ],
                unresolvedExternalCandidateUris: [
                    unresolvedExternalIncludeUri,
                    racingUnresolvedIncludeUri,
                ],
            };
        }
        getAllDefinitions(kind?: string): Definition[] {
            derivedDefinesKey = this.currentDefinesKey;
            return kind && kind !== 'module' ? [] : [...this.definitions].sort((left, right) =>
                left.name.localeCompare(right.name)
                || left.uri.localeCompare(right.uri)
                || left.declarationStart - right.declarationStart
            );
        }
        getDuplicateGroups(): Array<{ name: string; definitions: Definition[] }> {
            const byName = new Map<string, Definition[]>();
            for (const definition of this.getAllDefinitions('module')) {
                const matches = byName.get(definition.name) ?? [];
                matches.push(definition);
                byName.set(definition.name, matches);
            }
            return [...byName.entries()]
                .filter(([, matches]) => matches.length > 1)
                .map(([name, matches]) => ({ name, definitions: matches }));
        }
        getDefinition(key: string): Definition | undefined {
            return this.definitions.find(definition => definition.key === key);
        }
        findDefinitions(name: string): Definition[] {
            return this.definitions.filter(definition => definition.name === name);
        }
        dispose(): void { this.disposed = true; events.push('dispose-index'); }
    }
    class FakeTreeProvider {
        private _topModule: TopModuleSelection | undefined;
        analyzeResult: unknown = null;
        get topModule(): TopModuleSelection | undefined { return this._topModule; }
        set topModule(selection: TopModuleSelection | undefined) {
            this._topModule = selection;
            presentedTop = selection;
            treeWriteCount++;
        }
        setScanResult(result: {
            definitions: ModuleDefinitionEntry[];
            moduleFiles: Record<string, string>;
            libDirs?: string[];
        } | null): void {
            treeWriteCount++;
            lastScanResult = result ?? undefined;
            if (result) {
                presentedDefinesKey = derivedDefinesKey;
                presentedLibDirs.push([...(result.libDirs ?? [])]);
            }
        }
        setAnalyzeResult(result: unknown): void {
            treeWriteCount++;
            this.analyzeResult = result;
            presentedAnalyzeResult = result;
        }
        getWorkspaceDefinitions(): ModuleDefinitionEntry[] {
            return lastScanResult?.definitions.filter(definition => definition.workspace) ?? [];
        }
    }
    class FakeTestbenchPanel {
        static readonly viewType = 'veriflow.testbench';
        setBeforeGenerate(): void {}
        setOnVisible(): void {}
        setModuleMap(moduleMap: Record<string, string>): void {
            testbenchModuleMap = { ...moduleMap };
        }
    }
    class FakeDependencyAnalyzer {
        constructor(readonly index: FakeIndex) {}
        async resolve(definitionKey: string) {
            resolvedDefinitionKeys.push(definitionKey);
            const resultTag = nextDependencyResultTag;
            nextDependencyResultTag = undefined;
            const gate = nextResolveGate;
            nextResolveGate = undefined;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
            return {
                topModule: 'top',
                topDefinitionKey: definitionKey,
                files: resultTag ? [resultTag] : [],
                missingModules: [],
                ambiguousModules: {},
                moduleMap: {},
                depGraph: {},
            };
        }
    }
    const vscodeStub = {
        Uri: FakeUri,
        RelativePattern: FakeRelativePattern,
        FileType: { File: 1, Directory: 2 },
        StatusBarAlignment: { Left: 1 },
        window: {
            createTreeView: () => ({ ...disposable, onDidChangeVisibility(): void {} }),
            registerWebviewViewProvider: () => disposable,
            registerCustomEditorProvider: () => disposable,
            createStatusBarItem: () => status,
            onDidChangeWindowState: () => disposable,
            showWarningMessage: async (message: string) => { popupWarnings.push(message); },
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showOpenDialog: async () => {
                const gate = nextOpenDialogGate;
                nextOpenDialogGate = undefined;
                if (!gate) {
                    return undefined;
                }
                gate.markStarted();
                await gate.release;
                return deferredOpenDialogSelection;
            },
            showQuickPick: async (items: Array<{ label: string; description?: string }>) => {
                quickPickCallCount++;
                quickPickItems = items;
                let gate = queuedQuickPickGates.shift();
                if (!gate) {
                    gate = nextQuickPickGate;
                    nextQuickPickGate = undefined;
                }
                if (!gate) {
                    return undefined;
                }
                gate.markStarted();
                await gate.release;
                return deferredQuickPickSelection;
            },
        },
        commands: {
            registerCommand(name: string, command: (...args: unknown[]) => unknown) {
                commands.set(name, command);
                return disposable;
            },
            async executeCommand(name: string, ...args: unknown[]): Promise<void> {
                executedCommands.push({ name, args });
            },
        },
        workspace: {
            workspaceFolders,
            fs: {
                async readDirectory(): Promise<[string, number][]> { return []; },
                async readFile(): Promise<Uint8Array> { return new Uint8Array(); },
                async stat(): Promise<{ type: number; mtime: number; size: number }> {
                    return { type: 1, mtime: 1, size: 1 };
                },
            },
            onDidChangeConfiguration(listener: typeof configListener) {
                configListener = listener;
                return disposable;
            },
            onDidChangeWorkspaceFolders(listener: typeof workspaceFoldersListener) {
                workspaceFoldersListener = listener;
                return disposable;
            },
            createFileSystemWatcher(pattern: string | FakeRelativePattern) {
                const pendingError = pendingWatcherConstructionError;
                if (pendingError) {
                    if (pendingError.remainingSuccessfulConstructions === 0) {
                        if (pendingError.remainingFailures === undefined
                            || pendingError.remainingFailures <= 1) {
                            pendingWatcherConstructionError = undefined;
                        } else {
                            pendingError.remainingFailures--;
                        }
                        throw pendingError.error;
                    }
                    pendingError.remainingSuccessfulConstructions--;
                }
                const record: WatcherRecord = {
                    pattern,
                    disposed: false,
                    listeners: {},
                    dispose(): void { this.disposed = true; },
                };
                watcherRecords.push(record);
                return {
                    dispose(): void { record.dispose(); },
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
        getWorkspaceRoot: () => workspaceFolders[0]?.uri.fsPath,
        getTopModule: () => storedTop,
        setTopModule: async (_context: unknown, selection: TopModuleSelection | undefined) => {
            const gate = nextTopPersistenceGate;
            nextTopPersistenceGate = undefined;
            const error = nextTopPersistenceError;
            nextTopPersistenceError = undefined;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
            if (error) {
                throw error;
            }
            storedTop = selection;
        },
        resolveTopModuleSelection: (
            stored: TopModuleSelection | undefined,
            entries: ModuleDefinitionEntry[]
        ): TopModuleSelection | undefined => {
            if (!stored) { return undefined; }
            if (stored.definitionKey) {
                return entries.some(entry => entry.workspace && entry.key === stored.definitionKey)
                    ? stored : undefined;
            }
            const matches = entries.filter(entry => entry.workspace && entry.name === stored.name);
            return matches.length === 1
                ? { definitionKey: matches[0].key, name: matches[0].name }
                : undefined;
        },
        getSettings: () => ({ ...settings, libDirs: [...settings.libDirs], defines: { ...settings.defines } }),
        getAnalyzeStatus: () => analyzeStatus,
        setAnalyzeStatus: async (_context: unknown, value: string) => { analyzeStatus = value; },
        getSimulateStatus: () => simulateStatus,
        setSimulateStatus: async (_context: unknown, value: string) => { simulateStatus = value; },
        getDependencyResult: () => persistedDependencyResult,
        setDependencyResult: async (_context: unknown, result: unknown) => {
            const gate = nextDependencyPersistenceGate;
            nextDependencyPersistenceGate = undefined;
            const error = nextDependencyPersistenceError;
            nextDependencyPersistenceError = undefined;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
            if (error) {
                throw error;
            }
            persistedDependencyResult = result;
        },
    };
    const coreStub = {
        DependencyAnalyzer: FakeDependencyAnalyzer,
        WorkspaceHdlIndex: FakeIndex,
        SimulationRunner: class {
            compileAndRun() {
                runnerCalls++;
                const result = {
                    success: true,
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    elapsedTime: 0.01,
                    logEntries: [],
                };
                const gate = nextRunnerGate;
                nextRunnerGate = undefined;
                if (!gate) {
                    return result;
                }
                gate.markStarted();
                return gate.release.then(() => result);
            }
        }, LogParser: class {},
        MODULE_DECL_RE: /module\s+([A-Za-z_$][\w$]*)/g,
        listVerilogFiles: () => [], readText: () => '',
        preprocessVerilog: (value: string) => value, removeComments: (value: string) => value,
        createHdlParserClient: () => {
            parserCreateCalls++;
            return { clearCache(): void {}, async dispose(): Promise<void> {} };
        },
        formatDuplicateSummary: (groups: Array<{ name: string; definitions: Definition[] }>) => ({
            outputLines: groups.flatMap(group => group.definitions.map(
                definition => `  ${group.name}: ${definition.uri}:${definition.declarationLine}`
            )),
            statusText: `$(warning) VeriFlow: ${groups.length} duplicate module name`,
            popupMessage: undefined,
        }),
    };
    const stubs: Record<string, unknown> = {
        vscode: vscodeStub,
        './config': configStub,
        './core': coreStub,
        './core/hdl/workspaceIndexStore': { WorkspaceIndexStore: class {} },
        './moduleTreeProvider': { ModuleTreeProvider: FakeTreeProvider },
        './moduleInstantiationCommand': { showModuleInstantiationPicker: async () => undefined },
        './testbenchPanel': { TestbenchPanelProvider: FakeTestbenchPanel },
        './waveformEditorProvider': {
            WaveformEditorProvider: class { static readonly viewType = 'veriflow.waveformEditor'; },
        },
        './output': {
            appendError(): void {}, appendInfo(): void {}, appendLine(): void {}, appendSuccess(): void {},
            appendWarning(message: string): void { warnings.push(message); },
            clear(): void { outputClearCount++; }, dispose(): void {},
            show(): void { outputShowCount++; },
        },
        fs: {
            existsSync(): boolean { return true; },
            readFileSync(): Buffer { return Buffer.from(''); },
        },
    };
    delete require.cache[require.resolve('../extension')];
    const extension = withModuleStubs(stubs, () => require('../extension') as {
        activate(context: unknown): void;
        deactivate(): Promise<void>;
    });
    const context = {
        extensionPath: path.join('D:', 'Extensions', 'VeriFlow'),
        subscriptions: [] as unknown[],
        workspaceState: { get: () => undefined, update: async () => undefined },
    };
    let extensionDeactivated = false;
    try {
        extension.activate(context);
        pendingWatcherConstructionError = {
            remainingSuccessfulConstructions: 0,
            error: new Error('initial index watcher construction failed'),
        };
        await assert.rejects(
            withTimeout(
                Promise.resolve(commands.get('veriflow.scanModules')!()),
                'failed initial index watcher construction'
            ),
            /initial index watcher construction failed/
        );
        const failedInitialIndex = FakeIndex.instances.at(-1)!;
        assert.strictEqual(failedInitialIndex.disposed, true);
        FakeIndex.instances.splice(0);

        const initialScanGate = createScanGate();
        nextScanGate = initialScanGate;
        const initialScan = Promise.resolve(commands.get('veriflow.scanModules')!());
        await withTimeout(initialScanGate.started, 'initial scan watcher window');
        const initialIndex = FakeIndex.instances.at(-1)!;
        workspaceSourceRevision++;
        const initialWindowRefresh = fireHdlWatchEvent(
            'change',
            workspaceDefinition.uri
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        initialScanGate.allow();
        await withTimeout(
            Promise.all([initialScan, initialWindowRefresh]),
            'initial module scan with watcher refresh'
        );

        assert.strictEqual(FakeIndex.instances.length, 1);
        assert.strictEqual(initialIndex.workspaceIndexedRevision, workspaceSourceRevision);
        assert.ok(
            events.indexOf('scan-commit:1')
            < events.indexOf(`refresh-revision:${workspaceSourceRevision}`)
        );
        assert.strictEqual(lastScanResult?.definitions.length, 5);
        assert.ok(lastScanResult?.definitions.find(
            definition => definition.key === topDefinition.key
        )?.workspace);
        const expectedWorkspaceAlu = FakeUri.parse(secondWorkspaceDefinition.uri).fsPath;
        assert.strictEqual(lastScanResult?.moduleFiles.alu, expectedWorkspaceAlu);
        assert.strictEqual(testbenchModuleMap.alu, expectedWorkspaceAlu);
        assert.ok(Object.prototype.hasOwnProperty.call(
            lastScanResult?.moduleFiles,
            '__proto__'
        ));
        assert.deepStrictEqual(storedTop, { definitionKey: topDefinition.key, name: 'top' });
        const activePatterns = watcherRecords
            .filter(record => !record.disposed)
            .map(record => record.pattern);
        assert.ok(activePatterns.length >= 4);
        assert.ok(activePatterns.every(patternValue => patternValue instanceof FakeRelativePattern));
        assert.ok(activePatterns.some(patternValue =>
            patternValue instanceof FakeRelativePattern
            && patternValue.baseUri.toString() === workspaceRootUri
            && patternValue.pattern === '**/*.{v,sv,vh,svh}'
        ));
        assert.ok(activePatterns.some(patternValue =>
            patternValue instanceof FakeRelativePattern
            && patternValue.baseUri.toString() === 'file:///A-library'
            && patternValue.pattern === '**/*.{v,sv,vh,svh}'
        ));
        assert.ok(activePatterns.some(patternValue =>
            patternValue instanceof FakeRelativePattern
            && patternValue.baseUri.toString() === 'file:///external/generated'
            && patternValue.pattern === 'defs[[]0[]].svh'
        ));
        assert.ok(activePatterns.some(patternValue =>
            patternValue instanceof FakeRelativePattern
            && patternValue.baseUri.toString() === 'file:///external/generated'
            && patternValue.pattern === 'defs.inc'
        ));
        assert.ok(activePatterns.some(patternValue =>
            patternValue instanceof FakeRelativePattern
            && patternValue.baseUri.toString() === `${workspaceRootUri}/generated`
            && patternValue.pattern === 'local.inc'
        ));
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes(workspaceDefinition.uri));
        assert.ok(warnings[0].includes(libraryDefinition.uri));
        assert.strictEqual(status.text, '$(warning) VeriFlow: 1 duplicate module name');
        assert.deepStrictEqual(popupWarnings, []);

        const warningsBeforeForeignEvents = warnings.length;
        await withTimeout(
            fireHdlWatchEvent('change', unconfiguredWorkspaceUri),
            'unconfigured workspace change'
        );
        await withTimeout(
            fireHdlWatchEvent('delete', unconfiguredWorkspaceUri),
            'unconfigured workspace delete'
        );
        assert.ok(!events.includes(`refresh:${unconfiguredWorkspaceUri}`));
        assert.ok(!events.includes(`remove:${unconfiguredWorkspaceUri}`));
        assert.ok(!lastScanResult?.definitions.some(
            definition => definition.uri === unconfiguredWorkspaceUri
        ));
        assert.ok(!Object.prototype.hasOwnProperty.call(testbenchModuleMap, 'rogue'));
        assert.strictEqual(warnings.length, warningsBeforeForeignEvents);

        await withTimeout(
            fireHdlWatchEvent('create', unresolvedExternalIncludeUri),
            'unresolved external include creation'
        );
        const probesBeforeRogueExternal = events.filter(event =>
            event.startsWith('probe-unresolved:')
        ).length;
        await withTimeout(
            fireHdlWatchEvent('create', rogueExternalUri),
            'unrelated external HDL creation'
        );
        assert.ok(events.some(event =>
            event.endsWith(`:${unresolvedExternalIncludeUri}`)
            && event.startsWith('probe-unresolved:')
        ));
        assert.ok(events.includes(`refresh:${unresolvedExternalIncludeUri}`));
        assert.ok(events.includes(`refresh-owner:${topDefinition.uri}`));
        assert.strictEqual(
            events.filter(event => event.startsWith('probe-unresolved:')).length,
            probesBeforeRogueExternal
        );
        assert.ok(!events.includes(`refresh:${rogueExternalUri}`));

        settings.defines = { PROBE_A: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'unresolved probe defines A scan');
        const staleProbeGate = createScanGate();
        nextUnresolvedProbeGate = staleProbeGate;
        const staleProbeEvent = fireHdlWatchEvent('create', racingUnresolvedIncludeUri);
        await withTimeout(staleProbeGate.started, 'stale unresolved include probe');

        settings.defines = { PROBE_B: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'unresolved probe defines B scan');
        assert.strictEqual(FakeIndex.instances.at(-1)?.currentDefinesKey, 'PROBE_B');
        staleProbeGate.allow();
        await withTimeout(staleProbeEvent, 'stale unresolved include probe recovery');
        const racingRefreshes = events.filter(event =>
            event.startsWith('refresh-defines:')
            && event.endsWith(`:${racingUnresolvedIncludeUri}`)
        );
        assert.strictEqual(racingRefreshes.at(-1),
            `refresh-defines:PROBE_B:${racingUnresolvedIncludeUri}`);
        assert.strictEqual(FakeIndex.instances.at(-1)?.currentDefinesKey, 'PROBE_B');
        assert.strictEqual(presentedDefinesKey, 'PROBE_B');

        await withTimeout(
            fireHdlWatchEvent('change', indexedExternalIncludeUri),
            'indexed external include change'
        );
        assert.ok(events.includes(`refresh:${indexedExternalIncludeUri}`));
        await withTimeout(
            fireHdlWatchEvent('change', metacharExternalIncludeUri),
            'metacharacter external include change'
        );
        assert.ok(events.includes(`refresh:${metacharExternalIncludeUri}`));
        await withTimeout(
            fireHdlWatchEvent('change', externalNonstandardIncludeUri),
            'external nonstandard include change'
        );
        await withTimeout(
            fireHdlWatchEvent('change', localNonstandardIncludeUri),
            'local nonstandard include change'
        );
        assert.ok(events.includes(`refresh:${externalNonstandardIncludeUri}`));
        assert.ok(events.includes(`refresh:${localNonstandardIncludeUri}`));
        assert.ok(events.filter(event => event === `refresh-owner:${topDefinition.uri}`).length >= 2);
        await withTimeout(
            fireHdlWatchEvent('delete', externalNonstandardIncludeUri),
            'external nonstandard include delete'
        );
        assert.ok(events.includes(`remove:${externalNonstandardIncludeUri}`));
        assert.ok(events.includes(`remove-owner:${topDefinition.uri}`));
        const rogueNonstandardEventsBefore = events.length;
        await withTimeout(
            fireHdlWatchEvent('change', rogueNonstandardIncludeUri),
            'rogue nonstandard include change'
        );
        assert.deepStrictEqual(events.slice(rogueNonstandardEventsBefore), []);
        await withTimeout(
            fireHdlWatchEvent('delete', indexedExternalIncludeUri),
            'indexed external include delete'
        );
        assert.ok(events.includes(`remove:${indexedExternalIncludeUri}`));

        await withTimeout(
            Promise.resolve(commands.get('veriflow.selectTop')!()),
            'top module picker'
        );
        const aluItems = quickPickItems.filter(item => item.label === 'alu');
        assert.deepStrictEqual(
            aluItems.map(item => item.description).sort(),
            [path.join('ip', 'alu.sv'), path.join('rtl', 'alu.sv')]
        );
        await withTimeout(
            Promise.resolve(commands.get('veriflow.analyze')!()),
            'dependency analysis'
        );
        assert.deepStrictEqual(resolvedDefinitionKeys, [topDefinition.key]);
        await withTimeout(
            Promise.resolve(commands.get('veriflow.simulate')!()),
            'completed simulation before config change'
        );
        assert.strictEqual(analyzeStatus, 'completed');
        assert.strictEqual(simulateStatus, 'completed');

        const resolvesBeforeConfigOpen = resolvedDefinitionKeys.length;
        settings.defines = { CONFIG_CHANGED: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'completed-state defines change');
        assert.strictEqual(analyzeStatus, 'outdated');
        assert.strictEqual(simulateStatus, 'outdated');
        assert.strictEqual(persistedDependencyResult, null);
        assert.strictEqual(presentedAnalyzeResult, null);

        await withTimeout(
            Promise.resolve(commands.get('veriflow.openWave')!()),
            'open wave after defines change'
        );
        assert.ok(resolvedDefinitionKeys.length > resolvesBeforeConfigOpen);
        assert.ok(executedCommands.some(command => command.name === 'vscode.openWith'));

        await withTimeout(
            fireHdlWatchEvent('change', workspaceDefinition.uri),
            'changed URI refresh'
        );
        await withTimeout(
            fireHdlWatchEvent('create', `${indexedWorkspaceRootUri}/new.sv`),
            'created URI refresh'
        );
        await withTimeout(
            fireHdlWatchEvent('delete', libraryDefinition.uri),
            'deleted URI removal'
        );
        assert.ok(events.includes(`refresh:${workspaceDefinition.uri}`));
        assert.ok(events.includes(`refresh:${indexedWorkspaceRootUri}/new.sv`));
        assert.ok(events.includes(`remove:${libraryDefinition.uri}`));

        const scansBeforeConfig = events.filter(event => event === 'scan').length;
        settings.defines = { FEATURE: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'defines rescan');
        assert.ok(events.filter(event => event === 'scan').length > scansBeforeConfig);
        assert.strictEqual(FakeIndex.instances.length, 1);

        const previousIndex = FakeIndex.instances[0];
        const oldLibraryWatcher = watcherRecords.find(record =>
            !record.disposed
            && record.pattern instanceof FakeRelativePattern
            && record.pattern.baseUri.toString() === 'file:///A-library'
        );
        assert.ok(oldLibraryWatcher);
        settings.libDirs = ['/other-library'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'library roots rescan');
        assert.strictEqual(FakeIndex.instances.length, 2);
        assert.strictEqual(previousIndex.disposed, true);
        assert.deepStrictEqual(FakeIndex.instances[1].scannedRoots.at(-1), [
            workspaceRootUri,
            'file:///other-library',
        ]);
        assert.strictEqual(oldLibraryWatcher.disposed, true);
        const staleWatcherRefreshesBefore = events.filter(event =>
            event === `refresh:${libraryDefinition.uri}`
        ).length;
        await fireWatcherRecord(
            oldLibraryWatcher,
            'change',
            FakeUri.parse(libraryDefinition.uri)
        );
        assert.strictEqual(
            events.filter(event => event === `refresh:${libraryDefinition.uri}`).length,
            staleWatcherRefreshesBefore
        );

        pendingWatcherConstructionError = {
            remainingSuccessfulConstructions: 0,
            remainingFailures: 3,
            error: new Error('persistent watcher construction failure'),
        };
        settings.libDirs = ['/persistent-failure'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'persistent watcher construction failure recovery');
        const invalidatedScanResult = lastScanResult;
        assert.strictEqual(invalidatedScanResult, undefined);
        assert.deepStrictEqual(testbenchModuleMap, {});
        assert.strictEqual(FakeIndex.instances.at(-1)?.disposed, true);

        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan after persistent watcher construction failure'
        );
        assert.deepStrictEqual(lastScanResult?.libDirs, ['/persistent-failure']);
        assert.strictEqual(FakeIndex.instances.at(-1)?.disposed, false);

        settings.libDirs = ['/overlap', '/overlap/nested'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'overlapping library roots rescan');
        const overlappingRootUri = 'file:///overlap/nested/deduplicated.sv';
        const overlappingRefreshesBefore = events.filter(event =>
            event === `refresh:${overlappingRootUri}`
        ).length;
        await withTimeout(
            fireHdlWatchEvent('create', overlappingRootUri),
            'overlapping watcher event'
        );
        assert.strictEqual(
            events.filter(event => event === `refresh:${overlappingRootUri}`).length,
            overlappingRefreshesBefore + 1
        );
        const overlappingChangesBefore = events.filter(event =>
            event === `refresh:${overlappingRootUri}`
        ).length;
        await withTimeout(
            fireHdlWatchEvent('change', overlappingRootUri),
            'duplicate overlapping watcher change'
        );
        assert.strictEqual(
            events.filter(event => event === `refresh:${overlappingRootUri}`).length,
            overlappingChangesBefore + 1
        );

        const deleteThenCreateUri = 'file:///overlap/atomic-replacement.sv';
        const deleteThenCreateStart = events.length;
        await withTimeout(
            Promise.all([
                fireHdlWatchEvent('delete', deleteThenCreateUri),
                fireHdlWatchEvent('create', deleteThenCreateUri),
            ]),
            'delete then create watcher batch'
        );
        assert.deepStrictEqual(
            events.slice(deleteThenCreateStart).filter(event =>
                event === `refresh:${deleteThenCreateUri}`
                || event === `remove:${deleteThenCreateUri}`
            ),
            [`refresh:${deleteThenCreateUri}`]
        );

        const createThenDeleteUri = 'file:///overlap/removed-after-create.sv';
        const createThenDeleteStart = events.length;
        await withTimeout(
            Promise.all([
                fireHdlWatchEvent('create', createThenDeleteUri),
                fireHdlWatchEvent('delete', createThenDeleteUri),
            ]),
            'create then delete watcher batch'
        );
        assert.deepStrictEqual(
            events.slice(createThenDeleteStart).filter(event =>
                event === `refresh:${createThenDeleteUri}`
                || event === `remove:${createThenDeleteUri}`
            ),
            [`remove:${createThenDeleteUri}`]
        );

        const batchUriA = 'file:///overlap/batch-a.sv';
        const batchUriB = 'file:///overlap/batch-b.sv';
        await withTimeout(
            Promise.all([
                fireHdlWatchEvent('create', batchUriA),
                fireHdlWatchEvent('create', batchUriB),
            ]),
            'distinct watcher event batch'
        );
        assert.strictEqual(
            events.filter(event => event === `refresh:${batchUriA}`).length,
            1
        );
        assert.strictEqual(
            events.filter(event => event === `refresh:${batchUriB}`).length,
            1
        );

        const presentationsBeforeRace = presentedLibDirs.length;
        const staleGate = createScanGate();
        scanGates.set('file:///stale-library', staleGate);
        settings.libDirs = ['/stale-library'];
        const staleScan = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        await withTimeout(staleGate.started, 'stale scan');

        const latestGate = createScanGate();
        scanGates.set('file:///latest-library', latestGate);
        settings.libDirs = ['/latest-library'];
        const latestScan = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        staleGate.allow();
        await withTimeout(latestGate.started, 'latest scan');
        assert.strictEqual(presentedLibDirs.length, presentationsBeforeRace);

        latestGate.allow();
        await withTimeout(Promise.all([staleScan, latestScan]), 'concurrent rescans');
        assert.deepStrictEqual(presentedLibDirs.at(-1), ['/latest-library']);

        const forcedPreparationGate = createScanGate();
        scanGates.set('file:///latest-library', forcedPreparationGate);
        const instancesBeforeForcedPreparation = FakeIndex.instances.length;
        const disposedPreparationIndex = FakeIndex.instances.at(-1)!;
        const forcedPreparationScan = Promise.resolve(commands.get('veriflow.scanModules')!());
        await withTimeout(forcedPreparationGate.started, 'preparation before workspace change');
        workspaceFolders.push({ uri: FakeUri.parse('file:///secondary-workspace') });
        const forcedWorkspaceRescan = Promise.resolve(workspaceFoldersListener!());
        forcedPreparationGate.allow();
        await withTimeout(
            Promise.all([forcedPreparationScan, forcedWorkspaceRescan]),
            'forced workspace preparation replacement'
        );
        assert.strictEqual(disposedPreparationIndex.disposed, true);
        assert.ok(FakeIndex.instances.length > instancesBeforeForcedPreparation);
        assert.deepStrictEqual(FakeIndex.instances.at(-1)?.scannedRoots.at(-1), [
            workspaceRootUri,
            'file:///latest-library',
        ]);
        assert.deepStrictEqual(lastScanResult?.libDirs, ['/latest-library']);

        storedTop = { definitionKey: '', name: 'top' };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'top migration before delayed picker root change'
        );
        const rootPickerGate = createScanGate();
        nextQuickPickGate = rootPickerGate;
        const delayedRootPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(rootPickerGate.started, 'delayed picker before root change');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === 'top');
        settings.libDirs = ['/picker-root'];
        const pickerRootChange = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        rootPickerGate.allow();
        await withTimeout(
            Promise.all([delayedRootPicker, pickerRootChange]),
            'delayed picker root invalidation'
        );
        assert.strictEqual(storedTop, undefined);

        settings.libDirs = ['/latest-library'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'picker root recovery');
        storedTop = { definitionKey: '', name: 'top' };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'top migration before delayed picker deletion'
        );
        const deletionPickerGate = createScanGate();
        nextQuickPickGate = deletionPickerGate;
        const delayedDeletionPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(deletionPickerGate.started, 'delayed picker before definition deletion');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === 'top');
        await withTimeout(
            fireHdlWatchEvent('delete', topDefinition.uri),
            'selected definition deletion'
        );
        deletionPickerGate.allow();
        await withTimeout(delayedDeletionPicker, 'delayed picker deletion invalidation');
        assert.strictEqual(storedTop, undefined);

        storedTop = { definitionKey: '', name: 'top' };
        await withTimeout(
            fireHdlWatchEvent('create', topDefinition.uri),
            'selected definition restoration'
        );

        storedTop = { definitionKey: topDefinition.key, name: topDefinition.name };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before same-root top persistence'
        );
        const sameRootTopPickerGate = createScanGate();
        const sameRootTopPersistenceGate = createScanGate();
        nextQuickPickGate = sameRootTopPickerGate;
        nextTopPersistenceGate = sameRootTopPersistenceGate;
        const sameRootTopPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(sameRootTopPickerGate.started, 'same-root top picker');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        sameRootTopPickerGate.allow();
        await withTimeout(sameRootTopPersistenceGate.started, 'same-root top persistence');
        await withTimeout(
            fireHdlWatchEvent('change', workspaceDefinition.uri),
            'same-root refresh during top persistence'
        );
        sameRootTopPersistenceGate.allow();
        await withTimeout(sameRootTopPicker, 'same-root persisted top selection');
        const sameRootTopSelection = {
            definitionKey: prototypeNamedDefinition.key,
            name: prototypeNamedDefinition.name,
        };
        assert.deepStrictEqual(storedTop, sameRootTopSelection);
        assert.deepStrictEqual(presentedTop, sameRootTopSelection);

        const deletedTopPickerGate = createScanGate();
        const deletedTopPersistenceGate = createScanGate();
        nextQuickPickGate = deletedTopPickerGate;
        nextTopPersistenceGate = deletedTopPersistenceGate;
        const deletedTopPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(deletedTopPickerGate.started, 'top picker before selected delete');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === 'top');
        deletedTopPickerGate.allow();
        await withTimeout(deletedTopPersistenceGate.started, 'top persistence before selected delete');
        const selectedTopDelete = Promise.resolve(
            fireHdlWatchEvent('delete', topDefinition.uri)
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        deletedTopPersistenceGate.allow();
        await withTimeout(
            Promise.all([deletedTopPicker, selectedTopDelete]),
            'deleted persisted top selection'
        );
        assert.strictEqual(storedTop, undefined);
        assert.strictEqual(presentedTop, undefined);
        await withTimeout(
            fireHdlWatchEvent('create', topDefinition.uri),
            'restore top after persisted selection delete'
        );

        storedTop = { definitionKey: topDefinition.key, name: topDefinition.name };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before out-of-order top persistence'
        );
        const staleTopPickerGate = createScanGate();
        const staleTopPersistenceGate = createScanGate();
        nextQuickPickGate = staleTopPickerGate;
        nextTopPersistenceGate = staleTopPersistenceGate;
        const staleTopPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(staleTopPickerGate.started, 'stale top picker');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === 'top');
        staleTopPickerGate.allow();
        await withTimeout(staleTopPersistenceGate.started, 'stale top persistence');

        settings.libDirs = ['/top-persistence-root'];
        const topPersistenceRootChange = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        await withTimeout(topPersistenceRootChange, 'top persistence root change');

        const latestTopPickerGate = createScanGate();
        nextQuickPickGate = latestTopPickerGate;
        const latestTopPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(latestTopPickerGate.started, 'latest top picker');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        latestTopPickerGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        staleTopPersistenceGate.allow();
        await withTimeout(
            Promise.all([staleTopPicker, latestTopPicker]),
            'out-of-order top persistence'
        );
        const latestTopSelection = {
            definitionKey: prototypeNamedDefinition.key,
            name: prototypeNamedDefinition.name,
        };
        assert.deepStrictEqual(storedTop, latestTopSelection);
        assert.deepStrictEqual(presentedTop, latestTopSelection);

        const clearingTopPickerGate = createScanGate();
        const clearingTopPersistenceGate = createScanGate();
        nextQuickPickGate = clearingTopPickerGate;
        nextTopPersistenceGate = clearingTopPersistenceGate;
        const clearingTopPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(clearingTopPickerGate.started, 'top picker before persistence clear');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === 'top');
        clearingTopPickerGate.allow();
        await withTimeout(clearingTopPersistenceGate.started, 'top persistence before clear');

        settings.libDirs = ['/top-persistence-clear'];
        const clearingTopRootChange = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        await withTimeout(clearingTopRootChange, 'top persistence clear root change');
        assert.strictEqual(presentedTop, undefined);

        const replacementRootCancelGate = createScanGate();
        nextQuickPickGate = replacementRootCancelGate;
        const replacementRootCanceledPicker = Promise.resolve(
            commands.get('veriflow.selectTop')!()
        );
        await withTimeout(
            replacementRootCancelGate.started,
            'replacement-root picker during old selection persistence'
        );
        deferredQuickPickSelection = undefined;
        replacementRootCancelGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        clearingTopPersistenceGate.allow();
        await withTimeout(
            Promise.all([clearingTopPicker, replacementRootCanceledPicker]),
            'top persistence clear with replacement-root cancellation'
        );
        assert.strictEqual(storedTop, undefined);
        assert.strictEqual(presentedTop, undefined);

        settings.libDirs = ['/latest-library'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'top persistence recovery');

        const maintenanceClearBaseline = {
            definitionKey: topDefinition.key,
            name: topDefinition.name,
        };
        storedTop = maintenanceClearBaseline;
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before pending maintenance top clear'
        );
        assert.deepStrictEqual(presentedTop, maintenanceClearBaseline);
        const maintenanceTopClearGate = createScanGate();
        nextTopPersistenceGate = maintenanceTopClearGate;
        settings.libDirs = ['/maintenance-top-clear'];
        const maintenanceTopRootChange = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        await withTimeout(maintenanceTopClearGate.started, 'pending maintenance top clear');
        await withTimeout(maintenanceTopRootChange, 'maintenance top root replacement');
        assert.strictEqual(presentedTop, undefined);

        const maintenanceCancelPickerGate = createScanGate();
        nextQuickPickGate = maintenanceCancelPickerGate;
        const maintenanceCanceledPicker = Promise.resolve(
            commands.get('veriflow.selectTop')!()
        );
        await withTimeout(
            maintenanceCancelPickerGate.started,
            'cancel picker during maintenance top clear'
        );
        deferredQuickPickSelection = undefined;
        maintenanceCancelPickerGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));
        maintenanceTopClearGate.allow();
        await withTimeout(maintenanceCanceledPicker, 'maintenance top clear cancellation');
        assert.strictEqual(storedTop, undefined);
        assert.strictEqual(presentedTop, undefined);

        settings.libDirs = ['/latest-library'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'maintenance top clear recovery');

        storedTop = { definitionKey: topDefinition.key, name: topDefinition.name };
        const invocationScanGate = createScanGate();
        scanGates.set('file:///latest-library', invocationScanGate);
        const invocationNewPickerGate = createScanGate();
        queuedQuickPickGates.push(invocationNewPickerGate);
        const quickPicksBeforeInvocationOrder = quickPickCallCount;
        const invocationOldPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(invocationScanGate.started, 'shared invocation-order scan');

        const invocationNewPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        invocationScanGate.allow();
        await withTimeout(invocationNewPickerGate.started, 'invocation-new top picker');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(quickPickCallCount - quickPicksBeforeInvocationOrder, 1);
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        invocationNewPickerGate.allow();
        await withTimeout(invocationNewPicker, 'invocation-new top selection');
        await withTimeout(invocationOldPicker, 'invocation-old top completion');
        assert.deepStrictEqual(storedTop, sameRootTopSelection);
        assert.deepStrictEqual(presentedTop, sameRootTopSelection);

        const cancellationScanGate = createScanGate();
        scanGates.set('file:///latest-library', cancellationScanGate);
        const cancellingNewPickerGate = createScanGate();
        queuedQuickPickGates.push(cancellingNewPickerGate);
        const quickPicksBeforeCancellation = quickPickCallCount;
        const cancelledOldPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(cancellationScanGate.started, 'shared cancellation scan');

        const cancellingNewPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        cancellationScanGate.allow();
        await withTimeout(cancellingNewPickerGate.started, 'newer cancelling top picker');
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(quickPickCallCount - quickPicksBeforeCancellation, 1);
        deferredQuickPickSelection = undefined;
        cancellingNewPickerGate.allow();
        await withTimeout(cancellingNewPicker, 'newer cancelled top selection');
        await withTimeout(cancelledOldPicker, 'older picker after newer cancellation');
        assert.deepStrictEqual(storedTop, sameRootTopSelection);
        assert.deepStrictEqual(presentedTop, sameRootTopSelection);

        const alreadyOpenOldPickerGate = createScanGate();
        nextQuickPickGate = alreadyOpenOldPickerGate;
        const alreadyOpenOldPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(alreadyOpenOldPickerGate.started, 'already-open old top picker');

        const completingNewPickerGate = createScanGate();
        nextQuickPickGate = completingNewPickerGate;
        const completingNewPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(completingNewPickerGate.started, 'new top picker after old opened');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        completingNewPickerGate.allow();
        await withTimeout(completingNewPicker, 'new top picker completes first');

        deferredQuickPickSelection = quickPickItems.find(item => item.label === 'top');
        alreadyOpenOldPickerGate.allow();
        await withTimeout(alreadyOpenOldPicker, 'old top picker completes last');
        assert.deepStrictEqual(storedTop, sameRootTopSelection);
        assert.deepStrictEqual(presentedTop, sameRootTopSelection);

        const cancellationBaselineSelection = {
            definitionKey: topDefinition.key,
            name: topDefinition.name,
        };
        storedTop = cancellationBaselineSelection;
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before pending persistence cancellation'
        );
        const pendingCancellationOldPickerGate = createScanGate();
        const pendingCancellationPersistenceGate = createScanGate();
        nextQuickPickGate = pendingCancellationOldPickerGate;
        nextTopPersistenceGate = pendingCancellationPersistenceGate;
        const pendingCancellationOldPicker = Promise.resolve(
            commands.get('veriflow.selectTop')!()
        );
        await withTimeout(
            pendingCancellationOldPickerGate.started,
            'old picker before pending persistence cancellation'
        );
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        pendingCancellationOldPickerGate.allow();
        await withTimeout(
            pendingCancellationPersistenceGate.started,
            'old persistence before newer cancellation'
        );

        const pendingCancellationNewPickerGate = createScanGate();
        nextQuickPickGate = pendingCancellationNewPickerGate;
        const pendingCancellationNewPicker = Promise.resolve(
            commands.get('veriflow.selectTop')!()
        );
        await withTimeout(
            pendingCancellationNewPickerGate.started,
            'new picker cancelling pending persistence'
        );
        deferredQuickPickSelection = undefined;
        pendingCancellationNewPickerGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        const firstCancellationRollbackGate = createScanGate();
        nextTopPersistenceGate = firstCancellationRollbackGate;
        pendingCancellationPersistenceGate.allow();
        await withTimeout(
            firstCancellationRollbackGate.started,
            'first cancellation rollback persistence'
        );
        assert.deepStrictEqual(storedTop, sameRootTopSelection);
        assert.deepStrictEqual(presentedTop, cancellationBaselineSelection);

        const chainedCancellationPickerGate = createScanGate();
        nextQuickPickGate = chainedCancellationPickerGate;
        const chainedCancellationPicker = Promise.resolve(
            commands.get('veriflow.selectTop')!()
        );
        await withTimeout(
            chainedCancellationPickerGate.started,
            'second picker during cancellation rollback'
        );
        deferredQuickPickSelection = undefined;
        chainedCancellationPickerGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        firstCancellationRollbackGate.allow();
        await withTimeout(
            Promise.all([
                pendingCancellationOldPicker,
                pendingCancellationNewPicker,
                chainedCancellationPicker,
            ]),
            'chained cancellation persistence correction'
        );
        assert.deepStrictEqual(storedTop, cancellationBaselineSelection);
        assert.deepStrictEqual(presentedTop, cancellationBaselineSelection);

        storedTop = { definitionKey: topDefinition.key, name: topDefinition.name };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before overlapping top persistence'
        );
        const overlappingOldPickerGate = createScanGate();
        const overlappingOldPersistenceGate = createScanGate();
        nextQuickPickGate = overlappingOldPickerGate;
        nextTopPersistenceGate = overlappingOldPersistenceGate;
        nextTopPersistenceError = new Error('overlapping top persistence failed');
        const overlappingOldPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(overlappingOldPickerGate.started, 'overlapping old top picker');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        overlappingOldPickerGate.allow();
        await withTimeout(
            overlappingOldPersistenceGate.started,
            'overlapping old top persistence'
        );
        const overlappingOldRejection = assert.rejects(
            overlappingOldPicker,
            /overlapping top persistence failed/
        );

        const overlappingNewPickerGate = createScanGate();
        nextQuickPickGate = overlappingNewPickerGate;
        const overlappingNewPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(overlappingNewPickerGate.started, 'overlapping new top picker');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        const treeWritesBeforeOverlappingNewIntent = treeWriteCount;
        overlappingNewPickerGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.ok(treeWriteCount > treeWritesBeforeOverlappingNewIntent);
        assert.deepStrictEqual(presentedTop, sameRootTopSelection);

        overlappingOldPersistenceGate.allow();
        await withTimeout(
            Promise.all([overlappingOldRejection, overlappingNewPicker]),
            'overlapping same-value top persistence'
        );
        assert.deepStrictEqual(storedTop, sameRootTopSelection);
        assert.deepStrictEqual(presentedTop, sameRootTopSelection);

        storedTop = { definitionKey: topDefinition.key, name: topDefinition.name };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before rejected top persistence'
        );
        const rejectedTopPickerGate = createScanGate();
        const rejectedTopPersistenceGate = createScanGate();
        nextQuickPickGate = rejectedTopPickerGate;
        nextTopPersistenceGate = rejectedTopPersistenceGate;
        nextTopPersistenceError = new Error('top persistence failed');
        const rejectedTopPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(rejectedTopPickerGate.started, 'rejected top picker');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        rejectedTopPickerGate.allow();
        await withTimeout(rejectedTopPersistenceGate.started, 'rejected top persistence');
        rejectedTopPersistenceGate.allow();
        await withTimeout(
            assert.rejects(rejectedTopPicker, /top persistence failed/),
            'rejected top selection'
        );
        const retainedTopSelection = {
            definitionKey: topDefinition.key,
            name: topDefinition.name,
        };
        assert.deepStrictEqual(storedTop, retainedTopSelection);
        assert.deepStrictEqual(presentedTop, retainedTopSelection);

        const recoveredTopPickerGate = createScanGate();
        nextQuickPickGate = recoveredTopPickerGate;
        const recoveredTopPicker = Promise.resolve(commands.get('veriflow.selectTop')!());
        await withTimeout(recoveredTopPickerGate.started, 'recovered top picker');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        recoveredTopPickerGate.allow();
        await withTimeout(recoveredTopPicker, 'recovered top persistence');
        assert.deepStrictEqual(storedTop, sameRootTopSelection);
        assert.deepStrictEqual(presentedTop, sameRootTopSelection);

        storedTop = { definitionKey: '', name: 'top' };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'top migration before stale workflows'
        );

        const staleDependencyPersistenceGate = createScanGate();
        nextDependencyResultTag = 'old-persisted-analysis';
        nextDependencyPersistenceGate = staleDependencyPersistenceGate;
        const stalePersistedAnalyze = Promise.resolve(commands.get('veriflow.analyze')!());
        await withTimeout(
            staleDependencyPersistenceGate.started,
            'stale dependency persistence'
        );

        settings.defines = { PERSISTENCE_ORDER: 'clear-before-new' };
        const dependencyPersistenceInvalidation = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        }));
        await withTimeout(
            dependencyPersistenceInvalidation,
            'dependency persistence invalidation'
        );

        nextDependencyResultTag = 'new-persisted-analysis';
        const latestPersistedAnalyze = Promise.resolve(commands.get('veriflow.analyze')!());
        await new Promise<void>(resolve => setImmediate(resolve));
        staleDependencyPersistenceGate.allow();
        await withTimeout(
            Promise.all([stalePersistedAnalyze, latestPersistedAnalyze]),
            'out-of-order dependency persistence'
        );
        assert.deepStrictEqual(
            (persistedDependencyResult as { files?: string[] } | null)?.files,
            ['new-persisted-analysis']
        );
        assert.deepStrictEqual(presentedAnalyzeResult, persistedDependencyResult);
        assert.strictEqual(analyzeStatus, 'completed');

        const clearingDependencyPersistenceGate = createScanGate();
        nextDependencyResultTag = 'analysis-before-persistence-clear';
        nextDependencyPersistenceGate = clearingDependencyPersistenceGate;
        const clearingPersistedAnalyze = Promise.resolve(commands.get('veriflow.analyze')!());
        await withTimeout(
            clearingDependencyPersistenceGate.started,
            'dependency persistence before clear'
        );

        settings.defines = { PERSISTENCE_ORDER: 'clear-only' };
        const dependencyPersistenceClear = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        }));
        await withTimeout(dependencyPersistenceClear, 'dependency persistence clear');
        clearingDependencyPersistenceGate.allow();
        await withTimeout(clearingPersistedAnalyze, 'cleared dependency persistence');
        assert.strictEqual(persistedDependencyResult, null);
        assert.strictEqual(presentedAnalyzeResult, null);
        assert.notStrictEqual(analyzeStatus, 'completed');

        const analyzeResolveGate = createScanGate();
        nextResolveGate = analyzeResolveGate;
        const staleAnalyze = Promise.resolve(commands.get('veriflow.analyze')!());
        await withTimeout(analyzeResolveGate.started, 'stale analyze resolve');
        settings.defines = { ASYNC_ANALYZE_INVALIDATED: true };
        const analyzeConfigChange = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        }));
        analyzeResolveGate.allow();
        await withTimeout(
            Promise.all([staleAnalyze, analyzeConfigChange]),
            'stale analyze invalidation'
        );
        assert.notStrictEqual(analyzeStatus, 'completed');
        assert.strictEqual(presentedAnalyzeResult, null);
        assert.strictEqual(persistedDependencyResult, null);

        await withTimeout(
            Promise.resolve(commands.get('veriflow.analyze')!()),
            'analysis before stale simulation resolve'
        );
        assert.strictEqual(analyzeStatus, 'completed');
        const runnersBeforeStaleResolve = runnerCalls;
        const simulateResolveGate = createScanGate();
        nextResolveGate = simulateResolveGate;
        const staleResolveSimulation = Promise.resolve(commands.get('veriflow.simulate')!());
        await withTimeout(simulateResolveGate.started, 'stale simulation resolve');
        settings.libDirs = ['/workflow-root'];
        const simulationRootChange = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        simulateResolveGate.allow();
        await withTimeout(
            Promise.all([staleResolveSimulation, simulationRootChange]),
            'stale simulation resolve invalidation'
        );
        assert.strictEqual(runnerCalls, runnersBeforeStaleResolve);
        assert.notStrictEqual(simulateStatus, 'completed');
        assert.strictEqual(persistedDependencyResult, null);

        settings.libDirs = ['/latest-library'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'stale workflow root recovery');
        storedTop = { definitionKey: '', name: 'top' };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'top migration after stale workflow root recovery'
        );
        await withTimeout(
            Promise.resolve(commands.get('veriflow.analyze')!()),
            'analysis before stale runner'
        );
        const runnerGate = createScanGate();
        nextRunnerGate = runnerGate;
        const staleRunnerSimulation = Promise.resolve(commands.get('veriflow.simulate')!());
        await withTimeout(runnerGate.started, 'stale simulation runner');
        settings.libDirs = ['/runner-root'];
        const runnerRootChange = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        }));
        runnerGate.allow();
        await withTimeout(
            Promise.all([staleRunnerSimulation, runnerRootChange]),
            'stale runner invalidation'
        );
        assert.strictEqual(simulateStatus, 'outdated');
        assert.strictEqual(persistedDependencyResult, null);

        settings.libDirs = ['/latest-library'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'post-workflow root recovery');
        storedTop = { definitionKey: '', name: 'top' };
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'top migration before failed root identity'
        );
        await withTimeout(
            Promise.resolve(commands.get('veriflow.analyze')!()),
            'analysis before failed root identity'
        );
        await withTimeout(
            Promise.resolve(commands.get('veriflow.simulate')!()),
            'simulation before failed root identity'
        );
        assert.strictEqual(analyzeStatus, 'completed');
        assert.strictEqual(simulateStatus, 'completed');

        const failedRoots = JSON.stringify([workspaceRootUri]);
        failedScanRoots.add(failedRoots);
        const clearsBeforeFailedIdentity = outputClearCount;
        settings.libDirs = [];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'failed replacement roots scan');
        assert.strictEqual(lastScanResult, undefined);
        assert.deepStrictEqual(testbenchModuleMap, {});
        assert.strictEqual(storedTop, undefined);
        assert.strictEqual(persistedDependencyResult, null);
        assert.strictEqual(analyzeStatus, 'outdated');
        assert.strictEqual(simulateStatus, 'outdated');
        assert.ok(outputClearCount > clearsBeforeFailedIdentity);
        assert.notStrictEqual(status.text, '$(sync~spin) VeriFlow: scanning...');
        assert.notStrictEqual(status.text, '$(warning) VeriFlow: 1 duplicate module name');
        failedScanRoots.delete(failedRoots);

        storedTop = { definitionKey: '', name: 'top' };
        settings.libDirs = ['/before-workspace-removal'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'replacement roots recovery scan');
        const retainedSameIdentityScan = lastScanResult;
        const retainedSameIdentityModuleMap = { ...testbenchModuleMap };
        const retainedSameIdentityStatus = status.text;
        const sameIdentityRoots = JSON.stringify([
            workspaceRootUri,
            'file:///before-workspace-removal',
        ]);
        failedScanRoots.add(sameIdentityRoots);
        settings.defines = { TRANSIENT_FAILURE: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'same identity transient scan failure');
        assert.strictEqual(lastScanResult, retainedSameIdentityScan);
        assert.deepStrictEqual(testbenchModuleMap, retainedSameIdentityModuleMap);
        assert.strictEqual(status.text, retainedSameIdentityStatus);
        failedScanRoots.delete(sameIdentityRoots);

        pendingWatcherConstructionError = {
            remainingSuccessfulConstructions: 0,
            error: new Error('immediate watcher construction failed'),
        };
        settings.defines = { IMMEDIATE_WATCHER_CONSTRUCTION_FAILURE: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'immediate watcher construction recovery scan');
        assert.strictEqual(
            FakeIndex.instances.at(-1)?.currentDefinesKey,
            'IMMEDIATE_WATCHER_CONSTRUCTION_FAILURE'
        );
        assert.strictEqual(status.text, retainedSameIdentityStatus);
        await withTimeout(
            fireHdlWatchEvent('change', workspaceDefinition.uri),
            'watch event after immediate construction recovery'
        );
        assert.ok(events.includes(
            `refresh-defines:IMMEDIATE_WATCHER_CONSTRUCTION_FAILURE:${workspaceDefinition.uri}`
        ));

        pendingWatcherConstructionError = {
            remainingSuccessfulConstructions: watcherRecords.filter(
                record => !record.disposed
            ).length,
            error: new Error('watcher construction failed'),
        };
        settings.defines = { WATCHER_CONSTRUCTION_FAILURE: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'watcher construction scan failure');
        const failedWatcherPlanIndex = FakeIndex.instances.at(-1)!;
        const failedWatcherPlanResult = lastScanResult;
        assert.strictEqual(failedWatcherPlanIndex.disposed, true);
        assert.strictEqual(failedWatcherPlanResult, undefined);
        assert.deepStrictEqual(testbenchModuleMap, {});
        assert.notStrictEqual(status.text, retainedSameIdentityStatus);
        assert.ok(!watcherRecords.some(record =>
            !record.disposed
            && record.pattern instanceof FakeRelativePattern
            && record.pattern.baseUri.toString() === 'file:///external/generated'
            && record.pattern.pattern === 'conditional.inc'
        ));

        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'watcher construction plan recovery scan'
        );
        assert.notStrictEqual(FakeIndex.instances.at(-1), failedWatcherPlanIndex);
        assert.strictEqual(presentedDefinesKey, 'WATCHER_CONSTRUCTION_FAILURE');
        assert.ok(watcherRecords.some(record =>
            !record.disposed
            && record.pattern instanceof FakeRelativePattern
            && record.pattern.baseUri.toString() === 'file:///external/generated'
            && record.pattern.pattern === 'conditional.inc'
        ));
        await withTimeout(
            fireHdlWatchEvent('change', conditionalNonstandardIncludeUri),
            'conditional include after watcher plan recovery'
        );
        assert.ok(events.includes(
            `refresh-defines:WATCHER_CONSTRUCTION_FAILURE:${conditionalNonstandardIncludeUri}`
        ));

        const chainedOldScanGate = createScanGate();
        nextScanGate = chainedOldScanGate;
        settings.defines = { CHAINED_OLD_SCAN: true };
        const chainedOldScan = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        }));
        await withTimeout(chainedOldScanGate.started, 'older chained status scan');

        failedScanDefines.add('CHAINED_NEW_SCAN');
        settings.defines = { CHAINED_NEW_SCAN: true };
        const chainedNewScan = Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        }));
        assert.strictEqual(status.text, '$(sync~spin) VeriFlow: scanning...');
        chainedOldScanGate.allow();
        await withTimeout(
            Promise.all([chainedOldScan, chainedNewScan]),
            'newer failed chained status scan'
        );
        assert.strictEqual(status.text, retainedSameIdentityStatus);
        failedScanDefines.delete('CHAINED_NEW_SCAN');

        await withTimeout(
            Promise.resolve(commands.get('veriflow.analyze')!()),
            'replacement dependency analysis'
        );
        await withTimeout(
            Promise.resolve(commands.get('veriflow.simulate')!()),
            'replacement simulation'
        );
        assert.ok(lastScanResult);
        assert.ok(persistedDependencyResult);

        const removalGate = createScanGate();
        scanGates.set('file:///before-workspace-removal', removalGate);
        const indexBeforeWorkspaceRemoval = FakeIndex.instances.at(-1)!;
        const slowSameIdentityScan = Promise.resolve(commands.get('veriflow.scanModules')!());
        await withTimeout(removalGate.started, 'slow scan before workspace removal');
        workspaceFolders.splice(0, workspaceFolders.length);
        await withTimeout(
            Promise.resolve(workspaceFoldersListener!()),
            'last workspace removal'
        );
        assert.strictEqual(lastScanResult, undefined);
        assert.deepStrictEqual(testbenchModuleMap, {});
        assert.strictEqual(storedTop, undefined);
        assert.strictEqual(persistedDependencyResult, null);
        assert.strictEqual(analyzeStatus, 'outdated');
        assert.strictEqual(simulateStatus, 'outdated');
        assert.strictEqual(indexBeforeWorkspaceRemoval.disposed, true);

        removalGate.allow();
        await withTimeout(slowSameIdentityScan, 'stale scan after workspace removal');
        assert.strictEqual(lastScanResult, undefined);
        assert.deepStrictEqual(testbenchModuleMap, {});

        await withTimeout(extension.deactivate(), 'reset before deactivation race');
        extensionDeactivated = true;
        workspaceFolders.push(folder, { uri: FakeUri.parse('file:///B-workspace') });
        storedTop = { definitionKey: topDefinition.key, name: topDefinition.name };
        persistedDependencyResult = null;
        analyzeStatus = 'idle';
        simulateStatus = 'idle';
        extension.activate(context);
        extensionDeactivated = false;
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before deferred deactivation'
        );

        const staleDialogGate = createScanGate();
        nextOpenDialogGate = staleDialogGate;
        const staleDialogOpen = Promise.resolve(commands.get('veriflow.openVcdViewer')!());
        await withTimeout(staleDialogGate.started, 'VCD dialog before lifecycle replacement');
        await withTimeout(extension.deactivate(), 'deactivate with open VCD dialog');
        extensionDeactivated = true;

        extension.activate(context);
        extensionDeactivated = false;
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan after VCD dialog lifecycle replacement'
        );
        const openWithBeforeStaleDialog = executedCommands.filter(command =>
            command.name === 'vscode.openWith'
        ).length;
        deferredOpenDialogSelection = [FakeUri.parse('file:///waves/stale.vcd')];
        staleDialogGate.allow();
        await withTimeout(staleDialogOpen, 'stale VCD dialog completion');
        assert.strictEqual(
            executedCommands.filter(command => command.name === 'vscode.openWith').length,
            openWithBeforeStaleDialog
        );

        const currentDialogGate = createScanGate();
        nextOpenDialogGate = currentDialogGate;
        const currentDialogOpen = Promise.resolve(commands.get('veriflow.openVcdViewer')!());
        await withTimeout(currentDialogGate.started, 'current lifecycle VCD dialog');
        deferredOpenDialogSelection = [FakeUri.parse('file:///waves/current.vcd')];
        currentDialogGate.allow();
        await withTimeout(currentDialogOpen, 'current lifecycle VCD open');
        assert.strictEqual(
            executedCommands.filter(command => command.name === 'vscode.openWith').length,
            openWithBeforeStaleDialog + 1
        );

        const deactivationPersistenceGate = createScanGate();
        nextDependencyPersistenceGate = deactivationPersistenceGate;
        const deferredDeactivationSimulation = Promise.resolve(
            commands.get('veriflow.simulate')!()
        );
        await withTimeout(
            deactivationPersistenceGate.started,
            'dependency persistence before deactivation'
        );
        const runnersBeforeDeactivation = runnerCalls;
        const parsersBeforeDeactivation = parserCreateCalls;
        const indexesBeforeDeactivation = FakeIndex.instances.length;
        const scansBeforeDeactivation = events.filter(event => event === 'scan').length;
        const treeWritesBeforeDeactivation = treeWriteCount;
        const statusWritesBeforeDeactivation = statusWriteCount;
        const outputShowsBeforeDeactivation = outputShowCount;
        let deactivationSettled = false;
        const deferredDeactivation = extension.deactivate().then(() => {
            deactivationSettled = true;
            extensionDeactivated = true;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(deactivationSettled, false);
        deactivationPersistenceGate.allow();
        await withTimeout(
            Promise.all([deferredDeactivationSimulation, deferredDeactivation]),
            'deferred extension deactivation'
        );
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(runnerCalls, runnersBeforeDeactivation);
        assert.strictEqual(parserCreateCalls, parsersBeforeDeactivation);
        assert.strictEqual(FakeIndex.instances.length, indexesBeforeDeactivation);
        assert.strictEqual(events.filter(event => event === 'scan').length, scansBeforeDeactivation);
        assert.strictEqual(treeWriteCount, treeWritesBeforeDeactivation);
        assert.strictEqual(statusWriteCount, statusWritesBeforeDeactivation);

        await Promise.all([
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            Promise.resolve(commands.get('veriflow.selectTop')!()),
            Promise.resolve(commands.get('veriflow.analyze')!()),
            Promise.resolve(commands.get('veriflow.simulate')!()),
            Promise.resolve(commands.get('veriflow.openWave')!()),
            Promise.resolve(commands.get('veriflow.openVcdViewer')!()),
            Promise.resolve(commands.get('veriflow.instantiateModule')!()),
            Promise.resolve(commands.get('veriflow.showOutput')!()),
        ]);
        assert.strictEqual(runnerCalls, runnersBeforeDeactivation);
        assert.strictEqual(parserCreateCalls, parsersBeforeDeactivation);
        assert.strictEqual(FakeIndex.instances.length, indexesBeforeDeactivation);
        assert.strictEqual(events.filter(event => event === 'scan').length, scansBeforeDeactivation);
        assert.strictEqual(treeWriteCount, treeWritesBeforeDeactivation);
        assert.strictEqual(statusWriteCount, statusWritesBeforeDeactivation);
        assert.strictEqual(outputShowCount, outputShowsBeforeDeactivation);

        storedTop = { definitionKey: topDefinition.key, name: topDefinition.name };
        extension.activate(context);
        extensionDeactivated = false;
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'scan before rejected persistence deactivation'
        );
        const deactivationPickerGate = createScanGate();
        const rejectedDeactivationPersistenceGate = createScanGate();
        nextQuickPickGate = deactivationPickerGate;
        nextTopPersistenceGate = rejectedDeactivationPersistenceGate;
        nextTopPersistenceError = new Error('deactivation persistence failed');
        const rejectedDeactivationPicker = Promise.resolve(
            commands.get('veriflow.selectTop')!()
        );
        await withTimeout(deactivationPickerGate.started, 'picker before rejected deactivation');
        deferredQuickPickSelection = quickPickItems.find(item => item.label === '__proto__');
        deactivationPickerGate.allow();
        await withTimeout(
            rejectedDeactivationPersistenceGate.started,
            'rejected persistence before deactivation'
        );
        const rejectedDeactivationSelection = assert.rejects(
            rejectedDeactivationPicker,
            /deactivation persistence failed/
        );
        const treeWritesBeforeRejectedDeactivation = treeWriteCount;
        const statusWritesBeforeRejectedDeactivation = statusWriteCount;
        let rejectedDeactivationSettled = false;
        const rejectedPersistenceDeactivation = extension.deactivate().then(() => {
            rejectedDeactivationSettled = true;
            extensionDeactivated = true;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(rejectedDeactivationSettled, false);
        rejectedDeactivationPersistenceGate.allow();
        await withTimeout(
            Promise.all([rejectedDeactivationSelection, rejectedPersistenceDeactivation]),
            'rejected persistence deactivation drain'
        );
        assert.strictEqual(treeWriteCount, treeWritesBeforeRejectedDeactivation);
        assert.strictEqual(statusWriteCount, statusWritesBeforeRejectedDeactivation);
    } finally {
        for (const gate of scanGates.values()) {
            gate.allow();
        }
        if (!extensionDeactivated) {
            await withTimeout(extension.deactivate(), 'extension deactivation');
        }
        delete require.cache[require.resolve('../extension')];
    }
}

async function main(): Promise<void> {
    const tests: Array<[string, () => void | Promise<void>]> = [
        ['legacy scanner removal', testExtensionNoLongerContainsLegacyModuleScanner],
        ['duplicate presentation', testDuplicateSummaryIsMergedAndHasNoPopup],
        ['exact module tree definitions', testModuleTreeKeepsEveryExactDefinition],
        ['exact top selection migration', testTopSelectionUsesExactIdentityAndMigratesLegacyNames],
        ['index scan watcher and config integration', testScanWatcherAndConfigUseOneExactIndex],
    ];
    const failures: string[] = [];
    for (const [name, test] of tests) {
        try {
            await test();
        } catch (error) {
            failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
    }
    if (failures.length > 0) {
        assert.fail(failures.join('\n\n'));
    }
    console.log('HDL feature migration tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
