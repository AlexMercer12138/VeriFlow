import * as assert from 'assert';

import {
    measureSchematicNode,
    resolvePinSides,
} from '@veriflow/schematic-core';

import type {
    GraphNode,
    GraphPin,
    PinDirection,
    SchematicGraph,
} from '../schematic/graphModel';
import {
    autoLayout,
    deriveFeedbackRoutes,
    mergeLayout,
    relayoutAll,
    schematicNodeSize,
    SchematicLayout,
    SchematicNodeSize,
    SchematicLayoutStore,
} from '../schematic/layoutStore';
import { parseWebviewCommand } from '../schematic/protocol';

class MemoryMemento {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
            return;
        }
        this.values.set(key, value);
    }

    keys(): string[] {
        return [...this.values.keys()];
    }

    set(key: string, value: unknown): void {
        this.values.set(key, value);
    }
}

class DeferredMemoryMemento {
    private readonly values = new Map<string, unknown>();
    private readonly pending: Array<{
        key: string;
        value: unknown;
        resolve: () => void;
    }> = [];

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    update(key: string, value: unknown): Promise<void> {
        return new Promise(resolve => this.pending.push({ key, value, resolve }));
    }

    pendingCount(): number {
        return this.pending.length;
    }

    resolveNext(): void {
        const update = this.pending.shift();
        assert.ok(update, 'expected a pending memento update');
        if (update.value === undefined) {
            this.values.delete(update.key);
        } else {
            this.values.set(update.key, update.value);
        }
        update.resolve();
    }
}

function createMemoryMemento(): MemoryMemento {
    return new MemoryMemento();
}

function pin(
    nodeId: string,
    name: string,
    direction: PinDirection
): GraphPin {
    return {
        id: `${nodeId}:${name}`,
        name,
        direction,
        width: { kind: 'known', bits: 1 },
        readOnly: false,
    };
}

function node(
    id: string,
    kind: GraphNode['kind'],
    pins: GraphPin[] = []
): GraphNode {
    return {
        id,
        kind,
        label: id.slice(id.indexOf(':') + 1),
        pins,
        readOnly: false,
    };
}

function createGraph(): SchematicGraph {
    const inputId = 'port:clk';
    const inoutId = 'port:shared';
    const instanceId = 'instance:u_child';
    const outputId = 'port:done';
    return {
        fileUri: 'file:///top.sv',
        moduleKey: 'module:top:0',
        moduleName: 'top',
        nodes: [
            node(inputId, 'port', [pin(inputId, 'clk', 'driver')]),
            node(inoutId, 'port', [
                pin(inoutId, 'shared', 'bidirectional'),
            ]),
            node(instanceId, 'instance', [
                pin(instanceId, 'clk', 'load'),
                pin(instanceId, 'shared', 'bidirectional'),
                pin(instanceId, 'done', 'driver'),
            ]),
            node(outputId, 'port', [pin(outputId, 'done', 'load')]),
        ],
        networks: [
            {
                id: 'network:clk',
                name: 'clk',
                width: { kind: 'known', bits: 1 },
                endpoints: [
                    { nodeId: inputId, pinId: `${inputId}:clk`, role: 'driver' },
                    { nodeId: instanceId, pinId: `${instanceId}:clk`, role: 'load' },
                ],
            },
            {
                id: 'network:shared',
                name: 'shared',
                width: { kind: 'known', bits: 1 },
                endpoints: [
                    {
                        nodeId: inoutId,
                        pinId: `${inoutId}:shared`,
                        role: 'bidirectional',
                    },
                    {
                        nodeId: instanceId,
                        pinId: `${instanceId}:shared`,
                        role: 'bidirectional',
                    },
                ],
            },
            {
                id: 'network:done',
                name: 'done',
                width: { kind: 'known', bits: 1 },
                endpoints: [
                    {
                        nodeId: instanceId,
                        pinId: `${instanceId}:done`,
                        role: 'driver',
                    },
                    { nodeId: outputId, pinId: `${outputId}:done`, role: 'load' },
                ],
            },
        ],
        diagnostics: [],
    };
}

function defaultLayout(): SchematicLayout {
    return {
        nodes: {},
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    };
}

function assertNodePairSeparated(
    graph: SchematicGraph,
    layout: SchematicLayout,
    firstId: string,
    secondId: string
): void {
    const firstNode = graph.nodes.find(candidate => candidate.id === firstId)!;
    const secondNode = graph.nodes.find(candidate => candidate.id === secondId)!;
    const first = layout.nodes[firstId];
    const second = layout.nodes[secondId];
    const firstSize = schematicNodeSize(firstNode);
    const secondSize = schematicNodeSize(secondNode);
    const horizontalSeparation = Math.abs(first.x - second.x)
        - (firstSize.width + secondSize.width) / 2;
    const verticalSeparation = Math.abs(first.y - second.y)
        - (firstSize.height + secondSize.height) / 2;
    assert.ok(
        horizontalSeparation >= 24 || verticalSeparation >= 24,
        `${firstId} overlaps ${secondId}: horizontal=${horizontalSeparation}, `
            + `vertical=${verticalSeparation}`
    );
}

async function testRoundTripAndRematch(): Promise<void> {
    const graph = createGraph();
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const layout = autoLayout(graph);
    layout.nodes['instance:u_child'].y += 31;
    layout.nodes['instance:u_child'].fixed = true;
    layout.viewport = { x: 10, y: 20, zoom: 1.25 };
    layout.minimap = false;
    layout.selectedObjectId = 'network:done';
    await store.save(graph.fileUri, graph.moduleKey, graph, layout);
    const storageKey = [
        'veriflow.schematicLayout',
        encodeURIComponent('file:///top.sv'),
        encodeURIComponent('module:top:0'),
    ].join(':');
    assert.deepStrictEqual(state.keys(), [storageKey]);
    const persisted = store.load(graph.fileUri, graph.moduleKey, graph);
    const merged = mergeLayout(graph, persisted);
    assert.strictEqual(merged.nodes['instance:u_child'].fixed, true);
    assert.strictEqual(merged.nodes['instance:u_child'].y,
        layout.nodes['instance:u_child'].y);
    assert.strictEqual(merged.selectedObjectId, 'network:done');
    assert.ok(merged.nodes['port:clk'].x < merged.nodes['instance:u_child'].x);

    const loaded = store.load(graph.fileUri, graph.moduleKey, graph)!;
    loaded.nodes['instance:u_child'].x = -1;
    loaded.viewport.x = -1;
    const reloaded = store.load(graph.fileUri, graph.moduleKey, graph)!;
    assert.strictEqual(reloaded.nodes['instance:u_child'].y,
        layout.nodes['instance:u_child'].y);
    assert.deepStrictEqual(reloaded.viewport, { x: 10, y: 20, zoom: 1.25 });

    const copyGraph = {
        ...graph,
        fileUri: 'file:///copy.sv',
        moduleKey: 'module:copy:0',
    };
    const callerLayout = autoLayout(copyGraph);
    callerLayout.nodes['port:clk'].y = 34;
    callerLayout.nodes['port:clk'].fixed = true;
    await store.save(copyGraph.fileUri, copyGraph.moduleKey, copyGraph, callerLayout);
    callerLayout.nodes['port:clk'].y = 999;
    assert.strictEqual(store.load(
        copyGraph.fileUri,
        copyGraph.moduleKey,
        copyGraph
    )?.nodes['port:clk'].y, 34);
}

async function testSemanticStorageEnvelopeRoundTrip(): Promise<void> {
    const graph = createGraph();
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const layout = autoLayout(graph);
    layout.nodes['instance:u_child'] = {
        ...layout.nodes['instance:u_child'],
        y: layout.nodes['instance:u_child'].y + 37,
        fixed: true,
    };
    layout.viewport = { x: 10, y: 20, zoom: 1.25 };
    layout.minimap = false;
    layout.selectedObjectId = 'network:done';

    await store.save(graph.fileUri, graph.moduleKey, graph, layout);

    const envelope = state.get<Record<string, unknown>>(state.keys()[0])!;
    assert.strictEqual(envelope.schemaVersion, 2);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(envelope, 'layout'), false);
    assert.deepStrictEqual(envelope.viewport, layout.viewport);
    assert.strictEqual(envelope.minimap, false);
    assert.strictEqual(envelope.selectedObjectId, 'network:done');
    const placement = envelope.placement as {
        nodes: Record<string, Record<string, unknown>>;
    };
    assert.strictEqual(placement.nodes['instance:u_child'].fixed, true);
    for (const nodePlacement of Object.values(placement.nodes)) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(nodePlacement, 'x'), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(nodePlacement, 'y'), false);
    }

    const loaded = store.load(graph.fileUri, graph.moduleKey, graph)!;
    assert.deepStrictEqual(loaded.viewport, layout.viewport);
    assert.strictEqual(loaded.minimap, false);
    assert.strictEqual(loaded.selectedObjectId, 'network:done');
    assert.strictEqual(loaded.nodes['instance:u_child'].fixed, true);
    assert.strictEqual(loaded.nodes['instance:u_child'].y,
        layout.nodes['instance:u_child'].y);
    assert.ok(loaded.nodes['port:clk'].x < loaded.nodes['instance:u_child'].x);
    assert.ok(loaded.nodes['port:done'].x > loaded.nodes['instance:u_child'].x);
    assert.ok(loaded.nodes['port:shared'].x > loaded.nodes['instance:u_child'].x);
    assert.strictEqual(loaded.nodes['port:done'].x, loaded.nodes['port:shared'].x);
}

async function testLegacyMigrationUsesAutomaticColumnsAndYOrder(): Promise<void> {
    const base = createGraph();
    const later = node('instance:later', 'instance');
    const graph: SchematicGraph = {
        ...base,
        nodes: [...base.nodes.slice(0, 3), later, ...base.nodes.slice(3)],
    };
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const key = [
        'veriflow.schematicLayout',
        encodeURIComponent(graph.fileUri),
        encodeURIComponent(graph.moduleKey),
    ].join(':');
    const legacyClock = { y: 0, fixed: true } as Record<string, unknown>;
    Object.defineProperty(legacyClock, 'x', {
        enumerable: true,
        get(): never {
            throw new Error('legacy x must not be read');
        },
    });
    state.set(key, {
        schemaVersion: 1,
        layout: {
            nodes: {
                'instance:u_child': { x: 50_000, y: 90, fixed: true },
                'instance:later': { x: -50_000, y: 10, fixed: false },
                'port:clk': legacyClock,
            },
            viewport: { x: 4, y: 5, zoom: 1.5 },
            minimap: false,
            selectedObjectId: 'instance:u_child',
        },
    });

    const migrated = store.load(graph.fileUri, graph.moduleKey, graph)!;

    assert.strictEqual(
        migrated.nodes['instance:u_child'].x,
        migrated.nodes['instance:later'].x
    );
    assert.ok(migrated.nodes['instance:later'].y
        < migrated.nodes['instance:u_child'].y);
    assert.strictEqual(migrated.nodes['instance:later'].fixed, false);
    assert.strictEqual(migrated.nodes['port:clk'].fixed, true);
    assert.deepStrictEqual(migrated.viewport, { x: 4, y: 5, zoom: 1.5 });

    await store.save(graph.fileUri, graph.moduleKey, graph, migrated);
    const rewritten = state.get<Record<string, unknown>>(key)!;
    assert.strictEqual(rewritten.schemaVersion, 2);
    const serialized = JSON.stringify(rewritten);
    assert.strictEqual(serialized.includes('50000'), false);
    assert.strictEqual(serialized.includes('-50000'), false);
}

async function testVersionValidationAndKeyIsolation(): Promise<void> {
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const first = defaultLayout();
    first.viewport.x = 1;
    const second = defaultLayout();
    second.viewport.x = 2;

    const firstGraph = { ...createGraph(), fileUri: 'file:///a:b', moduleKey: 'module:c' };
    const secondGraph = { ...createGraph(), fileUri: 'file:///a', moduleKey: 'b:module:c' };
    first.nodes = autoLayout(firstGraph).nodes;
    second.nodes = autoLayout(secondGraph).nodes;
    await Promise.all([
        store.save(firstGraph.fileUri, firstGraph.moduleKey, firstGraph, first),
        store.save(secondGraph.fileUri, secondGraph.moduleKey, secondGraph, second),
    ]);
    assert.strictEqual(store.load(
        firstGraph.fileUri, firstGraph.moduleKey, firstGraph
    )?.viewport.x, 1);
    assert.strictEqual(store.load(
        secondGraph.fileUri, secondGraph.moduleKey, secondGraph
    )?.viewport.x, 2);
    assert.strictEqual(state.keys().length, 2);

    const isolatedState = createMemoryMemento();
    const isolatedStore = new SchematicLayoutStore(isolatedState);
    const versionGraph = {
        ...createGraph(),
        fileUri: 'file:///version.sv',
        moduleKey: 'module:version:0',
    };
    await isolatedStore.save(
        versionGraph.fileUri,
        versionGraph.moduleKey,
        versionGraph,
        autoLayout(versionGraph)
    );
    const key = isolatedState.keys()[0];
    isolatedState.set(key, { schemaVersion: 3, placement: { nodes: {} } });
    assert.strictEqual(
        isolatedStore.load(versionGraph.fileUri, versionGraph.moduleKey, versionGraph),
        undefined
    );
    isolatedState.set(key, {
        schemaVersion: 1,
        layout: { nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, minimap: true },
    });
    assert.strictEqual(
        isolatedStore.load(versionGraph.fileUri, versionGraph.moduleKey, versionGraph),
        undefined
    );
}

async function testLoadDropsOnlyMalformedLegacyNodeEntries(): Promise<void> {
    const uri = 'file:///legacy-mixed.sv';
    const moduleKey = 'module:legacy-mixed:0';
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const storageKey = [
        'veriflow.schematicLayout',
        encodeURIComponent(uri),
        encodeURIComponent(moduleKey),
    ].join(':');
    state.set(storageKey, {
        schemaVersion: 1,
        layout: {
            nodes: {
                valid: { x: 40, y: 80, fixed: true },
                malformed: { x: 'not-used', y: 'not-a-coordinate', fixed: false },
            },
            viewport: { x: 5, y: 6, zoom: 1.25 },
            minimap: false,
            selectedObjectId: 'valid',
        },
    });

    const graph: SchematicGraph = {
        ...createGraph(),
        fileUri: uri,
        moduleKey,
        nodes: [node('valid', 'opaque'), node('malformed', 'opaque')],
        networks: [],
    };
    const loaded = store.load(uri, moduleKey, graph)!;
    assert.strictEqual(loaded.nodes.valid.fixed, true);
    assert.strictEqual(loaded.nodes.malformed.fixed, false);
    assert.deepStrictEqual(loaded.viewport, { x: 5, y: 6, zoom: 1.25 });
    assert.strictEqual(loaded.selectedObjectId, 'valid');
}

function testHostileStoredPlacementIsRejected(): void {
    const graph = createGraph();
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const key = [
        'veriflow.schematicLayout',
        encodeURIComponent(graph.fileUri),
        encodeURIComponent(graph.moduleKey),
    ].join(':');
    const nodes = new Proxy({}, {
        ownKeys(): never {
            throw new Error('hostile stored placement');
        },
    });
    state.set(key, {
        schemaVersion: 2,
        placement: { nodes },
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    });

    assert.doesNotThrow(() => {
        assert.strictEqual(store.load(graph.fileUri, graph.moduleKey, graph), undefined);
    });
}

async function testNormalizationAndNoEdgePersistence(): Promise<void> {
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const graph: SchematicGraph = {
        ...createGraph(),
        fileUri: 'file:///normalize.sv',
        moduleKey: 'module:normalize:0',
        nodes: [node('valid', 'opaque')],
        networks: [],
    };
    const input = {
        nodes: {
            valid: { x: 4, y: 8, fixed: false },
            invalidX: { x: Number.NaN, y: 8, fixed: false },
            invalidY: { x: 4, y: Number.POSITIVE_INFINITY, fixed: true },
        },
        viewport: { x: 0, y: 0, zoom: 99 },
        minimap: true,
        edges: { secret: [{ x: 1, y: 2 }] },
        feedbackRoutes: [{
            networkId: 'network:secret',
            side: 'top',
            lane: 0,
            trunk: { x1: 0, x2: 10, y: -20 },
            endpoints: [],
        }],
    };
    // Untrusted webview saves are all-or-nothing; the host store separately
    // tolerates malformed entries in legacy persisted data by dropping them.
    assert.strictEqual(parseWebviewCommand({
        type: 'saveLayout',
        moduleKey: 'module:normalize:0',
        revision: 'snapshot:normalize',
        layout: input,
    }), undefined);
    await store.save(
        graph.fileUri,
        graph.moduleKey,
        graph,
        input as SchematicLayout
    );
    const storageKey = [
        'veriflow.schematicLayout',
        encodeURIComponent('file:///normalize.sv'),
        encodeURIComponent('module:normalize:0'),
    ].join(':');
    const stored = state.get<Record<string, unknown>>(storageKey)!;
    assert.strictEqual(stored.schemaVersion, 2);
    assert.deepStrictEqual(stored.viewport, { x: 0, y: 0, zoom: 4 });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'edges'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stored, 'feedbackRoutes'), false);
    const loaded = store.load(graph.fileUri, graph.moduleKey, graph)!;
    assert.deepStrictEqual(Object.keys(loaded.nodes), ['valid']);
    assert.strictEqual(loaded.viewport.zoom, 4);
    assert.strictEqual('edges' in loaded, false);

    loaded.viewport.zoom = -100;
    const lowZoomGraph = { ...graph, moduleKey: 'module:low-zoom:0' };
    await store.save(
        lowZoomGraph.fileUri,
        lowZoomGraph.moduleKey,
        lowZoomGraph,
        loaded
    );
    assert.strictEqual(
        store.load(
            lowZoomGraph.fileUri,
            lowZoomGraph.moduleKey,
            lowZoomGraph
        )?.viewport.zoom,
        0.1
    );

    state.set(storageKey, {
        schemaVersion: 2,
        placement: { nodes: {} },
        viewport: { x: Number.NaN, y: 0, zoom: 1 },
        minimap: true,
    });
    assert.strictEqual(
        store.load(graph.fileUri, graph.moduleKey, graph),
        undefined
    );
}

async function testProtocolSpecialNodeRoundTrip(): Promise<void> {
    const inputNodes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inputNodes, '__proto__', {
        value: { x: 17, y: 23, fixed: true },
        enumerable: true,
    });
    const command = parseWebviewCommand({
        type: 'saveLayout',
        moduleKey: 'module:special-node',
        revision: 'snapshot:special-node',
        layout: {
            nodes: inputNodes,
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });
    assert.strictEqual(command?.type, 'saveLayout');
    if (command?.type !== 'saveLayout') {
        throw new Error('expected a valid saveLayout command');
    }

    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const graph: SchematicGraph = {
        ...createGraph(),
        fileUri: 'file:///special.sv',
        moduleKey: command.moduleKey,
        nodes: [node('__proto__', 'opaque')],
        networks: [],
    };
    await store.save(graph.fileUri, command.moduleKey, graph, command.layout);

    const persisted = state.get<{
        placement: { nodes: Record<string, unknown> };
    }>(state.keys()[0])!;
    assert.strictEqual(Object.getPrototypeOf(persisted.placement.nodes), Object.prototype);
    assert.strictEqual(
        Object.prototype.propertyIsEnumerable.call(persisted.placement.nodes, '__proto__'),
        true
    );
    assert.strictEqual(
        (persisted.placement.nodes['__proto__'] as { fixed: boolean }).fixed,
        true
    );

    const loaded = store.load(graph.fileUri, command.moduleKey, graph)!;
    assert.strictEqual(Object.getPrototypeOf(loaded.nodes), Object.prototype);
    assert.strictEqual(
        Object.prototype.propertyIsEnumerable.call(loaded.nodes, '__proto__'),
        true
    );
    assert.strictEqual(loaded.nodes['__proto__'].fixed, true);
    assert.strictEqual(loaded.nodes['__proto__'].y, 23);
    assert.strictEqual(({} as { x?: number }).x, undefined);
}

async function testStaleObjectCleanupAndClearFixed(): Promise<void> {
    const graph = createGraph();
    const staleLayout: SchematicLayout = {
        nodes: {
            'instance:u_child': { x: 300, y: 100, fixed: true },
            'instance:removed': { x: 500, y: 100, fixed: true },
        },
        viewport: { x: 3, y: 5, zoom: 1.5 },
        minimap: false,
        selectedObjectId: 'instance:removed',
    };
    const merged = mergeLayout(graph, staleLayout);
    assert.strictEqual('instance:removed' in merged.nodes, false);
    assert.deepStrictEqual(merged.nodes['instance:u_child'], {
        x: 300,
        y: 100,
        fixed: true,
    });
    assert.strictEqual(merged.selectedObjectId, undefined);
    assert.deepStrictEqual(merged.viewport, staleLayout.viewport);
    assert.strictEqual(merged.minimap, false);

    const selectedNode = mergeLayout(graph, {
        ...staleLayout,
        selectedObjectId: 'instance:u_child',
    });
    assert.strictEqual(selectedNode.selectedObjectId, 'instance:u_child');
    const selectedNetwork = mergeLayout(graph, {
        ...staleLayout,
        selectedObjectId: 'network:done',
    });
    assert.strictEqual(selectedNetwork.selectedObjectId, 'network:done');

    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    await store.save(graph.fileUri, graph.moduleKey, graph, staleLayout);
    const cleared = await store.clearFixed(graph.fileUri, graph.moduleKey, graph);
    assert.ok(cleared);
    assert.ok(Object.values(cleared.nodes).every(layout => !layout.fixed));
    assert.ok(Object.values(
        store.load(graph.fileUri, graph.moduleKey, graph)!.nodes
    ).every(layout => !layout.fixed));
    const storedX = store.load(
        graph.fileUri,
        graph.moduleKey,
        graph
    )!.nodes['instance:u_child'].x;
    cleared.nodes['instance:u_child'].x = -100;
    assert.strictEqual(
        store.load(graph.fileUri, graph.moduleKey, graph)?.nodes['instance:u_child'].x,
        storedX
    );
    const missingGraph = {
        ...graph,
        fileUri: 'file:///missing.sv',
        moduleKey: 'module:missing:0',
    };
    assert.strictEqual(
        await store.clearFixed(
            missingGraph.fileUri,
            missingGraph.moduleKey,
            missingGraph
        ),
        undefined
    );
}

async function testMergePreservesAllMatchedCoordinates(): Promise<void> {
    const graph = createGraph();
    graph.nodes.push(node('opaque:new', 'opaque'));
    const persisted: SchematicLayout = {
        nodes: {
            'instance:u_child': { x: 456, y: 234, fixed: false },
            'opaque:removed': { x: 800, y: 900, fixed: false },
        },
        viewport: { x: 1, y: 2, zoom: 1.5 },
        minimap: false,
    };

    const merged = mergeLayout(graph, persisted);

    assert.deepStrictEqual(merged.nodes['instance:u_child'], {
        x: 456,
        y: 234,
        fixed: false,
    });
    assert.strictEqual('opaque:removed' in merged.nodes, false);
    assert.ok(Number.isFinite(merged.nodes['opaque:new'].x));
    assert.ok(Number.isFinite(merged.nodes['opaque:new'].y));
}

async function testMergePlacesNewNodesAroundMatchedNodes(): Promise<void> {
    const graph = createGraph();
    graph.nodes.push(node('opaque:new', 'opaque'));
    const baseline = autoLayout(graph);
    const persisted: SchematicLayout = {
        ...defaultLayout(),
        nodes: {
            'instance:u_child': {
                ...baseline.nodes['opaque:new'],
                fixed: false,
            },
        },
    };

    const merged = mergeLayout(graph, persisted);

    assert.deepStrictEqual(
        merged.nodes['instance:u_child'],
        persisted.nodes['instance:u_child']
    );
    assertNodePairSeparated(graph, merged, 'instance:u_child', 'opaque:new');
}

async function testClearFixedWaitsForPriorSave(): Promise<void> {
    const state = new DeferredMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const uri = 'file:///queued.sv';
    const moduleKey = 'module:queued:0';
    const graph: SchematicGraph = {
        ...createGraph(),
        fileUri: uri,
        moduleKey,
        nodes: [node('queued', 'opaque')],
        networks: [],
    };
    const layout = autoLayout(graph);
    layout.nodes.queued = { x: 10, y: 20, fixed: true };

    const save = store.save(uri, moduleKey, graph, layout);
    const clear = store.clearFixed(uri, moduleKey, graph);
    await Promise.resolve();
    assert.strictEqual(state.pendingCount(), 1);

    state.resolveNext();
    await save;
    await Promise.resolve();
    assert.strictEqual(state.pendingCount(), 1);

    state.resolveNext();
    const cleared = await clear;
    assert.ok(cleared);
    assert.strictEqual(cleared.nodes.queued.fixed, false);
    assert.strictEqual(store.load(uri, moduleKey, graph)?.nodes.queued.fixed, false);
}

async function testDeterministicAutoLayoutAndColumns(): Promise<void> {
    const graph = createGraph();
    const first = autoLayout(graph);
    const second = autoLayout(graph);
    assert.deepStrictEqual(first, second);

    const input = first.nodes['port:clk'];
    const inout = first.nodes['port:shared'];
    const instance = first.nodes['instance:u_child'];
    const output = first.nodes['port:done'];
    assert.ok(input.x < instance.x);
    assert.ok(instance.x < output.x);
    assert.strictEqual(output.x, inout.x);
    assert.ok(Object.values(first.nodes).every(layout =>
        Number.isFinite(layout.x) && Number.isFinite(layout.y) && !layout.fixed
    ));
}

async function testPartialAndFullRelayout(): Promise<void> {
    const graph = createGraph();
    const existing: SchematicLayout = {
        nodes: {
            'instance:u_child': { x: 777, y: 333, fixed: true },
        },
        viewport: { x: 10, y: 20, zoom: 2 },
        minimap: false,
        selectedObjectId: 'network:done',
    };
    const partial = autoLayout(graph, existing);
    assert.deepStrictEqual(partial.nodes['instance:u_child'], {
        x: 777,
        y: 333,
        fixed: true,
    });
    assert.ok(partial.nodes['port:clk'].x < 777);
    assert.ok(partial.nodes['port:done'].x > 777);
    assert.deepStrictEqual(partial.viewport, existing.viewport);

    const full = relayoutAll(graph, existing);
    assert.ok(Object.values(full.nodes).every(layout => !layout.fixed));
    assert.notDeepStrictEqual(full.nodes['instance:u_child'],
        existing.nodes['instance:u_child']);
    assert.deepStrictEqual(full.viewport, existing.viewport);
    assert.strictEqual(full.minimap, false);
    assert.strictEqual(full.selectedObjectId, 'network:done');
}

async function testPartialLayoutAvoidsFixedObstacles(): Promise<void> {
    const empty: SchematicGraph = {
        fileUri: 'file:///obstacles.sv',
        moduleKey: 'module:obstacles:0',
        moduleName: 'obstacles',
        nodes: [],
        networks: [],
        diagnostics: [],
    };
    const fixedPortId = 'port:fixed-input';
    const newPortId = 'port:new-input';
    const outputPortId = 'port:output';
    const fixedInteriorId = 'instance:fixed';
    const newInteriorIds = ['opaque:new-a', 'opaque:new-b', 'opaque:new-c'];
    const graph: SchematicGraph = {
        ...empty,
        nodes: [
            node(fixedPortId, 'port', [
                pin(fixedPortId, 'fixed-input', 'driver'),
            ]),
            node(newPortId, 'port', [
                pin(newPortId, 'new-input', 'driver'),
            ]),
            node(outputPortId, 'port', [
                pin(outputPortId, 'output', 'load'),
            ]),
            node(fixedInteriorId, 'instance'),
            ...newInteriorIds.map(id => node(id, 'opaque')),
        ],
    };
    const baseline = autoLayout(graph);
    const existing: SchematicLayout = {
        ...defaultLayout(),
        nodes: {
            [fixedPortId]: {
                ...baseline.nodes[newPortId],
                fixed: true,
            },
            [fixedInteriorId]: {
                ...baseline.nodes[newInteriorIds[0]],
                fixed: true,
            },
        },
    };

    const partial = autoLayout(graph, existing);

    assert.deepStrictEqual(partial.nodes[fixedPortId], existing.nodes[fixedPortId]);
    assert.deepStrictEqual(
        partial.nodes[fixedInteriorId],
        existing.nodes[fixedInteriorId]
    );
    assert.ok(partial.nodes[newPortId].x < partial.nodes[newInteriorIds[0]].x);
    assert.ok(partial.nodes[outputPortId].x > partial.nodes[newInteriorIds[0]].x);
    const movableIds = [newPortId, outputPortId, ...newInteriorIds];
    const fixedIds = [fixedPortId, fixedInteriorId];
    for (const fixedId of fixedIds) {
        for (const movableId of movableIds) {
            assertNodePairSeparated(graph, partial, fixedId, movableId);
        }
    }
    for (let first = 0; first < movableIds.length; first += 1) {
        for (let second = first + 1; second < movableIds.length; second += 1) {
            assertNodePairSeparated(
                graph,
                partial,
                movableIds[first],
                movableIds[second]
            );
        }
    }

    const overlappingFixedGraph: SchematicGraph = {
        ...empty,
        nodes: [
            node('opaque:fixed-a', 'opaque'),
            node('opaque:fixed-b', 'opaque'),
            node('opaque:new', 'opaque'),
        ],
    };
    const overlappingBaseline = autoLayout(overlappingFixedGraph);
    const overlappingCenter = overlappingBaseline.nodes['opaque:new'];
    const overlappingFixed: SchematicLayout = {
        ...defaultLayout(),
        nodes: {
            'opaque:fixed-a': { ...overlappingCenter, fixed: true },
            'opaque:fixed-b': { ...overlappingCenter, fixed: true },
        },
    };
    const avoided = autoLayout(overlappingFixedGraph, overlappingFixed);
    assert.deepStrictEqual(
        avoided.nodes['opaque:fixed-a'],
        overlappingFixed.nodes['opaque:fixed-a']
    );
    assert.deepStrictEqual(
        avoided.nodes['opaque:fixed-b'],
        overlappingFixed.nodes['opaque:fixed-b']
    );
    assertNodePairSeparated(
        overlappingFixedGraph,
        avoided,
        'opaque:fixed-a',
        'opaque:new'
    );
    assertNodePairSeparated(
        overlappingFixedGraph,
        avoided,
        'opaque:fixed-b',
        'opaque:new'
    );
}

async function testEmptyAndDisconnectedGraphs(): Promise<void> {
    const empty: SchematicGraph = {
        fileUri: 'file:///empty.sv',
        moduleKey: 'module:empty:0',
        moduleName: 'empty',
        nodes: [],
        networks: [],
        diagnostics: [],
    };
    assert.deepStrictEqual(autoLayout(empty), defaultLayout());
    assert.deepStrictEqual(mergeLayout(empty, {
        ...defaultLayout(),
        selectedObjectId: 'network:removed',
    }), defaultLayout());

    const disconnected: SchematicGraph = {
        ...empty,
        nodes: [
            node('opaque:a', 'opaque'),
            node('opaque:b', 'opaque'),
            node('opaque:c', 'opaque'),
        ],
    };
    const layout = autoLayout(disconnected);
    const positions = Object.values(layout.nodes);
    assert.strictEqual(positions.length, 3);
    assert.ok(positions.every(position =>
        Number.isFinite(position.x) && Number.isFinite(position.y)
    ));
    assert.strictEqual(
        new Set(positions.map(position => `${position.x},${position.y}`)).size,
        3
    );
    assert.deepStrictEqual(layout, autoLayout(disconnected));

    const canonicallyEquivalentIds: SchematicGraph = {
        ...empty,
        nodes: [
            node('opaque:\u00e9', 'opaque'),
            node('opaque:e\u0301', 'opaque'),
        ],
    };
    assert.deepStrictEqual(
        autoLayout(canonicallyEquivalentIds),
        autoLayout({
            ...canonicallyEquivalentIds,
            nodes: [...canonicallyEquivalentIds.nodes].reverse(),
        })
    );
}

async function testPinAwareNodeSizing(): Promise<void> {
    const denseNode = (id: string): GraphNode => node(id, 'instance', [
        ...Array.from({ length: 10 }, (_, index) =>
            pin(id, `input-${index}`, 'load')),
        ...Array.from({ length: 8 }, (_, index) =>
            pin(id, `output-${index}`, 'driver')),
        ...Array.from({ length: 12 }, (_, index) =>
            pin(id, `inout-${index}`, 'bidirectional')),
    ]);
    const first = denseNode('instance:dense-a');
    const second = denseNode('instance:dense-b');
    assert.deepStrictEqual(schematicNodeSize(first), { width: 160, height: 492 });

    const graph: SchematicGraph = {
        fileUri: 'file:///dense.sv',
        moduleKey: 'module:dense:0',
        moduleName: 'dense',
        nodes: [first, second],
        networks: [],
        diagnostics: [],
    };
    const layout = autoLayout(graph);
    assertNodePairSeparated(graph, layout, first.id, second.id);
}

async function testResolvedBidirectionalSizingPreventsDagreOverlap(): Promise<void> {
    const mixedNode = (id: string): GraphNode => node(id, 'instance', [
        ...Array.from({ length: 5 }, (_, index) =>
            pin(id, `output-${index}`, 'driver')),
        ...Array.from({ length: 5 }, (_, index) =>
            pin(id, `shared-${index}`, 'bidirectional')),
    ]);
    const first = mixedNode('instance:mixed-a');
    const second = mixedNode('instance:mixed-b');
    const sinkId = 'instance:sink';
    const sink = node(sinkId, 'instance', [
        ...Array.from({ length: 10 }, (_, index) =>
            pin(sinkId, `input-${index}`, 'load')),
    ]);
    const graph: SchematicGraph = {
        fileUri: 'file:///mixed-bidirectional.sv',
        moduleKey: 'module:mixed-bidirectional:0',
        moduleName: 'mixed_bidirectional',
        nodes: [first, second, sink],
        networks: [first, second].flatMap((source, sourceIndex) =>
            Array.from({ length: 5 }, (_, pinIndex) => ({
                id: `network:shared-${sourceIndex}-${pinIndex}`,
                name: `shared-${sourceIndex}-${pinIndex}`,
                width: { kind: 'known' as const, bits: 1 },
                endpoints: [
                    {
                        nodeId: source.id,
                        pinId: `${source.id}:shared-${pinIndex}`,
                        role: 'bidirectional' as const,
                    },
                    {
                        nodeId: sinkId,
                        pinId: `${sinkId}:input-${sourceIndex * 5 + pinIndex}`,
                        role: 'load' as const,
                    },
                ],
            }))
        ),
        diagnostics: [],
    };

    const layout = autoLayout(graph);
    const pinSides = resolvePinSides(graph);
    const actualSize = (selected: GraphNode): SchematicNodeSize => {
        const measured = measureSchematicNode(
            selected,
            pinSides,
            text => text.length * 7
        );
        return { width: measured.width, height: measured.height };
    };
    const firstSize = actualSize(first);
    const secondSize = actualSize(second);
    assert.deepStrictEqual(firstSize, { width: 160, height: 252 });
    assert.deepStrictEqual(secondSize, firstSize);

    const firstPosition = layout.nodes[first.id];
    const secondPosition = layout.nodes[second.id];
    const horizontalGap = Math.abs(firstPosition.x - secondPosition.x)
        - (firstSize.width + secondSize.width) / 2;
    const verticalGap = Math.abs(firstPosition.y - secondPosition.y)
        - (firstSize.height + secondSize.height) / 2;
    assert.ok(
        horizontalGap >= 24 || verticalGap >= 24,
        `resolved nodes overlap: horizontal=${horizontalGap}, vertical=${verticalGap}`
    );
}

async function testDeterministicFeedbackRoutes(): Promise<void> {
    const nodeA = 'opaque:a';
    const nodeB = 'opaque:b';
    const nodeC = 'opaque:c';
    const graph: SchematicGraph = {
        fileUri: 'file:///feedback.sv',
        moduleKey: 'module:feedback:0',
        moduleName: 'feedback',
        nodes: [
            node(nodeA, 'opaque'),
            node(nodeB, 'opaque'),
            node(nodeC, 'opaque'),
        ],
        networks: [
            {
                id: 'network:forward',
                name: 'forward',
                width: { kind: 'known', bits: 1 },
                endpoints: [
                    { nodeId: nodeA, pinId: `${nodeA}:out`, role: 'driver' },
                    { nodeId: nodeB, pinId: `${nodeB}:in`, role: 'load' },
                ],
            },
            {
                id: 'network:feedback-a',
                name: 'feedback-a',
                width: { kind: 'known', bits: 1 },
                endpoints: [
                    { nodeId: nodeB, pinId: `${nodeB}:out`, role: 'driver' },
                    { nodeId: nodeA, pinId: `${nodeA}:in`, role: 'load' },
                    { nodeId: nodeC, pinId: `${nodeC}:in`, role: 'load' },
                ],
            },
            {
                id: 'network:feedback-b',
                name: 'feedback-b',
                width: { kind: 'known', bits: 1 },
                endpoints: [
                    { nodeId: nodeC, pinId: `${nodeC}:out`, role: 'driver' },
                    { nodeId: nodeB, pinId: `${nodeB}:in-2`, role: 'load' },
                ],
            },
        ],
        diagnostics: [],
    };
    const layout: SchematicLayout = {
        ...defaultLayout(),
        nodes: {
            [nodeA]: { x: 100, y: 100, fixed: false },
            [nodeB]: { x: 400, y: 100, fixed: false },
            [nodeC]: { x: 700, y: 200, fixed: false },
        },
    };

    const routes = deriveFeedbackRoutes(graph, layout);

    assert.deepStrictEqual(routes.map(route => [
        route.networkId,
        route.side,
        route.lane,
    ]), [
        ['network:feedback-a', 'top', 0],
        ['network:feedback-b', 'bottom', 0],
    ]);
    const minNodeY = 100 - schematicNodeSize(graph.nodes[0]).height / 2;
    const maxNodeY = 200 + schematicNodeSize(graph.nodes[2]).height / 2;
    assert.ok(routes[0].trunk.y < minNodeY);
    assert.ok(routes[1].trunk.y > maxNodeY);
    assert.deepStrictEqual(routes[0].endpoints.map(endpoint => [
        endpoint.nodeId,
        endpoint.role,
    ]), [
        [nodeA, 'load'],
        [nodeB, 'driver'],
        [nodeC, 'load'],
    ]);
    for (const route of routes) {
        assert.ok(route.trunk.x1 <= route.trunk.x2);
        for (const endpoint of route.endpoints) {
            const selectedNode = graph.nodes.find(candidate =>
                candidate.id === endpoint.nodeId
            )!;
            const expectedY = layout.nodes[endpoint.nodeId].y
                + (route.side === 'top' ? -1 : 1)
                    * schematicNodeSize(selectedNode).height / 2;
            assert.strictEqual(endpoint.y, expectedY);
        }
    }

    const permutedGraph: SchematicGraph = {
        ...graph,
        nodes: [...graph.nodes].reverse(),
        networks: [...graph.networks].reverse().map(network => ({
            ...network,
            endpoints: [...network.endpoints].reverse(),
        })),
    };
    assert.deepStrictEqual(deriveFeedbackRoutes(permutedGraph, layout), routes);
}

async function main(): Promise<void> {
    await testRoundTripAndRematch();
    await testSemanticStorageEnvelopeRoundTrip();
    await testLegacyMigrationUsesAutomaticColumnsAndYOrder();
    await testVersionValidationAndKeyIsolation();
    await testLoadDropsOnlyMalformedLegacyNodeEntries();
    testHostileStoredPlacementIsRejected();
    await testNormalizationAndNoEdgePersistence();
    await testProtocolSpecialNodeRoundTrip();
    await testStaleObjectCleanupAndClearFixed();
    await testMergePreservesAllMatchedCoordinates();
    await testMergePlacesNewNodesAroundMatchedNodes();
    await testClearFixedWaitsForPriorSave();
    await testDeterministicAutoLayoutAndColumns();
    await testPartialAndFullRelayout();
    await testPartialLayoutAvoidsFixedObstacles();
    await testEmptyAndDisconnectedGraphs();
    await testPinAwareNodeSizing();
    await testResolvedBidirectionalSizingPreventsDagreOverlap();
    await testDeterministicFeedbackRoutes();

    console.log('Schematic layout tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
