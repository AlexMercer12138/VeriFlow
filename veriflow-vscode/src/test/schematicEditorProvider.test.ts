import * as assert from 'assert';
import Module = require('module');
import * as path from 'path';

import type { HdlDocument } from '../core/hdl/model';
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

type ProviderHarness = {
    messages: HostEvent[];
    moduleKeys: string[];
    setPostGate(predicate: (event: HostEvent) => boolean, gate: Gate): void;
    setSaveGate(gate: Gate): void;
    send(message: unknown): void;
    changeDocument(text: string, version: number): void;
    disposePanel(): void;
    dispose(): Promise<void>;
};

async function createProviderHarness(
    documentsByText: Map<string, HdlDocument>,
    initialText: string
): Promise<ProviderHarness> {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const resource = FakeUri.parse('file:///workspace/design.sv');
    let documentText = initialText;
    let documentVersion = 1;
    let messageListener: ((message: unknown) => void) | undefined;
    let documentListener: ((event: { document: typeof document }) => void) | undefined;
    let disposeListener: (() => void) | undefined;
    let viewStateListener: ((event: { webviewPanel: typeof panel }) => void) | undefined;
    let postGate: { predicate: (event: HostEvent) => boolean; gate: Gate } | undefined;
    let saveGate: Gate | undefined;
    const messages: HostEvent[] = [];
    const disposable = { dispose(): void {} };
    const document = {
        uri: resource,
        get version(): number { return documentVersion; },
        getText(): string { return documentText; },
    };
    const panel = {
        active: true,
        viewColumn: 1,
        reveal(): void {},
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
        onDidChangeViewState(listener: typeof viewStateListener) {
            viewStateListener = listener;
            return disposable;
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
    const vscodeStub = {
        Uri: FakeUri,
        workspace: {
            onDidChangeTextDocument(listener: typeof documentListener) {
                documentListener = listener;
                return disposable;
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
        workspaceState: {
            get: () => undefined,
            async update(): Promise<void> {
                const pending = saveGate;
                if (pending) {
                    saveGate = undefined;
                    pending.markStarted();
                    await pending.release;
                }
            },
        },
    };
    const navigation = {
        consumePending: () => undefined,
        register: () => disposable,
        markFocused(): void {},
    };
    const index = {
        async parseOpenDocument(
            _uri: string,
            _version: number,
            text: string
        ): Promise<HdlDocument> {
            const parsed = documentsByText.get(text);
            if (!parsed) throw new Error(`No parsed fixture for ${text}`);
            return parsed;
        },
        findDefinitions: () => [],
    };
    const provider = new SchematicEditorProvider(context, navigation, {
        getIndex: async () => index,
    });
    await provider.resolveCustomTextEditor(document, panel, token);
    assert.ok(messageListener);
    messageListener!({ type: 'ready' });
    await waitFor(
        () => messages.some(event => event.type === 'graph'),
        'initial graph publication'
    );
    const initialize = messages.find(event => event.type === 'initialize');
    assert.ok(initialize && initialize.type === 'initialize');
    const moduleKeys = initialize.type === 'initialize'
        ? initialize.modules.map(module => module.key)
        : [];

    return {
        messages,
        moduleKeys,
        setPostGate(predicate, gate): void { postGate = { predicate, gate }; },
        setSaveGate(gate): void { saveGate = gate; },
        send(message): void { messageListener!(message); },
        changeDocument(text, version): void {
            documentText = text;
            documentVersion = version;
            documentListener!({ document });
        },
        disposePanel(): void { disposeListener!(); },
        async dispose(): Promise<void> {
            disposeListener?.();
            moduleLoader._load = originalLoad;
            delete require.cache[require.resolve('../schematic/schematicEditorProvider')];
        },
    };
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

void testRapidSelectionStopsStalePublish()
    .then(testRapidRefreshStopsStalePublish)
    .then(testDisposalStopsPublishAfterAwait)
    .then(testRelayoutSaveCannotPublishNewerMutableState)
    .then(() => console.log('schematic editor provider tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
