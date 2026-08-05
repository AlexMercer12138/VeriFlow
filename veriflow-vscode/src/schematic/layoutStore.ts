import {
    Graph,
    layout as runDagreLayout,
    type EdgeLabel,
    type GraphLabel,
    type NodeLabel,
} from '@dagrejs/dagre';

import type { GraphNode, SchematicGraph, SchematicNetwork } from './graphModel';

export type NodeLayout = { x: number; y: number; fixed: boolean };

export type SchematicLayout = {
    nodes: Record<string, NodeLayout>;
    viewport: { x: number; y: number; zoom: number };
    minimap: boolean;
    selectedObjectId?: string;
};

interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

type StoredLayoutEnvelope = {
    schemaVersion: 1;
    layout: SchematicLayout;
};

type BoundarySide = 'left' | 'right';

const SCHEMA_VERSION = 1;
const STORAGE_PREFIX = 'veriflow.schematicLayout:';
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const RANK_SEPARATION = 48;
const NODE_SEPARATION = 24;
const NODE_WIDTH = 160;
const NODE_HEIGHT = 72;
const PORT_WIDTH = 96;
const PORT_HEIGHT = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizeNodeLayout(value: unknown): NodeLayout | undefined {
    if (!isRecord(value)
        || !finiteNumber(value.x)
        || !finiteNumber(value.y)
        || typeof value.fixed !== 'boolean') {
        return undefined;
    }
    return { x: value.x, y: value.y, fixed: value.fixed };
}

function normalizeLayout(value: unknown): SchematicLayout | undefined {
    if (!isRecord(value)
        || !isRecord(value.nodes)
        || !isRecord(value.viewport)
        || !finiteNumber(value.viewport.x)
        || !finiteNumber(value.viewport.y)
        || !finiteNumber(value.viewport.zoom)
        || typeof value.minimap !== 'boolean'
        || (value.selectedObjectId !== undefined
            && typeof value.selectedObjectId !== 'string')) {
        return undefined;
    }

    const nodes: Record<string, NodeLayout> = {};
    for (const [id, candidate] of Object.entries(value.nodes)) {
        const normalized = normalizeNodeLayout(candidate);
        if (normalized) {
            nodes[id] = normalized;
        }
    }
    const normalized: SchematicLayout = {
        nodes,
        viewport: {
            x: value.viewport.x,
            y: value.viewport.y,
            zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value.viewport.zoom)),
        },
        minimap: value.minimap,
    };
    if (value.selectedObjectId !== undefined) {
        normalized.selectedObjectId = value.selectedObjectId;
    }
    return normalized;
}

function defaultLayout(): SchematicLayout {
    return {
        nodes: {},
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    };
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function storageKey(uri: string, moduleKey: string): string {
    return `${STORAGE_PREFIX}${encodeURIComponent(uri)}:${encodeURIComponent(moduleKey)}`;
}

export class SchematicLayoutStore {
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(private readonly state: MementoLike) {}

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation, operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    load(uri: string, moduleKey: string): SchematicLayout | undefined {
        const persisted = this.state.get<unknown>(storageKey(uri, moduleKey));
        if (!isRecord(persisted)
            || persisted.schemaVersion !== SCHEMA_VERSION
            || !Object.prototype.hasOwnProperty.call(persisted, 'layout')) {
            return undefined;
        }
        return normalizeLayout(persisted.layout);
    }

    save(uri: string, moduleKey: string, layout: SchematicLayout): Promise<void> {
        const normalized = normalizeLayout(layout);
        const key = storageKey(uri, moduleKey);
        const envelope: StoredLayoutEnvelope | undefined = normalized
            ? { schemaVersion: SCHEMA_VERSION, layout: normalized }
            : undefined;
        return this.enqueue(async () => {
            await this.state.update(key, envelope);
        });
    }

    async clearFixed(
        uri: string,
        moduleKey: string
    ): Promise<SchematicLayout | undefined> {
        return this.enqueue(async () => {
            const current = this.load(uri, moduleKey);
            if (!current) {
                return undefined;
            }
            const cleared: SchematicLayout = {
                ...current,
                nodes: Object.fromEntries(
                    Object.entries(current.nodes).map(([id, node]) => [
                        id,
                        { ...node, fixed: false },
                    ])
                ),
            };
            const envelope: StoredLayoutEnvelope = {
                schemaVersion: SCHEMA_VERSION,
                layout: {
                    ...cleared,
                    nodes: Object.fromEntries(
                        Object.entries(cleared.nodes).map(([id, node]) => [
                            id,
                            { ...node },
                        ])
                    ),
                    viewport: { ...cleared.viewport },
                },
            };
            await this.state.update(storageKey(uri, moduleKey), envelope);
            return cleared;
        });
    }
}

function boundarySide(node: GraphNode): BoundarySide | undefined {
    if (node.kind !== 'port' || node.pins.length === 0) {
        return undefined;
    }
    return node.pins[0].direction === 'load' ? 'right' : 'left';
}

function nodeDimensions(node: GraphNode): { width: number; height: number } {
    return node.kind === 'port'
        ? { width: PORT_WIDTH, height: PORT_HEIGHT }
        : { width: NODE_WIDTH, height: NODE_HEIGHT };
}

function addNetworkEdges(
    layoutGraph: Graph<GraphLabel, NodeLabel, EdgeLabel>,
    network: SchematicNetwork,
    knownNodeIds: ReadonlySet<string>,
    graphNodes: ReadonlyMap<string, GraphNode>,
    seenEdges: Set<string>
): void {
    const endpoints = network.endpoints
        .filter(endpoint => knownNodeIds.has(endpoint.nodeId))
        .sort((left, right) => compareIds(left.nodeId, right.nodeId)
            || compareIds(left.pinId, right.pinId));
    const drivers = endpoints.filter(endpoint => endpoint.role === 'driver');
    const sinks = endpoints.filter(endpoint => endpoint.role !== 'driver');
    const sources = drivers.length > 0
        ? drivers
        : endpoints.filter(endpoint =>
            boundarySide(graphNodes.get(endpoint.nodeId)!) === 'left'
        ).slice(0, 1);
    const resolvedSources = sources.length > 0 ? sources : endpoints.slice(0, 1);
    const resolvedSinks = drivers.length > 0
        ? sinks
        : endpoints.filter(endpoint => !resolvedSources.includes(endpoint));

    for (const source of resolvedSources) {
        for (const sink of resolvedSinks) {
            if (source.nodeId === sink.nodeId) {
                continue;
            }
            const edgeKey = `${source.nodeId}\0${sink.nodeId}`;
            if (!seenEdges.has(edgeKey)) {
                layoutGraph.setEdge(source.nodeId, sink.nodeId);
                seenEdges.add(edgeKey);
            }
        }
    }
}

function dagrePositions(graph: SchematicGraph): Record<string, NodeLayout> {
    const layoutGraph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ directed: true });
    layoutGraph.setGraph({
        rankdir: 'LR',
        ranksep: RANK_SEPARATION,
        nodesep: NODE_SEPARATION,
    });
    layoutGraph.setDefaultEdgeLabel(() => ({}));

    const sortedNodes = [...graph.nodes].sort((left, right) =>
        compareIds(left.id, right.id));
    const nodeById = new Map(sortedNodes.map(node => [node.id, node]));
    const nodeIds = new Set(nodeById.keys());
    for (const node of sortedNodes) {
        layoutGraph.setNode(node.id, nodeDimensions(node));
    }
    const seenEdges = new Set<string>();
    for (const network of [...graph.networks].sort((left, right) =>
        compareIds(left.id, right.id))) {
        addNetworkEdges(layoutGraph, network, nodeIds, nodeById, seenEdges);
    }

    runDagreLayout(layoutGraph);
    return Object.fromEntries(sortedNodes.map(node => {
        const positioned = layoutGraph.node(node.id);
        return [node.id, {
            x: positioned.x ?? 0,
            y: positioned.y ?? 0,
            fixed: false,
        }];
    }));
}

function placeBoundaryColumn(
    nodeIds: string[],
    x: number,
    positions: Record<string, NodeLayout>
): void {
    const sortedIds = [...nodeIds].sort(compareIds);
    const totalHeight = sortedIds.length * PORT_HEIGHT
        + Math.max(0, sortedIds.length - 1) * NODE_SEPARATION;
    const firstY = PORT_HEIGHT / 2 - totalHeight / 2;
    sortedIds.forEach((id, index) => {
        positions[id] = {
            x,
            y: firstY + index * (PORT_HEIGHT + NODE_SEPARATION),
            fixed: false,
        };
    });
}

function applyBoundaryColumns(
    graph: SchematicGraph,
    positions: Record<string, NodeLayout>,
    fixedNodes: ReadonlySet<string>
): void {
    const interiorIds = graph.nodes
        .filter(node => boundarySide(node) === undefined)
        .map(node => node.id);
    const interiorX = interiorIds.map(id => positions[id].x);
    const minInteriorX = interiorX.length > 0 ? Math.min(...interiorX) : PORT_WIDTH;
    const maxInteriorX = interiorX.length > 0 ? Math.max(...interiorX) : PORT_WIDTH;
    const columnOffset = NODE_WIDTH / 2 + RANK_SEPARATION + PORT_WIDTH / 2;
    const leftIds = graph.nodes
        .filter(node => boundarySide(node) === 'left' && !fixedNodes.has(node.id))
        .map(node => node.id);
    const rightIds = graph.nodes
        .filter(node => boundarySide(node) === 'right' && !fixedNodes.has(node.id))
        .map(node => node.id);

    placeBoundaryColumn(leftIds, minInteriorX - columnOffset, positions);
    placeBoundaryColumn(rightIds, maxInteriorX + columnOffset, positions);
}

function cleanSelection(
    graph: SchematicGraph,
    selectedObjectId: string | undefined
): string | undefined {
    if (selectedObjectId === undefined) {
        return undefined;
    }
    return graph.nodes.some(node => node.id === selectedObjectId)
        || graph.networks.some(network => network.id === selectedObjectId)
        ? selectedObjectId
        : undefined;
}

export function autoLayout(
    graph: SchematicGraph,
    existing?: SchematicLayout
): SchematicLayout {
    const normalizedExisting = normalizeLayout(existing) ?? defaultLayout();
    const positions = dagrePositions(graph);
    const graphNodeIds = new Set(graph.nodes.map(node => node.id));
    const fixedNodes = new Set<string>();
    for (const [id, position] of Object.entries(normalizedExisting.nodes)) {
        if (graphNodeIds.has(id) && position.fixed) {
            positions[id] = { ...position };
            fixedNodes.add(id);
        }
    }
    applyBoundaryColumns(graph, positions, fixedNodes);

    const selectedObjectId = cleanSelection(graph, normalizedExisting.selectedObjectId);
    return {
        nodes: positions,
        viewport: { ...normalizedExisting.viewport },
        minimap: normalizedExisting.minimap,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

export function mergeLayout(
    graph: SchematicGraph,
    persisted?: SchematicLayout
): SchematicLayout {
    return autoLayout(graph, persisted);
}

export function relayoutAll(
    graph: SchematicGraph,
    existing?: SchematicLayout
): SchematicLayout {
    const normalizedExisting = normalizeLayout(existing) ?? defaultLayout();
    return autoLayout(graph, {
        ...normalizedExisting,
        nodes: Object.fromEntries(Object.entries(normalizedExisting.nodes).map(([id, node]) => [
            id,
            { ...node, fixed: false },
        ])),
    });
}
