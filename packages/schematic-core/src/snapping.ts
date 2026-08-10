import { assignColumns } from './columns';
import { layoutSchematic } from './layout';
import type { SchematicGraph } from './model';
import type { TextMeasurer } from './nodeGeometry';
import {
    mergePlacement,
    moveNodeToColumn,
    type SchematicPlacement,
} from './placement';
import type { SchematicRenderModel } from './renderModel';
import type { Point } from './routing/geometry';

function centerY(bounds: Readonly<{ y: number; height: number }>): number {
    return bounds.y + bounds.height / 2;
}

function legalInternalColumns(
    graph: SchematicGraph,
    assignment: ReturnType<typeof assignColumns>
): ReadonlySet<number> {
    return new Set(graph.nodes.flatMap(node => {
        if (node.kind === 'port') return [];
        const column = assignment.nodeColumn.get(node.id);
        return column === undefined ? [] : [column];
    }));
}

function targetColumn(
    graph: SchematicGraph,
    assignment: ReturnType<typeof assignColumns>,
    placement: SchematicPlacement,
    renderModel: SchematicRenderModel,
    nodeId: string,
    dropX: number
): number {
    const current = placement.nodes[nodeId]?.column;
    if (current === undefined || !Number.isFinite(dropX)) return current ?? 0;
    const node = graph.nodes.find(candidate => candidate.id === nodeId);
    if (!node || node.kind === 'port') return current;
    const internal = legalInternalColumns(graph, assignment);
    const columns = renderModel.columns
        .filter(column => internal.has(column.index))
        .map(column => ({
            index: column.index,
            midpoint: column.x + column.width / 2,
        }))
        .sort((left, right) => left.index - right.index);
    const currentGeometry = columns.find(column => column.index === current);
    if (!currentGeometry) return current;

    let target = current;
    if (dropX > currentGeometry.midpoint) {
        for (const column of columns) {
            if (column.index > current && dropX > column.midpoint) {
                target = column.index;
            }
        }
    } else if (dropX < currentGeometry.midpoint) {
        for (let index = columns.length - 1; index >= 0; index -= 1) {
            const column = columns[index];
            if (column.index < current && dropX < column.midpoint) {
                target = column.index;
            }
        }
    }
    return target;
}

function insertionOrder(
    graph: SchematicGraph,
    placement: SchematicPlacement,
    renderModel: SchematicRenderModel,
    nodeId: string,
    column: number,
    dropY: number
): number {
    const sourceOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const candidates = graph.nodes.flatMap(node => {
        if (node.id === nodeId || placement.nodes[node.id]?.column !== column) return [];
        const rendered = renderModel.nodes.get(node.id);
        return rendered ? [{
            id: node.id,
            y: centerY(rendered.bounds),
            order: placement.nodes[node.id].order,
        }] : [];
    });
    candidates.sort((left, right) => left.y - right.y
        || left.order - right.order
        || (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0)
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    let order = 0;
    while (order < candidates.length && candidates[order].y <= dropY) order += 1;
    return order;
}

export function snapNodeToPlacement(
    graph: SchematicGraph,
    placement: SchematicPlacement,
    renderModel: SchematicRenderModel,
    nodeId: string,
    dropCenter: Readonly<Point>,
    measureText: TextMeasurer
): SchematicPlacement {
    const assignment = assignColumns(graph);
    const normalized = mergePlacement(graph, assignment, placement);
    const selected = renderModel.nodes.get(nodeId);
    if (!selected || normalized.nodes[nodeId] === undefined) return normalized;
    const selectedCenterY = centerY(selected.bounds);
    const dropY = Number.isFinite(dropCenter.y)
        && Math.abs(dropCenter.y) <= Number.MAX_SAFE_INTEGER
        ? dropCenter.y
        : selectedCenterY;
    const column = targetColumn(
        graph,
        assignment,
        normalized,
        renderModel,
        nodeId,
        dropCenter.x
    );
    const order = insertionOrder(
        graph,
        normalized,
        renderModel,
        nodeId,
        column,
        dropY
    );
    const provisional = moveNodeToColumn(
        graph,
        assignment,
        normalized,
        nodeId,
        column,
        order,
        0
    );
    const provisionalNode = layoutSchematic(
        graph,
        provisional,
        measureText
    ).nodes.get(nodeId);
    const yOffset = provisionalNode === undefined
        ? 0
        : dropY - centerY(provisionalNode.bounds);
    return moveNodeToColumn(
        graph,
        assignment,
        provisional,
        nodeId,
        column,
        order,
        yOffset
    );
}
