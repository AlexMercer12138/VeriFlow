import * as assert from 'assert';

import type {
    GraphNode,
    GraphPin,
    PinDirection,
    SchematicGraph,
} from '../schematic/graphModel';
import {
    autoLayout,
    mergeLayout,
    relayoutAll,
    SchematicLayout,
    SchematicLayoutStore,
} from '../schematic/layoutStore';

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

async function testRoundTripAndRematch(): Promise<void> {
    const graph = createGraph();
    const state = createMemoryMemento();
    const store = new SchematicLayoutStore(state);
    await store.save('file:///top.sv', 'module:top:0', {
        nodes: { 'instance:u_child': { x: 320, y: 120, fixed: true } },
        viewport: { x: 10, y: 20, zoom: 1.25 }, minimap: false,
    });
    assert.deepStrictEqual(store.load('file:///top.sv', 'module:top:0')?.viewport,
        { x: 10, y: 20, zoom: 1.25 });
    const merged = mergeLayout(graph, store.load('file:///top.sv', 'module:top:0'));
    assert.deepStrictEqual(merged.nodes['instance:u_child'],
        { x: 320, y: 120, fixed: true });
    assert.ok(merged.nodes['port:clk'].x < merged.nodes['instance:u_child'].x);

    const loaded = store.load('file:///top.sv', 'module:top:0')!;
    loaded.nodes['instance:u_child'].x = -1;
    loaded.viewport.x = -1;
    assert.deepStrictEqual(store.load('file:///top.sv', 'module:top:0'), {
        nodes: { 'instance:u_child': { x: 320, y: 120, fixed: true } },
        viewport: { x: 10, y: 20, zoom: 1.25 },
        minimap: false,
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
    };
    await store.save(
        'file:///normalize.sv',
        'module:normalize:0',
        input as SchematicLayout
    );
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

    const key = state.keys().find(candidate =>
        candidate.includes(encodeURIComponent('module:normalize:0'))
    )!;
    state.set(key, {
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

async function main(): Promise<void> {
    await testRoundTripAndRematch();
    await testVersionValidationAndKeyIsolation();
    await testNormalizationAndNoEdgePersistence();
    await testStaleObjectCleanupAndClearFixed();
    await testClearFixedWaitsForPriorSave();
    await testDeterministicAutoLayoutAndColumns();
    await testPartialAndFullRelayout();
    await testEmptyAndDisconnectedGraphs();

    console.log('Schematic layout tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
