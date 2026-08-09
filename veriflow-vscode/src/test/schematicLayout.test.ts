import * as assert from 'assert';

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
    direction: PinDirection,
    side: GraphPin['side']
): GraphPin {
    return {
        id: `${nodeId}:${name}`,
        name,
        direction,
        side,
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
            node(inputId, 'port', [pin(inputId, 'clk', 'driver', 'right')]),
            node(inoutId, 'port', [
                pin(inoutId, 'shared', 'bidirectional', 'bottom'),
            ]),
            node(instanceId, 'instance', [
                pin(instanceId, 'clk', 'load', 'left'),
                pin(instanceId, 'shared', 'bidirectional', 'bottom'),
                pin(instanceId, 'done', 'driver', 'right'),
            ]),
            node(outputId, 'port', [pin(outputId, 'done', 'load', 'left')]),
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
    await store.save('file:///top.sv', 'module:top:0', {
        nodes: { 'instance:u_child': { x: 320, y: 120, fixed: true } },
        viewport: { x: 10, y: 20, zoom: 1.25 },
        minimap: false,
        selectedObjectId: 'network:done',
    });
    const storageKey = [
        'veriflow.schematicLayout',
        encodeURIComponent('file:///top.sv'),
        encodeURIComponent('module:top:0'),
    ].join(':');
    assert.deepStrictEqual(state.keys(), [storageKey]);
    assert.deepStrictEqual(state.get<unknown>(storageKey), {
        schemaVersion: 1,
        layout: {
            nodes: { 'instance:u_child': { x: 320, y: 120, fixed: true } },
            viewport: { x: 10, y: 20, zoom: 1.25 },
            minimap: false,
            selectedObjectId: 'network:done',
        },
    });
    const persisted = store.load('file:///top.sv', 'module:top:0');
    assert.deepStrictEqual(persisted, {
        nodes: { 'instance:u_child': { x: 320, y: 120, fixed: true } },
        viewport: { x: 10, y: 20, zoom: 1.25 },
        minimap: false,
        selectedObjectId: 'network:done',
    });
    const merged = mergeLayout(graph, persisted);
    assert.deepStrictEqual(merged.nodes['instance:u_child'],
        { x: 320, y: 120, fixed: true });
    assert.strictEqual(merged.selectedObjectId, 'network:done');
    assert.ok(merged.nodes['port:clk'].x < merged.nodes['instance:u_child'].x);

    const loaded = store.load('file:///top.sv', 'module:top:0')!;
    loaded.nodes['instance:u_child'].x = -1;
    loaded.viewport.x = -1;
    assert.deepStrictEqual(store.load('file:///top.sv', 'module:top:0'), {
        nodes: { 'instance:u_child': { x: 320, y: 120, fixed: true } },
        viewport: { x: 10, y: 20, zoom: 1.25 },
        minimap: false,
        selectedObjectId: 'network:done',
    });

    const callerLayout = defaultLayout();
    callerLayout.nodes['port:clk'] = { x: 12, y: 34, fixed: true };
    await store.save('file:///copy.sv', 'module:copy:0', callerLayout);
    callerLayout.nodes['port:clk'].x = 999;
    assert.strictEqual(
        store.load('file:///copy.sv', 'module:copy:0')?.nodes['port:clk'].x,
        12
    );
}

async function testVersionValidationAndKeyIsolation(): Promise<void> {
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const first = defaultLayout();
    first.viewport.x = 1;
    const second = defaultLayout();
    second.viewport.x = 2;

    await Promise.all([
        store.save('file:///a:b', 'module:c', first),
        store.save('file:///a', 'b:module:c', second),
    ]);
    assert.strictEqual(store.load('file:///a:b', 'module:c')?.viewport.x, 1);
    assert.strictEqual(store.load('file:///a', 'b:module:c')?.viewport.x, 2);
    assert.strictEqual(state.keys().length, 2);

    const isolatedState = createMemoryMemento();
    const isolatedStore = new SchematicLayoutStore(isolatedState);
    await isolatedStore.save('file:///version.sv', 'module:version:0', defaultLayout());
    const key = isolatedState.keys()[0];
    isolatedState.set(key, { schemaVersion: 2, layout: defaultLayout() });
    assert.strictEqual(
        isolatedStore.load('file:///version.sv', 'module:version:0'),
        undefined
    );
    isolatedState.set(key, {
        schemaVersion: 1,
        layout: { nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, minimap: true },
    });
    assert.strictEqual(
        isolatedStore.load('file:///version.sv', 'module:version:0'),
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
                malformed: { x: 'not-a-coordinate', y: 10, fixed: false },
            },
            viewport: { x: 5, y: 6, zoom: 1.25 },
            minimap: false,
            selectedObjectId: 'valid',
        },
    });

    assert.deepStrictEqual(store.load(uri, moduleKey), {
        nodes: { valid: { x: 40, y: 80, fixed: true } },
        viewport: { x: 5, y: 6, zoom: 1.25 },
        minimap: false,
        selectedObjectId: 'valid',
    });
}

async function testNormalizationAndNoEdgePersistence(): Promise<void> {
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
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
        layout: input,
    }), undefined);
    await store.save(
        'file:///normalize.sv',
        'module:normalize:0',
        input as SchematicLayout
    );
    const storageKey = [
        'veriflow.schematicLayout',
        encodeURIComponent('file:///normalize.sv'),
        encodeURIComponent('module:normalize:0'),
    ].join(':');
    assert.deepStrictEqual(state.get<unknown>(storageKey), {
        schemaVersion: 1,
        layout: {
            nodes: { valid: { x: 4, y: 8, fixed: false } },
            viewport: { x: 0, y: 0, zoom: 4 },
            minimap: true,
        },
    });
    const loaded = store.load('file:///normalize.sv', 'module:normalize:0')!;
    assert.deepStrictEqual(loaded.nodes, {
        valid: { x: 4, y: 8, fixed: false },
    });
    assert.strictEqual(loaded.viewport.zoom, 4);
    assert.strictEqual('edges' in loaded, false);

    loaded.viewport.zoom = -100;
    await store.save('file:///normalize.sv', 'module:low-zoom:0', loaded);
    assert.strictEqual(
        store.load('file:///normalize.sv', 'module:low-zoom:0')?.viewport.zoom,
        0.1
    );

    state.set(storageKey, {
        schemaVersion: 1,
        layout: {
            nodes: {},
            viewport: { x: Number.NaN, y: 0, zoom: 1 },
            minimap: true,
        },
    });
    assert.strictEqual(
        store.load('file:///normalize.sv', 'module:normalize:0'),
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
    await store.save('file:///special.sv', command.moduleKey, command.layout);

    const persisted = state.get<{ layout: SchematicLayout }>(state.keys()[0])!;
    assert.strictEqual(Object.getPrototypeOf(persisted.layout.nodes), Object.prototype);
    assert.strictEqual(
        Object.prototype.propertyIsEnumerable.call(persisted.layout.nodes, '__proto__'),
        true
    );
    assert.deepStrictEqual(persisted.layout.nodes['__proto__'], {
        x: 17,
        y: 23,
        fixed: true,
    });

    const loaded = store.load('file:///special.sv', command.moduleKey)!;
    assert.strictEqual(Object.getPrototypeOf(loaded.nodes), Object.prototype);
    assert.strictEqual(
        Object.prototype.propertyIsEnumerable.call(loaded.nodes, '__proto__'),
        true
    );
    assert.deepStrictEqual(loaded.nodes['__proto__'], {
        x: 17,
        y: 23,
        fixed: true,
    });
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
    await store.save(graph.fileUri, graph.moduleKey, staleLayout);
    const cleared = await store.clearFixed(graph.fileUri, graph.moduleKey);
    assert.ok(cleared);
    assert.ok(Object.values(cleared.nodes).every(layout => !layout.fixed));
    assert.ok(Object.values(
        store.load(graph.fileUri, graph.moduleKey)!.nodes
    ).every(layout => !layout.fixed));
    cleared.nodes['instance:u_child'].x = -100;
    assert.strictEqual(
        store.load(graph.fileUri, graph.moduleKey)?.nodes['instance:u_child'].x,
        300
    );
    assert.strictEqual(
        await store.clearFixed('file:///missing.sv', 'module:missing:0'),
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
    const layout = defaultLayout();
    layout.nodes.queued = { x: 10, y: 20, fixed: true };

    const save = store.save(uri, moduleKey, layout);
    const clear = store.clearFixed(uri, moduleKey);
    await Promise.resolve();
    assert.strictEqual(state.pendingCount(), 1);

    state.resolveNext();
    await save;
    await Promise.resolve();
    assert.strictEqual(state.pendingCount(), 1);

    state.resolveNext();
    assert.deepStrictEqual(await clear, {
        ...layout,
        nodes: { queued: { x: 10, y: 20, fixed: false } },
    });
    assert.strictEqual(store.load(uri, moduleKey)?.nodes.queued.fixed, false);
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
    assert.strictEqual(input.x, inout.x);
    assert.ok(input.x < instance.x);
    assert.ok(instance.x < output.x);
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
                pin(fixedPortId, 'fixed-input', 'driver', 'right'),
            ]),
            node(newPortId, 'port', [
                pin(newPortId, 'new-input', 'driver', 'right'),
            ]),
            node(outputPortId, 'port', [
                pin(outputPortId, 'output', 'load', 'left'),
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
            pin(id, `input-${index}`, 'load', 'left')),
        ...Array.from({ length: 8 }, (_, index) =>
            pin(id, `output-${index}`, 'driver', 'right')),
        ...Array.from({ length: 12 }, (_, index) =>
            pin(id, `inout-${index}`, 'bidirectional', 'bottom')),
    ]);
    const first = denseNode('instance:dense-a');
    const second = denseNode('instance:dense-b');
    assert.deepStrictEqual(schematicNodeSize(first), { width: 234, height: 216 });

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
    await testVersionValidationAndKeyIsolation();
    await testLoadDropsOnlyMalformedLegacyNodeEntries();
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
    await testDeterministicFeedbackRoutes();

    console.log('Schematic layout tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
