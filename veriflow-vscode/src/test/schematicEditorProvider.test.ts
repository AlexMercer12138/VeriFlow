import * as assert from 'assert';
import Module = require('module');
import * as path from 'path';

import type { HdlDocument } from '../core/hdl/model';
import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import type { SchematicLayout } from '../schematic/layoutStore';
import { SchematicNavigationRegistry } from '../schematic/navigationRegistry';
import type { HostEvent } from '../schematic/protocol';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';

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

    get fsPath(): string {
        return this.path.replace(/^\/([A-Za-z]:\/)/, '$1').replace(/\//g, path.sep);
    }

    toString(): string {
        return `file://${this.path}`;
    }
}

type Gate = {
    started: Promise<void>;
    markStarted(): void;
    release: Promise<void>;
    allow(): void;
};

function createGate(): Gate {
    let markStarted!: () => void;
    let allow!: () => void;
    return {
        started: new Promise(resolve => { markStarted = resolve; }),
        markStarted,
        release: new Promise(resolve => { allow = resolve; }),
        allow,
    };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function offsetLayout(layout: SchematicLayout, yOffset: number): SchematicLayout {
    return {
        ...layout,
        placement: {
            nodes: Object.fromEntries(Object.entries(layout.placement.nodes).map(
                ([id, node]) => [id, {
                    ...node,
                    yOffset: node.yOffset + yOffset,
                    fixed: true,
                }]
            )),
        },
    };
}

type ProviderHarness = {
    messages: HostEvent[];
    moduleKeys: string[];
    shownText: Array<{ uri: string; selection: { start: number; end: number } }>;
    completedTextEffects: string[];
    openedSchematics: string[];
    focusEvents: string[];
    diagnostics: Array<{ uri: string; count: number }>;
    deletedDiagnosticUris: string[];
    parseCallCount(): number;
    storedValues(): unknown[];
    setParseGate(text: string, gate: Gate): void;
    setOpenTextGate(uri: string, gate: Gate): void;
    setShowTextGate(uri: string, gate: Gate): void;
    setDefinitionGate(definitionKey: string, gate: Gate): void;
    setIndexGate(gate: Gate): void;
    setPostGate(predicate: (event: HostEvent) => boolean, gate: Gate): void;
    setSaveGate(gate: Gate): void;
    setIndexDefinitions(definitions: HdlDefinitionSummary[]): void;
    invalidateIndex(): void;
    invalidateUnrelatedIndex(): void;
    send(message: unknown): void;
    changeDocument(text: string, version: number): void;
    focusedTextUri(): string | undefined;
    focusedSurface(): string | undefined;
    disposePanel(): void;
    dispose(): Promise<void>;
};

async function createProviderHarness(
    documentsByText: Map<string, HdlDocument>,
    initialText: string,
    initialParseRace?: {
        text: string;
        gate: Gate;
        replacement: HdlDocument;
    },
    options?: {
        failingUri?: string;
        waitForInitialGraph?: boolean;
        resourceUri?: string;
        navigation?: SchematicNavigationRegistry;
        cancelled?: boolean;
        executeCommand?(command: string, ...args: unknown[]): Promise<void>;
    }
): Promise<ProviderHarness> {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const resource = FakeUri.parse(options?.resourceUri ?? 'file:///workspace/design.sv');
    let documentText = initialText;
    let documentVersion = 1;
    let messageListener: ((message: unknown) => void) | undefined;
    let documentListener: ((event: { document: typeof document }) => void) | undefined;
    let disposeListener: (() => void) | undefined;
    let postGate: { predicate: (event: HostEvent) => boolean; gate: Gate } | undefined;
    let parseGate: { text: string; gate: Gate } | undefined = initialParseRace
        ? { text: initialParseRace.text, gate: initialParseRace.gate }
        : undefined;
    let saveGate: Gate | undefined;
    let indexGate: Gate | undefined;
    const openTextGates = new Map<string, Gate>();
    const showTextGates = new Map<string, Gate>();
    const definitionGates = new Map<string, Gate>();
    let indexInvalidationListener: ((index?: object) => void) | undefined;
    let indexDefinitions: HdlDefinitionSummary[] = [];
    let parseCalls = 0;
    const messages: HostEvent[] = [];
    const shownText: ProviderHarness['shownText'] = [];
    const completedTextEffects: string[] = [];
    let focusedTextUri: string | undefined;
    const openedSchematics: string[] = [];
    const focusEvents: string[] = [];
    let focusedSurface: string | undefined;
    const diagnostics: ProviderHarness['diagnostics'] = [];
    const deletedDiagnosticUris: string[] = [];
    const workspaceValues = new Map<string, unknown>();
    const disposable = { dispose(): void {} };
    const document = {
        uri: resource,
        get version(): number { return documentVersion; },
        getText(): string { return documentText; },
    };
    const panel = {
        active: true,
        viewColumn: 1,
        reveal(): void {
            focusedSurface = `schematic:${resource.toString()}`;
            focusEvents.push(focusedSurface);
        },
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-webview://schematic',
            asWebviewUri(uri: FakeUri): FakeUri { return uri; },
            async postMessage(event: HostEvent): Promise<boolean> {
                messages.push(event);
                const pending = postGate;
                if (pending?.predicate(event)) {
                    postGate = undefined;
                    pending.gate.markStarted();
                    await pending.gate.release;
                }
                return true;
            },
            onDidReceiveMessage(listener: (message: unknown) => void) {
                messageListener = listener;
                return disposable;
            },
        },
        onDidChangeViewState(
            _listener: (event: { webviewPanel: unknown }) => void
        ) {
            return disposable;
        },
        onDidDispose(listener: () => void) {
            disposeListener = listener;
            return disposable;
        },
    };
    const token = {
        isCancellationRequested: options?.cancelled ?? false,
        onCancellationRequested: () => disposable,
    };
    const vscodeStub = {
        Uri: FakeUri,
        Range: class {
            constructor(readonly start: number, readonly end: number) {}
        },
        Selection: class {
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
                        const next = diagnostics.filter(record => record.uri !== value);
                        next.push({ uri: value, count: items.length });
                        diagnostics.splice(0, diagnostics.length, ...next);
                    },
                    delete(uri: FakeUri): void {
                        const value = uri.toString();
                        deletedDiagnosticUris.push(value);
                        const next = diagnostics.filter(record => record.uri !== value);
                        diagnostics.splice(0, diagnostics.length, ...next);
                    },
                    dispose(): void {},
                };
            },
        },
        workspace: {
            async openTextDocument(uri: FakeUri) {
                if (uri.toString() === options?.failingUri) {
                    throw new Error(`Cannot open diagnostic source ${uri.toString()}`);
                }
                const gate = openTextGates.get(uri.toString());
                if (gate) {
                    openTextGates.delete(uri.toString());
                    gate.markStarted();
                    await gate.release;
                }
                return { uri, positionAt: (offset: number) => offset };
            },
            onDidChangeTextDocument(listener: typeof documentListener) {
                documentListener = listener;
                return disposable;
            },
        },
        window: {
            async showTextDocument(sourceDocument: { uri: FakeUri }) {
                const sourceUri = sourceDocument.uri.toString();
                const gate = showTextGates.get(sourceUri);
                if (gate) {
                    showTextGates.delete(sourceUri);
                    gate.markStarted();
                    await gate.release;
                }
                completedTextEffects.push(sourceUri);
                focusedTextUri = sourceUri;
                focusedSurface = `text:${sourceUri}`;
                focusEvents.push(focusedSurface);
                return {
                    selection: undefined as unknown,
                    revealRange(selection: { start: number; end: number }): void {
                        shownText.push({
                            uri: sourceDocument.uri.toString(),
                            selection: {
                                start: selection.start,
                                end: selection.end,
                            },
                        });
                    },
                };
            },
        },
        commands: {
            async executeCommand(command: string, ...args: unknown[]): Promise<void> {
                await options?.executeCommand?.(command, ...args);
                if (command === 'vscode.openWith' && args[0] instanceof FakeUri) {
                    const openedUri = args[0].toString();
                    openedSchematics.push(openedUri);
                    focusedSurface = `schematic:${openedUri}`;
                    focusEvents.push(focusedSurface);
                }
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
        return request === 'vscode'
            ? vscodeStub
            : originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../schematic/schematicEditorProvider')];
    const { SchematicEditorProvider } = require('../schematic/schematicEditorProvider') as {
        SchematicEditorProvider: new (
            context: unknown,
            navigation: unknown,
            services: unknown
        ) => {
            resolveCustomTextEditor(document: unknown, panel: unknown, token: unknown): Promise<void>;
        };
    };
    const context = {
        extensionUri: FakeUri.file(extensionRoot),
        subscriptions: [] as Array<{ dispose(): void }>,
        workspaceState: new class {
            get<T>(key: string): T | undefined {
                return workspaceValues.get(key) as T | undefined;
            }

            async update(key: string, value: unknown): Promise<void> {
                const pending = saveGate;
                if (pending) {
                    saveGate = undefined;
                    pending.markStarted();
                    await pending.release;
                }
                workspaceValues.set(key, value);
            }
        }(),
    };
    const navigation = options?.navigation ?? new SchematicNavigationRegistry();
    const index = {
        async parseOpenDocument(
            _uri: string,
            _version: number,
            text: string
        ): Promise<HdlDocument> {
            parseCalls++;
            const parsed = documentsByText.get(text);
            if (!parsed) throw new Error(`No parsed fixture for ${text}`);
            const pending = parseGate;
            if (pending?.text === text) {
                parseGate = undefined;
                pending.gate.markStarted();
                if (initialParseRace?.text === text) {
                    documentsByText.set(text, initialParseRace.replacement);
                    indexInvalidationListener!(index);
                    initialParseRace = undefined;
                }
                await pending.gate.release;
            }
            return parsed;
        },
        findDefinitions(name: string): HdlDefinitionSummary[] {
            return indexDefinitions.filter(definition => definition.name === name);
        },
        getDefinition(
            key: string
        ): HdlDefinitionSummary | undefined | Promise<HdlDefinitionSummary | undefined> {
            const definition = indexDefinitions.find(candidate => candidate.key === key);
            const gate = definitionGates.get(key);
            if (!gate) return definition;
            definitionGates.delete(key);
            gate.markStarted();
            return gate.release.then(() => definition);
        },
    };
    const provider = new SchematicEditorProvider(context, navigation, {
        getIndex: async () => {
            const pending = indexGate;
            if (pending) {
                indexGate = undefined;
                pending.markStarted();
                await pending.release;
            }
            return index;
        },
        onDidInvalidate(listener: (invalidatedIndex?: object) => void) {
            indexInvalidationListener = listener;
            return {
                dispose(): void {
                    if (indexInvalidationListener === listener) {
                        indexInvalidationListener = undefined;
                    }
                },
            };
        },
    });
    await provider.resolveCustomTextEditor(document, panel, token);
    assert.ok(messageListener);
    messageListener!({ type: 'ready' });
    if (options?.waitForInitialGraph !== false) {
        await waitFor(
            () => messages.some(event => event.type === 'graph'),
            'initial graph publication'
        );
    }
    const initialize = messages.find(event => event.type === 'initialize');
    if (options?.waitForInitialGraph !== false) {
        assert.ok(initialize && initialize.type === 'initialize');
    }
    const moduleKeys = initialize?.type === 'initialize'
        ? initialize.modules.map(module => module.key)
        : [];

    return {
        messages,
        moduleKeys,
        shownText,
        completedTextEffects,
        openedSchematics,
        focusEvents,
        diagnostics,
        deletedDiagnosticUris,
        parseCallCount(): number { return parseCalls; },
        storedValues(): unknown[] { return [...workspaceValues.values()]; },
        setParseGate(text, gate): void { parseGate = { text, gate }; },
        setOpenTextGate(uri, gate): void { openTextGates.set(uri, gate); },
        setShowTextGate(uri, gate): void { showTextGates.set(uri, gate); },
        setDefinitionGate(definitionKey, gate): void {
            definitionGates.set(definitionKey, gate);
        },
        setIndexGate(gate): void { indexGate = gate; },
        setPostGate(predicate, gate): void { postGate = { predicate, gate }; },
        setSaveGate(gate): void { saveGate = gate; },
        setIndexDefinitions(definitions): void { indexDefinitions = definitions; },
        invalidateIndex(): void { indexInvalidationListener!(index); },
        invalidateUnrelatedIndex(): void { indexInvalidationListener!({}); },
        send(message): void { messageListener!(message); },
        changeDocument(text, version): void {
            documentText = text;
            documentVersion = version;
            documentListener!({ document });
        },
        focusedTextUri(): string | undefined { return focusedTextUri; },
        focusedSurface(): string | undefined { return focusedSurface; },
        disposePanel(): void { disposeListener!(); },
        async dispose(): Promise<void> {
            disposeListener?.();
            moduleLoader._load = originalLoad;
            delete require.cache[require.resolve('../schematic/schematicEditorProvider')];
        },
    };
}

async function testWebviewSelectionRestoresFocusAfterInFlightTextEffect(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const firstUri = 'file:///workspace/first.sv';
    const text = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(sourceUri, text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const firstGate = createGate();
    try {
        harness.setShowTextGate(firstUri, firstGate);
        harness.send({
            type: 'revealSource',
            span: { uri: firstUri, start: 1, end: 2 },
        });
        await firstGate.started;

        const secondKey = harness.moduleKeys[1];
        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'graph' && event.graph.moduleKey === secondKey
            ),
            'newer selection graph before text effect completion'
        );
        firstGate.allow();
        await waitFor(
            () => harness.completedTextEffects.includes(firstUri),
            'in-flight text effect completion'
        );
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(harness.focusEvents, [
            `text:${firstUri}`,
            `schematic:${sourceUri}`,
        ]);
        assert.strictEqual(harness.focusedSurface(), `schematic:${sourceUri}`);
        const latestGraph = harness.messages.filter(event => event.type === 'graph').at(-1);
        assert.strictEqual(latestGraph?.type, 'graph');
        assert.strictEqual(latestGraph.graph.moduleKey, secondKey);
    } finally {
        firstGate.allow();
        await harness.dispose();
    }
}

async function testWebviewSelectionRestoresFocusAfterInFlightOpenEffect(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const targetUri = 'file:///workspace/target.sv';
    const text = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(sourceUri, text);
    const definition = indexedModule('target', targetUri, 0, 'a');
    const openGate = createGate();
    const harness = await createProviderHarness(
        new Map([[text, document]]),
        text,
        undefined,
        {
            async executeCommand(_command, uri): Promise<void> {
                if (uri instanceof FakeUri && uri.toString() === targetUri) {
                    openGate.markStarted();
                    await openGate.release;
                }
            },
        }
    );
    try {
        harness.setIndexDefinitions([definition]);
        harness.send({ type: 'openDefinition', definitionKey: definition.key });
        await openGate.started;

        const secondKey = harness.moduleKeys[1];
        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'graph' && event.graph.moduleKey === secondKey
            ),
            'newer selection graph before open effect completion'
        );
        openGate.allow();
        await waitFor(
            () => harness.openedSchematics.includes(targetUri),
            'in-flight schematic open completion'
        );
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(harness.focusEvents, [
            `schematic:${targetUri}`,
            `schematic:${sourceUri}`,
        ]);
        assert.strictEqual(harness.focusedSurface(), `schematic:${sourceUri}`);
        const latestGraph = harness.messages.filter(event => event.type === 'graph').at(-1);
        assert.strictEqual(latestGraph?.type, 'graph');
        assert.strictEqual(latestGraph.graph.moduleKey, secondKey);
    } finally {
        openGate.allow();
        await harness.dispose();
    }
}

async function testQueuedPanelSelectionReportsWhenNewerSelectionSkipsItsFocus(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const firstUri = 'file:///workspace/first.sv';
    const text = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(sourceUri, text);
    const navigation = new SchematicNavigationRegistry();
    const harness = await createProviderHarness(
        new Map([[text, document]]),
        text,
        undefined,
        { navigation }
    );
    const firstGate = createGate();
    try {
        harness.setShowTextGate(firstUri, firstGate);
        harness.send({
            type: 'revealSource',
            span: { uri: firstUri, start: 1, end: 2 },
        });
        await firstGate.started;

        const [firstKey, secondKey] = harness.moduleKeys;
        const skippedSelection = navigation.findPreferred(sourceUri)!.selectModule(secondKey);
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'graph' && event.graph.moduleKey === secondKey
            ),
            'queued target selection graph'
        );
        harness.send({ type: 'selectModule', moduleKey: firstKey });
        await waitFor(
            () => harness.messages.filter(event => event.type === 'graph').at(-1)
                ?.graph.moduleKey === firstKey,
            'newer target selection graph'
        );
        firstGate.allow();
        const executed = await skippedSelection;
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.strictEqual(executed, false);
        assert.deepStrictEqual(harness.focusEvents, [
            `text:${firstUri}`,
            `schematic:${sourceUri}`,
        ]);
        assert.strictEqual(harness.focusedSurface(), `schematic:${sourceUri}`);
    } finally {
        firstGate.allow();
        await harness.dispose();
    }
}

async function testInFlightTextEffectsCompleteInIntentOrder(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const firstUri = 'file:///workspace/first.sv';
    const secondUri = 'file:///workspace/second.sv';
    const text = 'module top; endmodule';
    const document = await parseWithRealWorker(sourceUri, text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const firstGate = createGate();
    try {
        harness.setShowTextGate(firstUri, firstGate);
        harness.send({
            type: 'revealSource',
            span: { uri: firstUri, start: 10, end: 20 },
        });
        await firstGate.started;

        harness.send({
            type: 'revealSource',
            span: { uri: secondUri, start: 30, end: 40 },
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        firstGate.allow();
        await waitFor(
            () => harness.completedTextEffects.length === 2,
            'ordered source reveal effects'
        );

        assert.deepStrictEqual(harness.completedTextEffects, [firstUri, secondUri]);
        assert.strictEqual(harness.focusedTextUri(), secondUri);
        assert.deepStrictEqual(harness.shownText, [{
            uri: secondUri,
            selection: { start: 30, end: 40 },
        }]);
    } finally {
        firstGate.allow();
        await harness.dispose();
    }
}

async function testInFlightOpenEffectsCompleteInIntentOrder(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const firstUri = 'file:///workspace/first.sv';
    const secondUri = 'file:///workspace/second.sv';
    const text = 'module top; endmodule';
    const document = await parseWithRealWorker(sourceUri, text);
    const firstDefinition = indexedModule('first', firstUri, 0, 'a');
    const secondDefinition = indexedModule('second', secondUri, 0, 'b');
    const firstGate = createGate();
    const harness = await createProviderHarness(
        new Map([[text, document]]),
        text,
        undefined,
        {
            async executeCommand(_command, uri): Promise<void> {
                if (uri instanceof FakeUri && uri.toString() === firstUri) {
                    firstGate.markStarted();
                    await firstGate.release;
                }
            },
        }
    );
    try {
        harness.setIndexDefinitions([firstDefinition, secondDefinition]);
        harness.send({ type: 'openDefinition', definitionKey: firstDefinition.key });
        await firstGate.started;

        harness.send({ type: 'openDefinition', definitionKey: secondDefinition.key });
        await new Promise<void>(resolve => setImmediate(resolve));
        firstGate.allow();
        await waitFor(
            () => harness.openedSchematics.length === 2,
            'ordered schematic open effects'
        );

        assert.deepStrictEqual(harness.openedSchematics, [firstUri, secondUri]);
    } finally {
        firstGate.allow();
        await harness.dispose();
    }
}

async function testRejectedInFlightOpenDoesNotPoisonNewerIntent(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const firstUri = 'file:///workspace/first.sv';
    const secondUri = 'file:///workspace/second.sv';
    const text = 'module top; endmodule';
    const document = await parseWithRealWorker(sourceUri, text);
    const firstDefinition = indexedModule('first', firstUri, 0, 'a');
    const secondDefinition = indexedModule('second', secondUri, 0, 'b');
    const firstGate = createGate();
    const harness = await createProviderHarness(
        new Map([[text, document]]),
        text,
        undefined,
        {
            async executeCommand(_command, uri): Promise<void> {
                if (uri instanceof FakeUri && uri.toString() === firstUri) {
                    firstGate.markStarted();
                    await firstGate.release;
                    throw new Error('stale vscode.openWith failed');
                }
            },
        }
    );
    try {
        harness.setIndexDefinitions([firstDefinition, secondDefinition]);
        harness.send({ type: 'openDefinition', definitionKey: firstDefinition.key });
        await firstGate.started;

        harness.send({ type: 'openDefinition', definitionKey: secondDefinition.key });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(harness.openedSchematics, []);
        firstGate.allow();
        await waitFor(
            () => harness.openedSchematics.includes(secondUri),
            'newer schematic open after stale rejection'
        );
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(harness.openedSchematics, [secondUri]);
        assert.deepStrictEqual(
            harness.messages.filter(event => event.type === 'hostError'),
            []
        );
    } finally {
        firstGate.allow();
        await harness.dispose();
    }
}

async function testRapidRevealSourceStopsStaleNavigation(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const firstUri = 'file:///workspace/first.sv';
    const secondUri = 'file:///workspace/second.sv';
    const text = 'module top; endmodule';
    const document = await parseWithRealWorker(sourceUri, text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const firstGate = createGate();
    try {
        harness.setOpenTextGate(firstUri, firstGate);
        harness.send({
            type: 'revealSource',
            span: { uri: firstUri, start: 10, end: 20 },
        });
        await firstGate.started;

        harness.send({
            type: 'revealSource',
            span: { uri: secondUri, start: 30, end: 40 },
        });
        await waitFor(
            () => harness.shownText.some(item => item.uri === secondUri),
            'newer source reveal'
        );
        firstGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(harness.shownText, [{
            uri: secondUri,
            selection: { start: 30, end: 40 },
        }]);
    } finally {
        firstGate.allow();
        await harness.dispose();
    }
}

async function testRapidOpenDefinitionStopsStaleNavigation(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const firstUri = 'file:///workspace/first.sv';
    const secondUri = 'file:///workspace/second.sv';
    const text = 'module top; endmodule';
    const document = await parseWithRealWorker(sourceUri, text);
    const firstDefinition = indexedModule('first', firstUri, 0, 'a');
    const secondDefinition = indexedModule('second', secondUri, 0, 'b');
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const firstGate = createGate();
    try {
        harness.setIndexDefinitions([firstDefinition, secondDefinition]);
        harness.setDefinitionGate(firstDefinition.key, firstGate);
        harness.send({ type: 'openDefinition', definitionKey: firstDefinition.key });
        await firstGate.started;

        harness.send({ type: 'openDefinition', definitionKey: secondDefinition.key });
        await waitFor(
            () => harness.openedSchematics.includes(secondUri),
            'newer schematic definition open'
        );
        firstGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(harness.openedSchematics, [secondUri]);
    } finally {
        firstGate.allow();
        await harness.dispose();
    }
}

async function testDisposalStopsNavigationAfterOwnedAwait(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const revealUri = 'file:///workspace/reveal.sv';
    const definitionUri = 'file:///workspace/definition.sv';
    const text = 'module top; endmodule';
    const document = await parseWithRealWorker(sourceUri, text);
    const definition = indexedModule('definition', definitionUri, 0, 'a');
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const revealGate = createGate();
    const definitionGate = createGate();
    try {
        harness.setIndexDefinitions([definition]);
        harness.setOpenTextGate(revealUri, revealGate);
        harness.send({
            type: 'revealSource',
            span: { uri: revealUri, start: 1, end: 2 },
        });
        await revealGate.started;

        harness.setDefinitionGate(definition.key, definitionGate);
        harness.send({ type: 'openDefinition', definitionKey: definition.key });
        await definitionGate.started;
        harness.disposePanel();
        revealGate.allow();
        definitionGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(
            {
                shownText: harness.shownText,
                openedSchematics: harness.openedSchematics,
                hostErrors: harness.messages.filter(event => event.type === 'hostError'),
            },
            { shownText: [], openedSchematics: [], hostErrors: [] }
        );
    } finally {
        revealGate.allow();
        definitionGate.allow();
        await harness.dispose();
    }
}

async function testWebviewSelectionSupersedesSlowReveal(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const revealUri = 'file:///workspace/reveal.sv';
    const text = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(sourceUri, text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const revealGate = createGate();
    try {
        harness.setOpenTextGate(revealUri, revealGate);
        harness.send({
            type: 'revealSource',
            span: { uri: revealUri, start: 1, end: 2 },
        });
        await revealGate.started;
        harness.send({ type: 'selectModule', moduleKey: harness.moduleKeys[1] });
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'graph'
                && event.graph.moduleKey === harness.moduleKeys[1]
            ),
            'newer Webview module selection'
        );
        revealGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(harness.shownText, []);
    } finally {
        revealGate.allow();
        await harness.dispose();
    }
}

async function testExternalPanelNavigationSupersedesSlowReveal(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const text = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(sourceUri, text);

    const revealNavigation = new SchematicNavigationRegistry();
    const revealHarness = await createProviderHarness(
        new Map([[text, document]]),
        text,
        undefined,
        { navigation: revealNavigation }
    );
    const revealGate = createGate();
    try {
        const revealUri = 'file:///workspace/reveal.sv';
        revealHarness.setOpenTextGate(revealUri, revealGate);
        revealHarness.send({
            type: 'revealSource',
            span: { uri: revealUri, start: 1, end: 2 },
        });
        await revealGate.started;
        revealNavigation.findPreferred(sourceUri)!.reveal();
        revealGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));
    } finally {
        revealGate.allow();
        await revealHarness.dispose();
    }

    const selectNavigation = new SchematicNavigationRegistry();
    const selectHarness = await createProviderHarness(
        new Map([[text, document]]),
        text,
        undefined,
        { navigation: selectNavigation }
    );
    const selectGate = createGate();
    try {
        const selectUri = 'file:///workspace/select.sv';
        selectHarness.setOpenTextGate(selectUri, selectGate);
        selectHarness.send({
            type: 'revealSource',
            span: { uri: selectUri, start: 3, end: 4 },
        });
        await selectGate.started;
        await selectNavigation.findPreferred(sourceUri)!.selectModule(
            selectHarness.moduleKeys[1]
        );
        selectGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual({
            revealed: revealHarness.shownText,
            selected: selectHarness.shownText,
        }, { revealed: [], selected: [] });
    } finally {
        selectGate.allow();
        await selectHarness.dispose();
    }
}

async function testDiagnosticSourceFailureDoesNotBlockGraph(): Promise<void> {
    const text = 'module top(input logic a); endmodule';
    const uri = 'file:///workspace/design.sv';
    const includedUri = 'file:///workspace/diagnostics.svh';
    const parsed = await parseWithRealWorker(uri, text);
    const document: HdlDocument = {
        ...parsed,
        diagnostics: [{
            severity: 'error',
            code: 'TEST_CURRENT',
            message: 'Current source diagnostic',
            span: { start: 1, end: 3 },
        }, {
            severity: 'warning',
            code: 'TEST_INCLUDED',
            message: 'Included source diagnostic',
            span: {
                start: 10,
                end: 20,
                compositeParts: [{ uri: includedUri, start: 4, end: 8 }],
            },
        }],
    };
    const harness = await createProviderHarness(
        new Map([[text, document]]),
        text,
        undefined,
        { failingUri: includedUri, waitForInitialGraph: false }
    );
    try {
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'graph' || event.type === 'hostError'
            ),
            'graph or diagnostic host error'
        );

        assert.ok(harness.messages.some(event => event.type === 'initialize'));
        assert.ok(harness.messages.some(event => event.type === 'graph'));
        assert.deepStrictEqual(
            harness.messages.filter(event => event.type === 'diagnostics').at(-1),
            { type: 'diagnostics', errors: 1, warnings: 1 }
        );
        assert.deepStrictEqual(
            harness.messages.filter(event => event.type === 'hostError'),
            []
        );
        assert.deepStrictEqual(harness.diagnostics, [{ uri, count: 1 }]);
        assert.ok(harness.deletedDiagnosticUris.includes(includedUri));
    } finally {
        await harness.dispose();
    }
}

async function testInitialParseReplaysTargetedIndexInvalidation(): Promise<void> {
    const source = 'module top(input logic selected_i); endmodule';
    const oldDocument = await parseWithRealWorker(
        'file:///workspace/design.sv',
        'module top(input logic old_include_i); endmodule'
    );
    const newDocument = await parseWithRealWorker(
        'file:///workspace/design.sv',
        'module top(input logic new_include_i); endmodule'
    );
    const documents = new Map<string, HdlDocument>([[source, oldDocument]]);
    const gate = createGate();
    const harnessPromise = createProviderHarness(documents, source, {
        text: source,
        gate,
        replacement: newDocument,
    });
    await gate.started;
    gate.allow();
    const harness = await harnessPromise;
    try {
        const latest = harness.messages.filter(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        ).at(-1)!;
        assert.ok(latest.graph.nodes.some(node => node.id === 'port:new_include_i'));
        assert.ok(!latest.graph.nodes.some(node => node.id === 'port:old_include_i'));
        assert.ok(harness.parseCallCount() >= 2);
    } finally {
        await harness.dispose();
    }
}

function indexedModule(
    name: string,
    uri: string,
    declarationStart: number,
    portName: string
): HdlDefinitionSummary {
    return {
        key: `module:${uri}:${declarationStart}`,
        kind: 'module',
        name,
        uri,
        declarationStart,
        declarationLine: 1,
        parameters: [],
        ports: [{
            name: portName,
            direction: 'input',
            width: { kind: 'known', bits: 1 },
        }],
        dependencies: [],
        modelFingerprint: `${name}:${portName}`,
    };
}

async function testFailedCrossFileOpenDoesNotRetainPendingSelection(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const targetUri = 'file:///workspace/target.sv';
    const sourceText = 'module source; endmodule';
    const targetText = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const sourceDocument = await parseWithRealWorker(sourceUri, sourceText);
    const targetDocument = await parseWithRealWorker(targetUri, targetText);
    const targetModule = targetDocument.modules.find(module => module.name === 'second')!;
    const targetKey = `module:${targetUri}:${targetModule.declarationSpan.start}`;
    const navigation = new SchematicNavigationRegistry();
    const sourceHarness = await createProviderHarness(
        new Map([[sourceText, sourceDocument]]),
        sourceText,
        undefined,
        {
            navigation,
            async executeCommand(): Promise<void> {
                throw new Error('vscode.openWith failed');
            },
        }
    );
    try {
        sourceHarness.setIndexDefinitions([
            indexedModule('second', targetUri, targetModule.declarationSpan.start, 'a'),
        ]);
        sourceHarness.send({ type: 'openDefinition', definitionKey: targetKey });
        await waitFor(
            () => sourceHarness.messages.some(event => event.type === 'hostError'),
            'failed cross-file schematic open'
        );
    } finally {
        await sourceHarness.dispose();
    }

    const targetHarness = await createProviderHarness(
        new Map([[targetText, targetDocument]]),
        targetText,
        undefined,
        { resourceUri: targetUri, navigation }
    );
    try {
        const latest = targetHarness.messages.filter(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph'
        ).at(-1)!;
        assert.strictEqual(latest.graph.moduleName, 'first');
    } finally {
        await targetHarness.dispose();
    }
}

async function testInitialTargetParseFailureClearsPendingSelection(): Promise<void> {
    const targetUri = 'file:///workspace/target.sv';
    const targetText = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const targetDocument = await parseWithRealWorker(targetUri, targetText);
    const secondModule = targetDocument.modules.find(module => module.name === 'second')!;
    const secondKey = `module:${targetUri}:${secondModule.declarationSpan.start}`;
    const navigation = new SchematicNavigationRegistry();
    navigation.setPending(targetUri, secondKey);

    const failedHarness = await createProviderHarness(
        new Map(),
        targetText,
        undefined,
        {
            resourceUri: targetUri,
            navigation,
            waitForInitialGraph: false,
        }
    );
    const reopenedHarness = await createProviderHarness(
        new Map([[targetText, targetDocument]]),
        targetText,
        undefined,
        { resourceUri: targetUri, navigation }
    );
    try {
        const latest = reopenedHarness.messages.filter(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph'
        ).at(-1)!;
        assert.strictEqual(latest.graph.moduleName, 'first');
    } finally {
        await reopenedHarness.dispose();
        await failedHarness.dispose();
    }
}

async function testPreCancelledTargetClearsPendingSelection(): Promise<void> {
    const targetUri = 'file:///workspace/target.sv';
    const targetText = [
        'module first; endmodule',
        'module second; endmodule',
    ].join('\n');
    const targetDocument = await parseWithRealWorker(targetUri, targetText);
    const secondModule = targetDocument.modules.find(module => module.name === 'second')!;
    const secondKey = `module:${targetUri}:${secondModule.declarationSpan.start}`;
    const navigation = new SchematicNavigationRegistry();
    navigation.setPending(targetUri, secondKey);

    const cancelledHarness = await createProviderHarness(
        new Map([[targetText, targetDocument]]),
        targetText,
        undefined,
        {
            resourceUri: targetUri,
            navigation,
            cancelled: true,
            waitForInitialGraph: false,
        }
    );
    const reopenedHarness = await createProviderHarness(
        new Map([[targetText, targetDocument]]),
        targetText,
        undefined,
        { resourceUri: targetUri, navigation }
    );
    try {
        const latest = reopenedHarness.messages.filter(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph'
        ).at(-1)!;
        assert.strictEqual(latest.graph.moduleName, 'first');
    } finally {
        await reopenedHarness.dispose();
        await cancelledHarness.dispose();
    }
}

async function testDisposedOldOpenCannotClearNewerSameKeyPending(): Promise<void> {
    const sourceUri = 'file:///workspace/design.sv';
    const targetUri = 'file:///workspace/target.sv';
    const sourceText = 'module source; endmodule';
    const sourceDocument = await parseWithRealWorker(sourceUri, sourceText);
    const targetDefinition = indexedModule('target', targetUri, 0, 'a');
    const navigation = new SchematicNavigationRegistry();
    const openGate = createGate();
    const sourceHarness = await createProviderHarness(
        new Map([[sourceText, sourceDocument]]),
        sourceText,
        undefined,
        {
            navigation,
            async executeCommand(): Promise<void> {
                openGate.markStarted();
                await openGate.release;
                throw new Error('stale vscode.openWith failed');
            },
        }
    );
    try {
        sourceHarness.setIndexDefinitions([targetDefinition]);
        sourceHarness.send({
            type: 'openDefinition',
            definitionKey: targetDefinition.key,
        });
        await openGate.started;

        navigation.setPending(targetUri, targetDefinition.key);
        sourceHarness.disposePanel();
        openGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.strictEqual(
            navigation.consumePending(targetUri),
            targetDefinition.key
        );
    } finally {
        openGate.allow();
        await sourceHarness.dispose();
    }
}

async function testUnsavedLocalDefinitionPreservesExternalAmbiguity(): Promise<void> {
    const initialText = [
        'module top(input logic a);',
        '    added_child u_child(.a(a));',
        'endmodule',
    ].join('\n');
    const updatedText = [
        initialText,
        'module added_child(input logic a); endmodule',
    ].join('\n');
    const documents = new Map<string, HdlDocument>([
        [initialText, await parseWithRealWorker('file:///workspace/design.sv', initialText)],
        [updatedText, await parseWithRealWorker('file:///workspace/design.sv', updatedText)],
    ]);
    const harness = await createProviderHarness(documents, initialText);
    try {
        harness.setIndexDefinitions([
            indexedModule('added_child', 'file:///library/added_child.sv', 0, 'a'),
        ]);
        const start = harness.messages.length;
        harness.changeDocument(updatedText, 2);
        await waitFor(
            () => harness.messages.slice(start).some(event => event.type === 'graph'),
            'graph after unsaved local module addition'
        );

        const graph = harness.messages.slice(start).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        )!;
        const instance = graph.graph.nodes.find(node => node.id === 'instance:u_child')!;
        assert.strictEqual(instance.definitionKey, undefined);
        assert.deepStrictEqual(instance.pins, []);
    } finally {
        await harness.dispose();
    }
}

async function testUnsavedSameDocumentRenameUsesLiveDefinition(): Promise<void> {
    const initialText = [
        'module top(input logic a);',
        '    old_child u_child(.a(a));',
        'endmodule',
        'module old_child(input logic a); endmodule',
    ].join('\n');
    const updatedText = initialText.replace(/old_child/g, 'new_child');
    const updatedDocument = await parseWithRealWorker(
        'file:///workspace/design.sv',
        updatedText
    );
    const documents = new Map<string, HdlDocument>([
        [initialText, await parseWithRealWorker('file:///workspace/design.sv', initialText)],
        [updatedText, updatedDocument],
    ]);
    const harness = await createProviderHarness(documents, initialText);
    try {
        const start = harness.messages.length;
        harness.changeDocument(updatedText, 2);
        await waitFor(
            () => harness.messages.slice(start).some(event => event.type === 'graph'),
            'graph after unsaved same-document rename'
        );

        const graph = harness.messages.slice(start).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        )!;
        const instance = graph.graph.nodes.find(node => node.id === 'instance:u_child')!;
        const live = updatedDocument.modules.find(module => module.name === 'new_child')!;
        assert.strictEqual(
            instance.definitionKey,
            `module:file:///workspace/design.sv:${live.declarationSpan.start}`
        );
        assert.deepStrictEqual(instance.pins.map(pin => pin.name), ['a']);

        const liveDefinitionKey = instance.definitionKey!;
        const navigationStart = harness.messages.length;
        harness.send({ type: 'openDefinition', definitionKey: liveDefinitionKey });
        await waitFor(
            () => graphModuleKeys(harness.messages.slice(navigationStart))
                .includes(liveDefinitionKey),
            'live same-file definition selection'
        );
    } finally {
        await harness.dispose();
    }
}

async function testLayoutIntentRemainsScopedToItsModuleWhileSaveIsPending(): Promise<void> {
    const text = [
        'module first(input logic first_i); endmodule',
        'module second(input logic second_i); endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const firstSaveGate = createGate();
    try {
        const [firstKey, secondKey] = harness.moduleKeys;
        const firstGraph = harness.messages.find(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph' && event.graph.moduleKey === firstKey
        )!;
        const firstLayout = offsetLayout(firstGraph.layout, 777);
        harness.setSaveGate(firstSaveGate);
        harness.send({
            type: 'saveLayout',
            moduleKey: firstKey,
            revision: firstGraph.revision,
            layout: firstLayout,
        });
        await firstSaveGate.started;

        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await waitFor(
            () => graphModuleKeys(harness.messages).at(-1) === secondKey,
            'second module selection'
        );
        harness.send({ type: 'relayoutAll', moduleKey: secondKey });

        const start = harness.messages.length;
        harness.send({ type: 'selectModule', moduleKey: firstKey });
        await waitFor(
            () => graphModuleKeys(harness.messages.slice(start)).includes(firstKey),
            'first module reselection while its save is pending'
        );
        const reselected = harness.messages.slice(start).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph' && event.graph.moduleKey === firstKey
        )!;
        assert.deepStrictEqual(reselected.layout, firstLayout);
    } finally {
        firstSaveGate.allow();
        await harness.dispose();
    }
}

async function testRepeatedReadyPublishesLatestAcceptedLayout(): Promise<void> {
    const text = 'module top(input logic a); endmodule';
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    try {
        const moduleKey = harness.moduleKeys[0];
        const initial = harness.messages.find(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        )!;
        const accepted = {
            ...initial.layout,
            viewport: { x: 321, y: 654, zoom: 1.75 },
            minimap: !initial.layout.minimap,
        };
        harness.send({
            type: 'saveLayout',
            moduleKey,
            revision: initial.revision,
            layout: accepted,
        });
        await new Promise<void>(resolve => setImmediate(resolve));

        const start = harness.messages.length;
        harness.send({ type: 'ready' });
        await waitFor(
            () => harness.messages.slice(start).some(event => event.type === 'graph'),
            'repeated ready graph publication'
        );
        const replayed = harness.messages.slice(start).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        )!;
        assert.deepStrictEqual(replayed.layout, accepted);
    } finally {
        await harness.dispose();
    }
}

async function testIndexInvalidationRefreshesAndSupersedesInFlightConfiguration(): Promise<void> {
    const source = [
        '`ifdef FEATURE_A',
        'module top(input logic feature_a_i); endmodule',
        '`else',
        'module top(input logic feature_b_i); endmodule',
        '`endif',
    ].join('\n');
    const initial = await parseWithRealWorker(
        'file:///workspace/design.sv',
        'module top(input logic initial_i); endmodule'
    );
    const featureA = await parseWithRealWorker(
        'file:///workspace/design.sv',
        'module top(input logic feature_a_i); endmodule'
    );
    const featureB = await parseWithRealWorker(
        'file:///workspace/design.sv',
        'module top(input logic feature_b_i); endmodule'
    );
    const documents = new Map<string, HdlDocument>([[source, initial]]);
    const harness = await createProviderHarness(documents, source);
    try {
        const unrelatedStart = harness.messages.length;
        harness.invalidateUnrelatedIndex();
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(harness.messages.slice(unrelatedStart), []);

        const gate = createGate();
        harness.setParseGate(source, gate);
        documents.set(source, featureA);
        const start = harness.messages.length;
        harness.invalidateIndex();
        await gate.started;

        documents.set(source, featureB);
        harness.invalidateIndex();
        await waitFor(
            () => harness.messages.slice(start).some(event =>
                event.type === 'graph'
                && event.graph.nodes.some(node => node.id === 'port:feature_b_i')
            ),
            'new configuration graph after index invalidation'
        );
        gate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        const published = harness.messages.slice(start).filter(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        );
        assert.strictEqual(published.length, 1);
        assert.ok(published[0].graph.nodes.some(node => node.id === 'port:feature_b_i'));
        assert.ok(!published[0].graph.nodes.some(node => node.id === 'port:feature_a_i'));
    } finally {
        await harness.dispose();
    }
}

async function testSelectionDuringRefreshPublishesRefreshedIntent(): Promise<void> {
    const firstText = [
        'module first(input logic old_first_i); endmodule',
        'module second(input logic old_second_i); endmodule',
    ].join('\n');
    const refreshedText = [
        'module first(input logic new_first_i); endmodule',
        'module second(input logic new_second_i); endmodule',
    ].join('\n');
    const documents = new Map<string, HdlDocument>([
        [firstText, await parseWithRealWorker('file:///workspace/design.sv', firstText)],
        [refreshedText, await parseWithRealWorker(
            'file:///workspace/design.sv',
            refreshedText
        )],
    ]);
    const harness = await createProviderHarness(documents, firstText);
    try {
        const secondKey = harness.moduleKeys[1];
        const parseGate = createGate();
        harness.setParseGate(refreshedText, parseGate);
        const start = harness.messages.length;

        harness.changeDocument(refreshedText, 2);
        await parseGate.started;
        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await waitFor(
            () => harness.messages.slice(start).some(event =>
                event.type === 'graph'
                && event.graph.moduleKey === secondKey
                && event.graph.nodes.some(node => node.id === 'port:old_second_i')
            ),
            'selection against pre-refresh document'
        );
        parseGate.allow();

        await waitFor(
            () => harness.messages.slice(start).some(event =>
                event.type === 'graph'
                && event.graph.moduleKey === secondKey
                && event.graph.nodes.some(node => node.id === 'port:new_second_i')
            ),
            'selected module from refreshed document'
        );
        const latest = harness.messages.filter(event => event.type === 'graph').at(-1);
        assert.ok(latest?.type === 'graph');
        assert.strictEqual(latest.graph.moduleKey, secondKey);
        assert.ok(latest.graph.nodes.some(node => node.id === 'port:new_second_i'));
    } finally {
        await harness.dispose();
    }
}

async function testRelayoutDuringRefreshPublishesRefreshedGraph(): Promise<void> {
    const firstText = 'module top(input logic a); endmodule';
    const refreshedText = 'module top(input logic a, output logic b); endmodule';
    const documents = new Map<string, HdlDocument>([
        [firstText, await parseWithRealWorker('file:///workspace/design.sv', firstText)],
        [refreshedText, await parseWithRealWorker(
            'file:///workspace/design.sv',
            refreshedText
        )],
    ]);
    const harness = await createProviderHarness(documents, firstText);
    let relayoutSaveGate: Gate | undefined;
    try {
        const moduleKey = harness.moduleKeys[0];
        const initialGraph = harness.messages.find(event => event.type === 'graph');
        assert.ok(initialGraph?.type === 'graph');
        const pinnedLayout = offsetLayout(initialGraph.layout, 1000);
        const initialSaveGate = createGate();
        harness.setSaveGate(initialSaveGate);
        harness.send({
            type: 'saveLayout',
            moduleKey,
            revision: initialGraph.revision,
            layout: pinnedLayout,
        });
        await initialSaveGate.started;
        initialSaveGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        const parseGate = createGate();
        harness.setParseGate(refreshedText, parseGate);
        const start = harness.messages.length;

        harness.changeDocument(refreshedText, 2);
        await parseGate.started;
        relayoutSaveGate = createGate();
        harness.setSaveGate(relayoutSaveGate);
        harness.send({ type: 'relayoutAll', moduleKey });
        await relayoutSaveGate.started;
        parseGate.allow();

        await waitFor(
            () => harness.messages.slice(start).some(event =>
                event.type === 'graph'
                && event.graph.nodes.some(node => node.id === 'port:b')
            ),
            'relayout intent on refreshed document'
        );
        const latest = harness.messages.filter(event => event.type === 'graph').at(-1);
        assert.ok(latest?.type === 'graph');
        assert.ok(latest.graph.nodes.some(node => node.id === 'port:b'));
        assert.strictEqual(latest.layout.placement.nodes['port:a'].fixed, false);
        assert.notDeepStrictEqual(
            latest.layout.placement.nodes['port:a'],
            pinnedLayout.placement.nodes['port:a']
        );
        relayoutSaveGate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));
    } finally {
        relayoutSaveGate?.allow();
        await harness.dispose();
    }
}

async function testDelayedSaveRebasesOntoCurrentGraphRevision(): Promise<void> {
    const firstText = 'module top(input logic shared_i); endmodule';
    const refreshedText = [
        'module top(input logic shared_i, output logic new_o);',
        'endmodule',
    ].join('\n');
    const documents = new Map<string, HdlDocument>([
        [firstText, await parseWithRealWorker('file:///workspace/design.sv', firstText)],
        [refreshedText, await parseWithRealWorker(
            'file:///workspace/design.sv',
            refreshedText
        )],
    ]);
    const harness = await createProviderHarness(documents, firstText);
    try {
        const oldEvent = harness.messages.filter(event => event.type === 'graph').at(-1);
        assert.ok(oldEvent?.type === 'graph');
        assert.ok(oldEvent.revision.length > 0);
        const oldLayout = offsetLayout(oldEvent.layout, 123);

        harness.changeDocument(refreshedText, 2);
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'graph'
                && event.graph.nodes.some(node => node.id === 'port:new_o')
            ),
            'same-module refreshed graph'
        );
        const newEvent = harness.messages.filter(event => event.type === 'graph').at(-1);
        assert.ok(newEvent?.type === 'graph');
        assert.notStrictEqual(newEvent.revision, oldEvent.revision);

        const rebaseStart = harness.messages.length;
        const saveGate = createGate();
        harness.setSaveGate(saveGate);
        harness.send({
            type: 'saveLayout',
            moduleKey: oldEvent.graph.moduleKey,
            revision: oldEvent.revision,
            layout: oldLayout,
        });
        await saveGate.started;
        saveGate.allow();
        await waitFor(
            () => harness.messages.slice(rebaseStart).some(event =>
                event.type === 'graph' && event.revision !== newEvent.revision
            ),
            'stale layout rebased onto current graph'
        );

        const stored = harness.storedValues().at(-1) as {
            schemaVersion: number;
            placement: { nodes: Record<string, unknown> };
        };
        assert.strictEqual(stored.schemaVersion, 2);
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(
                stored.placement.nodes,
                'port:shared_i'
            ),
            true
        );
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(stored.placement.nodes, 'port:new_o'),
            false
        );
        const rebased = harness.messages.slice(rebaseStart).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph' && event.revision !== newEvent.revision
        )!;
        assert.notStrictEqual(rebased.revision, oldEvent.revision);
        assert.ok(rebased.graph.nodes.some(node => node.id === 'port:new_o'));
        assert.strictEqual(
            rebased.layout.placement.nodes['port:shared_i'].fixed,
            true
        );
        assert.strictEqual(
            rebased.layout.placement.nodes['port:shared_i'].yOffset,
            oldLayout.placement.nodes['port:shared_i'].yOffset
        );

        const replayStart = harness.messages.length;
        harness.send({ type: 'ready' });
        await waitFor(
            () => harness.messages.slice(replayStart).some(event => event.type === 'graph'),
            'current graph replay after delayed old save'
        );
        const replayed = harness.messages.slice(replayStart).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph'
        )!;
        assert.strictEqual(replayed.revision, rebased.revision);
        assert.ok(replayed.graph.nodes.some(node => node.id === 'port:new_o'));
        assert.deepStrictEqual(replayed.layout, rebased.layout);

        const currentLayout = {
            ...rebased.layout,
            viewport: { x: 91, y: 37, zoom: 1.5 },
        };
        harness.send({
            type: 'saveLayout',
            moduleKey: newEvent.graph.moduleKey,
            revision: rebased.revision,
            layout: currentLayout,
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        const afterCurrentSave = JSON.stringify(harness.storedValues());
        harness.send({
            type: 'saveLayout',
            moduleKey: oldEvent.graph.moduleKey,
            revision: oldEvent.revision,
            layout: oldLayout,
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(JSON.stringify(harness.storedValues()), afterCurrentSave);

        const beforeUnknown = JSON.stringify(harness.storedValues());
        harness.send({
            type: 'saveLayout',
            moduleKey: rebased.graph.moduleKey,
            revision: 'unknown-snapshot-revision',
            layout: rebased.layout,
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(JSON.stringify(harness.storedValues()), beforeUnknown);
    } finally {
        await harness.dispose();
    }
}

async function testDelayedSaveRebasesAfterModuleRoundTrip(): Promise<void> {
    const text = [
        'module first(input logic first_i); endmodule',
        'module second(input logic second_i); endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    try {
        const [firstKey, secondKey] = harness.moduleKeys;
        const firstEvent = harness.messages.find(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph' && event.graph.moduleKey === firstKey
        )!;
        const delayedLayout = offsetLayout(firstEvent.layout, 144);

        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await waitFor(
            () => graphModuleKeys(harness.messages).at(-1) === secondKey,
            'second module before delayed save'
        );
        const returnStart = harness.messages.length;
        harness.send({ type: 'selectModule', moduleKey: firstKey });
        await waitFor(
            () => graphModuleKeys(harness.messages.slice(returnStart)).includes(firstKey),
            'first module before delayed save'
        );
        const returned = harness.messages.filter(event =>
            event.type === 'graph' && event.graph.moduleKey === firstKey
        ).at(-1);
        assert.ok(returned?.type === 'graph');
        assert.notStrictEqual(returned.revision, firstEvent.revision);

        const rebaseStart = harness.messages.length;
        harness.send({
            type: 'saveLayout',
            moduleKey: firstKey,
            revision: firstEvent.revision,
            layout: delayedLayout,
        });
        await waitFor(
            () => harness.messages.slice(rebaseStart).some(event =>
                event.type === 'graph'
                && event.graph.moduleKey === firstKey
                && event.revision !== returned.revision
            ),
            'first module rebase after round trip'
        );
        const rebased = harness.messages.filter(event =>
            event.type === 'graph' && event.graph.moduleKey === firstKey
        ).at(-1);
        assert.ok(rebased?.type === 'graph');
        assert.strictEqual(
            rebased.layout.placement.nodes['port:first_i'].fixed,
            true
        );
        assert.strictEqual(
            rebased.layout.placement.nodes['port:first_i'].yOffset,
            delayedLayout.placement.nodes['port:first_i'].yOffset
        );
    } finally {
        await harness.dispose();
    }
}

async function testDelayedSaveDoesNotRebaseOntoOutgoingGraphDuringSelection(): Promise<void> {
    const text = [
        'module first(input logic first_i); endmodule',
        'module second(input logic second_i); endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const indexGate = createGate();
    const saveGate = createGate();
    try {
        const [firstKey, secondKey] = harness.moduleKeys;
        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await waitFor(
            () => graphModuleKeys(harness.messages).at(-1) === secondKey,
            'second module before delayed save race'
        );
        const oldSecond = harness.messages.filter(event =>
            event.type === 'graph' && event.graph.moduleKey === secondKey
        ).at(-1);
        assert.ok(oldSecond?.type === 'graph');

        harness.send({ type: 'selectModule', moduleKey: firstKey });
        await waitFor(
            () => graphModuleKeys(harness.messages).at(-1) === firstKey,
            'first module before delayed save race'
        );

        harness.setIndexGate(indexGate);
        harness.setSaveGate(saveGate);
        const start = harness.messages.length;
        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await indexGate.started;
        harness.send({
            type: 'saveLayout',
            moduleKey: secondKey,
            revision: oldSecond.revision,
            layout: oldSecond.layout,
        });
        await saveGate.started;
        saveGate.allow();
        await waitFor(
            () => harness.storedValues().length > 0,
            'delayed save completion during module selection'
        );
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(graphModuleKeys(harness.messages.slice(start)), []);

        indexGate.allow();
        await waitFor(
            () => graphModuleKeys(harness.messages.slice(start)).includes(secondKey),
            'selected module graph after delayed save race'
        );
        assert.deepStrictEqual(
            graphModuleKeys(harness.messages.slice(start)),
            [secondKey]
        );
    } finally {
        saveGate.allow();
        indexGate.allow();
        await harness.dispose();
    }
}

function graphModuleKeys(messages: HostEvent[]): string[] {
    return messages.flatMap(event => event.type === 'graph' ? [event.graph.moduleKey] : []);
}

async function testRapidSelectionStopsStalePublish(): Promise<void> {
    const text = [
        'module first(input logic first_i); endmodule',
        'module second(input logic second_i); endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    try {
        const [firstKey, secondKey] = harness.moduleKeys;
        const gate = createGate();
        harness.setPostGate(
            event => event.type === 'initialize' && event.selectedModuleKey === secondKey,
            gate
        );
        const start = harness.messages.length;
        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await gate.started;
        harness.send({ type: 'selectModule', moduleKey: firstKey });
        await waitFor(
            () => graphModuleKeys(harness.messages.slice(start)).includes(firstKey),
            'newer selection graph'
        );
        gate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(
            graphModuleKeys(harness.messages.slice(start)),
            [firstKey]
        );
    } finally {
        await harness.dispose();
    }
}

async function testRapidRefreshStopsStalePublish(): Promise<void> {
    const firstText = 'module top(input logic first_i); endmodule';
    const secondText = 'module top(input logic second_i); endmodule';
    const thirdText = 'module top(input logic third_i); endmodule';
    const documents = new Map<string, HdlDocument>([
        [firstText, await parseWithRealWorker('file:///workspace/design.sv', firstText)],
        [secondText, await parseWithRealWorker('file:///workspace/design.sv', secondText)],
        [thirdText, await parseWithRealWorker('file:///workspace/design.sv', thirdText)],
    ]);
    const harness = await createProviderHarness(documents, firstText);
    try {
        const gate = createGate();
        harness.setPostGate(event => event.type === 'initialize', gate);
        const start = harness.messages.length;
        harness.changeDocument(secondText, 2);
        await gate.started;
        harness.changeDocument(thirdText, 3);
        await waitFor(
            () => harness.messages.slice(start).some(event =>
                event.type === 'graph'
                && event.graph.nodes.some(node => node.id === 'port:third_i')
            ),
            'newer refresh graph'
        );
        gate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.strictEqual(
            harness.messages.slice(start).filter(event => event.type === 'graph').length,
            1
        );
    } finally {
        await harness.dispose();
    }
}

async function testDisposalStopsPublishAfterAwait(): Promise<void> {
    const text = [
        'module first(input logic first_i); endmodule',
        'module second(input logic second_i); endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    const gate = createGate();
    const secondKey = harness.moduleKeys[1];
    harness.setPostGate(
        event => event.type === 'initialize' && event.selectedModuleKey === secondKey,
        gate
    );
    const start = harness.messages.length;
    harness.send({ type: 'selectModule', moduleKey: secondKey });
    await gate.started;
    harness.disposePanel();
    gate.allow();
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.deepStrictEqual(graphModuleKeys(harness.messages.slice(start)), []);
    await harness.dispose();
}

async function testRelayoutSaveCannotPublishNewerMutableState(): Promise<void> {
    const text = [
        'module first(input logic first_i); endmodule',
        'module second(input logic second_i); endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    try {
        const [firstKey, secondKey] = harness.moduleKeys;
        const gate = createGate();
        harness.setSaveGate(gate);
        const start = harness.messages.length;
        harness.send({ type: 'relayoutAll', moduleKey: firstKey });
        await gate.started;
        harness.send({ type: 'selectModule', moduleKey: secondKey });
        await waitFor(
            () => graphModuleKeys(harness.messages.slice(start)).includes(secondKey),
            'newer selection during relayout save'
        );
        gate.allow();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.deepStrictEqual(
            graphModuleKeys(harness.messages.slice(start)),
            [secondKey]
        );
    } finally {
        await harness.dispose();
    }
}

async function testRelayoutRejectsDelayedSaveFromPreviousRevision(): Promise<void> {
    const text = 'module top(input logic a); endmodule';
    const document = await parseWithRealWorker('file:///workspace/design.sv', text);
    const harness = await createProviderHarness(new Map([[text, document]]), text);
    try {
        const initial = harness.messages.find(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        )!;
        const delayedLayout = {
            ...initial.layout,
            viewport: { x: 701, y: 702, zoom: 1.75 },
        };
        const start = harness.messages.length;

        harness.send({ type: 'relayoutAll', moduleKey: initial.graph.moduleKey });
        await waitFor(
            () => harness.messages.slice(start).some(event => event.type === 'graph'),
            'relayout graph publication'
        );
        const relayout = harness.messages.slice(start).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> => event.type === 'graph'
        )!;
        assert.notStrictEqual(relayout.revision, initial.revision);
        const storedAfterRelayout = JSON.stringify(harness.storedValues());

        harness.send({
            type: 'saveLayout',
            moduleKey: initial.graph.moduleKey,
            revision: initial.revision,
            layout: delayedLayout,
        });
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.strictEqual(JSON.stringify(harness.storedValues()), storedAfterRelayout);
        const replayStart = harness.messages.length;
        harness.send({ type: 'ready' });
        await waitFor(
            () => harness.messages.slice(replayStart).some(event => event.type === 'graph'),
            'relayout replay after delayed save'
        );
        const replayed = harness.messages.slice(replayStart).find(
            (event): event is Extract<HostEvent, { type: 'graph' }> =>
                event.type === 'graph'
        )!;
        assert.strictEqual(replayed.revision, relayout.revision);
        assert.deepStrictEqual(replayed.layout, relayout.layout);
    } finally {
        await harness.dispose();
    }
}

void testWebviewSelectionRestoresFocusAfterInFlightTextEffect()
    .then(testWebviewSelectionRestoresFocusAfterInFlightOpenEffect)
    .then(testQueuedPanelSelectionReportsWhenNewerSelectionSkipsItsFocus)
    .then(testRejectedInFlightOpenDoesNotPoisonNewerIntent)
    .then(testInFlightTextEffectsCompleteInIntentOrder)
    .then(testInFlightOpenEffectsCompleteInIntentOrder)
    .then(testPreCancelledTargetClearsPendingSelection)
    .then(testExternalPanelNavigationSupersedesSlowReveal)
    .then(testWebviewSelectionSupersedesSlowReveal)
    .then(testDisposedOldOpenCannotClearNewerSameKeyPending)
    .then(testInitialTargetParseFailureClearsPendingSelection)
    .then(testDisposalStopsNavigationAfterOwnedAwait)
    .then(testRapidOpenDefinitionStopsStaleNavigation)
    .then(testRapidRevealSourceStopsStaleNavigation)
    .then(testRapidSelectionStopsStalePublish)
    .then(testFailedCrossFileOpenDoesNotRetainPendingSelection)
    .then(testDiagnosticSourceFailureDoesNotBlockGraph)
    .then(testInitialParseReplaysTargetedIndexInvalidation)
    .then(testRapidRefreshStopsStalePublish)
    .then(testDelayedSaveRebasesOntoCurrentGraphRevision)
    .then(testDelayedSaveRebasesAfterModuleRoundTrip)
    .then(testDelayedSaveDoesNotRebaseOntoOutgoingGraphDuringSelection)
    .then(testDisposalStopsPublishAfterAwait)
    .then(testRelayoutSaveCannotPublishNewerMutableState)
    .then(testRelayoutRejectsDelayedSaveFromPreviousRevision)
    .then(testRelayoutDuringRefreshPublishesRefreshedGraph)
    .then(testSelectionDuringRefreshPublishesRefreshedIntent)
    .then(testIndexInvalidationRefreshesAndSupersedesInFlightConfiguration)
    .then(testUnsavedLocalDefinitionPreservesExternalAmbiguity)
    .then(testUnsavedSameDocumentRenameUsesLiveDefinition)
    .then(testLayoutIntentRemainsScopedToItsModuleWhileSaveIsPending)
    .then(testRepeatedReadyPublishesLatestAcceptedLayout)
    .then(() => console.log('schematic editor provider tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
