import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPlacement,
    mergePlacement,
    migrateLegacyPlacement,
    moveNodeToColumn,
    type ColumnAssignment,
    type SchematicPlacement,
} from '../src';
import type {
    GraphNode,
    PinDirection,
    SchematicGraph,
} from '../src/model';

function node(
    id: string,
    kind: GraphNode['kind'],
    direction?: PinDirection
): GraphNode {
    return {
        id,
        kind,
        label: id,
        pins: direction === undefined ? [] : [{
            id: `${id}:pin`,
            name: 'pin',
            direction,
            width: { kind: 'known', bits: 1 },
            readOnly: false,
        }],
        readOnly: false,
    };
}

function graph(nodes: GraphNode[]): SchematicGraph {
    return {
        fileUri: 'file:///top.sv',
        moduleKey: 'module:top:0',
        moduleName: 'top',
        nodes,
        networks: [],
        diagnostics: [],
    };
}

function assignment(columns: string[][]): ColumnAssignment {
    return {
        columns,
        nodeColumn: new Map(columns.flatMap((ids, column) =>
            ids.map(id => [id, column] as const)
        )),
        feedbackNetworkIds: new Set(),
    };
}

const input = node('port:input', 'port', 'driver');
const first = node('instance:first', 'instance');
const second = node('instance:second', 'instance');
const third = node('instance:third', 'instance');
const output = node('port:output', 'port', 'load');
const inout = node('port:inout', 'port', 'bidirectional');

test('creates automatic placement for every graph node in source order', () => {
    const model = graph([input, first, second, output]);
    const columns = assignment([
        [input.id],
        [first.id, second.id],
        [output.id],
    ]);

    assert.deepEqual(createPlacement(model, columns), {
        nodes: {
            [input.id]: { column: 0, order: 0, yOffset: 0, fixed: false },
            [first.id]: { column: 1, order: 0, yOffset: 0, fixed: false },
            [second.id]: { column: 1, order: 1, yOffset: 0, fixed: false },
            [output.id]: { column: 2, order: 0, yOffset: 0, fixed: false },
        },
    });
});

test('keeps manual placement across refresh and drops stale nodes', () => {
    const model = graph([input, first, second, third, output]);
    const columns = assignment([
        [input.id],
        [first.id, third.id],
        [second.id],
        [output.id],
    ]);
    const persisted: SchematicPlacement = {
        nodes: {
            [first.id]: { column: 2, order: 7, yOffset: 12, fixed: true },
            [second.id]: { column: 1, order: 0, yOffset: -4, fixed: true },
            removed: { column: 1, order: 0, yOffset: 99, fixed: true },
        },
    };

    assert.deepEqual(mergePlacement(model, columns, persisted), {
        nodes: {
            [input.id]: { column: 0, order: 0, yOffset: 0, fixed: false },
            [first.id]: { column: 2, order: 0, yOffset: 12, fixed: true },
            [second.id]: { column: 1, order: 0, yOffset: -4, fixed: true },
            [third.id]: { column: 1, order: 1, yOffset: 0, fixed: false },
            [output.id]: { column: 3, order: 0, yOffset: 0, fixed: false },
        },
    });
});

test('lets non-manual placement follow refreshed automatic order', () => {
    const model = graph([first, second]);
    const columns = assignment([[first.id, second.id]]);
    const persisted: SchematicPlacement = {
        nodes: {
            [first.id]: { column: 0, order: 9, yOffset: 50, fixed: false },
            [second.id]: { column: 0, order: 0, yOffset: -50, fixed: false },
        },
    };

    assert.deepEqual(mergePlacement(model, columns, persisted),
        createPlacement(model, columns));
});

test('normalizes duplicate orders independently within each column', () => {
    const model = graph([first, second, third]);
    const columns = assignment([[first.id], [second.id, third.id]]);
    const persisted: SchematicPlacement = {
        nodes: {
            [first.id]: { column: 1, order: 5, yOffset: 1, fixed: true },
            [second.id]: { column: 1, order: 5, yOffset: 2, fixed: true },
            [third.id]: { column: 1, order: -20, yOffset: 3, fixed: true },
        },
    };

    const merged = mergePlacement(model, columns, persisted);

    assert.deepEqual(merged.nodes[first.id], {
        column: 1, order: 1, yOffset: 1, fixed: true,
    });
    assert.deepEqual(merged.nodes[second.id], {
        column: 1, order: 2, yOffset: 2, fixed: true,
    });
    assert.deepEqual(merged.nodes[third.id], {
        column: 1, order: 0, yOffset: 3, fixed: true,
    });
});

test('clamps internal columns and keeps boundary ports on their assigned side', () => {
    const model = graph([input, first, second, output, inout]);
    const columns = assignment([
        [input.id],
        [first.id],
        [second.id],
        [output.id, inout.id],
    ]);
    let moved = createPlacement(model, columns);
    moved = moveNodeToColumn(model, columns, moved, input.id, 2, 0, 5);
    moved = moveNodeToColumn(model, columns, moved, first.id, 99, 0, 6);
    moved = moveNodeToColumn(model, columns, moved, output.id, 1, 0, 7);
    moved = moveNodeToColumn(model, columns, moved, inout.id, 0, 0, 8);

    assert.equal(moved.nodes[input.id].column, 0);
    assert.equal(moved.nodes[first.id].column, 2);
    assert.equal(moved.nodes[output.id].column, 3);
    assert.equal(moved.nodes[inout.id].column, 3);
});

test('snaps persisted internal placement away from unoccupied columns', () => {
    const model = graph([input, first, second, output]);
    const columns = assignment([
        [input.id],
        [first.id],
        [],
        [second.id],
        [output.id],
    ]);
    const persisted: SchematicPlacement = {
        nodes: {
            [first.id]: { column: 2, order: 0, yOffset: 0, fixed: true },
        },
    };

    const moved = moveNodeToColumn(model, columns, persisted, first.id, 2, 0, 0);

    assert.equal(moved.nodes[first.id].column, 1);
});

test('allows boundary column numbers when they are actual internal columns', () => {
    const model = graph([first, second]);
    const columns = assignment([[first.id], [], [second.id]]);
    let moved = createPlacement(model, columns);

    moved = moveNodeToColumn(model, columns, moved, first.id, 99, 0, 0);
    moved = moveNodeToColumn(model, columns, moved, second.id, -99, 0, 0);

    assert.equal(moved.nodes[first.id].column, 2);
    assert.equal(moved.nodes[second.id].column, 0);
});

test('replaces non-finite offsets with a deterministic safe default', () => {
    const model = graph([first]);
    const columns = assignment([[first.id]]);
    const persisted: SchematicPlacement = {
        nodes: {
            [first.id]: {
                column: 0,
                order: 0,
                yOffset: Number.POSITIVE_INFINITY,
                fixed: true,
            },
        },
    };

    assert.equal(mergePlacement(model, columns, persisted).nodes[first.id].yOffset, 0);
    assert.equal(
        moveNodeToColumn(
            model,
            columns,
            createPlacement(model, columns),
            first.id,
            0,
            0,
            Number.NaN
        )
            .nodes[first.id].yOffset,
        0
    );
});

test('relayout is represented by recreating placement without manual intent', () => {
    const model = graph([first, second]);
    const columns = assignment([[first.id, second.id]]);
    const manual = moveNodeToColumn(
        model,
        columns,
        createPlacement(model, columns),
        second.id,
        0,
        0,
        18
    );
    assert.equal(manual.nodes[second.id].fixed, true);

    assert.deepEqual(createPlacement(model, columns), {
        nodes: {
            [first.id]: { column: 0, order: 0, yOffset: 0, fixed: false },
            [second.id]: { column: 0, order: 1, yOffset: 0, fixed: false },
        },
    });
});

test('migrates legacy y ordering inside automatic columns without using x', () => {
    const model = graph([input, first, second, third, output]);
    const columns = assignment([
        [input.id],
        [first.id, second.id, third.id],
        [output.id],
    ]);

    const migrated = migrateLegacyPlacement(model, columns, {
        [first.id]: { x: 9000, y: 40, fixed: true },
        [second.id]: { x: -9000, y: 10, fixed: false },
        [third.id]: { x: 0, y: 10, fixed: true },
        removed: { x: 0, y: -100, fixed: true },
    });

    assert.deepEqual(migrated, {
        nodes: {
            [input.id]: { column: 0, order: 0, yOffset: 0, fixed: false },
            [first.id]: { column: 1, order: 2, yOffset: 0, fixed: true },
            [second.id]: { column: 1, order: 0, yOffset: 0, fixed: false },
            [third.id]: { column: 1, order: 1, yOffset: 0, fixed: true },
            [output.id]: { column: 2, order: 0, yOffset: 0, fixed: false },
        },
    });
});
