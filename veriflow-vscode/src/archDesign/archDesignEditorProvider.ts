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

import type { WorkspaceHdlIndex } from '../core/hdl/workspaceHdlIndex';
import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import { parseWebviewCommand, type HostEvent } from '../schematic/protocol';
import { relayoutAll } from '../schematic/layoutStore';
import { buildSchematicWebviewHtml } from '../schematic/webviewSupport';
import {
    archDesignLayout,
    archDesignPresentationFromLayout,
    toArchDesignModuleDefinitions,
} from './editorSupport';
import {
    exportArchDesignToFile,
    type ArchDesignFileExportResult,
} from './archDesignExport';

export type ArchDesignEditorServices = {
    getIndex(
        document: vscode.TextDocument,
        owner?: object
    ): WorkspaceHdlIndex | undefined | Promise<WorkspaceHdlIndex | undefined>;
    releaseIndex?(owner: object): void;
    onDidInvalidate?(
        listener: (index?: WorkspaceHdlIndex) => void
    ): { dispose(): void };
    exportDesign?(
        designPath: string,
        design: ArchDesign,
        definitions: readonly HdlDefinitionSummary[]
    ): Promise<ArchDesignFileExportResult>;
};

type EditableSnapshot = Readonly<{
    revision: string;
    design: ArchDesign;
    definitions: readonly ArchDesignModuleDefinition[];
    sourceDefinitions: readonly HdlDefinitionSummary[];
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
            const result = await (this.services.exportDesign ?? exportArchDesignToFile)(
                uri.fsPath,
                snapshot.design,
                snapshot.sourceDefinitions
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
        const revision = (): string => {
            revisionSequence += 1;
            return `${revisionNamespace}:${document.version}:${revisionSequence.toString(36)}`;
        };
        const fullRange = (): vscode.Range => new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        const diagnosticRange = (): vscode.Range => fullRange();
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
        const refresh = async (): Promise<void> => {
            if (!state.ready || state.disposed || token.isCancellationRequested) return;
            const generation = ++state.refreshGeneration;
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
            const index = await this.services.getIndex(document, indexOwner);
            if (generation !== state.refreshGeneration
                || state.disposed
                || token.isCancellationRequested) return;
            state.lastIndex = index;
            const sourceDefinitions = index?.getAllDefinitions('module') ?? [];
            const definitions = toArchDesignModuleDefinitions(sourceDefinitions);
            const projection = projectArchDesignGraph(design, definitions, {
                fileUri: document.uri.toString(),
            });
            const nextRevision = revision();
            const snapshot: EditableSnapshot = {
                revision: nextRevision,
                design,
                definitions,
                sourceDefinitions,
                validation: projection.validation,
                graph: projection.graph,
                ...(index === undefined ? {} : { index }),
            };
            state.snapshot = snapshot;
            await publishDiagnostics(projection.validation.diagnostics);
            if (generation !== state.refreshGeneration || state.disposed) return;
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
            });
            await post({
                type: 'archDesignState',
                status: 'editable',
                revision: nextRevision,
                design,
                catalog: definitions,
                validation: projection.validation,
            });
        };
        const applyDocumentEdit = async (
            snapshot: EditableSnapshot,
            edit: Parameters<typeof applyArchDesignEdit>[1]
        ): Promise<void> => {
            if (state.snapshot !== snapshot || state.disposed) return;
            try {
                const next = applyArchDesignEdit(snapshot.design, edit);
                const nextText = serializeArchDesign(next);
                if (nextText === document.getText()) {
                    await refresh();
                    return;
                }
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.replace(document.uri, fullRange(), nextText);
                state.snapshot = undefined;
                const applied = await vscode.workspace.applyEdit(workspaceEdit);
                if (!applied) throw new Error('Unable to apply Arch Design edit');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!state.disposed) await vscode.window.showErrorMessage(message);
                await refresh();
            }
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
                        if (!snapshot
                            || command.revision !== snapshot.revision
                            || command.moduleKey !== snapshot.graph.moduleKey) return;
                        await applyDocumentEdit(snapshot, {
                            type: 'setPresentation',
                            presentation: archDesignPresentationFromLayout(
                                snapshot.design,
                                snapshot.graph,
                                command.layout
                            ),
                        });
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
            if (event.document !== document || state.disposed) return;
            void refresh().catch(error => { void reportError(error); });
        });
        const indexInvalidationSubscription = this.services.onDidInvalidate?.(index => {
            if (index !== undefined && index !== state.lastIndex) return;
            void refresh().catch(error => { void reportError(error); });
        });
        const tokenSubscription = token.onCancellationRequested(() => {
            state.refreshGeneration += 1;
            state.snapshot = undefined;
            if (this.sessions.get(sessionKey) === session) {
                this.sessions.delete(sessionKey);
            }
        });
        const panelSubscription = panel.onDidDispose(() => {
            if (state.disposed) return;
            state.disposed = true;
            state.refreshGeneration += 1;
            state.snapshot = undefined;
            if (this.sessions.get(sessionKey) === session) {
                this.sessions.delete(sessionKey);
            }
            this.diagnostics.delete(document.uri);
            this.services.releaseIndex?.(indexOwner);
            messageSubscription.dispose();
            documentSubscription.dispose();
            indexInvalidationSubscription?.dispose();
            tokenSubscription.dispose();
            panelSubscription.dispose();
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
