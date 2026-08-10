import {
    assignColumns,
    createPlacement,
    MAX_SCHEMATIC_PLACEMENT_OFFSET,
    mergePlacement,
    migrateLegacyPlacement,
    type LegacyNodePlacement,
    type SchematicPlacement,
} from '@veriflow/schematic-core';

import type { SchematicGraph } from './graphModel';

export type SchematicLayout = {
    placement: SchematicPlacement;
    viewport: { x: number; y: number; zoom: number };
    minimap: boolean;
    selectedObjectId?: string;
};

interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

type StoredLayoutEnvelopeV2 = SchematicLayout & {
    schemaVersion: 2;
};

const SCHEMA_VERSION = 2;
const STORAGE_PREFIX = 'veriflow.schematicLayout:';
export const MAX_SCHEMATIC_LAYOUT_NODES = 50_000;
export const MAX_SCHEMATIC_LAYOUT_COLUMN = 100_000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
    return Object.prototype.propertyIsEnumerable.call(value, key)
        ? value[key]
        : undefined;
}

function boundedCoordinate(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && Math.abs(value) <= MAX_SCHEMATIC_PLACEMENT_OFFSET;
}

function boundedInteger(value: unknown, maximum: number): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        && value < maximum;
}

function defineOwn<T>(target: Record<string, T>, id: string, value: T): void {
    Object.defineProperty(target, id, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function normalizePlacement(value: unknown): SchematicPlacement | undefined {
    if (!isRecord(value)) return undefined;
    const nodesValue = ownValue(value, 'nodes');
    if (!isRecord(nodesValue)) return undefined;
    const nodes: SchematicPlacement['nodes'] = {};
    let nodeCount = 0;
    for (const id of Object.keys(nodesValue)) {
        if (!Object.prototype.propertyIsEnumerable.call(nodesValue, id)) continue;
        nodeCount += 1;
        if (nodeCount > MAX_SCHEMATIC_LAYOUT_NODES) return undefined;
        const candidate = nodesValue[id];
        if (!isRecord(candidate)) return undefined;
        const column = ownValue(candidate, 'column');
        const order = ownValue(candidate, 'order');
        const yOffset = ownValue(candidate, 'yOffset');
        const fixed = ownValue(candidate, 'fixed');
        if (!boundedInteger(column, MAX_SCHEMATIC_LAYOUT_COLUMN)
            || !boundedInteger(order, MAX_SCHEMATIC_LAYOUT_NODES)
            || !boundedCoordinate(yOffset)
            || typeof fixed !== 'boolean') {
            return undefined;
        }
        defineOwn(nodes, id, { column, order, yOffset, fixed });
    }
    return { nodes };
}

function normalizePresentation(
    value: Record<string, unknown>
): Omit<SchematicLayout, 'placement'> | undefined {
    const viewportValue = ownValue(value, 'viewport');
    const minimap = ownValue(value, 'minimap');
    const selectedObjectId = ownValue(value, 'selectedObjectId');
    if (!isRecord(viewportValue)
        || typeof minimap !== 'boolean'
        || (selectedObjectId !== undefined && typeof selectedObjectId !== 'string')) {
        return undefined;
    }
    const x = ownValue(viewportValue, 'x');
    const y = ownValue(viewportValue, 'y');
    const zoom = ownValue(viewportValue, 'zoom');
    if (!boundedCoordinate(x) || !boundedCoordinate(y)
        || typeof zoom !== 'number' || !Number.isFinite(zoom)) {
        return undefined;
    }
    return {
        viewport: {
            x,
            y,
            zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)),
        },
        minimap,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

export function normalizeSchematicLayout(value: unknown): SchematicLayout | undefined {
    try {
        if (!isRecord(value)) return undefined;
        const placement = normalizePlacement(ownValue(value, 'placement'));
        const presentation = normalizePresentation(value);
        return placement && presentation
            ? { placement, ...presentation }
            : undefined;
    } catch {
        return undefined;
    }
}

function normalizeStoredV2(value: unknown): StoredLayoutEnvelopeV2 | undefined {
    if (!isRecord(value) || ownValue(value, 'schemaVersion') !== SCHEMA_VERSION) {
        return undefined;
    }
    const layout = normalizeSchematicLayout(value);
    return layout ? { schemaVersion: SCHEMA_VERSION, ...layout } : undefined;
}

function normalizeLegacyNodes(
    value: unknown
): Record<string, LegacyNodePlacement> | undefined {
    if (!isRecord(value)) return undefined;
    const nodes: Record<string, LegacyNodePlacement> = {};
    let nodeCount = 0;
    for (const id of Object.keys(value)) {
        if (!Object.prototype.propertyIsEnumerable.call(value, id)) continue;
        nodeCount += 1;
        if (nodeCount > MAX_SCHEMATIC_LAYOUT_NODES) return undefined;
        try {
            const candidate = value[id];
            if (!isRecord(candidate)) continue;
            const y = ownValue(candidate, 'y');
            const fixed = ownValue(candidate, 'fixed');
            if (!boundedCoordinate(y) || typeof fixed !== 'boolean') continue;
            defineOwn(nodes, id, { y, fixed });
        } catch {
            continue;
        }
    }
    return nodes;
}

function migrateStoredV1(
    graph: SchematicGraph,
    value: unknown
): StoredLayoutEnvelopeV2 | undefined {
    if (!isRecord(value) || ownValue(value, 'schemaVersion') !== 1) return undefined;
    const legacy = ownValue(value, 'layout');
    if (!isRecord(legacy)) return undefined;
    const legacyNodes = normalizeLegacyNodes(ownValue(legacy, 'nodes'));
    const presentation = normalizePresentation(legacy);
    if (!legacyNodes || !presentation) return undefined;
    return {
        schemaVersion: SCHEMA_VERSION,
        placement: migrateLegacyPlacement(
            graph,
            assignColumns(graph),
            legacyNodes
        ),
        ...presentation,
    };
}

function readStoredLayout(
    graph: SchematicGraph,
    value: unknown
): StoredLayoutEnvelopeV2 | undefined {
    try {
        return normalizeStoredV2(value) ?? migrateStoredV1(graph, value);
    } catch {
        return undefined;
    }
}

function defaultPresentation(): Omit<SchematicLayout, 'placement'> {
    return {
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    };
}

function cleanSelection(
    graph: SchematicGraph,
    selectedObjectId: string | undefined
): string | undefined {
    if (selectedObjectId === undefined) return undefined;
    return graph.nodes.some(node => node.id === selectedObjectId)
        || graph.networks.some(network => network.id === selectedObjectId)
        ? selectedObjectId
        : undefined;
}

function presentationForGraph(
    graph: SchematicGraph,
    presentation: Omit<SchematicLayout, 'placement'>
): Omit<SchematicLayout, 'placement'> {
    const selectedObjectId = cleanSelection(graph, presentation.selectedObjectId);
    return {
        viewport: { ...presentation.viewport },
        minimap: presentation.minimap,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

function storedEnvelope(layout: SchematicLayout): StoredLayoutEnvelopeV2 {
    return {
        schemaVersion: SCHEMA_VERSION,
        placement: {
            nodes: Object.fromEntries(Object.entries(layout.placement.nodes).map(
                ([id, node]) => [id, { ...node }]
            )),
        },
        viewport: { ...layout.viewport },
        minimap: layout.minimap,
        ...(layout.selectedObjectId === undefined
            ? {}
            : { selectedObjectId: layout.selectedObjectId }),
    };
}

function storageKey(uri: string, moduleKey: string): string {
    return `${STORAGE_PREFIX}${encodeURIComponent(uri)}:${encodeURIComponent(moduleKey)}`;
}

export function autoLayout(
    graph: SchematicGraph,
    existing?: SchematicLayout
): SchematicLayout {
    return mergeLayout(graph, existing);
}

export function mergeLayout(
    graph: SchematicGraph,
    persisted?: SchematicLayout
): SchematicLayout {
    const normalized = normalizeSchematicLayout(persisted);
    const assignment = assignColumns(graph);
    return {
        placement: mergePlacement(graph, assignment, normalized?.placement),
        ...presentationForGraph(graph, normalized ?? defaultPresentation()),
    };
}

export function relayoutAll(
    graph: SchematicGraph,
    existing?: SchematicLayout
): SchematicLayout {
    const normalized = normalizeSchematicLayout(existing);
    return {
        placement: createPlacement(graph, assignColumns(graph)),
        ...presentationForGraph(graph, normalized ?? defaultPresentation()),
    };
}

export class SchematicLayoutStore {
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(private readonly state: MementoLike) {}

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation, operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    load(
        uri: string,
        moduleKey: string,
        graph: SchematicGraph
    ): SchematicLayout | undefined {
        const stored = readStoredLayout(
            graph,
            this.state.get<unknown>(storageKey(uri, moduleKey))
        );
        return stored ? mergeLayout(graph, stored) : undefined;
    }

    save(
        uri: string,
        moduleKey: string,
        graph: SchematicGraph,
        layout: SchematicLayout
    ): Promise<void> {
        const normalized = normalizeSchematicLayout(layout);
        const envelope = normalized
            ? storedEnvelope(mergeLayout(graph, normalized))
            : undefined;
        return this.enqueue(async () => {
            await this.state.update(storageKey(uri, moduleKey), envelope);
        });
    }

    async clearFixed(
        uri: string,
        moduleKey: string,
        graph: SchematicGraph
    ): Promise<SchematicLayout | undefined> {
        return this.enqueue(async () => {
            const current = readStoredLayout(
                graph,
                this.state.get<unknown>(storageKey(uri, moduleKey))
            );
            if (!current) return undefined;
            const layout = relayoutAll(graph, current);
            await this.state.update(
                storageKey(uri, moduleKey),
                storedEnvelope(layout)
            );
            return layout;
        });
    }
}
