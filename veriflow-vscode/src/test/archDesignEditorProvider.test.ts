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
import {
    createInterfaceProtocolCatalog,
    type InterfaceProtocolCatalog,
} from '@veriflow/schematic-core/interfaces';

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
    informationMessages: string[];
    errorMessages: string[];
    exportEvents: string[];
    replacements: AppliedReplacement[];
    releasedOwners: object[];
    exportRequests: Array<{
        designPath: string;
        design: ArchDesign;
        definitions: HdlDefinitionSummary[];
        interfaceCatalog: InterfaceProtocolCatalog;
    }>;
    protocolCatalog: InterfaceProtocolCatalog;
    validate(): Promise<void>;
    exportRtl(): Promise<void>;
    validateWithoutUri(): Promise<void>;
    pauseExports(): () => void;
    pauseNextIndexRefresh(): () => void;
    pauseNextSave(): () => void;
    pauseNextWebviewPost(type: HostEvent['type']): () => void;
    rejectNextDocumentEdit(): void;
    rejectNextSave(): void;
    setNextSaveDocument(text: string, version: number): void;
    failNextExport(error: Error): void;
    setDefinitions(definitions: HdlDefinitionSummary[]): void;
    invalidateIndex(): void;
    setProtocolGeneration(generation: number): void;
    invalidateProtocols(): void;
    send(message: unknown): void;
    changeDocument(text: string, version: number): void;
    signalDocumentStateChange(): void;
    applyReplacement(index: number, version: number): void;
    closePanel(): void;
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
    initialDefinitions: HdlDefinitionSummary[] = [],
    initialProtocolGeneration = 0,
    autoReady = true
): Promise<ProviderHarness> {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const resource = FakeUri.parse('file:///workspace/soc.ad');
    let documentText = initialText;
    let documentVersion = 1;
    let documentDirty = false;
    let messageListener: ((message: unknown) => void) | undefined;
    let documentListener: ((event: {
        document: typeof document;
        contentChanges: readonly unknown[];
    }) => void) | undefined;
    let disposeListener: (() => void) | undefined;
    let invalidationListener: ((index?: object) => void) | undefined;
    let protocolInvalidationListener: (() => void) | undefined;
    let definitions = [...initialDefinitions];
    let protocolGeneration = initialProtocolGeneration;
    const interfaceCatalog = createInterfaceProtocolCatalog();
    const messages: HostEvent[] = [];
    const diagnostics: ProviderHarness['diagnostics'] = [];
    const informationMessages: string[] = [];
    const errorMessages: string[] = [];
    const exportEvents: string[] = [];
    const replacements: AppliedReplacement[] = [];
    const releasedOwners: object[] = [];
    const exportRequests: ProviderHarness['exportRequests'] = [];
    let exportGate: Promise<void> | undefined;
    let releaseExport: (() => void) | undefined;
    let nextIndexGate: Promise<void> | undefined;
    let releaseNextIndex: (() => void) | undefined;
    let nextSaveGate: Promise<void> | undefined;
    let releaseNextSave: (() => void) | undefined;
    let nextPostGate: Promise<void> | undefined;
    let releaseNextPost: (() => void) | undefined;
    let nextPostType: HostEvent['type'] | undefined;
    let nextExportError: Error | undefined;
    let nextDocumentEditAccepted = true;
    let nextSaveAccepted = true;
    let nextSavedDocument: Readonly<{ text: string; version: number }> | undefined;
    const disposable = { dispose(): void {} };
    const document = {
        uri: resource,
        get version(): number { return documentVersion; },
        get isDirty(): boolean { return documentDirty; },
        getText(): string { return documentText; },
        positionAt(offset: number): number { return offset; },
        async save(): Promise<boolean> {
            exportEvents.push('save');
            if (exportEvents.length > 50) {
                throw new Error('export retried before editor initialization');
            }
            const accepted = nextSaveAccepted;
            nextSaveAccepted = true;
            if (accepted && nextSavedDocument) {
                documentText = nextSavedDocument.text;
                documentVersion = nextSavedDocument.version;
                documentDirty = true;
                nextSavedDocument = undefined;
            }
            const savedVersion = documentVersion;
            const gate = nextSaveGate;
            nextSaveGate = undefined;
            await gate;
            if (accepted && documentVersion === savedVersion) documentDirty = false;
            return accepted;
        },
    };
    const panel = {
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-webview://schematic',
            asWebviewUri(uri: FakeUri): FakeUri { return uri; },
            async postMessage(event: HostEvent): Promise<boolean> {
                messages.push(event);
                if (event.type === nextPostType) {
                    const gate = nextPostGate;
                    nextPostGate = undefined;
                    nextPostType = undefined;
                    await gate;
                }
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
                const accepted = nextDocumentEditAccepted;
                nextDocumentEditAccepted = true;
                return accepted;
            },
        },
        window: {
            showErrorMessage(message: string): Promise<undefined> {
                errorMessages.push(message);
                return Promise.resolve(undefined);
            },
            showInformationMessage(message: string): Promise<undefined> {
                informationMessages.push(message);
                return Promise.resolve(undefined);
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
            validate(uri?: unknown): Promise<void>;
            exportRtl(uri?: unknown): Promise<void>;
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
        async getIndex() {
            const gate = nextIndexGate;
            nextIndexGate = undefined;
            await gate;
            return index;
        },
        releaseIndex(owner: object): void { releasedOwners.push(owner); },
        onDidInvalidate(listener: (changed?: object) => void) {
            invalidationListener = listener;
            return {
                dispose(): void {
                    if (invalidationListener === listener) invalidationListener = undefined;
                },
            };
        },
        async getInterfaceProtocols() {
            return {
                catalog: interfaceCatalog,
                diagnostics: [],
                generation: protocolGeneration,
            };
        },
        onDidInvalidateInterfaceProtocols(listener: () => void) {
            protocolInvalidationListener = listener;
            return {
                dispose(): void {
                    if (protocolInvalidationListener === listener) {
                        protocolInvalidationListener = undefined;
                    }
                },
            };
        },
        async exportDesign(
            designPath: string,
            selectedDesign: ArchDesign,
            selectedDefinitions: HdlDefinitionSummary[],
            selectedInterfaceCatalog: InterfaceProtocolCatalog
        ) {
            exportEvents.push('export');
            exportRequests.push({
                designPath,
                design: selectedDesign,
                definitions: selectedDefinitions,
                interfaceCatalog: selectedInterfaceCatalog,
            });
            await exportGate;
            if (nextExportError) {
                const error = nextExportError;
                nextExportError = undefined;
                throw error;
            }
            return {
                status: 'published' as const,
                outputPath: '/workspace/soc.v',
                language: 'verilog' as const,
            };
        },
    });
    await provider.resolveCustomTextEditor(document, panel, token);
    assert.ok(messageListener);
    if (autoReady) {
        messageListener!({ type: 'ready' });
        await waitFor(
            () => messages.some(event => event.type === 'archDesignState'),
            'initial Arch Design state'
        );
    }

    return {
        messages,
        diagnostics,
        informationMessages,
        errorMessages,
        exportEvents,
        replacements,
        releasedOwners,
        exportRequests,
        protocolCatalog: interfaceCatalog,
        validate(): Promise<void> {
            return provider.validate(resource as never);
        },
        exportRtl(): Promise<void> {
            return provider.exportRtl(resource as never);
        },
        validateWithoutUri(): Promise<void> { return provider.validate(); },
        pauseExports(): () => void {
            exportGate = new Promise<void>(resolve => { releaseExport = resolve; });
            return () => {
                releaseExport?.();
                releaseExport = undefined;
                exportGate = undefined;
            };
        },
        pauseNextIndexRefresh(): () => void {
            nextIndexGate = new Promise<void>(resolve => { releaseNextIndex = resolve; });
            return () => {
                releaseNextIndex?.();
                releaseNextIndex = undefined;
            };
        },
        pauseNextSave(): () => void {
            nextSaveGate = new Promise<void>(resolve => { releaseNextSave = resolve; });
            return () => {
                releaseNextSave?.();
                releaseNextSave = undefined;
            };
        },
        pauseNextWebviewPost(type): () => void {
            nextPostType = type;
            nextPostGate = new Promise<void>(resolve => { releaseNextPost = resolve; });
            return () => {
                releaseNextPost?.();
                releaseNextPost = undefined;
            };
        },
        rejectNextDocumentEdit(): void { nextDocumentEditAccepted = false; },
        rejectNextSave(): void { nextSaveAccepted = false; },
        setNextSaveDocument(text, version): void {
            nextSavedDocument = { text, version };
        },
        failNextExport(error: Error): void { nextExportError = error; },
        setDefinitions(next): void { definitions = [...next]; },
        invalidateIndex(): void { invalidationListener?.(index); },
        setProtocolGeneration(generation): void { protocolGeneration = generation; },
        invalidateProtocols(): void { protocolInvalidationListener?.(); },
        send(message): void { messageListener?.(message); },
        changeDocument(text, version): void {
            documentText = text;
            documentVersion = version;
            documentDirty = true;
            documentListener?.({ document, contentChanges: [{}] });
        },
        signalDocumentStateChange(): void {
            documentListener?.({ document, contentChanges: [] });
        },
        applyReplacement(index, version): void {
            const replacement = replacements[index];
            assert.ok(replacement, `missing replacement ${index}`);
            documentText = replacement.text;
            documentVersion = version;
            documentDirty = true;
            documentListener?.({ document, contentChanges: [{}] });
        },
        closePanel(): void { disposeListener?.(); },
        async dispose(): Promise<void> {
            disposeListener?.();
            await new Promise<void>(resolve => setImmediate(resolve));
            moduleLoader._load = originalLoad;
            delete require.cache[require.resolve('../archDesign/archDesignEditorProvider')];
        },
    };
}

async function testValidateWaitsForInitialEditorRefresh(): Promise<void> {
    const harness = await createHarness(sourceDesign(), [], 0, false);
    try {
        let settled = false;
        const validation = harness.validate().then(() => { settled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(settled, false);
        assert.deepStrictEqual(harness.errorMessages, []);
        assert.deepStrictEqual(harness.informationMessages, []);

        harness.send({ type: 'ready' });
        await validation;
        assert.deepStrictEqual(harness.errorMessages, []);
        assert.deepStrictEqual(harness.informationMessages, [
            'Arch Design validation passed: 0 errors',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function testExportWaitsForInitialEditorRefresh(): Promise<void> {
    const harness = await createHarness(sourceDesign(), [], 0, false);
    try {
        let settled = false;
        const exporting = harness.exportRtl().then(() => { settled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(settled, false);
        assert.deepStrictEqual(harness.exportEvents, []);
        assert.deepStrictEqual(harness.errorMessages, []);

        harness.send({ type: 'ready' });
        await exporting;
        assert.deepStrictEqual(harness.exportEvents, ['save', 'export']);
        assert.deepStrictEqual(harness.errorMessages, []);
        assert.deepStrictEqual(harness.informationMessages, [
            'Arch Design RTL exported: /workspace/soc.v',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function testProtocolGenerationRefreshPreservesGraphAndRejectsStaleCommands(): Promise<void> {
    const harness = await createHarness(sourceDesign(), [], 3);
    try {
        const initialState = harness.messages.find(
            event => event.type === 'archDesignState' && event.status === 'editable'
        );
        assert.ok(initialState?.type === 'archDesignState'
            && initialState.status === 'editable');
        if (initialState?.type !== 'archDesignState'
            || initialState.status !== 'editable') return;
        assert.match(initialState.revision, /:3:/);
        const initialGraphCount = harness.messages.filter(
            event => event.type === 'graph'
        ).length;

        harness.setProtocolGeneration(4);
        harness.invalidateProtocols();
        await waitFor(
            () => harness.messages.filter(
                event => event.type === 'archDesignState' && event.status === 'editable'
            ).length === 2,
            'protocol generation refresh'
        );
        const refreshedState = harness.messages.filter(
            event => event.type === 'archDesignState' && event.status === 'editable'
        ).at(-1);
        assert.ok(refreshedState?.type === 'archDesignState'
            && refreshedState.status === 'editable');
        if (refreshedState?.type !== 'archDesignState'
            || refreshedState.status !== 'editable') return;
        assert.match(refreshedState.revision, /:4:/);
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'graph').length,
            initialGraphCount
        );

        harness.send({
            type: 'editArchDesign',
            revision: initialState.revision,
            edit: { type: 'addPort', port: { name: 'stale', direction: 'input' } },
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(harness.replacements, []);
        harness.send({ type: 'exportArchDesign', revision: refreshedState.revision });
        await waitFor(() => harness.exportRequests.length === 1, 'protocol snapshot export');
        assert.strictEqual(
            harness.exportRequests[0].interfaceCatalog,
            harness.protocolCatalog
        );
    } finally {
        await harness.dispose();
    }
}

async function testValidateReportsLatestDiagnosticCount(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }));
    try {
        await harness.validate();
        assert.deepStrictEqual(harness.informationMessages, []);
        assert.deepStrictEqual(harness.errorMessages, [
            'Arch Design validation failed: 1 error',
        ]);

        harness.setDefinitions([{
            ...moduleDefinition(),
            ports: [],
        }]);
        const previousStates = harness.messages.filter(
            event => event.type === 'archDesignState'
        ).length;
        harness.invalidateIndex();
        await waitFor(
            () => harness.messages.filter(event => event.type === 'archDesignState').length
                > previousStates,
            'validated catalog refresh'
        );
        await harness.validate();
        assert.deepStrictEqual(harness.informationMessages, [
            'Arch Design validation passed: 0 errors',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function testExportUsesLatestSnapshotAndReportsAfterPublication(): Promise<void> {
    const initialDefinition = {
        ...moduleDefinition(),
        ports: [],
    };
    const harness = await createHarness(sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }), [initialDefinition]);
    try {
        const initialState = harness.messages.find(
            event => event.type === 'archDesignState' && event.status === 'editable'
        );
        assert.ok(initialState?.type === 'archDesignState');
        harness.changeDocument(sourceDesign({
            module: 'latest_soc',
            instances: [{ name: 'u_core', module: 'core' }],
        }), 2);
        const latestDefinition = {
            ...initialDefinition,
            modelFingerprint: 'core-v2',
        };
        harness.setDefinitions([latestDefinition]);
        harness.invalidateIndex();
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'archDesignState'
                && event.status === 'editable'
                && event.design.module === 'latest_soc'
            ),
            'latest export snapshot'
        );
        const latestState = harness.messages.filter(
            event => event.type === 'archDesignState' && event.status === 'editable'
        ).at(-1);
        assert.ok(latestState?.type === 'archDesignState' && latestState.status === 'editable');
        if (latestState?.type !== 'archDesignState' || latestState.status !== 'editable') return;

        harness.send({
            type: 'exportArchDesign',
            revision: initialState?.type === 'archDesignState'
                ? initialState.revision
                : 'stale',
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(harness.exportRequests.length, 0);

        const release = harness.pauseExports();
        harness.send({ type: 'exportArchDesign', revision: latestState.revision });
        await waitFor(() => harness.exportRequests.length === 1, 'webview export request');
        assert.deepStrictEqual(harness.exportEvents, ['save', 'export']);
        assert.deepStrictEqual(harness.informationMessages, []);
        assert.strictEqual(harness.exportRequests[0].designPath, '/workspace/soc.ad');
        assert.strictEqual(harness.exportRequests[0].design.module, 'latest_soc');
        assert.deepStrictEqual(
            harness.exportRequests[0].definitions.map(item => item.modelFingerprint),
            ['core-v2']
        );
        release();
        await waitFor(
            () => harness.informationMessages.length === 1,
            'successful export notification'
        );
        assert.deepStrictEqual(harness.informationMessages, [
            'Arch Design RTL exported: /workspace/soc.v',
        ]);
    } finally {
        await harness.dispose();
    }
}

async function testExportSavesCommandDocumentAndStopsWhenSaveFails(): Promise<void> {
    const successful = await createHarness(sourceDesign(), []);
    try {
        successful.setNextSaveDocument(sourceDesign({ module: 'saved_soc' }), 2);
        await successful.exportRtl();
        assert.deepStrictEqual(successful.exportEvents, ['save', 'export']);
        assert.strictEqual(successful.exportRequests.length, 1);
        assert.strictEqual(successful.exportRequests[0].design.module, 'saved_soc');
    } finally {
        await successful.dispose();
    }

    const rejected = await createHarness(sourceDesign(), []);
    try {
        rejected.rejectNextSave();
        await rejected.exportRtl();
        assert.deepStrictEqual(rejected.exportEvents, ['save']);
        assert.strictEqual(rejected.exportRequests.length, 0);
        assert.deepStrictEqual(rejected.errorMessages, [
            'Unable to save Arch Design before RTL export',
        ]);
    } finally {
        await rejected.dispose();
    }

    const rejectedWebview = await createHarness(sourceDesign(), []);
    try {
        const state = rejectedWebview.messages.find(
            event => event.type === 'archDesignState' && event.status === 'editable'
        );
        assert.ok(state?.type === 'archDesignState' && state.status === 'editable');
        if (state?.type !== 'archDesignState' || state.status !== 'editable') return;
        rejectedWebview.rejectNextSave();
        rejectedWebview.send({ type: 'exportArchDesign', revision: state.revision });
        await waitFor(
            () => rejectedWebview.errorMessages.length === 1,
            'rejected webview save error'
        );
        assert.deepStrictEqual(rejectedWebview.exportEvents, ['save']);
        assert.strictEqual(rejectedWebview.exportRequests.length, 0);
        assert.deepStrictEqual(rejectedWebview.errorMessages, [
            'Unable to save Arch Design before RTL export',
        ]);
    } finally {
        await rejectedWebview.dispose();
    }

    const repaired = await createHarness(sourceDesign(), []);
    try {
        repaired.changeDocument('{ invalid', 2);
        await waitFor(
            () => repaired.messages.some(
                event => event.type === 'archDesignState' && event.status === 'invalid'
            ),
            'invalid document before save repair'
        );
        repaired.setNextSaveDocument(sourceDesign({ module: 'repaired_soc' }), 3);
        await repaired.exportRtl();
        assert.deepStrictEqual(repaired.exportEvents, ['save', 'export']);
        assert.strictEqual(repaired.exportRequests.length, 1);
        assert.strictEqual(repaired.exportRequests[0].design.module, 'repaired_soc');
        assert.deepStrictEqual(repaired.errorMessages, []);
    } finally {
        await repaired.dispose();
    }

    const concurrent = await createHarness(sourceDesign(), []);
    try {
        const release = concurrent.pauseExports();
        const first = concurrent.exportRtl();
        const second = concurrent.exportRtl();
        await waitFor(() => concurrent.exportRequests.length > 0, 'concurrent export request');
        assert.deepStrictEqual(concurrent.exportEvents, ['save', 'export']);
        assert.strictEqual(concurrent.exportRequests.length, 1);
        release();
        await Promise.all([first, second]);
        assert.deepStrictEqual(concurrent.informationMessages, [
            'Arch Design RTL exported: /workspace/soc.v',
        ]);
    } finally {
        await concurrent.dispose();
    }

    const editedDuringRefresh = await createHarness(sourceDesign(), []);
    try {
        const releaseRefresh = editedDuringRefresh.pauseNextIndexRefresh();
        const exporting = editedDuringRefresh.exportRtl();
        await waitFor(
            () => editedDuringRefresh.exportEvents.includes('save'),
            'save before export refresh'
        );
        editedDuringRefresh.changeDocument(
            sourceDesign({ module: 'edited_during_export' }),
            2
        );
        releaseRefresh();
        await exporting;
        assert.deepStrictEqual(
            editedDuringRefresh.exportEvents,
            ['save', 'save', 'export']
        );
        assert.strictEqual(editedDuringRefresh.exportRequests.length, 1);
        assert.strictEqual(
            editedDuringRefresh.exportRequests[0].design.module,
            'edited_during_export'
        );
    } finally {
        await editedDuringRefresh.dispose();
    }

    const editedDuringSave = await createHarness(sourceDesign(), []);
    try {
        const releaseSave = editedDuringSave.pauseNextSave();
        const exporting = editedDuringSave.exportRtl();
        await waitFor(
            () => editedDuringSave.exportEvents.includes('save'),
            'pending save before document edit'
        );
        editedDuringSave.changeDocument(sourceDesign({ module: 'dirty_soc' }), 2);
        releaseSave();
        await exporting;
        assert.deepStrictEqual(editedDuringSave.exportEvents, ['save', 'save', 'export']);
        assert.strictEqual(editedDuringSave.exportRequests.length, 1);
        assert.strictEqual(editedDuringSave.exportRequests[0].design.module, 'dirty_soc');
    } finally {
        await editedDuringSave.dispose();
    }

    const invalidatedDuringPost = await createHarness(sourceDesign(), []);
    try {
        const releasePost = invalidatedDuringPost.pauseNextWebviewPost('diagnostics');
        invalidatedDuringPost.setDefinitions([moduleDefinition()]);
        const exporting = invalidatedDuringPost.exportRtl();
        await waitFor(
            () => invalidatedDuringPost.messages.filter(
                event => event.type === 'diagnostics'
            ).length === 2,
            'paused export diagnostics publication'
        );
        invalidatedDuringPost.setDefinitions([{
            ...moduleDefinition(),
            modelFingerprint: 'core-after-invalidation',
        }]);
        invalidatedDuringPost.invalidateIndex();
        releasePost();
        await exporting;
        assert.deepStrictEqual(
            invalidatedDuringPost.exportRequests[0].definitions.map(
                item => item.modelFingerprint
            ),
            ['core-after-invalidation']
        );
    } finally {
        await invalidatedDuringPost.dispose();
    }

    const closedDuringRefresh = await createHarness(sourceDesign(), []);
    try {
        const releaseRefresh = closedDuringRefresh.pauseNextIndexRefresh();
        const exporting = closedDuringRefresh.exportRtl();
        await waitFor(
            () => closedDuringRefresh.exportEvents.includes('save'),
            'save before closing export session'
        );
        closedDuringRefresh.closePanel();
        releaseRefresh();
        await exporting;
        assert.deepStrictEqual(closedDuringRefresh.exportEvents, ['save']);
        assert.strictEqual(closedDuringRefresh.exportRequests.length, 0);
    } finally {
        await closedDuringRefresh.dispose();
    }
}

async function testExportBlocksSemanticErrorsAndReportsPublicationFailure(): Promise<void> {
    const invalid = await createHarness(sourceDesign({
        instances: [{ name: 'u_missing', module: 'missing' }],
    }));
    try {
        await invalid.exportRtl();
        assert.strictEqual(invalid.exportRequests.length, 0);
        assert.deepStrictEqual(invalid.errorMessages, [
            'Arch Design RTL export blocked: 1 error',
        ]);
    } finally {
        await invalid.dispose();
    }

    const failing = await createHarness(sourceDesign(), []);
    try {
        failing.failNextExport(new Error('publication failed'));
        await failing.exportRtl();
        assert.strictEqual(failing.exportRequests.length, 1);
        assert.deepStrictEqual(failing.informationMessages, []);
        assert.deepStrictEqual(failing.errorMessages, ['publication failed']);
    } finally {
        await failing.dispose();
    }
}

async function testDisposedPanelIsNotAnActiveSession(): Promise<void> {
    const harness = await createHarness(sourceDesign(), []);
    await harness.dispose();
    await harness.validateWithoutUri();
    assert.deepStrictEqual(harness.errorMessages, [
        'No editable Arch Design is active',
    ]);
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
        assert.strictEqual(graph.fitOnFirstRender, true);
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

async function testRejectedDocumentEditRepublishesEditableState(): Promise<void> {
    const harness = await createHarness(sourceDesign(), []);
    try {
        const initialState = harness.messages.find(
            event => event.type === 'archDesignState' && event.status === 'editable'
        );
        assert.ok(initialState?.type === 'archDesignState'
            && initialState.status === 'editable');
        if (initialState?.type !== 'archDesignState'
            || initialState.status !== 'editable') return;

        harness.rejectNextDocumentEdit();
        harness.send({
            type: 'editArchDesign',
            revision: initialState.revision,
            edit: { type: 'addPort', port: { name: 'clk', direction: 'input' } },
        });
        await waitFor(
            () => harness.errorMessages.includes('Unable to apply Arch Design edit'),
            'rejected document edit error'
        );
        await waitFor(
            () => harness.messages.filter(
                event => event.type === 'archDesignState' && event.status === 'editable'
            ).length === 2,
            'editable state recovery'
        );

        const recoveredState = harness.messages.filter(
            event => event.type === 'archDesignState' && event.status === 'editable'
        ).at(-1);
        assert.ok(recoveredState?.type === 'archDesignState'
            && recoveredState.status === 'editable');
        if (recoveredState?.type !== 'archDesignState'
            || recoveredState.status !== 'editable') return;
        assert.notStrictEqual(recoveredState.revision, initialState.revision);
        harness.send({
            type: 'editArchDesign',
            revision: recoveredState.revision,
            edit: { type: 'addPort', port: { name: 'reset_n', direction: 'input' } },
        });
        await waitFor(() => harness.replacements.length === 2, 'edit after recovery');
    } finally {
        await harness.dispose();
    }
}

async function testAcceptedNoOpEditRepublishesEditableState(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'sink', direction: 'output' },
        ],
        connections: [{
            name: 'data',
            endpoints: [
                { kind: 'port', port: 'source' },
                { kind: 'port', port: 'sink' },
            ],
        }],
    }), []);
    try {
        const initialState = harness.messages.find(
            event => event.type === 'archDesignState' && event.status === 'editable'
        );
        assert.ok(initialState?.type === 'archDesignState'
            && initialState.status === 'editable');
        if (initialState?.type !== 'archDesignState'
            || initialState.status !== 'editable') return;

        harness.send({
            type: 'editArchDesign',
            revision: initialState.revision,
            edit: {
                type: 'connect',
                source: { kind: 'port', port: 'source' },
                target: { kind: 'port', port: 'sink' },
            },
        });
        await waitFor(
            () => harness.messages.filter(
                event => event.type === 'archDesignState' && event.status === 'editable'
            ).length === 2,
            'no-op editable state recovery'
        );
        assert.deepStrictEqual(harness.replacements, []);
        const recoveredState = harness.messages.filter(
            event => event.type === 'archDesignState' && event.status === 'editable'
        ).at(-1);
        assert.ok(recoveredState?.type === 'archDesignState'
            && recoveredState.status === 'editable');
        if (recoveredState?.type === 'archDesignState'
            && recoveredState.status === 'editable') {
            assert.notStrictEqual(recoveredState.revision, initialState.revision);
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

async function testPresentationChangeAcknowledgesWithoutReloadingGraph(): Promise<void> {
    const source = sourceDesign({
        ports: [{ name: 'clk', direction: 'input' }],
        instances: [{ name: 'u_core', module: 'core' }],
    });
    const harness = await createHarness(source, [moduleDefinition()]);
    try {
        const graphEvent = harness.messages.find(event => event.type === 'graph');
        assert.ok(graphEvent?.type === 'graph');
        if (graphEvent?.type !== 'graph') return;
        const initialInitializeCount = harness.messages.filter(
            event => event.type === 'initialize'
        ).length;
        const initialGraphCount = harness.messages.filter(
            event => event.type === 'graph'
        ).length;
        const initialStateCount = harness.messages.filter(
            event => event.type === 'archDesignState'
        ).length;
        const layout = structuredClone(graphEvent.layout);
        layout.placement.nodes['instance:u_core'] = {
            column: 1,
            order: 0,
            yOffset: 40,
            fixed: true,
        };
        layout.viewport = { x: -48, y: 72, zoom: 1.2 };

        harness.send({
            type: 'saveLayout',
            moduleKey: graphEvent.graph.moduleKey,
            revision: graphEvent.revision,
            layout,
        });
        await waitFor(() => harness.replacements.length === 1, 'presentation replacement');
        harness.applyReplacement(0, 2);
        await waitFor(
            () => harness.messages.some(event => event.type === 'archDesignLayoutSaved'),
            'presentation acknowledgement'
        );

        assert.strictEqual(
            harness.messages.filter(event => event.type === 'initialize').length,
            initialInitializeCount
        );
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'graph').length,
            initialGraphCount
        );
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'archDesignState').length,
            initialStateCount
        );
        const acknowledgement = harness.messages.find(
            event => event.type === 'archDesignLayoutSaved'
        );
        assert.ok(acknowledgement?.type === 'archDesignLayoutSaved');
        if (acknowledgement?.type !== 'archDesignLayoutSaved') return;
        assert.notStrictEqual(acknowledgement.revision, graphEvent.revision);

        harness.send({
            type: 'editArchDesign',
            revision: acknowledgement.revision,
            edit: { type: 'addPort', port: { name: 'reset_n', direction: 'input' } },
        });
        await waitFor(() => harness.replacements.length === 2, 'semantic edit after layout');
        const parsed = parseArchDesignText(harness.replacements[1].text);
        assert.strictEqual(parsed.status, 'editable');
        if (parsed.status !== 'editable') return;
        assert.deepStrictEqual(parsed.design.presentation.viewport, layout.viewport);
        assert.deepStrictEqual(
            parsed.design.presentation.nodes?.['instance:u_core'],
            { column: 1, order: 0, offset: 40, userPositioned: true }
        );
        assert.deepStrictEqual(
            parsed.design.ports.map(port => port.name),
            ['clk', 'reset_n']
        );
    } finally {
        await harness.dispose();
    }
}

async function testExternalChangeDuringPresentationSaveStillReloadsGraph(): Promise<void> {
    const harness = await createHarness(sourceDesign(), []);
    try {
        const graphEvent = harness.messages.find(event => event.type === 'graph');
        assert.ok(graphEvent?.type === 'graph');
        if (graphEvent?.type !== 'graph') return;
        harness.send({
            type: 'saveLayout',
            moduleKey: graphEvent.graph.moduleKey,
            revision: graphEvent.revision,
            layout: {
                ...structuredClone(graphEvent.layout),
                viewport: { x: 10, y: 20, zoom: 1.1 },
            },
        });
        await waitFor(() => harness.replacements.length === 1, 'pending presentation edit');
        const external = sourceDesign({ module: 'external_top' });
        harness.changeDocument(external, 2);
        await waitFor(
            () => harness.messages.some(event =>
                event.type === 'archDesignState'
                && event.status === 'editable'
                && event.design.module === 'external_top'
            ),
            'external document refresh'
        );
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'graph').length,
            2
        );
        assert.strictEqual(
            harness.messages.some(event => event.type === 'archDesignLayoutSaved'),
            false
        );
    } finally {
        await harness.dispose();
    }
}

async function testDocumentStateChangeDoesNotReloadGraph(): Promise<void> {
    const harness = await createHarness(sourceDesign(), []);
    try {
        const initialInitializeCount = harness.messages.filter(
            event => event.type === 'initialize'
        ).length;
        const initialGraphCount = harness.messages.filter(
            event => event.type === 'graph'
        ).length;
        const initialStateCount = harness.messages.filter(
            event => event.type === 'archDesignState'
        ).length;

        harness.signalDocumentStateChange();
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.strictEqual(
            harness.messages.filter(event => event.type === 'initialize').length,
            initialInitializeCount
        );
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'graph').length,
            initialGraphCount
        );
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'archDesignState').length,
            initialStateCount
        );
    } finally {
        await harness.dispose();
    }
}

async function testOverlappingPresentationSavesPersistLatestLayout(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }), [moduleDefinition()]);
    try {
        const graph = harness.messages.find(event => event.type === 'graph');
        assert.ok(graph?.type === 'graph');
        if (graph?.type !== 'graph') return;
        const firstLayout = structuredClone(graph.layout);
        firstLayout.viewport = { x: 12, y: 24, zoom: 1.1 };
        const latestLayout = structuredClone(graph.layout);
        latestLayout.viewport = { x: 96, y: -48, zoom: 1.35 };

        harness.send({
            type: 'saveLayout',
            moduleKey: graph.graph.moduleKey,
            revision: graph.revision,
            layout: firstLayout,
        });
        await waitFor(() => harness.replacements.length === 1, 'first layout replacement');
        harness.send({
            type: 'saveLayout',
            moduleKey: graph.graph.moduleKey,
            revision: graph.revision,
            layout: latestLayout,
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(harness.replacements.length, 1);

        harness.applyReplacement(0, 2);
        await waitFor(() => harness.replacements.length === 2, 'queued layout replacement');
        harness.applyReplacement(1, 3);
        await waitFor(
            () => harness.messages.filter(
                event => event.type === 'archDesignLayoutSaved'
            ).length === 2,
            'queued layout acknowledgements'
        );

        const parsed = parseArchDesignText(harness.replacements[1].text);
        assert.strictEqual(parsed.status, 'editable');
        if (parsed.status !== 'editable') return;
        assert.deepStrictEqual(parsed.design.presentation.viewport, latestLayout.viewport);
        assert.strictEqual(
            harness.messages.filter(event => event.type === 'graph').length,
            1
        );
    } finally {
        await harness.dispose();
    }
}

async function testQueuedPresentationSaveCompletesAfterPanelClose(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }), [moduleDefinition()]);
    try {
        const graph = harness.messages.find(event => event.type === 'graph');
        assert.ok(graph?.type === 'graph');
        if (graph?.type !== 'graph') return;
        const firstLayout = structuredClone(graph.layout);
        firstLayout.viewport = { x: 8, y: 16, zoom: 1.1 };
        const latestLayout = structuredClone(graph.layout);
        latestLayout.viewport = { x: -120, y: 64, zoom: 0.9 };

        harness.send({
            type: 'saveLayout',
            moduleKey: graph.graph.moduleKey,
            revision: graph.revision,
            layout: firstLayout,
        });
        await waitFor(() => harness.replacements.length === 1, 'closing first layout');
        harness.send({
            type: 'saveLayout',
            moduleKey: graph.graph.moduleKey,
            revision: graph.revision,
            layout: latestLayout,
        });
        harness.closePanel();

        harness.applyReplacement(0, 2);
        await waitFor(
            () => harness.replacements.length === 2,
            'layout queued before panel close'
        );
        const parsed = parseArchDesignText(harness.replacements[1].text);
        assert.strictEqual(parsed.status, 'editable');
        if (parsed.status !== 'editable') return;
        assert.deepStrictEqual(parsed.design.presentation.viewport, latestLayout.viewport);
    } finally {
        await harness.dispose();
    }
}

async function testLatestLayoutAcceptsRevisionWhoseAcknowledgementIsPending(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }), [moduleDefinition()]);
    try {
        const graph = harness.messages.find(event => event.type === 'graph');
        assert.ok(graph?.type === 'graph');
        if (graph?.type !== 'graph') return;
        const firstLayout = structuredClone(graph.layout);
        firstLayout.viewport = { x: 10, y: 20, zoom: 1.1 };
        const latestLayout = structuredClone(graph.layout);
        latestLayout.viewport = { x: 140, y: -72, zoom: 0.8 };

        harness.send({
            type: 'saveLayout',
            moduleKey: graph.graph.moduleKey,
            revision: graph.revision,
            layout: firstLayout,
        });
        await waitFor(() => harness.replacements.length === 1, 'first stale-revision layout');
        harness.applyReplacement(0, 2);
        await waitFor(
            () => harness.messages.some(event => event.type === 'archDesignLayoutSaved'),
            'first stale-revision acknowledgement'
        );

        harness.send({
            type: 'saveLayout',
            moduleKey: graph.graph.moduleKey,
            revision: graph.revision,
            layout: latestLayout,
        });
        await waitFor(
            () => harness.replacements.length === 2,
            'latest layout with unhandled acknowledgement revision'
        );
        const parsed = parseArchDesignText(harness.replacements[1].text);
        assert.strictEqual(parsed.status, 'editable');
        if (parsed.status !== 'editable') return;
        assert.deepStrictEqual(parsed.design.presentation.viewport, latestLayout.viewport);
    } finally {
        await harness.dispose();
    }
}

async function testQueuedLayoutSurvivesPanelCloseDuringSemanticEdit(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }), [moduleDefinition()]);
    try {
        const graph = harness.messages.find(event => event.type === 'graph');
        assert.ok(graph?.type === 'graph');
        if (graph?.type !== 'graph') return;
        harness.send({
            type: 'editArchDesign',
            revision: graph.revision,
            edit: { type: 'addPort', port: { name: 'reset_n', direction: 'input' } },
        });
        await waitFor(() => harness.replacements.length === 1, 'closing semantic edit');
        const latestLayout = structuredClone(graph.layout);
        latestLayout.viewport = { x: -88, y: 44, zoom: 1.25 };
        harness.send({
            type: 'saveLayout',
            moduleKey: graph.graph.moduleKey,
            revision: graph.revision,
            layout: latestLayout,
        });
        harness.closePanel();

        harness.applyReplacement(0, 2);
        await waitFor(
            () => harness.replacements.length === 2,
            'layout after closing semantic edit'
        );
        const parsed = parseArchDesignText(harness.replacements[1].text);
        assert.strictEqual(parsed.status, 'editable');
        if (parsed.status !== 'editable') return;
        assert.deepStrictEqual(parsed.design.presentation.viewport, latestLayout.viewport);
        assert.deepStrictEqual(parsed.design.ports.map(port => port.name), ['reset_n']);
    } finally {
        await harness.dispose();
    }
}

async function testPersistedViewportDisablesInitialFit(): Promise<void> {
    const harness = await createHarness(sourceDesign({
        presentation: { viewport: { x: 0, y: 0, zoom: 1 } },
    }), []);
    try {
        const graph = harness.messages.find(event => event.type === 'graph');
        assert.ok(graph?.type === 'graph');
        if (graph?.type === 'graph') {
            assert.strictEqual(graph.fitOnFirstRender, false);
        }
    } finally {
        await harness.dispose();
    }
}

async function testRelayoutRejectsStaleArchDesignRevision(): Promise<void> {
    const harness = await createHarness(sourceDesign(), []);
    try {
        const state = harness.messages.find(
            event => event.type === 'archDesignState' && event.status === 'editable'
        );
        const graph = harness.messages.find(event => event.type === 'graph');
        assert.ok(state?.type === 'archDesignState' && state.status === 'editable');
        assert.ok(graph?.type === 'graph');
        if (state?.type !== 'archDesignState'
            || state.status !== 'editable'
            || graph?.type !== 'graph') return;

        harness.send({
            type: 'relayoutAll',
            moduleKey: graph.graph.moduleKey,
            revision: 'stale',
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepStrictEqual(harness.replacements, []);

        harness.send({
            type: 'relayoutAll',
            moduleKey: graph.graph.moduleKey,
            revision: state.revision,
        });
        await waitFor(() => harness.replacements.length === 1, 'current AD relayout');
    } finally {
        await harness.dispose();
    }
}

async function main(): Promise<void> {
    await testValidateWaitsForInitialEditorRefresh();
    await testExportWaitsForInitialEditorRefresh();
    await testProtocolGenerationRefreshPreservesGraphAndRejectsStaleCommands();
    await testEditableLifecycleAndNativeEdit();
    await testRejectedDocumentEditRepublishesEditableState();
    await testAcceptedNoOpEditRepublishesEditableState();
    await testInvalidTextRetainsLastValidGraph();
    await testUnsupportedSchemaIsReadOnly();
    await testCatalogInvalidationAndDisposal();
    await testLayoutSavePersistsOnlyStableArchDesignNodes();
    await testPresentationChangeAcknowledgesWithoutReloadingGraph();
    await testExternalChangeDuringPresentationSaveStillReloadsGraph();
    await testDocumentStateChangeDoesNotReloadGraph();
    await testOverlappingPresentationSavesPersistLatestLayout();
    await testQueuedPresentationSaveCompletesAfterPanelClose();
    await testLatestLayoutAcceptsRevisionWhoseAcknowledgementIsPending();
    await testQueuedLayoutSurvivesPanelCloseDuringSemanticEdit();
    await testPersistedViewportDisablesInitialFit();
    await testRelayoutRejectsStaleArchDesignRevision();
    await testValidateReportsLatestDiagnosticCount();
    await testExportUsesLatestSnapshotAndReportsAfterPublication();
    await testExportSavesCommandDocumentAndStopsWhenSaveFails();
    await testExportBlocksSemanticErrorsAndReportsPublicationFailure();
    await testDisposedPanelIsNotAnActiveSession();
    console.log('Arch Design editor provider tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
