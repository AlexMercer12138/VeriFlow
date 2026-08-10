import { assignColumns } from './columns';
import { layoutSchematic } from './layout';
import type { GraphNode, SchematicGraph } from './model';
import type { TextMeasurer } from './nodeGeometry';
import {
    mergePlacement,
    moveNodesToColumns,
    type SchematicPlacement,
} from './placement';
import type { SchematicRenderModel } from './renderModel';
import type { Point } from './routing/geometry';

export type SchematicNodeDrop = Readonly<{
    nodeId: string;
    dropCenter: Readonly<Point>;
}>;

type SnappingColumn = Readonly<{
    index: number;
    midpoint: number;
}>;

type ResolvedDrop = Readonly<{
    nodeId: string;
    column: number;
    dropY: number;
}>;

function centerY(bounds: Readonly<{ y: number; height: number }>): number {
    return bounds.y + bounds.height / 2;
}

function snappingColumns(
    graph: SchematicGraph,
    assignment: ReturnType<typeof assignColumns>,
    renderModel: SchematicRenderModel
): SnappingColumn[] {
    const internal = new Set(graph.nodes.flatMap(node => {
        if (node.kind === 'port') return [];
        const column = assignment.nodeColumn.get(node.id);
        return column === undefined ? [] : [column];
    }));
    return renderModel.columns
        .filter(column => internal.has(column.index))
        .map(column => ({
            index: column.index,
            midpoint: column.x + column.width / 2,
        }))
        .sort((left, right) => left.index - right.index);
}

function targetColumn(
    node: GraphNode,
    current: number,
    columns: readonly SnappingColumn[],
    columnPositions: ReadonlyMap<number, number>,
    dropX: number
): number {
    if (node.kind === 'port' || !Number.isFinite(dropX)) return current;
    const currentPosition = columnPositions.get(current);
    if (currentPosition === undefined) return current;
    const currentGeometry = columns[currentPosition];

    if (dropX > currentGeometry.midpoint) {
        let low = currentPosition + 1;
        let high = columns.length;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (columns[middle].midpoint < dropX) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        const target = low - 1;
        return target > currentPosition ? columns[target].index : current;
    } else if (dropX < currentGeometry.midpoint) {
        let low = 0;
        let high = currentPosition;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (columns[middle].midpoint <= dropX) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low < currentPosition ? columns[low].index : current;
    }
    return current;
}

function resolveDrops(
    graph: SchematicGraph,
    assignment: ReturnType<typeof assignColumns>,
    placement: SchematicPlacement,
    renderModel: SchematicRenderModel,
    drops: readonly SchematicNodeDrop[]
): ResolvedDrop[] {
    const columns = snappingColumns(graph, assignment, renderModel);
    const columnPositions = new Map(columns.map((column, index) => [
        column.index,
        index,
    ]));
    const dropsById = new Map(drops.map(drop => [drop.nodeId, drop]));
    return graph.nodes.flatMap(node => {
        const drop = dropsById.get(node.id);
        const current = placement.nodes[node.id];
        const rendered = renderModel.nodes.get(node.id);
        if (!drop || !current || !rendered) return [];
        const originalY = centerY(rendered.bounds);
        const dropY = Number.isFinite(drop.dropCenter.y)
            && Math.abs(drop.dropCenter.y) <= Number.MAX_SAFE_INTEGER
            ? drop.dropCenter.y
            : originalY;
        return [{
            nodeId: node.id,
            column: targetColumn(
                node,
                current.column,
                columns,
                columnPositions,
                drop.dropCenter.x
            ),
            dropY,
        }];
    });
}

export function snapNodesToPlacement(
    graph: SchematicGraph,
    placement: SchematicPlacement,
    renderModel: SchematicRenderModel,
    drops: readonly SchematicNodeDrop[],
    measureText: TextMeasurer
): SchematicPlacement {
    const assignment = assignColumns(graph);
    const normalized = mergePlacement(graph, assignment, placement);
    const resolved = resolveDrops(
        graph,
        assignment,
        normalized,
        renderModel,
        drops
    );
    if (resolved.length === 0) return normalized;

    const sourceOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const moved = new Map(resolved.map(drop => [drop.nodeId, drop]));
    const byColumn = new Map<number, Array<{
        nodeId: string;
        y: number;
        originalOrder: number;
        sourceOrder: number;
    }>>();
    for (const node of graph.nodes) {
        const current = normalized.nodes[node.id];
        if (!current) continue;
        const drop = moved.get(node.id);
        const rendered = renderModel.nodes.get(node.id);
        const column = drop?.column ?? current.column;
        const entries = byColumn.get(column) ?? [];
        entries.push({
            nodeId: node.id,
            y: drop?.dropY ?? (rendered ? centerY(rendered.bounds) : current.order),
            originalOrder: current.order,
            sourceOrder: sourceOrder.get(node.id) ?? 0,
        });
        byColumn.set(column, entries);
    }

    const finalOrders = new Map<string, number>();
    for (const entries of byColumn.values()) {
        entries.sort((left, right) => left.y - right.y
            || left.originalOrder - right.originalOrder
            || left.sourceOrder - right.sourceOrder
            || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));
        entries.forEach((entry, order) => finalOrders.set(entry.nodeId, order));
    }

    const provisionalMoves = resolved.map(drop => ({
        nodeId: drop.nodeId,
        column: drop.column,
        order: finalOrders.get(drop.nodeId) ?? normalized.nodes[drop.nodeId].order,
        yOffset: 0,
    }));
    const provisional = moveNodesToColumns(
        graph,
        assignment,
        normalized,
        provisionalMoves
    );
    const provisionalRender = layoutSchematic(graph, provisional, measureText);
    return moveNodesToColumns(
        graph,
        assignment,
        provisional,
        resolved.map(drop => {
            const provisionalNode = provisionalRender.nodes.get(drop.nodeId);
            return {
                nodeId: drop.nodeId,
                column: drop.column,
                order: finalOrders.get(drop.nodeId)
                    ?? provisional.nodes[drop.nodeId].order,
                yOffset: provisionalNode === undefined
                    ? 0
                    : drop.dropY - centerY(provisionalNode.bounds),
            };
        })
    );
}

export function snapNodeToPlacement(
    graph: SchematicGraph,
    placement: SchematicPlacement,
    renderModel: SchematicRenderModel,
    nodeId: string,
    dropCenter: Readonly<Point>,
    measureText: TextMeasurer
): SchematicPlacement {
    return snapNodesToPlacement(
        graph,
        placement,
        renderModel,
        [{ nodeId, dropCenter }],
        measureText
    );
}
