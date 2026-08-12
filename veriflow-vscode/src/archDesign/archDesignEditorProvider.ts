import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

import {
    applyArchDesignEdit,
    parseArchDesignText,
    projectArchDesignGraph,
    serializeArchDesign,
    type ArchDesign,
    type ArchDesignDiagnostic,
    type ArchDesignModuleDefinition,
    type ArchDesignValidationResult,
} from '@veriflow/schematic-core/arch-design';
import type { SchematicGraph } from '@veriflow/schematic-core';
import {
    createInterfaceProtocolCatalog,
    type InterfaceProtocolCatalog,
} from '@veriflow/schematic-core/interfaces';

import type { WorkspaceHdlIndex } from '../core/hdl/workspaceHdlIndex';
import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import { parseWebviewCommand, type HostEvent } from '../schematic/protocol';
import { relayoutAll, type SchematicLayout } from '../schematic/layoutStore';
import { buildSchematicWebviewHtml } from '../schematic/webviewSupport';
import {
    archDesignLayout,
    archDesignGraphsEqual,
    archDesignPresentationFromLayout,
    toArchDesignModuleDefinitions,
} from './editorSupport';
import {
    exportArchDesignToFile,
    type ArchDesignFileExportResult,
} from './archDesignExport';
import type {
    InterfaceProtocolCatalogSnapshot,
} from './interfaceProtocolLoader';

export type ArchDesignEditorServices = {
    getIndex(
        document: vscode.TextDocument,
        owner?: object
    ): WorkspaceHdlIndex | undefined | Promise<WorkspaceHdlIndex | undefined>;
    releaseIndex?(owner: object): void;
    onDidInvalidate?(
        listener: (index?: WorkspaceHdlIndex) => void
    ): { dispose(): void };
    getInterfaceProtocols?(
        document: vscode.TextDocument
    ): InterfaceProtocolCatalogSnapshot | Promise<InterfaceProtocolCatalogSnapshot>;
    onDidInvalidateInterfaceProtocols?(
        listener: () => void
    ): { dispose(): void };
    exportDesign?(
        designPath: string,
        design: ArchDesign,
        definitions: readonly HdlDefinitionSummary[],
        interfaceCatalog: InterfaceProtocolCatalog
    ): Promise<ArchDesignFileExportResult>;
};

type EditableSnapshot = Readonly<{
    revision: string;
    design: ArchDesign;
    definitions: readonly ArchDesignModuleDefinition[];
    sourceDefinitions: readonly HdlDefinitionSummary[];
    interfaceCatalog: InterfaceProtocolCatalog;
    interfaceProtocolGeneration: number;
    validation: ArchDesignValidationResult;
    graph: SchematicGraph;
    index?: WorkspaceHdlIndex;
}>;

type PanelState = {
    disposed: boolean;
    ready: boolean;
    refreshGeneration: number;
    snapshot?: EditableSnapshot;
    lastIndex?: WorkspaceHdlIndex;
    pendingPresentationWrite?: Readonly<{
        expectedText: string;
        design: ArchDesign;
        sourceSnapshot: EditableSnapshot;
    }>;
    pendingSemanticWrite?: Readonly<{
        expectedText: string;
        design: ArchDesign;
        sourceSnapshot: EditableSnapshot;
    }>;
    queuedPresentationLayout?: Readonly<{
        moduleKey: string;
        layout: SchematicLayout;
    }>;
    acknowledgedPresentationRevision?: Readonly<{
        source: string;
        current: string;
    }>;
    refreshAfterPresentationWrite?: boolean;
};

type EditorSession = Readonly<{
    uri: vscode.Uri;
    state: PanelState;
}>;

export class ArchDesignEditorProvider implements vscode.CustomTextEditorProvider {
    static readonly viewType = 'veriflow.archDesignEditor';

    private readonly diagnostics: vscode.DiagnosticCollection;
    private readonly sessions = new Map<string, EditorSession>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: ArchDesignEditorServices
    ) {
        this.diagnostics = vscode.languages.createDiagnosticCollection(
            'veriflow-arch-design'
        );
        context.subscriptions.push(this.diagnostics);
    }

    async validate(uri?: vscode.Uri): Promise<void> {
        const snapshot = this.snapshotFor(uri);
        if (!snapshot) {
            await vscode.window.showErrorMessage('No editable Arch Design is active');
            return;
        }
        const count = snapshot.validation.diagnostics.length;
        if (snapshot.validation.valid) {
            await vscode.window.showInformationMessage(
                `Arch Design validation passed: ${count} errors`
            );
        } else {
            await vscode.window.showErrorMessage(
                `Arch Design validation failed: ${count} ${count === 1 ? 'error' : 'errors'}`
            );
        }
    }

    async exportRtl(uri?: vscode.Uri): Promise<void> {
        const session = this.sessionFor(uri);
        const snapshot = session?.state.snapshot;
        if (!session || !snapshot) {
            await vscode.window.showErrorMessage('No editable Arch Design is active');
            return;
        }
        await this.exportSnapshot(session.uri, snapshot);
    }

    private sessionFor(uri?: vscode.Uri): EditorSession | undefined {
        if (uri) return this.sessions.get(uri.toString());
        return this.sessions.size === 1 ? this.sessions.values().next().value : undefined;
    }

    private snapshotFor(uri?: vscode.Uri): EditableSnapshot | undefined {
        return this.sessionFor(uri)?.state.snapshot;
    }

    private async exportSnapshot(
        uri: vscode.Uri,
        snapshot: EditableSnapshot
    ): Promise<void> {
        const errorCount = snapshot.validation.diagnostics.length;
        if (!snapshot.validation.valid) {
            await vscode.window.showErrorMessage(
                `Arch Design RTL export blocked: ${errorCount} `
                + `${errorCount === 1 ? 'error' : 'errors'}`
            );
            return;
        }
        try {
            const result = this.services.exportDesign
                ? await this.services.exportDesign(
                    uri.fsPath,
                    snapshot.design,
                    snapshot.sourceDefinitions,
                    snapshot.interfaceCatalog
                )
                : await exportArchDesignToFile(
                    uri.fsPath,
                    snapshot.design,
                    snapshot.sourceDefinitions,
                    { interfaceCatalog: snapshot.interfaceCatalog }
                );
            if (result.status === 'invalid') {
                const count = result.diagnostics.length;
                await vscode.window.showErrorMessage(
                    `Arch Design RTL export blocked: ${count} `
                    + `${count === 1 ? 'error' : 'errors'}`
                );
                return;
            }
            await vscode.window.showInformationMessage(
                `Arch Design RTL exported: ${result.outputPath}`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await vscode.window.showErrorMessage(message);
        }
    }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        const assetRoot = vscode.Uri.joinPath(
            this.context.extensionUri,
            'media',
            'schematic'
        );
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [assetRoot],
        };
        panel.webview.html = this.getHtml(panel.webview, assetRoot);

        const state: PanelState = {
            disposed: false,
            ready: false,
            refreshGeneration: 0,
        };
        const sessionKey = document.uri.toString();
        const session: EditorSession = { uri: document.uri, state };
        this.sessions.set(sessionKey, session);
        const indexOwner = {};
        const revisionNamespace = crypto.randomBytes(12).toString('hex');
        let revisionSequence = 0;
        const post = async (event: HostEvent): Promise<void> => {
            if (!state.disposed) await panel.webview.postMessage(event);
        };
        const revision = (interfaceProtocolGeneration = 0): string => {
            revisionSequence += 1;
            return `${revisionNamespace}:${document.version}:${interfaceProtocolGeneration}:`
                + revisionSequence.toString(36);
        };
        const fullRange = (): vscode.Range => new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        const diagnosticRange = (): vscode.Range => fullRange();
        const finishClosedPanelPresentationWrites = (): void => {
            if (!state.disposed
                || state.pendingPresentationWrite
                || state.pendingSemanticWrite
                || state.queuedPresentationLayout) return;
            state.snapshot = undefined;
            documentSubscription?.dispose();
        };
        const publishDiagnostics = async (
            items: readonly ArchDesignDiagnostic[]
        ): Promise<void> => {
            if (state.disposed) return;
            const diagnostics = items.map(item => {
                const diagnostic = new vscode.Diagnostic(
                    diagnosticRange(),
                    `${item.path}: ${item.message}`,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.code = item.code;
                diagnostic.source = 'VeriFlow Arch Design';
                return diagnostic;
            });
            this.diagnostics.set(document.uri, diagnostics);
            await post({
                type: 'diagnostics',
                errors: diagnostics.length,
                warnings: 0,
            });
        };
        const reportError = async (error: unknown): Promise<void> => {
            const message = error instanceof Error ? error.message : String(error);
            await post({ type: 'hostError', message });
            if (!state.disposed) await vscode.window.showErrorMessage(message);
        };
        const publishEmptyInitialize = async (editable: boolean): Promise<void> => {
            await post({
                type: 'initialize',
                fileUri: document.uri.toString(),
                modules: [],
                selectedModuleKey: '',
                documentKind: 'arch-design',
                editable,
            });
        };
        const refresh = async (preserveEqualGraph = false): Promise<void> => {
            if (!state.ready || state.disposed || token.isCancellationRequested) return;
            const generation = ++state.refreshGeneration;
            const previousSnapshot = state.snapshot;
            state.pendingPresentationWrite = undefined;
            state.pendingSemanticWrite = undefined;
            state.queuedPresentationLayout = undefined;
            state.acknowledgedPresentationRevision = undefined;
            state.refreshAfterPresentationWrite = false;
            state.snapshot = undefined;
            const parsed = parseArchDesignText(document.getText());
            if (parsed.status === 'invalid') {
                if (generation !== state.refreshGeneration || state.disposed) return;
                if (revisionSequence === 0) await publishEmptyInitialize(false);
                await publishDiagnostics(parsed.diagnostics);
                await post({
                    type: 'archDesignState',
                    status: 'invalid',
                    revision: revision(),
                    diagnostics: parsed.diagnostics,
                });
                return;
            }
            if (parsed.status === 'unsupported') {
                if (generation !== state.refreshGeneration || state.disposed) return;
                await publishEmptyInitialize(false);
                await publishDiagnostics([{
                    path: '$.schemaVersion',
                    code: 'AD_SCHEMA_UNSUPPORTED',
                    message: `Arch Design schema version ${parsed.schemaVersion} is not supported`,
                }]);
                await post({
                    type: 'archDesignState',
                    status: 'readonly',
                    revision: revision(),
                    schemaVersion: parsed.schemaVersion,
                    reason: `Schema version ${parsed.schemaVersion} is not supported`,
                });
                return;
            }

            const design = parsed.design;
            const [index, interfaceProtocols] = await Promise.all([
                this.services.getIndex(document, indexOwner),
                this.services.getInterfaceProtocols?.(document) ?? Promise.resolve({
                    catalog: createInterfaceProtocolCatalog(),
                    diagnostics: [],
                    generation: 0,
                }),
            ]);
            if (generation !== state.refreshGeneration
                || state.disposed
                || token.isCancellationRequested) return;
            state.lastIndex = index;
            const sourceDefinitions = index?.getAllDefinitions('module') ?? [];
            const definitions = toArchDesignModuleDefinitions(sourceDefinitions);
            const projection = projectArchDesignGraph(design, definitions, {
                fileUri: document.uri.toString(),
                interfaceCatalog: interfaceProtocols.catalog,
            });
            const protocolDiagnostics: ArchDesignDiagnostic[] =
                interfaceProtocols.diagnostics.map(item => ({
                    path: `${item.source}:${item.path}`,
                    code: item.code,
                    message: item.message,
                }));
            const validation: ArchDesignValidationResult = Object.freeze({
                ...projection.validation,
                valid: projection.validation.valid && protocolDiagnostics.length === 0,
                diagnostics: Object.freeze([
                    ...protocolDiagnostics,
                    ...projection.validation.diagnostics,
                ]),
            });
            const nextRevision = revision(interfaceProtocols.generation);
            const snapshot: EditableSnapshot = {
                revision: nextRevision,
                design,
                definitions,
                sourceDefinitions,
                interfaceCatalog: interfaceProtocols.catalog,
                interfaceProtocolGeneration: interfaceProtocols.generation,
                validation,
                graph: projection.graph,
                ...(index === undefined ? {} : { index }),
            };
            state.snapshot = snapshot;
            await publishDiagnostics(validation.diagnostics);
            if (generation !== state.refreshGeneration || state.disposed) return;
            const graphUnchanged = preserveEqualGraph
                && previousSnapshot !== undefined
                && archDesignGraphsEqual(previousSnapshot.graph, projection.graph);
            if (graphUnchanged) {
                await post({ type: 'archDesignRevisionChanged', revision: nextRevision });
            } else {
                await post({
                    type: 'initialize',
                    fileUri: document.uri.toString(),
                    modules: [{
                        key: projection.graph.moduleKey,
                        name: projection.graph.moduleName,
                    }],
                    selectedModuleKey: projection.graph.moduleKey,
                    documentKind: 'arch-design',
                    editable: true,
                });
                await post({
                    type: 'graph',
                    revision: nextRevision,
                    graph: projection.graph,
                    layout: archDesignLayout(design, projection.graph),
                    fitOnFirstRender: design.presentation.viewport === undefined,
                });
            }
            await post({
                type: 'archDesignState',
                status: 'editable',
                revision: nextRevision,
                design,
                catalog: definitions,
                validation,
            });
        };
        const applyDocumentEdit = async (
            snapshot: EditableSnapshot,
            edit: Parameters<typeof applyArchDesignEdit>[1],
            acknowledgePresentation = false
        ): Promise<void> => {
            if (state.snapshot !== snapshot
                || (state.disposed && !acknowledgePresentation)) return;
            let pendingWrite: PanelState['pendingPresentationWrite'];
            try {
                const next = applyArchDesignEdit(snapshot.design, edit);
                const nextText = serializeArchDesign(next);
                if (nextText === document.getText()) {
                    if (acknowledgePresentation) {
                        await post({
                            type: 'archDesignLayoutSaved',
                            revision: snapshot.revision,
                        });
                    } else {
                        await refresh();
                    }
                    return;
                }
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.replace(document.uri, fullRange(), nextText);
                if (acknowledgePresentation) {
                    pendingWrite = {
                        expectedText: nextText,
                        design: next,
                        sourceSnapshot: snapshot,
                    };
                    state.pendingPresentationWrite = pendingWrite;
                } else {
                    state.pendingSemanticWrite = {
                        expectedText: nextText,
                        design: next,
                        sourceSnapshot: snapshot,
                    };
                }
                state.snapshot = undefined;
                const applied = await vscode.workspace.applyEdit(workspaceEdit);
                if (!applied) throw new Error('Unable to apply Arch Design edit');
            } catch (error) {
                if (state.pendingPresentationWrite === pendingWrite) {
                    state.pendingPresentationWrite = undefined;
                }
                state.pendingSemanticWrite = undefined;
                const message = error instanceof Error ? error.message : String(error);
                if (!state.disposed) await vscode.window.showErrorMessage(message);
                if (state.disposed) {
                    finishClosedPanelPresentationWrites();
                } else {
                    await refresh();
                }
            }
        };
        const applyQueuedPresentation = async (
            snapshot: EditableSnapshot
        ): Promise<void> => {
            const queued = state.queuedPresentationLayout;
            if (!queued || queued.moduleKey !== snapshot.graph.moduleKey) return;
            state.queuedPresentationLayout = undefined;
            await applyDocumentEdit(snapshot, {
                type: 'setPresentation',
                presentation: archDesignPresentationFromLayout(
                    snapshot.design,
                    snapshot.graph,
                    queued.layout
                ),
            }, true);
        };

        const messageSubscription = panel.webview.onDidReceiveMessage(value => {
            const command = parseWebviewCommand(value);
            if (!command || state.disposed) return;
            void (async () => {
                switch (command.type) {
                    case 'ready':
                        state.ready = true;
                        await refresh();
                        return;
                    case 'editArchDesign': {
                        const snapshot = state.snapshot;
                        if (!snapshot || command.revision !== snapshot.revision) return;
                        await applyDocumentEdit(snapshot, command.edit);
                        return;
                    }
                    case 'saveLayout': {
                        const snapshot = state.snapshot;
                        if (!snapshot) {
                            const pending = state.pendingPresentationWrite
                                ?? state.pendingSemanticWrite;
                            if (pending
                                && command.revision === pending.sourceSnapshot.revision
                                && command.moduleKey === pending.sourceSnapshot.graph.moduleKey) {
                                state.queuedPresentationLayout = {
                                    moduleKey: command.moduleKey,
                                    layout: command.layout,
                                };
                            }
                            return;
                        }
                        if (command.revision !== snapshot.revision
                            && command.revision
                                !== state.acknowledgedPresentationRevision?.source) return;
                        if (command.moduleKey !== snapshot.graph.moduleKey) return;
                        state.acknowledgedPresentationRevision = undefined;
                        await applyDocumentEdit(snapshot, {
                            type: 'setPresentation',
                            presentation: archDesignPresentationFromLayout(
                                snapshot.design,
                                snapshot.graph,
                                command.layout
                            ),
                        }, true);
                        return;
                    }
                    case 'relayoutAll': {
                        const snapshot = state.snapshot;
                        if (!snapshot
                            || command.revision !== snapshot.revision
                            || command.moduleKey !== snapshot.graph.moduleKey) return;
                        const layout = relayoutAll(
                            snapshot.graph,
                            archDesignLayout(snapshot.design, snapshot.graph)
                        );
                        await applyDocumentEdit(snapshot, {
                            type: 'setPresentation',
                            presentation: archDesignPresentationFromLayout(
                                snapshot.design,
                                snapshot.graph,
                                layout
                            ),
                        });
                        return;
                    }
                    case 'exportArchDesign': {
                        const snapshot = state.snapshot;
                        if (!snapshot || command.revision !== snapshot.revision) return;
                        await this.exportSnapshot(document.uri, snapshot);
                        return;
                    }
                    case 'selectModule':
                    case 'revealSource':
                    case 'openDefinition':
                    case 'search':
                        return;
                }
            })().catch(error => { void reportError(error); });
        });
        const documentSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== document
                || (state.disposed
                    && !state.pendingPresentationWrite
                    && !state.pendingSemanticWrite)) return;
            if (event.contentChanges.length === 0) return;
            void (async () => {
                const pendingWrite = state.pendingPresentationWrite;
                if (pendingWrite && document.getText() === pendingWrite.expectedText) {
                    state.pendingPresentationWrite = undefined;
                    state.refreshGeneration += 1;
                    const nextRevision = revision(
                        pendingWrite.sourceSnapshot.interfaceProtocolGeneration
                    );
                    const nextSnapshot: EditableSnapshot = {
                        ...pendingWrite.sourceSnapshot,
                        revision: nextRevision,
                        design: pendingWrite.design,
                    };
                    state.snapshot = nextSnapshot;
                    state.acknowledgedPresentationRevision = {
                        source: pendingWrite.sourceSnapshot.revision,
                        current: nextRevision,
                    };
                    await post({
                        type: 'archDesignLayoutSaved',
                        revision: nextRevision,
                    });
                    await applyQueuedPresentation(nextSnapshot);
                    if (state.refreshAfterPresentationWrite
                        && !state.pendingPresentationWrite
                        && !state.disposed) {
                        state.refreshAfterPresentationWrite = false;
                        await refresh();
                    }
                    finishClosedPanelPresentationWrites();
                    return;
                }
                const pendingSemanticWrite = state.pendingSemanticWrite;
                if (pendingSemanticWrite
                    && document.getText() === pendingSemanticWrite.expectedText) {
                    state.pendingSemanticWrite = undefined;
                    state.refreshGeneration += 1;
                    const nextRevision = revision(
                        pendingSemanticWrite.sourceSnapshot.interfaceProtocolGeneration
                    );
                    const nextSnapshot: EditableSnapshot = {
                        ...pendingSemanticWrite.sourceSnapshot,
                        revision: nextRevision,
                        design: pendingSemanticWrite.design,
                    };
                    state.snapshot = nextSnapshot;
                    if (state.queuedPresentationLayout) {
                        state.refreshAfterPresentationWrite = !state.disposed;
                        await applyQueuedPresentation(nextSnapshot);
                    } else if (!state.disposed) {
                        await refresh();
                    }
                    finishClosedPanelPresentationWrites();
                    return;
                }
                state.pendingPresentationWrite = undefined;
                state.pendingSemanticWrite = undefined;
                state.queuedPresentationLayout = undefined;
                state.acknowledgedPresentationRevision = undefined;
                state.refreshAfterPresentationWrite = false;
                await refresh();
            })().catch(error => { void reportError(error); });
        });
        const indexInvalidationSubscription = this.services.onDidInvalidate?.(index => {
            if (index !== undefined && index !== state.lastIndex) return;
            void refresh().catch(error => { void reportError(error); });
        });
        const protocolInvalidationSubscription =
            this.services.onDidInvalidateInterfaceProtocols?.(() => {
                void refresh(true).catch(error => { void reportError(error); });
            });
        const tokenSubscription = token.onCancellationRequested(() => {
            state.refreshGeneration += 1;
            state.snapshot = undefined;
            state.pendingPresentationWrite = undefined;
            state.pendingSemanticWrite = undefined;
            state.queuedPresentationLayout = undefined;
            state.acknowledgedPresentationRevision = undefined;
            state.refreshAfterPresentationWrite = false;
            if (this.sessions.get(sessionKey) === session) {
                this.sessions.delete(sessionKey);
            }
        });
        const panelSubscription = panel.onDidDispose(() => {
            if (state.disposed) return;
            state.disposed = true;
            state.refreshGeneration += 1;
            if (this.sessions.get(sessionKey) === session) {
                this.sessions.delete(sessionKey);
            }
            this.diagnostics.delete(document.uri);
            this.services.releaseIndex?.(indexOwner);
            messageSubscription.dispose();
            indexInvalidationSubscription?.dispose();
            protocolInvalidationSubscription?.dispose();
            tokenSubscription.dispose();
            panelSubscription.dispose();
            finishClosedPanelPresentationWrites();
        });
    }

    private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
        const shell = fs.readFileSync(
            vscode.Uri.joinPath(assetRoot, 'index.html').fsPath,
            'utf8'
        );
        return buildSchematicWebviewHtml(shell, {
            cspSource: webview.cspSource,
            styleUri: webview.asWebviewUri(
                vscode.Uri.joinPath(assetRoot, 'index.css')
            ).toString(),
            scriptUri: webview.asWebviewUri(
                vscode.Uri.joinPath(assetRoot, 'index.js')
            ).toString(),
            nonce: crypto.randomBytes(18).toString('base64'),
        });
    }
}
