import type { ColumnAssignment } from './columns';
import type { GraphNode, SchematicGraph } from './model';

export type SchematicNodePlacement = {
    column: number;
    order: number;
    yOffset: number;
    fixed: boolean;
};

export type SchematicPlacement = {
    nodes: Record<string, SchematicNodePlacement>;
};

export type LegacyNodePlacement = {
    /** Retained for v1 callers, but migration deliberately never reads it. */
    x?: unknown;
    y: number;
    fixed: boolean;
};

function setOwn<T>(target: Record<string, T>, id: string, value: T): void {
    Object.defineProperty(target, id, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function safeInteger(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function safeOffset(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

function automaticColumn(
    assignment: ColumnAssignment,
    nodeId: string
): number {
    const assigned = assignment.nodeColumn.get(nodeId);
    if (assigned !== undefined && Number.isFinite(assigned)) {
        return Math.max(0, Math.trunc(assigned));
    }
    const fallback = assignment.columns.findIndex(column => column.includes(nodeId));
    return Math.max(0, fallback);
}

function sourceIndexes(graph: SchematicGraph): ReadonlyMap<string, number> {
    return new Map(graph.nodes.map((node, index) => [node.id, index]));
}

function normalizeOrdersByIds(
    nodeIds: readonly string[],
    nodes: Record<string, SchematicNodePlacement>
): Record<string, SchematicNodePlacement> {
    const indexes = new Map(nodeIds.map((id, index) => [id, index]));
    const byColumn = new Map<number, Array<[string, SchematicNodePlacement]>>();
    for (const id of nodeIds) {
        const placement = nodes[id];
        if (!placement) continue;
        const column = safeInteger(placement.column, 0);
        const entries = byColumn.get(column) ?? [];
        entries.push([id, { ...placement, column }]);
        byColumn.set(column, entries);
    }

    const normalized: Record<string, SchematicNodePlacement> = {};
    for (const entries of byColumn.values()) {
        entries.sort((left, right) =>
            safeInteger(left[1].order, indexes.get(left[0]) ?? 0)
                - safeInteger(right[1].order, indexes.get(right[0]) ?? 0)
            || Number(right[1].fixed) - Number(left[1].fixed)
            || (indexes.get(left[0]) ?? 0) - (indexes.get(right[0]) ?? 0)
        );
        entries.forEach(([id, placement], order) => {
            setOwn(normalized, id, {
                ...placement,
                order,
                yOffset: safeOffset(placement.yOffset),
            });
        });
    }
    return normalized;
}

function normalizeOrders(
    graph: SchematicGraph,
    nodes: Record<string, SchematicNodePlacement>
): Record<string, SchematicNodePlacement> {
    return normalizeOrdersByIds(graph.nodes.map(node => node.id), nodes);
}

function boundaryColumn(
    node: GraphNode,
    assignment: ColumnAssignment
): number | undefined {
    return node.kind === 'port'
        ? automaticColumn(assignment, node.id)
        : undefined;
}

function internalColumns(
    graph: SchematicGraph,
    assignment: ColumnAssignment
): number[] {
    return [...new Set(graph.nodes
        .filter(node => node.kind !== 'port')
        .map(node => automaticColumn(assignment, node.id)))]
        .sort((left, right) => left - right);
}

function clampNodeColumn(
    node: GraphNode,
    assignment: ColumnAssignment,
    requested: number,
    legalInternalColumns: readonly number[]
): number {
    const boundary = boundaryColumn(node, assignment);
    if (boundary !== undefined) return boundary;
    const automatic = automaticColumn(assignment, node.id);
    if (legalInternalColumns.length === 0) return automatic;
    const column = safeInteger(requested, automatic);
    return legalInternalColumns.reduce((selected, candidate) => {
        const selectedDistance = Math.abs(column - selected);
        const candidateDistance = Math.abs(column - candidate);
        return candidateDistance < selectedDistance ? candidate : selected;
    }, legalInternalColumns[0]);
}

export function createPlacement(
    graph: SchematicGraph,
    assignment: ColumnAssignment
): SchematicPlacement {
    const nodes: Record<string, SchematicNodePlacement> = {};
    const orderByColumn = new Map<number, number>();
    for (const node of graph.nodes) {
        const column = automaticColumn(assignment, node.id);
        const order = orderByColumn.get(column) ?? 0;
        orderByColumn.set(column, order + 1);
        setOwn(nodes, node.id, {
            column,
            order,
            yOffset: 0,
            fixed: false,
        });
    }
    return { nodes };
}

export function mergePlacement(
    graph: SchematicGraph,
    assignment: ColumnAssignment,
    persisted?: SchematicPlacement
): SchematicPlacement {
    const automatic = createPlacement(graph, assignment);
    if (!persisted || typeof persisted !== 'object' || persisted === null
        || typeof persisted.nodes !== 'object' || persisted.nodes === null) {
        return automatic;
    }

    const legalInternalColumns = internalColumns(graph, assignment);
    for (const node of graph.nodes) {
        const candidate = Object.prototype.hasOwnProperty.call(persisted.nodes, node.id)
            ? persisted.nodes[node.id]
            : undefined;
        if (!candidate || typeof candidate.fixed !== 'boolean') continue;
        if (!candidate.fixed) continue;
        setOwn(automatic.nodes, node.id, {
            column: clampNodeColumn(
                node,
                assignment,
                candidate.column,
                legalInternalColumns
            ),
            order: safeInteger(candidate.order, automatic.nodes[node.id].order),
            yOffset: safeOffset(candidate.yOffset),
            fixed: true,
        });
    }
    return { nodes: normalizeOrders(graph, automatic.nodes) };
}

export function moveNodeToColumn(
    graph: SchematicGraph,
    assignment: ColumnAssignment,
    placement: SchematicPlacement,
    nodeId: string,
    column: number,
    order: number,
    yOffset: number
): SchematicPlacement {
    const normalized = mergePlacement(graph, assignment, placement);
    const selectedNode = graph.nodes.find(node => node.id === nodeId);
    const current = selectedNode ? normalized.nodes[nodeId] : undefined;
    if (!selectedNode || !current) return normalized;

    const nodes = normalized.nodes;
    setOwn(nodes, nodeId, {
        column: clampNodeColumn(
            selectedNode,
            assignment,
            column,
            internalColumns(graph, assignment)
        ),
        order: safeInteger(order, current.order),
        yOffset: safeOffset(yOffset),
        fixed: true,
    });

    return { nodes: normalizeOrders(graph, nodes) };
}

export function migrateLegacyPlacement(
    graph: SchematicGraph,
    assignment: ColumnAssignment,
    legacyNodes: Readonly<Record<string, LegacyNodePlacement>>
): SchematicPlacement {
    const placement = createPlacement(graph, assignment);
    const sourceIndex = sourceIndexes(graph);
    const legacyOrder = new Map<string, number>();
    const byColumn = new Map<number, Array<{ id: string; y: number }>>();

    for (const node of graph.nodes) {
        const candidate = Object.prototype.hasOwnProperty.call(legacyNodes, node.id)
            ? legacyNodes[node.id]
            : undefined;
        if (!candidate || !Number.isFinite(candidate.y)
            || typeof candidate.fixed !== 'boolean') {
            continue;
        }
        const column = placement.nodes[node.id].column;
        const entries = byColumn.get(column) ?? [];
        entries.push({ id: node.id, y: candidate.y });
        byColumn.set(column, entries);
        placement.nodes[node.id] = {
            ...placement.nodes[node.id],
            fixed: candidate.fixed,
        };
    }

    for (const entries of byColumn.values()) {
        entries.sort((left, right) => left.y - right.y
            || (sourceIndex.get(left.id) ?? 0) - (sourceIndex.get(right.id) ?? 0));
        entries.forEach((entry, order) => legacyOrder.set(entry.id, order));
    }
    for (const node of graph.nodes) {
        const order = legacyOrder.get(node.id);
        if (order !== undefined) placement.nodes[node.id].order = order;
    }

    return { nodes: normalizeOrders(graph, placement.nodes) };
}
