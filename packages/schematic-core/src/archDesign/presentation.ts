import { assignColumns } from '../columns';
import type { SchematicGraph } from '../model';
import {
    mergePlacement,
    type SchematicNodePlacement,
    type SchematicPlacement,
} from '../placement';
import type { ArchDesign } from './model';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: UnknownRecord, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key)
        ? record[key]
        : undefined;
}

function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function snapshotPersistedPlacement(
    design: ArchDesign,
    graph: SchematicGraph
): SchematicPlacement {
    const snapshot: Record<string, SchematicNodePlacement> = Object.create(null);
    const presentation = design.presentation as unknown;
    if (!isRecord(presentation)) return { nodes: snapshot };
    const source = ownValue(presentation, 'nodes');
    if (!isRecord(source)) return { nodes: snapshot };

    const graphNodeIds = new Set(graph.nodes.map(node => node.id));
    for (const id of Object.keys(source)) {
        if (!graphNodeIds.has(id)
            || !Object.prototype.hasOwnProperty.call(source, id)) {
            continue;
        }
        const value = source[id];
        if (!isRecord(value)) continue;
        const column = ownValue(value, 'column');
        const order = ownValue(value, 'order');
        const offset = ownValue(value, 'offset');
        const userPositioned = ownValue(value, 'userPositioned');
        setOwn(snapshot, id, {
            column: column as number,
            order: order as number,
            yOffset: offset === undefined ? 0 : offset as number,
            fixed: userPositioned === true,
        });
    }
    return { nodes: snapshot };
}

export function projectArchDesignPlacement(
    design: ArchDesign,
    graph: SchematicGraph
): SchematicPlacement {
    const assignment = assignColumns(graph);
    const persisted = snapshotPersistedPlacement(design, graph);
    return mergePlacement(graph, assignment, persisted);
}
