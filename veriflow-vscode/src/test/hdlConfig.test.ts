import * as assert from 'assert';
import * as fs from 'fs';
import Module = require('module');
import * as path from 'path';

type ExtensionSettings = {
    defines: Record<string, string | boolean>;
};

type ConfigModule = {
    getSettings(): ExtensionSettings;
};

type ParserClientOptions = {
    workerPath: string;
    runtimeWasmPath: string;
    languageWasmPath: string;
};

type ParserClient = {
    readonly options: ParserClientOptions;
    dispose(): Promise<void>;
};

async function testExtensionLifecycle(): Promise<void> {
    let configurationListener:
        | ((event: { affectsConfiguration(section: string): boolean }) => void)
        | undefined;
    let parserCreations = 0;
    let outputDisposals = 0;

    class FakeParserClient {
        clearCacheCalls = 0;
        disposeCalls = 0;

        clearCache(): void {
            this.clearCacheCalls++;
        }

        async dispose(): Promise<void> {
            this.disposeCalls++;
        }
    }

    const parsers: FakeParserClient[] = [];
    const disposable = { dispose(): void {} };
    const vscodeStub = {
        StatusBarAlignment: { Left: 1 },
        window: {
            createTreeView: () => ({ ...disposable, onDidChangeVisibility(): void {} }),
            registerWebviewViewProvider: () => disposable,
            registerCustomEditorProvider: () => disposable,
            createStatusBarItem: () => ({ ...disposable, show(): void {}, text: '' }),
            onDidChangeWindowState: () => disposable,
        },
        commands: {
            registerCommand: () => disposable,
        },
        workspace: {
            onDidChangeConfiguration(
                listener: (event: { affectsConfiguration(section: string): boolean }) => void
            ) {
                configurationListener = listener;
                return disposable;
            },
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
        getWorkspaceRoot: () => undefined,
        getTopModule: () => '',
        setTopModule: async () => undefined,
        getSettings: () => ({
            libDirs: [],
            defines: {},
            simulator: 'iverilog',
            waveViewer: 'builtin',
            simulatorCompileCmd: '',
            simulatorRunCmd: '',
            waveViewerCmd: '',
            waveFileTemplate: '{top_module}.vcd',
            testbenchOutputDir: '.',
        }),
        getAnalyzeStatus: () => 'idle',
        setAnalyzeStatus: async () => undefined,
        getSimulateStatus: () => 'idle',
        setSimulateStatus: async () => undefined,
        getDependencyResult: () => null,
        setDependencyResult: async () => undefined,
    };
    const coreStub = {
        DependencyAnalyzer: class {},
        SimulationRunner: class {},
        LogParser: class {},
        createHdlParserClient: (_context: { extensionPath: string }) => {
            parserCreations++;
            const parser = new FakeParserClient();
            parsers.push(parser);
            return parser;
        },
        HdlParserClient: FakeParserClient,
    };
    const outputStub = {
        appendError(): void {},
        appendInfo(): void {},
        appendLine(): void {},
        appendSuccess(): void {},
        appendWarning(): void {},
        clear(): void {},
        dispose(): void { outputDisposals++; },
        show(): void {},
    };
    const dependencyStubs: Record<string, unknown> = {
        './config': configStub,
        './core': coreStub,
        './moduleTreeProvider': {
            ModuleTreeProvider: class {
                setAnalyzeResult(): void {}
            },
        },
        './moduleInstantiationCommand': {
            showModuleInstantiationPicker: async () => undefined,
        },
        './testbenchPanel': {
            TestbenchPanelProvider: class {
                static readonly viewType = 'veriflow.testbench';
                setBeforeGenerate(): void {}
                setOnVisible(): void {}
                refreshModules(): void {}
                dispose(): void {}
            },
        },
        './waveformEditorProvider': {
            WaveformEditorProvider: class {
                static readonly viewType = 'veriflow.waveformEditor';
            },
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
        './output': outputStub,
    };

    const moduleLoader = Module as typeof Module & {
        _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function loadExtensionWithStubs(
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

    try {
        const extension = require('../extension') as {
            activate(context: { extensionPath: string; subscriptions: unknown[] }): void;
            deactivate(): Promise<void> | void;
            getHdlParser(context: { extensionPath: string }): FakeParserClient;
        };
        const context = { extensionPath: path.join('D:', 'Extensions', 'A'), subscriptions: [] };
        extension.activate(context);
        assert.ok(configurationListener);
        configurationListener!({
            affectsConfiguration: section => section === 'veriflow',
        });
        assert.strictEqual(parserCreations, 0);

        const parser = extension.getHdlParser(context);
        assert.strictEqual(extension.getHdlParser(context), parser);
        assert.strictEqual(parserCreations, 1);
        assert.throws(
            () => extension.getHdlParser({
                extensionPath: path.join('D:', 'Extensions', 'B'),
            }),
            /extension path|deactivate/i
        );

        configurationListener!({
            affectsConfiguration: section => section === 'veriflow',
        });
        assert.strictEqual(parser.clearCacheCalls, 0);
        configurationListener!({
            affectsConfiguration: section =>
                section === 'veriflow' || section === 'veriflow.defines',
        });
        assert.strictEqual(parser.clearCacheCalls, 1);

        await extension.deactivate();
        assert.strictEqual(parser.disposeCalls, 1);
        assert.strictEqual(outputDisposals, 1);

        assert.throws(() => extension.getHdlParser(context), /stopping/i);
        extension.activate(context);
        const replacement = extension.getHdlParser(context);
        assert.notStrictEqual(replacement, parser);
        assert.strictEqual(parserCreations, 2);
        await extension.deactivate();
        assert.strictEqual(replacement.disposeCalls, 1);
    } finally {
        moduleLoader._load = originalLoad;
        delete require.cache[require.resolve('../extension')];
    }
}

async function main(): Promise<void> {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const manifest = JSON.parse(
        fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
    ) as {
        engines: { vscode: string; node?: string };
        main: string;
        contributes: {
            configuration: {
                properties: Record<string, unknown>;
            };
        };
    };

    let configuredDefines: unknown;
    let workerConstructions = 0;
    const vscodeStub = {
        workspace: {
            getConfiguration(section: string): { get<T>(key: string, fallback: T): T } {
                assert.strictEqual(section, 'veriflow');
                return {
                    get<T>(key: string, fallback: T): T {
                        return (key === 'defines' && configuredDefines !== undefined
                            ? configuredDefines
                            : fallback) as T;
                    },
                };
            },
        },
    };

    const moduleLoader = Module as typeof Module & {
        _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function loadWithVscodeStub(
        request: string,
        parent: NodeModule | undefined,
        isMain: boolean
    ): unknown {
        if (request === 'vscode') {
            return vscodeStub;
        }
        if (request === 'worker_threads') {
            return {
                Worker: class UnexpectedWorker {
                    constructor() {
                        workerConstructions++;
                        throw new Error('factory must not start the parser worker');
                    }
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        const { getSettings } = require('../config') as ConfigModule;

        assert.deepStrictEqual(getSettings().defines, {});

        const rawDefines = Object.create({ inherited: 'ignored' }) as Record<string, unknown>;
        rawDefines.STRING_VALUE = '8';
        rawDefines.BOOLEAN_VALUE = true;
        rawDefines.empty = '';
        rawDefines.falseValue = false;
        rawDefines.numberValue = 8;
        rawDefines.nullValue = null;
        rawDefines.arrayValue = ['ignored'];
        rawDefines.objectValue = { ignored: true };
        Object.defineProperty(rawDefines, 'constructor', {
            value: 'ignored',
            enumerable: true,
        });
        rawDefines.prototype = 'ignored';
        Object.defineProperty(rawDefines, '__proto__', {
            value: 'ignored',
            enumerable: true,
        });
        configuredDefines = rawDefines;

        const first = getSettings().defines;
        assert.strictEqual(Object.getPrototypeOf(first), Object.prototype);
        assert.deepStrictEqual(first, {
            STRING_VALUE: '8',
            BOOLEAN_VALUE: true,
            empty: '',
            falseValue: false,
        });

        first.STRING_VALUE = 'changed by caller';
        (first as Record<string, string | boolean>).NEW_VALUE = true;
        assert.deepStrictEqual(getSettings().defines, {
            STRING_VALUE: '8',
            BOOLEAN_VALUE: true,
            empty: '',
            falseValue: false,
        });

        const hdl = require('../core/hdl') as {
            HdlParserClient: new (options: ParserClientOptions) => ParserClient;
            computeTreeEdit: unknown;
            createHdlParserClient(context: { extensionPath: string }): ParserClient;
        };
        assert.strictEqual(typeof hdl.HdlParserClient, 'function');
        assert.strictEqual(typeof hdl.computeTreeEdit, 'function');

        const extensionPath = path.join('D:', 'Extensions', 'VeriFlow');
        const parser = hdl.createHdlParserClient({ extensionPath });
        assert.ok(parser instanceof hdl.HdlParserClient);
        assert.strictEqual(workerConstructions, 0);
        assert.deepStrictEqual(parser.options, {
            workerPath: path.join(extensionPath, 'dist', 'workers', 'hdlParserWorker.js'),
            runtimeWasmPath: path.join(
                extensionPath,
                'media',
                'parsers',
                'web-tree-sitter.wasm'
            ),
            languageWasmPath: path.join(
                extensionPath,
                'media',
                'parsers',
                'tree-sitter-systemverilog.wasm'
            ),
        });
        await parser.dispose();
        assert.strictEqual(workerConstructions, 0);
    } finally {
        moduleLoader._load = originalLoad;
    }

    assert.deepStrictEqual(
        manifest.contributes.configuration.properties['veriflow.defines'],
        {
            type: 'object',
            default: {},
            additionalProperties: { type: ['string', 'boolean'] },
            description: 'SystemVerilog preprocessor defines used by VeriFlow structural parsing',
        }
    );
    assert.strictEqual(manifest.engines.vscode, '^1.82.0');
    assert.strictEqual(manifest.engines.node, undefined);
    assert.strictEqual(manifest.main, './dist/extension.js');

    await testExtensionLifecycle();

    console.log('HDL configuration tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
