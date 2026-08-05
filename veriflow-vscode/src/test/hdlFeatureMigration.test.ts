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
            return new FakeUri(`file:///${normalized}`, filepath);
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
    get fsPath(): string { return this.path; }
    toString(): string { return `${this.scheme}://${this.authority}${this.path}`; }
}

async function testScanWatcherAndConfigUseOneExactIndex(): Promise<void> {
    const workspaceDefinition: Definition = {
        key: 'module:file:///workspace/rtl/alu.sv:0',
        kind: 'module',
        name: 'alu',
        uri: 'file:///workspace/rtl/alu.sv',
        declarationStart: 0,
        declarationLine: 1,
        parameters: [], ports: [], dependencies: [], modelFingerprint: 'workspace',
    };
    const libraryDefinition: Definition = {
        ...workspaceDefinition,
        key: 'module:file:///library/alu.sv:0',
        uri: 'file:///library/alu.sv',
        modelFingerprint: 'library',
    };
    const secondWorkspaceDefinition: Definition = {
        ...workspaceDefinition,
        key: 'module:file:///workspace/ip/alu.sv:0',
        uri: 'file:///workspace/ip/alu.sv',
        modelFingerprint: 'workspace-ip',
    };
    const topDefinition: Definition = {
        ...workspaceDefinition,
        key: 'module:file:///workspace/top.sv:0',
        name: 'top',
        uri: 'file:///workspace/top.sv',
        modelFingerprint: 'top',
    };
    const prototypeNamedDefinition: Definition = {
        ...workspaceDefinition,
        key: 'module:file:///workspace/prototype_named.sv:0',
        name: '__proto__',
        uri: 'file:///workspace/prototype_named.sv',
        modelFingerprint: 'prototype-named',
    };
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
    let changeListener: ((uri: FakeUri) => unknown) | undefined;
    let createListener: ((uri: FakeUri) => unknown) | undefined;
    let deleteListener: ((uri: FakeUri) => unknown) | undefined;
    let configListener: ((event: { affectsConfiguration(section: string): boolean }) => unknown) | undefined;
    let watcherPattern = '';
    let lastScanResult: {
        definitions: ModuleDefinitionEntry[];
        moduleFiles: Record<string, string>;
    } | undefined;
    const presentedLibDirs: string[][] = [];
    let quickPickItems: Array<{ label: string; description?: string }> = [];
    const status = { text: '', tooltip: '', command: '', show(): void {}, dispose(): void {} };
    const disposable = { dispose(): void {} };
    const folder = { uri: FakeUri.parse('file:///workspace') };
    const settings = {
        libDirs: ['/library'], defines: {} as Record<string, string | boolean>,
        simulator: 'iverilog', waveViewer: 'builtin', simulatorCompileCmd: '',
        simulatorRunCmd: '', waveViewerCmd: '', waveFileTemplate: '{top_module}.vcd',
        testbenchOutputDir: '.',
    };
    let storedTop: TopModuleSelection | undefined = { definitionKey: '', name: 'top' };

    class FakeIndex {
        static instances: FakeIndex[] = [];
        readonly scannedRoots: string[][] = [];
        disposed = false;
        constructor(readonly options: unknown) { FakeIndex.instances.push(this); }
        async load(): Promise<void> { events.push('load'); }
        async updateConfiguration(defines: Record<string, string | true>): Promise<void> {
            events.push(`update:${Object.keys(defines).sort().join('+')}`);
        }
        async scan(roots: string[]): Promise<void> {
            this.scannedRoots.push([...roots]);
            events.push('scan');
            const gate = roots.map(root => scanGates.get(root)).find(Boolean);
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
        }
        async refreshUri(uri: string): Promise<void> { events.push(`refresh:${uri}`); }
        async removeUri(uri: string): Promise<void> { events.push(`remove:${uri}`); }
        getAllDefinitions(kind?: string): Definition[] {
            return kind && kind !== 'module' ? [] : [...definitions];
        }
        getDuplicateGroups(): Array<{ name: string; definitions: Definition[] }> {
            return [{
                name: 'alu',
                definitions: [workspaceDefinition, secondWorkspaceDefinition, libraryDefinition],
            }];
        }
        getDefinition(key: string): Definition | undefined {
            return definitions.find(definition => definition.key === key);
        }
        findDefinitions(name: string): Definition[] {
            return definitions.filter(definition => definition.name === name);
        }
        dispose(): void { this.disposed = true; events.push('dispose-index'); }
    }
    class FakeTreeProvider {
        topModule: TopModuleSelection | undefined;
        analyzeResult: unknown;
        setScanResult(result: {
            definitions: ModuleDefinitionEntry[];
            moduleFiles: Record<string, string>;
            libDirs?: string[];
        }): void {
            lastScanResult = result;
            presentedLibDirs.push([...(result.libDirs ?? [])]);
        }
        setAnalyzeResult(result: unknown): void { this.analyzeResult = result; }
        getWorkspaceDefinitions(): ModuleDefinitionEntry[] {
            return lastScanResult?.definitions.filter(definition => definition.workspace) ?? [];
        }
    }
    class FakeTestbenchPanel {
        static readonly viewType = 'veriflow.testbench';
        setBeforeGenerate(): void {}
        setOnVisible(): void {}
        setModuleMap(): void {}
    }
    class FakeDependencyAnalyzer {
        constructor(readonly index: FakeIndex) {}
        resolve(definitionKey: string) {
            resolvedDefinitionKeys.push(definitionKey);
            return {
                topModule: 'top',
                topDefinitionKey: definitionKey,
                files: [],
                missingModules: [],
                ambiguousModules: {},
                moduleMap: {},
                depGraph: {},
            };
        }
    }
    const vscodeStub = {
        Uri: FakeUri,
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
            showQuickPick: async (items: Array<{ label: string; description?: string }>) => {
                quickPickItems = items;
                return undefined;
            },
        },
        commands: {
            registerCommand(name: string, command: (...args: unknown[]) => unknown) {
                commands.set(name, command);
                return disposable;
            },
        },
        workspace: {
            workspaceFolders: [folder],
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
            onDidChangeWorkspaceFolders: () => disposable,
            createFileSystemWatcher(pattern: string) {
                watcherPattern = pattern;
                return {
                    ...disposable,
                    onDidChange(listener: typeof changeListener): void { changeListener = listener; },
                    onDidCreate(listener: typeof createListener): void { createListener = listener; },
                    onDidDelete(listener: typeof deleteListener): void { deleteListener = listener; },
                };
            },
        },
    };
    const configStub = {
        getWorkspaceRoot: () => folder.uri.fsPath,
        getTopModule: () => storedTop,
        setTopModule: async (_context: unknown, selection: TopModuleSelection | undefined) => {
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
        getAnalyzeStatus: () => 'idle', setAnalyzeStatus: async () => undefined,
        getSimulateStatus: () => 'idle', setSimulateStatus: async () => undefined,
        getDependencyResult: () => null, setDependencyResult: async () => undefined,
    };
    const coreStub = {
        DependencyAnalyzer: FakeDependencyAnalyzer,
        WorkspaceHdlIndex: FakeIndex,
        SimulationRunner: class {}, LogParser: class {},
        MODULE_DECL_RE: /module\s+([A-Za-z_$][\w$]*)/g,
        listVerilogFiles: () => [], readText: () => '',
        preprocessVerilog: (value: string) => value, removeComments: (value: string) => value,
        createHdlParserClient: () => ({ clearCache(): void {}, async dispose(): Promise<void> {} }),
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
            clear(): void {}, dispose(): void {}, show(): void {},
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
    try {
        extension.activate(context);
        await withTimeout(
            Promise.resolve(commands.get('veriflow.scanModules')!()),
            'initial module scan'
        );

        assert.strictEqual(FakeIndex.instances.length, 1);
        assert.strictEqual(lastScanResult?.definitions.length, 5);
        assert.ok(Object.prototype.hasOwnProperty.call(
            lastScanResult?.moduleFiles,
            '__proto__'
        ));
        assert.deepStrictEqual(storedTop, { definitionKey: topDefinition.key, name: 'top' });
        assert.strictEqual(watcherPattern, '**/*.{v,sv,vh,svh}');
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes(workspaceDefinition.uri));
        assert.ok(warnings[0].includes(libraryDefinition.uri));
        assert.strictEqual(status.text, '$(warning) VeriFlow: 1 duplicate module name');
        assert.deepStrictEqual(popupWarnings, []);

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
            Promise.resolve(changeListener!(FakeUri.parse(workspaceDefinition.uri))),
            'changed URI refresh'
        );
        await withTimeout(
            Promise.resolve(createListener!(FakeUri.parse('file:///workspace/new.sv'))),
            'created URI refresh'
        );
        await withTimeout(
            Promise.resolve(deleteListener!(FakeUri.parse(libraryDefinition.uri))),
            'deleted URI removal'
        );
        assert.ok(events.includes(`refresh:${workspaceDefinition.uri}`));
        assert.ok(events.includes('refresh:file:///workspace/new.sv'));
        assert.ok(events.includes(`remove:${libraryDefinition.uri}`));

        const scansBeforeConfig = events.filter(event => event === 'scan').length;
        settings.defines = { FEATURE: true };
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.defines',
        })), 'defines rescan');
        assert.ok(events.filter(event => event === 'scan').length > scansBeforeConfig);
        assert.strictEqual(FakeIndex.instances.length, 1);

        const previousIndex = FakeIndex.instances[0];
        settings.libDirs = ['/other-library'];
        await withTimeout(Promise.resolve(configListener!({
            affectsConfiguration: section => section === 'veriflow.libDirs',
        })), 'library roots rescan');
        assert.strictEqual(FakeIndex.instances.length, 2);
        assert.strictEqual(previousIndex.disposed, true);
        assert.deepStrictEqual(FakeIndex.instances[1].scannedRoots.at(-1), [
            'file:///workspace',
            'file:///other-library',
        ]);

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
    } finally {
        for (const gate of scanGates.values()) {
            gate.allow();
        }
        await withTimeout(extension.deactivate(), 'extension deactivation');
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
