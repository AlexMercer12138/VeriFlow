import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

import type { HdlDocument, ModuleModel } from '../core/hdl/model';
import { canonicalizeSourceUri } from '../core/hdl/preprocessor';
import type { WorkspaceHdlIndex } from '../core/hdl/workspaceHdlIndex';
import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import { buildSchematicGraph, type InstanceDefinitionBinding } from './graphBuilder';
import {
    mergeLayout,
    relayoutAll,
    SchematicLayoutStore,
    type SchematicLayout,
} from './layoutStore';
import {
    type SchematicNavigationRegistry,
    type SchematicPanelHandle,
} from './navigationRegistry';
import { parseWebviewCommand, type HostEvent } from './protocol';
import {
    isCurrentSchematicRefresh,
    selectableSchematicModules,
    selectSchematicModuleKey,
    SchematicBuildGeneration,
    type SelectableSchematicModule,
} from './schematicEditorSupport';
import { buildSchematicWebviewHtml } from './webviewSupport';

export type SchematicEditorServices = {
    getIndex(
        document: vscode.TextDocument,
        owner?: object
    ): WorkspaceHdlIndex | undefined | Promise<WorkspaceHdlIndex | undefined>;
    releaseIndex?(owner: object): void;
    onDidInvalidate?(
        listener: (index?: WorkspaceHdlIndex) => void
    ): { dispose(): void };
};

type SelectableModule = SelectableSchematicModule<ModuleModel>;

type PanelState = {
    disposed: boolean;
    ready: boolean;
    refreshGeneration: number;
    parsedDocument?: HdlDocument;
    modules: SelectableModule[];
    selectedModuleKey?: string;
    graph?: ReturnType<typeof buildSchematicGraph>;
    layout?: SchematicLayout;
    errorMessage?: string;
    index?: WorkspaceHdlIndex;
};

type SchematicPublishSnapshot = {
    generation: number;
    initialize: Extract<HostEvent, { type: 'initialize' }>;
    graph?: ReturnType<typeof buildSchematicGraph>;
    layout?: SchematicLayout;
};

function instanceBindings(
    document: HdlDocument,
    module: ModuleModel,
    index: WorkspaceHdlIndex | undefined
): Map<string, InstanceDefinitionBinding> {
    const bindings = new Map<string, InstanceDefinitionBinding>();
    const documentUri = canonicalizeSourceUri(document.uri);
    const liveDefinitions = document.modules
        .filter(candidate => canonicalizeSourceUri(
            candidate.nameSpan.uri ?? document.uri
        ) === documentUri)
        .map((candidate): HdlDefinitionSummary => ({
            key: `module:${documentUri}:${candidate.declarationSpan.start}`,
            kind: 'module',
            name: candidate.name,
            uri: documentUri,
            declarationStart: candidate.declarationSpan.start,
            declarationLine: candidate.declarationLine,
            parameters: candidate.parameters.map(parameter => ({
                name: parameter.name,
                ...(parameter.defaultExpression === undefined
                    ? {}
                    : { defaultExpression: parameter.defaultExpression }),
            })),
            ports: candidate.ports.map(port => ({
                name: port.name,
                direction: port.direction,
                ...(port.packedRange === undefined
                    ? {}
                    : { packedRange: port.packedRange }),
                width: port.width,
            })),
            dependencies: [...new Set(candidate.instances.map(
                instance => instance.moduleName
            ))].sort(),
            modelFingerprint: `live:${documentUri}:${candidate.declarationSpan.start}`,
        }));
    for (const instance of module.instances) {
        const definitions = new Map<string, HdlDefinitionSummary>();
        for (const definition of index?.findDefinitions(
            instance.moduleName,
            'module'
        ) ?? []) {
            if (canonicalizeSourceUri(definition.uri) !== documentUri) {
                definitions.set(definition.key, definition);
            }
        }
        for (const definition of liveDefinitions) {
            if (definition.name === instance.moduleName) {
                definitions.set(definition.key, definition);
            }
        }
        if (definitions.size === 1) {
            bindings.set(instance.id, [...definitions.values()][0]);
        } else if (definitions.size > 1) {
            bindings.set(instance.id, null);
        }
    }
    return bindings;
}

export class SchematicEditorProvider implements vscode.CustomTextEditorProvider {
    static readonly viewType = 'veriflow.schematicEditor';

    private readonly layoutStore: SchematicLayoutStore;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly navigation: SchematicNavigationRegistry,
        private readonly services: SchematicEditorServices
    ) {
        this.layoutStore = new SchematicLayoutStore(context.workspaceState);
    }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        const uri = canonicalizeSourceUri(document.uri.toString());
        const indexOwner = {};
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
            modules: [],
        };
        const graphBuilds = new SchematicBuildGeneration<HdlDocument>();
        let consumePendingSelection = true;
        let registration: { dispose(): void } | undefined;
        let ensureRegistered = (): void => undefined;
        let refreshAbortController: AbortController | undefined;
        let publishGeneration = 0;
        let currentPublishSnapshot: SchematicPublishSnapshot | undefined;
        const layoutIntents = new Map<string, SchematicLayout>();

        const post = async (event: HostEvent): Promise<void> => {
            if (!state.disposed) {
                await panel.webview.postMessage(event);
            }
        };
        const isCurrentPublish = (generation: number): boolean =>
            generation === publishGeneration
            && !state.disposed
            && !token.isCancellationRequested;
        const capturePublishSnapshot = (generation: number): SchematicPublishSnapshot => ({
            generation,
            initialize: {
                type: 'initialize',
                fileUri: uri,
                modules: state.modules.map(module => ({
                    key: module.key,
                    name: module.name,
                })),
                selectedModuleKey: state.selectedModuleKey ?? '',
            },
            ...(state.graph && state.layout
                ? { graph: state.graph, layout: state.layout }
                : {}),
        });
        const buildSelectedGraph = async (
            generation: number,
            preparedIndex?: WorkspaceHdlIndex
        ): Promise<SchematicPublishSnapshot | undefined> => {
            const selected = state.modules.find(module =>
                module.key === state.selectedModuleKey
            );
            if (!selected || !state.parsedDocument || state.disposed) {
                graphBuilds.invalidate();
                state.graph = undefined;
                state.layout = undefined;
                if (!isCurrentPublish(generation)) return undefined;
                const snapshot = capturePublishSnapshot(generation);
                currentPublishSnapshot = snapshot;
                return snapshot;
            }
            const parsedDocument = state.parsedDocument;
            const build = graphBuilds.begin(parsedDocument, selected.key);
            const index = preparedIndex ?? await this.services.getIndex(
                document,
                indexOwner
            );
            if (!isCurrentPublish(generation) || !graphBuilds.isCurrent(
                build,
                state.parsedDocument,
                state.selectedModuleKey
            )) {
                return undefined;
            }
            const graph = {
                ...buildSchematicGraph(
                    parsedDocument,
                    selected.model,
                    instanceBindings(parsedDocument, selected.model, index)
                ),
                moduleKey: selected.key,
            };
            const intendedLayout = layoutIntents.get(selected.key)
                ?? this.layoutStore.load(uri, selected.key);
            const layout = mergeLayout(
                graph,
                intendedLayout
            );
            if (!isCurrentPublish(generation)) return undefined;
            state.graph = graph;
            state.layout = layout;
            const snapshot = capturePublishSnapshot(generation);
            currentPublishSnapshot = snapshot;
            return snapshot;
        };
        const publishSnapshot = async (
            snapshot: SchematicPublishSnapshot
        ): Promise<void> => {
            if (!isCurrentPublish(snapshot.generation)) return;
            await panel.webview.postMessage(snapshot.initialize);
            if (!isCurrentPublish(snapshot.generation)) return;
            if (snapshot.graph && snapshot.layout) {
                await panel.webview.postMessage({
                    type: 'graph',
                    graph: snapshot.graph,
                    layout: snapshot.layout,
                });
                if (!isCurrentPublish(snapshot.generation)) return;
            }
        };
        const reportError = async (error: unknown): Promise<void> => {
            await post({
                type: 'hostError',
                message: error instanceof Error ? error.message : String(error),
            });
        };
        const refreshDocument = async (): Promise<void> => {
            const generation = ++state.refreshGeneration;
            publishGeneration++;
            refreshAbortController?.abort();
            const refreshController = new AbortController();
            refreshAbortController = refreshController;
            const documentUri = document.uri.toString();
            const documentVersion = document.version;
            const documentText = document.getText();
            try {
                const index = await this.services.getIndex(document, indexOwner);
                if (!isCurrentSchematicRefresh(
                    generation,
                    state.refreshGeneration,
                    state.disposed,
                    token.isCancellationRequested
                )) {
                    return;
                }
                if (!index) {
                    throw new Error('HDL workspace index is unavailable');
                }
                state.index = index;
                const parsed = await index.parseOpenDocument(
                    documentUri,
                    documentVersion,
                    documentText,
                    refreshController.signal,
                    indexOwner
                );
                if (!isCurrentSchematicRefresh(
                    generation,
                    state.refreshGeneration,
                    state.disposed,
                    token.isCancellationRequested
                )) {
                    return;
                }
                state.errorMessage = undefined;
                state.parsedDocument = parsed;
                state.modules = selectableSchematicModules(
                    uri,
                    parsed.uri,
                    parsed.modules
                );
                const pending = consumePendingSelection
                    ? this.navigation.consumePending(uri)
                    : undefined;
                consumePendingSelection = false;
                state.selectedModuleKey = selectSchematicModuleKey(
                    state.modules,
                    pending,
                    state.selectedModuleKey
                );
                const invocationGeneration = ++publishGeneration;
                const snapshot = await buildSelectedGraph(invocationGeneration, index);
                if (!isCurrentSchematicRefresh(
                    generation,
                    state.refreshGeneration,
                    state.disposed,
                    token.isCancellationRequested
                )) {
                    return;
                }
                ensureRegistered();
                if (state.ready && snapshot) {
                    await publishSnapshot(snapshot);
                }
            } catch (error) {
                if (!state.disposed
                    && !token.isCancellationRequested
                    && generation === state.refreshGeneration
                ) {
                    state.errorMessage = error instanceof Error
                        ? error.message
                        : String(error);
                    if (state.ready) {
                        await reportError(state.errorMessage);
                    }
                }
            } finally {
                if (refreshAbortController === refreshController) {
                    refreshAbortController = undefined;
                }
            }
        };
        const selectModule = async (definitionKey: string): Promise<void> => {
            if (state.disposed
                || !state.modules.some(module => module.key === definitionKey)) {
                return;
            }
            const invocationGeneration = ++publishGeneration;
            state.selectedModuleKey = definitionKey;
            const snapshot = await buildSelectedGraph(invocationGeneration);
            if (state.ready && snapshot) {
                await publishSnapshot(snapshot);
            }
        };
        const handle: SchematicPanelHandle = {
            uri,
            reveal: () => {
                if (state.disposed) return;
                panel.reveal(panel.viewColumn);
                this.navigation.markFocused(handle);
            },
            selectModule,
        };
        ensureRegistered = () => {
            if (state.disposed || token.isCancellationRequested || registration) return;
            registration = this.navigation.register(handle);
            if (panel.active) {
                this.navigation.markFocused(handle);
            }
        };
        const tokenSubscription = token.onCancellationRequested(() => {
            refreshAbortController?.abort();
        });

        const messageSubscription = panel.webview.onDidReceiveMessage(message => {
            const command = parseWebviewCommand(message);
            if (!command) return;
            void (async () => {
                switch (command.type) {
                    case 'ready':
                        state.ready = true;
                        if (state.errorMessage) {
                            await reportError(state.errorMessage);
                        } else if (currentPublishSnapshot) {
                            await publishSnapshot(currentPublishSnapshot);
                        }
                        return;
                    case 'selectModule':
                        await selectModule(command.moduleKey);
                        return;
                    case 'saveLayout':
                        if (command.moduleKey !== state.selectedModuleKey) return;
                        state.layout = command.layout;
                        layoutIntents.set(command.moduleKey, command.layout);
                        currentPublishSnapshot = capturePublishSnapshot(publishGeneration);
                        await this.layoutStore.save(uri, command.moduleKey, command.layout);
                        if (layoutIntents.get(command.moduleKey) === command.layout) {
                            layoutIntents.delete(command.moduleKey);
                        }
                        return;
                    case 'relayoutAll':
                        if (command.moduleKey !== state.selectedModuleKey
                            || !state.graph) {
                            return;
                        }
                        const invocationGeneration = ++publishGeneration;
                        const graph = state.graph;
                        const layout = relayoutAll(graph, state.layout);
                        state.layout = layout;
                        layoutIntents.set(command.moduleKey, layout);
                        currentPublishSnapshot = capturePublishSnapshot(
                            invocationGeneration
                        );
                        await this.layoutStore.save(uri, command.moduleKey, layout);
                        if (layoutIntents.get(command.moduleKey) === layout) {
                            layoutIntents.delete(command.moduleKey);
                        }
                        if (!isCurrentPublish(invocationGeneration)) return;
                        await panel.webview.postMessage({ type: 'graph', graph, layout });
                        if (!isCurrentPublish(invocationGeneration)) return;
                        return;
                    case 'revealSource':
                    case 'openDefinition':
                    case 'search':
                        return;
                }
            })().catch(error => { void reportError(error); });
        });
        const documentSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (canonicalizeSourceUri(event.document.uri.toString()) === uri) {
                void refreshDocument();
            }
        });
        const indexInvalidationSubscription = this.services.onDidInvalidate?.(
            invalidatedIndex => {
                if (invalidatedIndex === undefined || invalidatedIndex === state.index) {
                    void refreshDocument();
                }
            }
        );
        const focusSubscription = panel.onDidChangeViewState(event => {
            if (event.webviewPanel.active) {
                this.navigation.markFocused(handle);
            }
        });
        const panelSubscription = panel.onDidDispose(() => {
            state.disposed = true;
            state.refreshGeneration++;
            publishGeneration++;
            refreshAbortController?.abort();
            graphBuilds.invalidate();
            registration?.dispose();
            this.services.releaseIndex?.(indexOwner);
            messageSubscription.dispose();
            documentSubscription.dispose();
            indexInvalidationSubscription?.dispose();
            focusSubscription.dispose();
            tokenSubscription.dispose();
            panelSubscription.dispose();
        });

        await refreshDocument();
    }

    private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
        const shell = fs.readFileSync(
            vscode.Uri.joinPath(assetRoot, 'index.html').fsPath,
            'utf8'
        );
        return buildSchematicWebviewHtml(shell, {
            cspSource: webview.cspSource,
            styleUri: webview.asWebviewUri(
                vscode.Uri.joinPath(assetRoot, 'styles.css')
            ).toString(),
            scriptUri: webview.asWebviewUri(
                vscode.Uri.joinPath(assetRoot, 'index.js')
            ).toString(),
            nonce: crypto.randomBytes(18).toString('base64'),
        });
    }
}
