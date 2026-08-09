import {
    Graph,
    layout as runDagreLayout,
    type EdgeLabel,
    type GraphLabel,
    type NodeLabel,
} from '@dagrejs/dagre';
import {
    measureSchematicNode,
    pinKey,
    SCHEMATIC_NODE_LAYOUT,
    type PinKey,
    type PinSide,
} from '@veriflow/schematic-core';

import type { GraphNode, SchematicGraph, SchematicNetwork } from './graphModel';

export type NodeLayout = {
    /** Node-center x coordinate in schematic coordinate space. */
    x: number;
    /** Node-center y coordinate in schematic coordinate space. */
    y: number;
    fixed: boolean;
};

export type SchematicNodeSize = { width: number; height: number };

export type SchematicLayout = {
    nodes: Record<string, NodeLayout>;
    viewport: { x: number; y: number; zoom: number };
    minimap: boolean;
    selectedObjectId?: string;
};

export type FeedbackRouteEndpoint = {
    nodeId: string;
    pinId: string;
    role: 'driver' | 'load';
    /** Attachment coordinate on the selected top or bottom node edge. */
    x: number;
    y: number;
};

export type FeedbackRoute = {
    networkId: string;
    side: 'top' | 'bottom';
    lane: number;
    /** Horizontal segment outside the bounds of every positioned graph node. */
    trunk: { x1: number; x2: number; y: number };
    endpoints: FeedbackRouteEndpoint[];
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
export const SCHEMATIC_PORT_SIZE = {
    width: SCHEMATIC_NODE_LAYOUT.portWidth,
    height: SCHEMATIC_NODE_LAYOUT.portHeight,
} as const;
const FEEDBACK_LANE_SEPARATION = 32;

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
            Object.defineProperty(nodes, id, {
                value: normalized,
                enumerable: true,
                configurable: true,
                writable: true,
            });
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

export function schematicNodeSize(node: GraphNode): SchematicNodeSize {
    const sides = new Map<PinKey, PinSide>(node.pins.map(pin => [
        pinKey(node.id, pin.id),
        pin.direction === 'driver' ? 'right' : 'left',
    ]));
    const measured = measureSchematicNode(node, sides, text => text.length * 7);
    return { width: measured.width, height: measured.height };
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
        layoutGraph.setNode(node.id, schematicNodeSize(node));
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
    const totalHeight = sortedIds.length * SCHEMATIC_PORT_SIZE.height
        + Math.max(0, sortedIds.length - 1) * NODE_SEPARATION;
    const firstY = SCHEMATIC_PORT_SIZE.height / 2 - totalHeight / 2;
    sortedIds.forEach((id, index) => {
        positions[id] = {
            x,
            y: firstY + index * (SCHEMATIC_PORT_SIZE.height + NODE_SEPARATION),
            fixed: false,
        };
    });
}

function applyBoundaryColumns(
    graph: SchematicGraph,
    positions: Record<string, NodeLayout>,
    fixedNodes: ReadonlySet<string>
): void {
    const interiorNodes = graph.nodes
        .filter(node => boundarySide(node) === undefined);
    const minInteriorX = interiorNodes.length > 0
        ? Math.min(...interiorNodes.map(node =>
            positions[node.id].x - schematicNodeSize(node).width / 2))
        : SCHEMATIC_PORT_SIZE.width / 2;
    const maxInteriorX = interiorNodes.length > 0
        ? Math.max(...interiorNodes.map(node =>
            positions[node.id].x + schematicNodeSize(node).width / 2))
        : SCHEMATIC_PORT_SIZE.width / 2;
    const boundaryOffset = RANK_SEPARATION + SCHEMATIC_PORT_SIZE.width / 2;
    const leftIds = graph.nodes
        .filter(node => boundarySide(node) === 'left' && !fixedNodes.has(node.id))
        .map(node => node.id);
    const rightIds = graph.nodes
        .filter(node => boundarySide(node) === 'right' && !fixedNodes.has(node.id))
        .map(node => node.id);

    placeBoundaryColumn(leftIds, minInteriorX - boundaryOffset, positions);
    placeBoundaryColumn(rightIds, maxInteriorX + boundaryOffset, positions);
}

function nodesAreSeparated(
    firstNode: GraphNode,
    firstPosition: NodeLayout,
    secondNode: GraphNode,
    secondPosition: NodeLayout
): boolean {
    const firstSize = schematicNodeSize(firstNode);
    const secondSize = schematicNodeSize(secondNode);
    const horizontalGap = Math.abs(firstPosition.x - secondPosition.x)
        - (firstSize.width + secondSize.width) / 2;
    const verticalGap = Math.abs(firstPosition.y - secondPosition.y)
        - (firstSize.height + secondSize.height) / 2;
    return horizontalGap >= NODE_SEPARATION || verticalGap >= NODE_SEPARATION;
}

function avoidNodeOverlaps(
    graph: SchematicGraph,
    positions: Record<string, NodeLayout>,
    anchoredNodeIds: ReadonlySet<string>
): void {
    const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
    const acceptedIds = [...anchoredNodeIds]
        .filter(id => nodesById.has(id))
        .sort(compareIds);
    const movableIds = graph.nodes
        .map(node => node.id)
        .filter(id => !anchoredNodeIds.has(id))
        .sort(compareIds);

    for (const id of movableIds) {
        const selectedNode = nodesById.get(id)!;
        let selectedPosition = positions[id];
        while (true) {
            const obstacles = acceptedIds.filter(acceptedId => !nodesAreSeparated(
                selectedNode,
                selectedPosition,
                nodesById.get(acceptedId)!,
                positions[acceptedId]
            ));
            if (obstacles.length === 0) {
                break;
            }
            const selectedHeight = schematicNodeSize(selectedNode).height;
            const nextY = Math.max(...obstacles.map(obstacleId => {
                const obstacle = nodesById.get(obstacleId)!;
                return positions[obstacleId].y
                    + (selectedHeight + schematicNodeSize(obstacle).height) / 2
                    + NODE_SEPARATION;
            }));
            selectedPosition = { ...selectedPosition, y: nextY };
            positions[id] = selectedPosition;
        }
        acceptedIds.push(id);
    }
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

function layoutWithAnchors(
    graph: SchematicGraph,
    normalizedExisting: SchematicLayout,
    preserveEveryMatchedNode: boolean
): SchematicLayout {
    const positions = dagrePositions(graph);
    const graphNodeIds = new Set(graph.nodes.map(node => node.id));
    const anchoredNodes = new Set<string>();
    for (const [id, position] of Object.entries(normalizedExisting.nodes)) {
        if (graphNodeIds.has(id) && (preserveEveryMatchedNode || position.fixed)) {
            positions[id] = { ...position };
            anchoredNodes.add(id);
        }
    }
    applyBoundaryColumns(graph, positions, anchoredNodes);
    avoidNodeOverlaps(graph, positions, anchoredNodes);

    const selectedObjectId = cleanSelection(graph, normalizedExisting.selectedObjectId);
    return {
        nodes: positions,
        viewport: { ...normalizedExisting.viewport },
        minimap: normalizedExisting.minimap,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

export function autoLayout(
    graph: SchematicGraph,
    existing?: SchematicLayout
): SchematicLayout {
    return layoutWithAnchors(
        graph,
        normalizeLayout(existing) ?? defaultLayout(),
        false
    );
}

export function mergeLayout(
    graph: SchematicGraph,
    persisted?: SchematicLayout
): SchematicLayout {
    const normalizedPersisted = normalizeLayout(persisted) ?? defaultLayout();
    return layoutWithAnchors(graph, normalizedPersisted, true);
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

export function deriveFeedbackRoutes(
    graph: SchematicGraph,
    layout: SchematicLayout
): FeedbackRoute[] {
    const normalizedLayout = normalizeLayout(layout);
    if (!normalizedLayout) {
        return [];
    }
    const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
    const positionedNodes = graph.nodes.flatMap(node => {
        const position = normalizedLayout.nodes[node.id];
        return position ? [{ node, position }] : [];
    });
    if (positionedNodes.length === 0) {
        return [];
    }
    const minY = Math.min(...positionedNodes.map(({ node, position }) =>
        position.y - schematicNodeSize(node).height / 2));
    const maxY = Math.max(...positionedNodes.map(({ node, position }) =>
        position.y + schematicNodeSize(node).height / 2));
    const feedbackNetworks = [...graph.networks]
        .sort((left, right) => compareIds(left.id, right.id))
        .flatMap(network => {
            const endpoints = network.endpoints
                .filter(endpoint =>
                    (endpoint.role === 'driver' || endpoint.role === 'load')
                    && nodesById.has(endpoint.nodeId)
                    && normalizedLayout.nodes[endpoint.nodeId] !== undefined
                )
                .sort((left, right) => compareIds(left.nodeId, right.nodeId)
                    || compareIds(left.pinId, right.pinId)
                    || compareIds(left.role, right.role));
            const drivers = endpoints.filter(endpoint => endpoint.role === 'driver');
            const loads = endpoints.filter(endpoint => endpoint.role === 'load');
            const hasFeedback = drivers.some(driver => loads.some(load =>
                normalizedLayout.nodes[load.nodeId].x
                    <= normalizedLayout.nodes[driver.nodeId].x
            ));
            return hasFeedback ? [{ network, endpoints }] : [];
        });

    return feedbackNetworks.map(({ network, endpoints }, index) => {
        const side: FeedbackRoute['side'] = index % 2 === 0 ? 'top' : 'bottom';
        const lane = Math.floor(index / 2);
        const endpointLayouts: FeedbackRouteEndpoint[] = endpoints.map(endpoint => {
            const selectedNode = nodesById.get(endpoint.nodeId)!;
            const position = normalizedLayout.nodes[endpoint.nodeId];
            const verticalDirection = side === 'top' ? -1 : 1;
            return {
                nodeId: endpoint.nodeId,
                pinId: endpoint.pinId,
                role: endpoint.role as 'driver' | 'load',
                x: position.x,
                y: position.y
                    + verticalDirection * schematicNodeSize(selectedNode).height / 2,
            };
        });
        const trunkY = side === 'top'
            ? minY - (lane + 1) * FEEDBACK_LANE_SEPARATION
            : maxY + (lane + 1) * FEEDBACK_LANE_SEPARATION;
        return {
            networkId: network.id,
            side,
            lane,
            trunk: {
                x1: Math.min(...endpointLayouts.map(endpoint => endpoint.x)),
                x2: Math.max(...endpointLayouts.map(endpoint => endpoint.x)),
                y: trunkY,
            },
            endpoints: endpointLayouts,
        };
    });
}
