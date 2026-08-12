import * as assert from 'assert';
import * as fs from 'fs';
import Module = require('module');
import * as path from 'path';

import {
    createEmptyArchDesign,
    parseArchDesignText,
    serializeArchDesign,
    type ArchDesign,
} from '@veriflow/schematic-core/arch-design';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import type { HostEvent } from '../schematic/protocol';

class FakeUri {
    private constructor(readonly path: string) {}

    static parse(value: string): FakeUri {
        return new FakeUri(decodeURIComponent(new URL(value).pathname));
    }

    static file(value: string): FakeUri {
        return new FakeUri(value.replace(/\\/g, '/'));
    }

    static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
        return new FakeUri(path.posix.join(base.path, ...segments));
    }

    with(change: { path?: string }): FakeUri {
        return new FakeUri(change.path ?? this.path);
    }

    get fsPath(): string {
        return this.path.replace(/^\/([A-Za-z]:\/)/, '$1').replace(/\//g, path.sep);
    }

    toString(): string {
        return `file://${this.path}`;
    }
}

type AppliedReplacement = {
    uri: string;
    start: number;
    end: number;
    text: string;
};

type ProviderHarness = {
    messages: HostEvent[];
    diagnostics: Array<{ uri: string; count: number }>;
    replacements: AppliedReplacement[];
    releasedOwners: object[];
    setDefinitions(definitions: HdlDefinitionSummary[]): void;
    invalidateIndex(): void;
    send(message: unknown): void;
    changeDocument(text: string, version: number): void;
    dispose(): Promise<void>;
};

function moduleDefinition(): HdlDefinitionSummary {
    return {
        key: 'module:file:///workspace/core.sv:0',
        kind: 'module',
        name: 'core',
        uri: 'file:///workspace/core.sv',
        declarationStart: 0,
        declarationLine: 1,
        parameters: [{ name: 'WIDTH', defaultExpression: '8' }],
        ports: [
            { name: 'clk', direction: 'input', width: { kind: 'known', bits: 1 } },
            { name: 'data_o', direction: 'output', width: { kind: 'known', bits: 8 } },
        ],
        dependencies: [],
        modelFingerprint: 'core-v1',
    };
}

function sourceDesign(overrides: Partial<ArchDesign> = {}): string {
    const design = {
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    } as ArchDesign;
    return serializeArchDesign(design);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        if (predicate()) return;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function createHarness(
    initialText: string,
    initialDefinitions: HdlDefinitionSummary[] = []
): Promise<ProviderHarness> {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const resource = FakeUri.parse('file:///workspace/soc.ad');
    let documentText = initialText;
    let documentVersion = 1;
    let messageListener: ((message: unknown) => void) | undefined;
    let documentListener: ((event: { document: typeof document }) => void) | undefined;
    let disposeListener: (() => void) | undefined;
    let invalidationListener: ((index?: object) => void) | undefined;
    let definitions = [...initialDefinitions];
    const messages: HostEvent[] = [];
    const diagnostics: ProviderHarness['diagnostics'] = [];
    const replacements: AppliedReplacement[] = [];
    const releasedOwners: object[] = [];
    const disposable = { dispose(): void {} };
    const document = {
        uri: resource,
        get version(): number { return documentVersion; },
        getText(): string { return documentText; },
        positionAt(offset: number): number { return offset; },
    };
    const panel = {
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-webview://schematic',
            asWebviewUri(uri: FakeUri): FakeUri { return uri; },
            async postMessage(event: HostEvent): Promise<boolean> {
                messages.push(event);
                return true;
            },
            onDidReceiveMessage(listener: (message: unknown) => void) {
                messageListener = listener;
                return disposable;
            },
        },
        onDidDispose(listener: () => void) {
            disposeListener = listener;
            return disposable;
        },
    };
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => disposable,
    };
    class WorkspaceEdit {
        readonly replacements: AppliedReplacement[] = [];

        replace(uri: FakeUri, range: { start: number; end: number }, text: string): void {
            this.replacements.push({
                uri: uri.toString(),
                start: range.start,
                end: range.end,
                text,
            });
        }
    }
    const vscodeStub = {
        Uri: FakeUri,
        WorkspaceEdit,
        Range: class {
            constructor(readonly start: number, readonly end: number) {}
        },
        Diagnostic: class {
            code?: string;
            source?: string;
            constructor(
                readonly range: unknown,
                readonly message: string,
                readonly severity: number
            ) {}
        },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
        languages: {
            createDiagnosticCollection() {
                return {
                    set(uri: FakeUri, items: unknown[]): void {
                        const value = uri.toString();
                        const next = diagnostics.filter(item => item.uri !== value);
                        next.push({ uri: value, count: items.length });
                        diagnostics.splice(0, diagnostics.length, ...next);
                    },
                    delete(uri: FakeUri): void {
                        const value = uri.toString();
                        diagnostics.splice(
                            0,
                            diagnostics.length,
                            ...diagnostics.filter(item => item.uri !== value)
                        );
                    },
                    dispose(): void {},
                };
            },
        },
        workspace: {
            fs: {
                async readFile(uri: FakeUri): Promise<Uint8Array> {
                    return fs.readFileSync(uri.fsPath);
                },
            },
            onDidChangeTextDocument(listener: typeof documentListener) {
                documentListener = listener;
                return disposable;
            },
            async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
                replacements.push(...edit.replacements);
                return true;
            },
        },
        window: {
            showErrorMessage(): Promise<undefined> { return Promise.resolve(undefined); },
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
        return request === 'vscode'
            ? vscodeStub
            : originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../archDesign/archDesignEditorProvider')];
    const { ArchDesignEditorProvider } = require(
        '../archDesign/archDesignEditorProvider'
    ) as {
        ArchDesignEditorProvider: new (context: unknown, services: unknown) => {
            resolveCustomTextEditor(
                document: unknown,
                panel: unknown,
                token: unknown
            ): Promise<void>;
        };
    };
    const context = {
        extensionUri: FakeUri.file(extensionRoot),
        subscriptions: [] as Array<{ dispose(): void }>,
    };
    const index = {
        getAllDefinitions(kind?: string): HdlDefinitionSummary[] {
            return definitions.filter(item => kind === undefined || item.kind === kind);
        },
    };
    const provider = new ArchDesignEditorProvider(context, {
        getIndex: async () => index,
        releaseIndex(owner: object): void { releasedOwners.push(owner); },
        onDidInvalidate(listener: (changed?: object) => void) {
            invalidationListener = listener;
            return {
                dispose(): void {
                    if (invalidationListener === listener) invalidationListener = undefined;
                },
            };
        },
    });
    await provider.resolveCustomTextEditor(document, panel, token);
    assert.ok(messageListener);
    messageListener!({ type: 'ready' });
    await waitFor(
        () => messages.some(event => event.type === 'archDesignState'),
        'initial Arch Design state'
    );

    return {
        messages,
        diagnostics,
        replacements,
        releasedOwners,
        setDefinitions(next): void { definitions = [...next]; },
        invalidateIndex(): void { invalidationListener?.(index); },
        send(message): void { messageListener?.(message); },
        changeDocument(text, version): void {
            documentText = text;
            documentVersion = version;
            documentListener?.({ document });
        },
        async dispose(): Promise<void> {
            disposeListener?.();
            await new Promise<void>(resolve => setImmediate(resolve));
            moduleLoader._load = originalLoad;
            delete require.cache[require.resolve('../archDesign/archDesignEditorProvider')];
        },
    };
}

async function testEditableLifecycleAndNativeEdit(): Promise<void> {
    const source = sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    });
    const harness = await createHarness(source, [moduleDefinition()]);
    try {
        const initialize = harness.messages.find(event => event.type === 'initialize');
        assert.ok(initialize?.type === 'initialize');
        assert.strictEqual(initialize.documentKind, 'arch-design');
        assert.strictEqual(initialize.editable, true);
        assert.deepStrictEqual(initialize.modules, [{
            key: 'arch-design:soc_top', name: 'soc_top',
        }]);
        const graph = harness.messages.find(event => event.type === 'graph');
        assert.ok(graph?.type === 'graph');
        assert.deepStrictEqual(
            graph.graph.nodes.find(node => node.id === 'instance:u_core')?.pins.map(pin => pin.name),
            ['clk', 'data_o']
        );
        const state = harness.messages.find(event => event.type === 'archDesignState');
        assert.ok(state?.type === 'archDesignState' && state.status === 'editable');
        if (state?.type !== 'archDesignState' || state.status !== 'editable') return;

        harness.send({
            type: 'editArchDesign',
            revision: 'stale',
            edit: { type: 'addPort', port: { name: 'ignored', direction: 'input' } },
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(harness.replacements.length, 0);

        harness.send({
            type: 'editArchDesign',
            revision: state.revision,
            edit: { type: 'addPort', port: { name: 'clk', direction: 'input' } },
        });
        await waitFor(() => harness.replacements.length === 1, 'native document edit');
        assert.deepStrictEqual(harness.replacements[0], {
            uri: 'file:///workspace/soc.ad',
            start: 0,
            end: source.length,
            text: harness.replacements[0].text,
        });
        const parsed = parseArchDesignText(harness.replacements[0].text);
        assert.strictEqual(parsed.status, 'editable');
        if (parsed.status === 'editable') {
            assert.deepStrictEqual(parsed.design.ports, [{ name: 'clk', direction: 'input' }]);
        }
    } finally {
        await harness.dispose();
    }
}

async function testInvalidTextRetainsLastValidGraph(): Promise<void> {
    const harness = await createHarness(sourceDesign(), []);
    try {
        const graphCount = harness.messages.filter(event => event.type === 'graph').length;
        harness.changeDocument('{ invalid', 2);
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'archDesignState' && event.status === 'invalid'
            ),
            'invalid state'
        );
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'graph').length,
            graphCount
        );
        assert.ok(harness.diagnostics.some(item => item.count > 0));
    } finally {
        await harness.dispose();
    }
}

async function testUnsupportedSchemaIsReadOnly(): Promise<void> {
    const source = JSON.stringify({
        format: 'vik-veriflow.arch-design',
        schemaVersion: 2,
        module: 'future',
    });
    const harness = await createHarness(source);
    try {
        const state = harness.messages.find(event => event.type === 'archDesignState');
        assert.ok(state?.type === 'archDesignState' && state.status === 'readonly');
        if (state?.type === 'archDesignState' && state.status === 'readonly') {
            assert.strictEqual(state.schemaVersion, 2);
        }
        assert.strictEqual(harness.messages.some(event => event.type === 'graph'), false);
        harness.send({
            type: 'editArchDesign',
            revision: state?.type === 'archDesignState' ? state.revision : 'missing',
            edit: { type: 'addPort', port: { name: 'clk', direction: 'input' } },
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(harness.replacements, []);
    } finally {
        await harness.dispose();
    }
}

async function testCatalogInvalidationAndDisposal(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }));
    try {
        const initialGraphs = harness.messages.filter(event => event.type === 'graph').length;
        const firstGraph = harness.messages.find(event => event.type === 'graph');
        assert.ok(firstGraph?.type === 'graph');
        assert.deepStrictEqual(
            firstGraph.graph.nodes.find(node => node.id === 'instance:u_core')?.pins,
            []
        );
        harness.setDefinitions([moduleDefinition()]);
        harness.invalidateIndex();
        await waitFor(
            () => harness.messages.filter(event => event.type === 'graph').length
                > initialGraphs,
            'catalog refresh graph'
        );
        const latest = harness.messages.filter(event => event.type === 'graph').at(-1);
        assert.ok(latest?.type === 'graph');
        assert.deepStrictEqual(
            latest.graph.nodes.find(node => node.id === 'instance:u_core')?.pins.map(
                pin => pin.name
            ),
            ['clk', 'data_o']
        );
    } finally {
        await harness.dispose();
    }
    assert.strictEqual(harness.releasedOwners.length, 1);
    assert.deepStrictEqual(harness.diagnostics, []);
}

async function testLayoutSavePersistsOnlyStableArchDesignNodes(): Promise<void> {
    const source = sourceDesign({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'result', direction: 'output' },
        ],
        instances: [{ name: 'u_core', module: 'core' }],
        connections: [{
            name: 'clock',
            endpoints: [
                { kind: 'port', port: 'clk' },
                { kind: 'instance', instance: 'u_core', port: 'clk' },
            ],
        }],
        defaults: { 'result.value': "1'b0" },
    });
    const harness = await createHarness(source, [moduleDefinition()]);
    try {
        const graphEvent = harness.messages.find(event => event.type === 'graph');
        assert.ok(graphEvent?.type === 'graph');
        if (graphEvent?.type !== 'graph') return;
        const layout = structuredClone(graphEvent.layout);
        layout.placement.nodes['instance:u_core'] = {
            column: 1,
            order: 0,
            yOffset: 24,
            fixed: true,
        };
        const constantNode = graphEvent.graph.nodes.find(node => node.kind === 'constant');
        assert.ok(constantNode);
        layout.placement.nodes[constantNode!.id] = {
            column: 1,
            order: 9,
            yOffset: 40,
            fixed: true,
        };
        layout.viewport = { x: -16, y: 32, zoom: 1.25 };

        harness.send({
            type: 'saveLayout',
            moduleKey: graphEvent.graph.moduleKey,
            revision: graphEvent.revision,
            layout,
        });
        await waitFor(() => harness.replacements.length === 1, 'layout document edit');
        const parsed = parseArchDesignText(harness.replacements[0].text);
        assert.strictEqual(parsed.status, 'editable');
        if (parsed.status !== 'editable') return;
        assert.deepStrictEqual(
            Object.keys(parsed.design.presentation.nodes ?? {}).sort(),
            ['instance:u_core', 'port:clk', 'port:result']
        );
        assert.deepStrictEqual(
            parsed.design.presentation.nodes?.['instance:u_core'],
            { column: 1, order: 0, offset: 24, userPositioned: true }
        );
        assert.deepStrictEqual(
            parsed.design.presentation.viewport,
            { x: -16, y: 32, zoom: 1.25 }
        );
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(
                parsed.design.presentation.nodes ?? {},
                constantNode!.id
            ),
            false
        );
    } finally {
        await harness.dispose();
    }
}

async function main(): Promise<void> {
    await testEditableLifecycleAndNativeEdit();
    await testInvalidTextRetainsLastValidGraph();
    await testUnsupportedSchemaIsReadOnly();
    await testCatalogInvalidationAndDisposal();
    await testLayoutSavePersistsOnlyStableArchDesignNodes();
    console.log('Arch Design editor provider tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
