import {
    Graph,
    layout as runDagreLayout,
    type EdgeLabel,
    type GraphLabel,
    type NodeLabel,
} from '@dagrejs/dagre';
import {
    assignColumns,
    createPlacement,
    measureSchematicNodeSize,
    mergePlacement,
    migrateLegacyPlacement,
    moveNodeToColumn,
    pinKey,
    resolvePinSides,
    SCHEMATIC_NODE_LAYOUT,
    type ColumnAssignment,
    type LegacyNodePlacement,
    type PinKey,
    type PinSide,
    type SchematicPlacement,
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

type StoredLayoutEnvelopeV2 = {
    schemaVersion: 2;
    placement: SchematicPlacement;
    viewport: SchematicLayout['viewport'];
    minimap: boolean;
    selectedObjectId?: string;
};

type BoundarySide = 'left' | 'right';

const SCHEMA_VERSION = 2;
const STORAGE_PREFIX = 'veriflow.schematicLayout:';
const MAX_LAYOUT_NODES = 50_000;
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

function normalizePlacement(value: unknown): SchematicPlacement | undefined {
    if (!isRecord(value) || !isRecord(value.nodes)) return undefined;
    const nodes: SchematicPlacement['nodes'] = {};
    let nodeCount = 0;
    for (const [id, candidate] of Object.entries(value.nodes)) {
        nodeCount += 1;
        if (nodeCount > MAX_LAYOUT_NODES) return undefined;
        if (!isRecord(candidate)
            || !finiteNumber(candidate.column)
            || !finiteNumber(candidate.order)
            || !finiteNumber(candidate.yOffset)
            || typeof candidate.fixed !== 'boolean') {
            continue;
        }
        Object.defineProperty(nodes, id, {
            value: {
                column: Math.trunc(candidate.column),
                order: Math.trunc(candidate.order),
                yOffset: candidate.yOffset,
                fixed: candidate.fixed,
            },
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return { nodes };
}

function presentationFrom(value: unknown): Omit<StoredLayoutEnvelopeV2,
    'schemaVersion' | 'placement'> | undefined {
    if (!isRecord(value)
        || !isRecord(value.viewport)
        || !finiteNumber(value.viewport.x)
        || !finiteNumber(value.viewport.y)
        || !finiteNumber(value.viewport.zoom)
        || typeof value.minimap !== 'boolean'
        || (value.selectedObjectId !== undefined
            && typeof value.selectedObjectId !== 'string')) {
        return undefined;
    }
    return {
        viewport: {
            x: value.viewport.x,
            y: value.viewport.y,
            zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value.viewport.zoom)),
        },
        minimap: value.minimap,
        ...(value.selectedObjectId === undefined
            ? {}
            : { selectedObjectId: value.selectedObjectId }),
    };
}

function normalizeStoredV2(value: unknown): StoredLayoutEnvelopeV2 | undefined {
    if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) return undefined;
    const placement = normalizePlacement(value.placement);
    const presentation = presentationFrom(value);
    return placement && presentation
        ? { schemaVersion: SCHEMA_VERSION, placement, ...presentation }
        : undefined;
}

function normalizeLegacyNodes(
    value: unknown
): Record<string, LegacyNodePlacement> | undefined {
    if (!isRecord(value)) return undefined;
    const nodes: Record<string, LegacyNodePlacement> = {};
    let nodeCount = 0;
    for (const id of Object.keys(value)) {
        nodeCount += 1;
        if (nodeCount > MAX_LAYOUT_NODES) return undefined;
        try {
            if (!Object.prototype.propertyIsEnumerable.call(value, id)) continue;
            const candidate = value[id];
            if (!isRecord(candidate)
                || !Object.prototype.propertyIsEnumerable.call(candidate, 'y')
                || !Object.prototype.propertyIsEnumerable.call(candidate, 'fixed')) {
                continue;
            }
            const y = candidate.y;
            const fixed = candidate.fixed;
            if (!finiteNumber(y) || typeof fixed !== 'boolean') continue;
            Object.defineProperty(nodes, id, {
                value: { y, fixed },
                enumerable: true,
                configurable: true,
                writable: true,
            });
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
    if (!isRecord(value) || value.schemaVersion !== 1
        || !Object.prototype.hasOwnProperty.call(value, 'layout')) {
        return undefined;
    }
    const legacy = value.layout;
    if (!isRecord(legacy)) return undefined;
    const legacyNodes = normalizeLegacyNodes(legacy.nodes);
    const presentation = presentationFrom(legacy);
    if (!legacyNodes || !presentation) return undefined;
    const assignment = assignColumns(graph);
    return {
        schemaVersion: SCHEMA_VERSION,
        placement: migrateLegacyPlacement(graph, assignment, legacyNodes),
        ...presentation,
    };
}

function readStoredLayout(
    graph: SchematicGraph,
    value: unknown
): { stored: StoredLayoutEnvelopeV2; migratedFromV1: boolean } | undefined {
    try {
        const current = normalizeStoredV2(value);
        if (current) return { stored: current, migratedFromV1: false };
        const migrated = migrateStoredV1(graph, value);
        return migrated ? { stored: migrated, migratedFromV1: true } : undefined;
    } catch {
        return undefined;
    }
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

    load(
        uri: string,
        moduleKey: string,
        graph: SchematicGraph
    ): SchematicLayout | undefined {
        const persisted = this.state.get<unknown>(storageKey(uri, moduleKey));
        const read = readStoredLayout(graph, persisted);
        return read
            ? materializeStoredLayout(graph, read.stored, read.migratedFromV1)
            : undefined;
    }

    save(
        uri: string,
        moduleKey: string,
        graph: SchematicGraph,
        layout: SchematicLayout
    ): Promise<void> {
        const normalized = normalizeLayout(layout);
        const key = storageKey(uri, moduleKey);
        const envelope: StoredLayoutEnvelopeV2 | undefined = normalized
            ? storedLayoutFromAbsolute(graph, normalized)
            : undefined;
        return this.enqueue(async () => {
            await this.state.update(key, envelope);
        });
    }

    async clearFixed(
        uri: string,
        moduleKey: string,
        graph: SchematicGraph
    ): Promise<SchematicLayout | undefined> {
        return this.enqueue(async () => {
            const current = this.state.get<unknown>(storageKey(uri, moduleKey));
            const read = readStoredLayout(graph, current);
            if (!read) return undefined;
            const envelope: StoredLayoutEnvelopeV2 = {
                schemaVersion: SCHEMA_VERSION,
                placement: createPlacement(graph, assignColumns(graph)),
                viewport: { ...read.stored.viewport },
                minimap: read.stored.minimap,
                ...(read.stored.selectedObjectId === undefined
                    ? {}
                    : { selectedObjectId: read.stored.selectedObjectId }),
            };
            await this.state.update(storageKey(uri, moduleKey), envelope);
            return materializeStoredLayout(graph, envelope);
        });
    }
}

function boundarySide(node: GraphNode): BoundarySide | undefined {
    if (node.kind !== 'port' || node.pins.length === 0) {
        return undefined;
    }
    return node.pins[0].direction === 'driver' ? 'left' : 'right';
}

export function schematicNodeSize(
    node: GraphNode,
    resolvedSides?: ReadonlyMap<PinKey, PinSide>
): SchematicNodeSize {
    const sides = resolvedSides ?? new Map<PinKey, PinSide>(node.pins.map(pin => [
        pinKey(node.id, pin.id),
        pin.direction === 'driver' ? 'right' : 'left',
    ]));
    return measureSchematicNodeSize(node, sides);
}

function resolvedNodeSizes(
    graph: SchematicGraph
): ReadonlyMap<string, SchematicNodeSize> {
    const resolvedSides = resolvePinSides(graph);
    return new Map(graph.nodes.map(node => [
        node.id,
        schematicNodeSize(node, resolvedSides),
    ]));
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

function dagrePositions(
    graph: SchematicGraph,
    nodeSizes: ReadonlyMap<string, SchematicNodeSize>
): Record<string, NodeLayout> {
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
        layoutGraph.setNode(node.id, nodeSizes.get(node.id)!);
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
    fixedNodes: ReadonlySet<string>,
    nodeSizes: ReadonlyMap<string, SchematicNodeSize>
): void {
    const interiorNodes = graph.nodes
        .filter(node => boundarySide(node) === undefined);
    const minInteriorX = interiorNodes.length > 0
        ? Math.min(...interiorNodes.map(node =>
            positions[node.id].x - nodeSizes.get(node.id)!.width / 2))
        : SCHEMATIC_PORT_SIZE.width / 2;
    const maxInteriorX = interiorNodes.length > 0
        ? Math.max(...interiorNodes.map(node =>
            positions[node.id].x + nodeSizes.get(node.id)!.width / 2))
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
    firstSize: SchematicNodeSize,
    firstPosition: NodeLayout,
    secondSize: SchematicNodeSize,
    secondPosition: NodeLayout
): boolean {
    const horizontalGap = Math.abs(firstPosition.x - secondPosition.x)
        - (firstSize.width + secondSize.width) / 2;
    const verticalGap = Math.abs(firstPosition.y - secondPosition.y)
        - (firstSize.height + secondSize.height) / 2;
    return horizontalGap >= NODE_SEPARATION || verticalGap >= NODE_SEPARATION;
}

function avoidNodeOverlaps(
    graph: SchematicGraph,
    positions: Record<string, NodeLayout>,
    anchoredNodeIds: ReadonlySet<string>,
    nodeSizes: ReadonlyMap<string, SchematicNodeSize>
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
                nodeSizes.get(selectedNode.id)!,
                selectedPosition,
                nodeSizes.get(acceptedId)!,
                positions[acceptedId]
            ));
            if (obstacles.length === 0) {
                break;
            }
            const selectedHeight = nodeSizes.get(selectedNode.id)!.height;
            const nextY = Math.max(...obstacles.map(obstacleId => {
                return positions[obstacleId].y
                    + (selectedHeight + nodeSizes.get(obstacleId)!.height) / 2
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
    const nodeSizes = resolvedNodeSizes(graph);
    const positions = dagrePositions(graph, nodeSizes);
    const graphNodeIds = new Set(graph.nodes.map(node => node.id));
    const anchoredNodes = new Set<string>();
    for (const [id, position] of Object.entries(normalizedExisting.nodes)) {
        if (graphNodeIds.has(id) && (preserveEveryMatchedNode || position.fixed)) {
            positions[id] = { ...position };
            anchoredNodes.add(id);
        }
    }
    applyBoundaryColumns(graph, positions, anchoredNodes, nodeSizes);
    avoidNodeOverlaps(graph, positions, anchoredNodes, nodeSizes);

    const selectedObjectId = cleanSelection(graph, normalizedExisting.selectedObjectId);
    return {
        nodes: positions,
        viewport: { ...normalizedExisting.viewport },
        minimap: normalizedExisting.minimap,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

function automaticColumnCenters(
    graph: SchematicGraph,
    assignment: ColumnAssignment,
    nodeSizes: ReadonlyMap<string, SchematicNodeSize>
): { positions: Record<string, NodeLayout>; centers: ReadonlyMap<number, number> } {
    const positions = dagrePositions(graph, nodeSizes);
    applyBoundaryColumns(graph, positions, new Set(), nodeSizes);
    const centers = new Map<number, number>();
    assignment.columns.forEach((nodeIds, column) => {
        const xs = nodeIds.flatMap(id => positions[id] ? [positions[id].x] : []);
        if (xs.length > 0) {
            centers.set(column, xs.reduce((sum, x) => sum + x, 0) / xs.length);
        }
    });
    return { positions, centers };
}

function layoutFromPlacement(
    graph: SchematicGraph,
    placement: SchematicPlacement,
    presentation: Pick<SchematicLayout, 'viewport' | 'minimap' | 'selectedObjectId'>,
    preservePlacement = false
): SchematicLayout {
    const assignment = assignColumns(graph);
    const normalized = preservePlacement
        ? placement
        : mergePlacement(graph, assignment, placement);
    const nodeSizes = resolvedNodeSizes(graph);
    const automatic = automaticColumnCenters(graph, assignment, nodeSizes);
    const sourceIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const nodesByColumn = new Map<number, GraphNode[]>();
    for (const node of graph.nodes) {
        const column = normalized.nodes[node.id].column;
        const nodes = nodesByColumn.get(column) ?? [];
        nodes.push(node);
        nodesByColumn.set(column, nodes);
    }

    const positions: Record<string, NodeLayout> = {};
    for (const [column, nodes] of nodesByColumn) {
        nodes.sort((left, right) =>
            normalized.nodes[left.id].order - normalized.nodes[right.id].order
            || sourceIndex.get(left.id)! - sourceIndex.get(right.id)!
        );
        const totalHeight = nodes.reduce((sum, node) =>
            sum + nodeSizes.get(node.id)!.height, 0)
            + Math.max(0, nodes.length - 1) * NODE_SEPARATION;
        let cursor = -totalHeight / 2;
        for (const node of nodes) {
            const size = nodeSizes.get(node.id)!;
            const semantic = normalized.nodes[node.id];
            const automaticPosition = automatic.positions[node.id];
            Object.defineProperty(positions, node.id, {
                value: {
                    x: automatic.centers.get(column) ?? automaticPosition.x,
                    y: cursor + size.height / 2 + semantic.yOffset,
                    fixed: semantic.fixed,
                },
                enumerable: true,
                configurable: true,
                writable: true,
            });
            cursor += size.height + NODE_SEPARATION;
        }
    }

    const selectedObjectId = cleanSelection(graph, presentation.selectedObjectId);
    return {
        nodes: positions,
        viewport: { ...presentation.viewport },
        minimap: presentation.minimap,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

function materializeStoredLayout(
    graph: SchematicGraph,
    stored: StoredLayoutEnvelopeV2,
    migratedFromV1 = false
): SchematicLayout {
    return layoutFromPlacement(graph, stored.placement, stored, migratedFromV1);
}

function nearestColumn(
    x: number,
    candidates: readonly number[],
    centers: ReadonlyMap<number, number>,
    fallback: number
): number {
    return candidates.reduce((selected, candidate) => {
        const selectedDistance = Math.abs(x - (centers.get(selected) ?? x));
        const candidateDistance = Math.abs(x - (centers.get(candidate) ?? x));
        return candidateDistance < selectedDistance ? candidate : selected;
    }, candidates[0] ?? fallback);
}

function storedLayoutFromAbsolute(
    graph: SchematicGraph,
    layout: SchematicLayout
): StoredLayoutEnvelopeV2 {
    const assignment = assignColumns(graph);
    let placement = createPlacement(graph, assignment);
    const baseline = layoutFromPlacement(graph, placement, layout);
    const nodeSizes = resolvedNodeSizes(graph);
    const { centers } = automaticColumnCenters(graph, assignment, nodeSizes);
    const internalColumns = [...new Set(graph.nodes
        .filter(node => node.kind !== 'port')
        .map(node => assignment.nodeColumn.get(node.id) ?? 0))]
        .sort((left, right) => left - right);
    const targetColumns = new Map<string, number>();

    for (const node of graph.nodes) {
        const absolute = layout.nodes[node.id];
        const automaticColumn = assignment.nodeColumn.get(node.id) ?? 0;
        const column = !absolute?.fixed || node.kind === 'port'
            ? automaticColumn
            : nearestColumn(absolute.x, internalColumns, centers, automaticColumn);
        targetColumns.set(node.id, column);
    }

    const sourceIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const byColumn = new Map<number, GraphNode[]>();
    for (const node of graph.nodes) {
        const column = targetColumns.get(node.id)!;
        const nodes = byColumn.get(column) ?? [];
        nodes.push(node);
        byColumn.set(column, nodes);
    }
    for (const [column, nodes] of byColumn) {
        nodes.sort((left, right) => {
            const leftLayout = layout.nodes[left.id]?.fixed
                ? layout.nodes[left.id]
                : baseline.nodes[left.id];
            const rightLayout = layout.nodes[right.id]?.fixed
                ? layout.nodes[right.id]
                : baseline.nodes[right.id];
            return leftLayout.y - rightLayout.y
                || sourceIndex.get(left.id)! - sourceIndex.get(right.id)!;
        });
        nodes.forEach((node, order) => {
            const absolute = layout.nodes[node.id];
            if (!absolute?.fixed) return;
            placement = moveNodeToColumn(
                graph,
                assignment,
                placement,
                node.id,
                column,
                order,
                0
            );
        });
    }
    placement = mergePlacement(graph, assignment, placement);

    const positioned = layoutFromPlacement(graph, placement, layout);
    for (const node of graph.nodes) {
        const absolute = layout.nodes[node.id];
        if (!absolute?.fixed) continue;
        const semantic = placement.nodes[node.id];
        placement = moveNodeToColumn(
            graph,
            assignment,
            placement,
            node.id,
            semantic.column,
            semantic.order,
            absolute.y - positioned.nodes[node.id].y
        );
    }
    placement = mergePlacement(graph, assignment, placement);

    return {
        schemaVersion: SCHEMA_VERSION,
        placement,
        viewport: { ...layout.viewport },
        minimap: layout.minimap,
        ...(layout.selectedObjectId === undefined
            ? {}
            : { selectedObjectId: layout.selectedObjectId }),
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
    const nodeSizes = resolvedNodeSizes(graph);
    const positionedNodes = graph.nodes.flatMap(node => {
        const position = normalizedLayout.nodes[node.id];
        return position ? [{ node, position }] : [];
    });
    if (positionedNodes.length === 0) {
        return [];
    }
    const minY = Math.min(...positionedNodes.map(({ node, position }) =>
        position.y - nodeSizes.get(node.id)!.height / 2));
    const maxY = Math.max(...positionedNodes.map(({ node, position }) =>
        position.y + nodeSizes.get(node.id)!.height / 2));
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
                    + verticalDirection * nodeSizes.get(selectedNode.id)!.height / 2,
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
