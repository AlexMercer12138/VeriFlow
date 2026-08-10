import type { GraphNode, SchematicGraph } from '@veriflow/schematic-core';

import type { HdlDefinitionSummary } from '../../core/hdl/workspaceIndexTypes';
import type { HdlDiagnostic } from '../../core/hdl/model';
import {
    mergeLayout,
    SchematicLayoutStore,
    type SchematicLayout,
} from '../../schematic/layoutStore';
import {
    openSchematicDefinition,
    revealSchematicSource,
    SchematicDiagnosticPublisher,
    SchematicNavigationRegistry,
    type SchematicPanelHandle,
} from '../../schematic/navigationRegistry';
import type { HostEvent, WebviewCommand } from '../../schematic/protocol';

export type SchematicProviderHarness = {
    registry: SchematicNavigationRegistry;
    resolve(uri: string, moduleKeys: string[]): Promise<TestPanelHandle>;
    dispatch(panel: TestPanelHandle, command: WebviewCommand): Promise<void>;
    openedText: Array<{ uri: string; selection: { start: number; end: number } }>;
    openedSchematics: Array<{ uri: string; definitionKey: string }>;
    hostEvents: HostEvent[];
    diagnostics: Array<{ uri: string; count: number }>;
};

export type TestPanelHandle = SchematicPanelHandle & {
    selectedModuleKey: string;
    messages: HostEvent[];
    disposed: boolean;
};

class MemoryMemento {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, value);
        }
    }
}

function definitionFromKey(
    definitionKey: string,
    fallbackUri: string
): HdlDefinitionSummary {
    const match = /^module:(.*):(\d+)$/.exec(definitionKey);
    const uri = match?.[1] ?? fallbackUri;
    const declarationStart = Number(match?.[2] ?? 0);
    return {
        key: definitionKey,
        kind: 'module',
        name: definitionKey,
        uri,
        declarationStart,
        declarationLine: 1,
        parameters: [],
        ports: [],
        dependencies: [],
        modelFingerprint: definitionKey,
    };
}

function nodeFor(moduleKey: string): GraphNode {
    return {
        id: `node:${moduleKey}`,
        kind: 'opaque',
        label: moduleKey,
        pins: [],
        readOnly: true,
    };
}

function boundaryNode(
    moduleKey: string,
    side: 'input' | 'output'
): GraphNode {
    const id = `port:${side}:${moduleKey}`;
    return {
        id,
        kind: 'port',
        label: side,
        pins: [{
            id: `${id}:pin`,
            name: side,
            direction: side === 'input' ? 'driver' : 'load',
            width: { kind: 'known', bits: 1 },
            readOnly: true,
        }],
        readOnly: true,
    };
}

function graphDiagnostics(uri: string): HdlDiagnostic[] {
    return [{
        severity: 'error',
        code: 'TEST_ERROR',
        message: 'Current-file error',
        span: { start: 2, end: 6 },
    }, {
        severity: 'warning',
        code: 'TEST_WARNING',
        message: 'Included warning',
        span: {
            start: 100,
            end: 120,
            compositeParts: [{
                uri: new URL('diagnostics.svh', uri).toString(),
                start: 8,
                end: 12,
            }],
        },
    }];
}

function graphFor(uri: string, moduleKey: string): SchematicGraph {
    return {
        fileUri: uri,
        moduleKey,
        moduleName: moduleKey,
        nodes: [
            boundaryNode(moduleKey, 'input'),
            nodeFor(moduleKey),
            boundaryNode(moduleKey, 'output'),
        ],
        networks: [],
        diagnostics: graphDiagnostics(uri),
    };
}

export function createSchematicProviderHarness(): SchematicProviderHarness {
    const registry = new SchematicNavigationRegistry();
    const layoutStore = new SchematicLayoutStore(new MemoryMemento());
    const openedText: SchematicProviderHarness['openedText'] = [];
    const openedSchematics: SchematicProviderHarness['openedSchematics'] = [];
    const hostEvents: HostEvent[] = [];
    const diagnostics: SchematicProviderHarness['diagnostics'] = [];
    const diagnosticPublisher = new SchematicDiagnosticPublisher({
        set(uri, items): void {
            const next = diagnostics.filter(record => record.uri !== uri);
            next.push({ uri, count: items.length });
            next.sort((left, right) => left.uri.localeCompare(right.uri));
            diagnostics.splice(0, diagnostics.length, ...next);
        },
        delete(uri): void {
            const next = diagnostics.filter(record => record.uri !== uri);
            diagnostics.splice(0, diagnostics.length, ...next);
        },
    });
    const definitions = new Map<string, HdlDefinitionSummary>();
    const moduleKeysByPanel = new Map<TestPanelHandle, string[]>();
    const layoutsByPanel = new Map<TestPanelHandle, Map<string, SchematicLayout>>();

    const post = (panel: TestPanelHandle, event: HostEvent): void => {
        panel.messages.push(event);
        hostEvents.push(event);
    };
    const publishGraph = async (panel: TestPanelHandle): Promise<void> => {
        const graph = graphFor(panel.uri, panel.selectedModuleKey);
        const persisted = layoutStore.load(panel.uri, panel.selectedModuleKey, graph)
            ?? layoutsByPanel.get(panel)?.get(panel.selectedModuleKey);
        const layout = mergeLayout(graph, persisted);
        let panelLayouts = layoutsByPanel.get(panel);
        if (!panelLayouts) {
            panelLayouts = new Map();
            layoutsByPanel.set(panel, panelLayouts);
        }
        panelLayouts.set(panel.selectedModuleKey, layout);
        post(panel, {
            type: 'graph',
            revision: `test:${panel.selectedModuleKey}`,
            graph,
            layout,
        });
        const counts = await diagnosticPublisher.publish(panel, panel.uri, graph.diagnostics);
        post(panel, { type: 'diagnostics', ...counts });
    };

    return {
        registry,
        openedText,
        openedSchematics,
        hostEvents,
        diagnostics,
        async resolve(uri, moduleKeys): Promise<TestPanelHandle> {
            for (const key of moduleKeys) {
                definitions.set(key, definitionFromKey(key, uri));
            }
            const pending = registry.consumePending(uri);
            let selectedModuleKey = pending && moduleKeys.includes(pending)
                ? pending
                : moduleKeys[0] ?? '';
            const messages: HostEvent[] = [];
            const disposed = false;
            const panel = {
                uri,
                get selectedModuleKey(): string { return selectedModuleKey; },
                get disposed(): boolean { return disposed; },
                messages,
                reveal(): void {
                    if (!disposed) registry.markFocused(panel);
                },
                async selectModule(definitionKey: string): Promise<void> {
                    if (disposed || !moduleKeysByPanel.get(panel)?.includes(definitionKey)) {
                        return;
                    }
                    selectedModuleKey = definitionKey;
                    post(panel, {
                        type: 'initialize',
                        fileUri: uri,
                        modules: moduleKeys.map(key => ({ key, name: key })),
                        selectedModuleKey,
                    });
                    await publishGraph(panel);
                },
            } as TestPanelHandle;
            moduleKeysByPanel.set(panel, [...moduleKeys]);
            registry.register(panel);
            registry.markFocused(panel);
            post(panel, {
                type: 'initialize',
                fileUri: uri,
                modules: moduleKeys.map(key => ({ key, name: key })),
                selectedModuleKey,
            });
            if (selectedModuleKey) await publishGraph(panel);
            return panel;
        },
        async dispatch(panel, command): Promise<void> {
            switch (command.type) {
                case 'selectModule':
                    await panel.selectModule(command.moduleKey);
                    return;
                case 'saveLayout': {
                    if (!moduleKeysByPanel.get(panel)?.includes(command.moduleKey)) return;
                    let panelLayouts = layoutsByPanel.get(panel);
                    if (!panelLayouts) {
                        panelLayouts = new Map();
                        layoutsByPanel.set(panel, panelLayouts);
                    }
                    panelLayouts.set(command.moduleKey, command.layout);
                    const graph = graphFor(panel.uri, command.moduleKey);
                    await layoutStore.save(
                        panel.uri,
                        command.moduleKey,
                        graph,
                        command.layout
                    );
                    return;
                }
                case 'ready':
                    return;
                case 'revealSource':
                    await revealSchematicSource(panel.uri, command.span, {
                        async openTextDocument(uri) {
                            return {
                                document: uri,
                                positionAt: (offset: number) => offset,
                            };
                        },
                        async showTextDocument(uri, selection) {
                            openedText.push({ uri, selection });
                        },
                    });
                    return;
                case 'openDefinition':
                    await openSchematicDefinition(
                        panel,
                        command.definitionKey,
                        registry,
                        {
                            getDefinition: definitionKey => definitions.get(definitionKey),
                            async openSchematic(uri, definitionKey) {
                                openedSchematics.push({ uri, definitionKey });
                            },
                        }
                    );
                    return;
                case 'search':
                case 'relayoutAll':
                    return;
            }
        },
    };
}
