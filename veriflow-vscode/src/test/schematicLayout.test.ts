import * as assert from 'assert';

import {
    assignColumns,
    MAX_SCHEMATIC_PLACEMENT_OFFSET,
    type GraphNode,
    type GraphPin,
    type PinDirection,
    type SchematicGraph,
} from '@veriflow/schematic-core';
import {
    autoLayout,
    MAX_SCHEMATIC_LAYOUT_COLUMN,
    mergeLayout,
    normalizeSchematicLayout,
    relayoutAll,
    SchematicLayoutStore,
    type SchematicLayout,
} from '../schematic/layoutStore';

class MemoryMemento {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, value);
    }

    keys(): string[] {
        return [...this.values.keys()];
    }

    set(key: string, value: unknown): void {
        this.values.set(key, value);
    }
}

class DeferredMemoryMemento extends MemoryMemento {
    private readonly pending: Array<{
        key: string;
        value: unknown;
        resolve: () => void;
    }> = [];

    override update(key: string, value: unknown): Promise<void> {
        return new Promise(resolve => this.pending.push({ key, value, resolve }));
    }

    pendingCount(): number {
        return this.pending.length;
    }

    resolveNext(): void {
        const update = this.pending.shift();
        assert.ok(update);
        void super.update(update.key, update.value);
        update.resolve();
    }
}

function pin(nodeId: string, name: string, direction: PinDirection): GraphPin {
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
        label: id,
        pins,
        readOnly: false,
    };
}

function createGraph(extraNodes: GraphNode[] = []): SchematicGraph {
    const inputId = 'port:clk';
    const instanceId = 'instance:u_child';
    const outputId = 'port:done';
    const inoutId = 'port:shared';
    return {
        fileUri: 'file:///top.sv',
        moduleKey: 'module:top:0',
        moduleName: 'top',
        nodes: [
            node(inputId, 'port', [pin(inputId, 'clk', 'driver')]),
            node(instanceId, 'instance', [
                pin(instanceId, 'clk', 'load'),
                pin(instanceId, 'done', 'driver'),
            ]),
            ...extraNodes,
            node(outputId, 'port', [pin(outputId, 'done', 'load')]),
            node(inoutId, 'port', [pin(inoutId, 'shared', 'bidirectional')]),
        ],
        networks: [{
            id: 'network:clk',
            name: 'clk',
            width: { kind: 'known', bits: 1 },
            endpoints: [
                { nodeId: inputId, pinId: `${inputId}:clk`, role: 'driver' },
                { nodeId: instanceId, pinId: `${instanceId}:clk`, role: 'load' },
            ],
        }, {
            id: 'network:done',
            name: 'done',
            width: { kind: 'known', bits: 1 },
            endpoints: [
                { nodeId: instanceId, pinId: `${instanceId}:done`, role: 'driver' },
                { nodeId: outputId, pinId: `${outputId}:done`, role: 'load' },
            ],
        }],
        diagnostics: [],
    };
}

function storageKey(graph: SchematicGraph): string {
    return `veriflow.schematicLayout:${encodeURIComponent(graph.fileUri)}`
        + `:${encodeURIComponent(graph.moduleKey)}`;
}

function manualLayout(graph: SchematicGraph): SchematicLayout {
    const layout = autoLayout(graph);
    layout.placement.nodes['instance:u_child'] = {
        column: 1,
        order: 0,
        yOffset: 34,
        fixed: true,
    };
    layout.viewport = { x: 11, y: -7, zoom: 1.25 };
    layout.minimap = false;
    layout.selectedObjectId = 'network:done';
    return layout;
}

function testAutomaticAndMergedPlacement(): void {
    const graph = createGraph([node('opaque:new', 'opaque')]);
    const automatic = autoLayout(graph);
    const assignment = assignColumns(graph);
    assert.deepStrictEqual(Object.keys(automatic.placement.nodes),
        graph.nodes.map(candidate => candidate.id));
    for (const candidate of graph.nodes) {
        assert.strictEqual(
            automatic.placement.nodes[candidate.id].column,
            assignment.nodeColumn.get(candidate.id)
        );
        assert.strictEqual(automatic.placement.nodes[candidate.id].fixed, false);
    }

    const persisted = manualLayout(graph);
    Object.defineProperty(persisted.placement.nodes, 'instance:removed', {
        value: { column: 1, order: 9, yOffset: 99, fixed: true },
        enumerable: true,
    });
    const merged = mergeLayout(graph, persisted);
    assert.deepStrictEqual(merged.placement.nodes['instance:u_child'], {
        column: 1,
        order: 0,
        yOffset: 34,
        fixed: true,
    });
    assert.strictEqual('instance:removed' in merged.placement.nodes, false);
    assert.strictEqual(merged.placement.nodes['opaque:new'].fixed, false);
    assert.deepStrictEqual(merged.viewport, persisted.viewport);
    assert.strictEqual(merged.minimap, false);
    assert.strictEqual(merged.selectedObjectId, 'network:done');
    assert.strictEqual(mergeLayout(graph, {
        ...persisted,
        selectedObjectId: 'network:removed',
    }).selectedObjectId, undefined);
}

async function testSemanticStorageRoundTripAndRefresh(): Promise<void> {
    const graph = createGraph();
    const state = new MemoryMemento();
    const store = new SchematicLayoutStore(state);
    const layout = manualLayout(graph);
    Object.defineProperty(layout.placement.nodes, 'instance:removed', {
        value: { column: 1, order: 1, yOffset: 90, fixed: true },
        enumerable: true,
    });

    await store.save(graph.fileUri, graph.moduleKey, graph, layout);

    assert.deepStrictEqual(state.keys(), [storageKey(graph)]);
    const envelope = state.get<Record<string, unknown>>(storageKey(graph))!;
    assert.strictEqual(envelope.schemaVersion, 2);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(envelope, 'layout'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(envelope, 'nodes'), false);
    const storedPlacement = envelope.placement as SchematicLayout['placement'];
    assert.strictEqual(storedPlacement.nodes['instance:u_child'].yOffset, 34);
    assert.strictEqual('instance:removed' in storedPlacement.nodes, false);

    const refreshed = createGraph([node('opaque:new', 'opaque')]);
    const loaded = store.load(graph.fileUri, graph.moduleKey, refreshed);
    assert.ok(loaded);
    assert.deepStrictEqual(loaded.viewport, layout.viewport);
    assert.strictEqual(loaded.minimap, false);
    assert.strictEqual(loaded.selectedObjectId, 'network:done');
    assert.deepStrictEqual(loaded.placement.nodes['instance:u_child'], {
        column: 1,
        order: 0,
        yOffset: 34,
        fixed: true,
    });
    assert.strictEqual(loaded.placement.nodes['opaque:new'].fixed, false);

    layout.placement.nodes['instance:u_child'].yOffset = 999;
    assert.strictEqual(
        store.load(graph.fileUri, graph.moduleKey, refreshed)
            ?.placement.nodes['instance:u_child'].yOffset,
        34
    );
}

async function testLegacyMigrationUsesAutomaticColumnsAndYOrder(): Promise<void> {
    const first = node('instance:first', 'instance');
    const second = node('instance:second', 'instance');
    const hostile = node('instance:hostile', 'instance');
    const graph: SchematicGraph = {
        ...createGraph(),
        nodes: [first, second, hostile],
        networks: [],
    };
    const state = new MemoryMemento();
    let xWasRead = false;
    const firstLegacy = { y: 40, fixed: true } as Record<string, unknown>;
    Object.defineProperty(firstLegacy, 'x', {
        get(): never {
            xWasRead = true;
            throw new Error('legacy x must not be read');
        },
        enumerable: true,
    });
    const hostileLegacy = { fixed: true } as Record<string, unknown>;
    Object.defineProperty(hostileLegacy, 'y', {
        get(): never {
            throw new Error('hostile legacy y');
        },
        enumerable: true,
    });
    state.set(storageKey(graph), {
        schemaVersion: 1,
        layout: {
            nodes: {
                [first.id]: firstLegacy,
                [second.id]: { x: -99_999, y: 10, fixed: true },
                [hostile.id]: hostileLegacy,
                malformed: { x: 0, y: 'bad', fixed: true },
            },
            viewport: { x: 7, y: 8, zoom: 2 },
            minimap: false,
            selectedObjectId: first.id,
        },
    });

    const loaded = new SchematicLayoutStore(state).load(
        graph.fileUri,
        graph.moduleKey,
        graph
    );
    assert.ok(loaded);
    assert.strictEqual(xWasRead, false);
    assert.strictEqual(loaded.placement.nodes[first.id].column, 0);
    assert.strictEqual(loaded.placement.nodes[second.id].column, 0);
    assert.strictEqual(loaded.placement.nodes[second.id].order, 0);
    assert.strictEqual(loaded.placement.nodes[first.id].order, 1);
    assert.strictEqual(loaded.placement.nodes[hostile.id].fixed, false);
    assert.deepStrictEqual(loaded.viewport, { x: 7, y: 8, zoom: 2 });
    assert.strictEqual(loaded.minimap, false);
    assert.strictEqual(loaded.selectedObjectId, first.id);
}

function testStoredVersionAndHostileDataAreRejected(): void {
    const graph = createGraph();
    const state = new MemoryMemento();
    const store = new SchematicLayoutStore(state);
    state.set(storageKey(graph), {
        schemaVersion: 3,
        placement: { nodes: {} },
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    });
    assert.strictEqual(store.load(graph.fileUri, graph.moduleKey, graph), undefined);

    const hostileNodes = new Proxy({}, {
        ownKeys(): never {
            throw new Error('hostile stored placement');
        },
    });
    state.set(storageKey(graph), {
        schemaVersion: 2,
        placement: { nodes: hostileNodes },
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    });
    assert.doesNotThrow(() => {
        assert.strictEqual(
            store.load(graph.fileUri, graph.moduleKey, graph),
            undefined
        );
    });
}

function testValidationBoundsAndPrototypeSafety(): void {
    const specialNodes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(specialNodes, '__proto__', {
        value: { column: 0, order: 0, yOffset: 2, fixed: true },
        enumerable: true,
    });
    const normalized = normalizeSchematicLayout({
        placement: { nodes: specialNodes },
        viewport: { x: 0, y: 0, zoom: 99 },
        minimap: true,
    });
    assert.ok(normalized);
    assert.strictEqual(normalized.viewport.zoom, 4);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(
        normalized.placement.nodes,
        '__proto__'
    ), true);
    assert.strictEqual(({} as { fixed?: boolean }).fixed, undefined);

    const valid = {
        placement: { nodes: {} },
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    };
    for (const invalid of [
        { ...valid, placement: { nodes: { x: {
            column: MAX_SCHEMATIC_LAYOUT_COLUMN,
            order: 0,
            yOffset: 0,
            fixed: true,
        } } } },
        { ...valid, placement: { nodes: { x: {
            column: 0,
            order: 0,
            yOffset: MAX_SCHEMATIC_PLACEMENT_OFFSET + 1,
            fixed: true,
        } } } },
        { ...valid, viewport: {
            x: MAX_SCHEMATIC_PLACEMENT_OFFSET + 1,
            y: 0,
            zoom: 1,
        } },
    ]) {
        assert.strictEqual(normalizeSchematicLayout(invalid), undefined);
    }

    const throwing = {};
    Object.defineProperty(throwing, 'placement', {
        get(): never {
            throw new Error('hostile getter');
        },
        enumerable: true,
    });
    assert.doesNotThrow(() => normalizeSchematicLayout(throwing));
    assert.strictEqual(normalizeSchematicLayout(throwing), undefined);
}

async function testRelayoutAndQueuedClearPreservePresentation(): Promise<void> {
    const graph = createGraph();
    const relaid = relayoutAll(graph, manualLayout(graph));
    assert.ok(Object.values(relaid.placement.nodes).every(value => !value.fixed));
    assert.deepStrictEqual(relaid.viewport, { x: 11, y: -7, zoom: 1.25 });
    assert.strictEqual(relaid.minimap, false);
    assert.strictEqual(relaid.selectedObjectId, 'network:done');

    const state = new DeferredMemoryMemento();
    const store = new SchematicLayoutStore(state);
    const save = store.save(
        graph.fileUri,
        graph.moduleKey,
        graph,
        manualLayout(graph)
    );
    const clear = store.clearFixed(graph.fileUri, graph.moduleKey, graph);
    await Promise.resolve();
    assert.strictEqual(state.pendingCount(), 1);
    state.resolveNext();
    await save;
    await Promise.resolve();
    assert.strictEqual(state.pendingCount(), 1);
    state.resolveNext();
    const cleared = await clear;
    assert.ok(cleared);
    assert.ok(Object.values(cleared.placement.nodes).every(value => !value.fixed));
    assert.strictEqual(store.load(
        graph.fileUri,
        graph.moduleKey,
        graph
    )?.placement.nodes['instance:u_child'].fixed, false);
}

async function main(): Promise<void> {
    testAutomaticAndMergedPlacement();
    await testSemanticStorageRoundTripAndRefresh();
    await testLegacyMigrationUsesAutomaticColumnsAndYOrder();
    testStoredVersionAndHostileDataAreRejected();
    testValidationBoundsAndPrototypeSafety();
    await testRelayoutAndQueuedClearPreservePresentation();

    console.log('Schematic layout tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
