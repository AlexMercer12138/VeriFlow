import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';

import type { HdlDocument, ModuleModel } from '../core/hdl/model';
import { canonicalizeSourceUri } from '../core/hdl/preprocessor';
import type { WorkspaceHdlIndex } from '../core/hdl/workspaceHdlIndex';
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
        document: vscode.TextDocument
    ): WorkspaceHdlIndex | undefined | Promise<WorkspaceHdlIndex | undefined>;
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
};

function instanceBindings(
    module: ModuleModel,
    index: WorkspaceHdlIndex | undefined
): Map<string, InstanceDefinitionBinding> {
    const bindings = new Map<string, InstanceDefinitionBinding>();
    if (!index) return bindings;
    for (const instance of module.instances) {
        const definitions = index.findDefinitions(instance.moduleName, 'module');
        if (definitions.length === 1) {
            bindings.set(instance.id, definitions[0]);
        } else if (definitions.length > 1) {
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

        const post = async (event: HostEvent): Promise<void> => {
            if (!state.disposed) {
                await panel.webview.postMessage(event);
            }
        };
        const initializeEvent = (): Extract<HostEvent, { type: 'initialize' }> => ({
            type: 'initialize',
            fileUri: uri,
            modules: state.modules.map(module => ({
                key: module.key,
                name: module.name,
            })),
            selectedModuleKey: state.selectedModuleKey ?? '',
        });
        const buildSelectedGraph = async (
            preparedIndex?: WorkspaceHdlIndex
        ): Promise<void> => {
            const selected = state.modules.find(module =>
                module.key === state.selectedModuleKey
            );
            if (!selected || !state.parsedDocument || state.disposed) {
                graphBuilds.invalidate();
                state.graph = undefined;
                state.layout = undefined;
                return;
            }
            const parsedDocument = state.parsedDocument;
            const build = graphBuilds.begin(parsedDocument, selected.key);
            const index = preparedIndex ?? await this.services.getIndex(document);
            if (state.disposed || !graphBuilds.isCurrent(
                build,
                state.parsedDocument,
                state.selectedModuleKey
            )) {
                return;
            }
            const graph = {
                ...buildSchematicGraph(
                    parsedDocument,
                    selected.model,
                    instanceBindings(selected.model, index)
                ),
                moduleKey: selected.key,
            };
            state.graph = graph;
            state.layout = mergeLayout(
                graph,
                this.layoutStore.load(uri, selected.key)
            );
        };
        const sendCurrentState = async (): Promise<void> => {
            await post(initializeEvent());
            if (state.graph && state.layout) {
                await post({ type: 'graph', graph: state.graph, layout: state.layout });
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
            refreshAbortController?.abort();
            const refreshController = new AbortController();
            refreshAbortController = refreshController;
            const documentUri = document.uri.toString();
            const documentVersion = document.version;
            const documentText = document.getText();
            try {
                const index = await this.services.getIndex(document);
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
                const parsed = await index.parseOpenDocument(
                    documentUri,
                    documentVersion,
                    documentText,
                    refreshController.signal
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
                await buildSelectedGraph(index);
                if (!isCurrentSchematicRefresh(
                    generation,
                    state.refreshGeneration,
                    state.disposed,
                    token.isCancellationRequested
                )) {
                    return;
                }
                ensureRegistered();
                if (state.ready) {
                    await sendCurrentState();
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
            state.selectedModuleKey = definitionKey;
            await buildSelectedGraph();
            if (state.ready) {
                await sendCurrentState();
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
                        } else if (state.parsedDocument) {
                            await sendCurrentState();
                        }
                        return;
                    case 'selectModule':
                        await selectModule(command.moduleKey);
                        return;
                    case 'saveLayout':
                        if (command.moduleKey !== state.selectedModuleKey) return;
                        state.layout = command.layout;
                        await this.layoutStore.save(uri, command.moduleKey, command.layout);
                        return;
                    case 'relayoutAll':
                        if (command.moduleKey !== state.selectedModuleKey
                            || !state.graph) {
                            return;
                        }
                        state.layout = relayoutAll(state.graph, state.layout);
                        await this.layoutStore.save(uri, command.moduleKey, state.layout);
                        await post({ type: 'graph', graph: state.graph, layout: state.layout });
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
        const focusSubscription = panel.onDidChangeViewState(event => {
            if (event.webviewPanel.active) {
                this.navigation.markFocused(handle);
            }
        });
        const panelSubscription = panel.onDidDispose(() => {
            state.disposed = true;
            state.refreshGeneration++;
            refreshAbortController?.abort();
            graphBuilds.invalidate();
            registration?.dispose();
            messageSubscription.dispose();
            documentSubscription.dispose();
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
