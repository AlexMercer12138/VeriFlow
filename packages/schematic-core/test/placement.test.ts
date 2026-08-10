import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assignColumns,
    createPlacement,
    MAX_SCHEMATIC_PLACEMENT_OFFSET,
    mergePlacement,
    migrateLegacyPlacement,
    moveNodeToColumn,
    moveNodesToColumns,
    layoutSchematic,
    snapNodeToPlacement,
    snapNodesToPlacement,
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

test('moves a large batch with a constant number of whole-graph passes', () => {
    const nodeCount = 1_200;
    const sourceNodes = Array.from({ length: nodeCount }, (_, index) =>
        node(`instance:bulk-${index}`, 'instance')
    );
    const model = graph(sourceNodes);
    const columns = assignment(Array.from({ length: 12 }, (_, column) =>
        sourceNodes
            .filter((_, index) => index % 12 === column)
            .map(candidate => candidate.id)
    ));
    const placement = createPlacement(model, columns);
    let nodeReads = 0;
    const observedNodes = new Proxy(sourceNodes, {
        get(target, property, receiver) {
            if (typeof property === 'string' && /^\d+$/.test(property)) {
                nodeReads += 1;
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const observedGraph = { ...model, nodes: observedNodes };

    const moved = moveNodesToColumns(
        observedGraph,
        columns,
        placement,
        sourceNodes.map((candidate, index) => ({
            nodeId: candidate.id,
            column: 11 - (index % 12),
            order: nodeCount - index,
            yOffset: index % 2 === 0 ? index : Number.NaN,
        }))
    );

    assert.ok(nodeReads <= nodeCount * 8, `graph node reads=${nodeReads}`);
    assert.equal(Object.keys(moved.nodes).length, nodeCount);
    assert.ok(Object.values(moved.nodes).every(candidate => candidate.fixed));
    assert.ok(Object.values(moved.nodes).every(candidate =>
        Number.isFinite(candidate.yOffset)
    ));
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

function connectedGraph(nodes: GraphNode[]): SchematicGraph {
    const connectedNodes = nodes.map(candidate => ({
        ...candidate,
        pins: [{
            id: `${candidate.id}:in`,
            name: 'in',
            direction: 'load' as const,
            width: { kind: 'known' as const, bits: 1 },
            readOnly: false,
        }, {
            id: `${candidate.id}:out`,
            name: 'out',
            direction: 'driver' as const,
            width: { kind: 'known' as const, bits: 1 },
            readOnly: false,
        }],
    }));
    return {
        ...graph(connectedNodes),
        networks: connectedNodes.slice(0, -1).map((source, index) => ({
            id: `network:${index}`,
            name: `network_${index}`,
            width: { kind: 'known', bits: 1 },
            readOnly: false,
            endpoints: [{
                nodeId: source.id,
                pinId: source.pins[1].id,
                role: 'driver' as const,
            }, {
                nodeId: connectedNodes[index + 1].id,
                pinId: connectedNodes[index + 1].pins[0].id,
                role: 'load' as const,
            }],
        })),
    };
}

const measure = (text: string): number => text.length * 7;

function nodeCenterY(
    rendered: ReturnType<typeof layoutSchematic>,
    nodeId: string
): number {
    const bounds = rendered.nodes.get(nodeId)!.bounds;
    return bounds.y + bounds.height / 2;
}

function placementOrder(
    model: SchematicGraph,
    placement: SchematicPlacement,
    column: number
): string[] {
    return model.nodes
        .filter(candidate => placement.nodes[candidate.id].column === column)
        .sort((left, right) => placement.nodes[left.id].order
            - placement.nodes[right.id].order)
        .map(candidate => candidate.id);
}

function renderedRowOrder(
    model: SchematicGraph,
    placement: SchematicPlacement,
    column: number
): string[] {
    const rendered = layoutSchematic(model, placement, measure);
    return model.nodes
        .filter(candidate => rendered.nodes.get(candidate.id)?.column === column)
        .sort((left, right) => rendered.nodes.get(left.id)!.row
            - rendered.nodes.get(right.id)!.row)
        .map(candidate => candidate.id);
}

test('keeps the current column until a drop crosses an adjacent column midpoint', () => {
    const chain = connectedGraph([
        node('instance:left', 'instance', 'driver'),
        node('instance:middle', 'instance', 'driver'),
        node('instance:right', 'instance', 'load'),
    ]);
    const placement = createPlacement(chain, assignment([
        ['instance:left'],
        ['instance:middle'],
        ['instance:right'],
    ]));
    const rendered = layoutSchematic(chain, placement, measure);
    const middle = rendered.nodes.get('instance:middle')!;
    const rightColumn = rendered.columns[2];
    const rightMidpoint = rightColumn.x + rightColumn.width / 2;

    const before = snapNodeToPlacement(
        chain,
        placement,
        rendered,
        'instance:middle',
        { x: rightMidpoint - 1, y: middle.bounds.y + middle.bounds.height / 2 },
        measure
    );
    const atMidpoint = snapNodeToPlacement(
        chain,
        placement,
        rendered,
        'instance:middle',
        { x: rightMidpoint, y: middle.bounds.y + middle.bounds.height / 2 },
        measure
    );
    const after = snapNodeToPlacement(
        chain,
        placement,
        rendered,
        'instance:middle',
        { x: rightMidpoint + 1, y: middle.bounds.y + middle.bounds.height / 2 },
        measure
    );

    assert.equal(before.nodes['instance:middle'].column, 1);
    assert.equal(atMidpoint.nodes['instance:middle'].column, 1);
    assert.equal(after.nodes['instance:middle'].column, 2);
});

test('snaps leftward and clamps finite drops to the outer legal internal columns', () => {
    const chain = connectedGraph([
        node('instance:left', 'instance', 'driver'),
        node('instance:middle', 'instance', 'driver'),
        node('instance:right', 'instance', 'load'),
    ]);
    const placement = createPlacement(chain, assignment([
        ['instance:left'],
        ['instance:middle'],
        ['instance:right'],
    ]));
    const rendered = layoutSchematic(chain, placement, measure);
    const middle = rendered.nodes.get('instance:middle')!;
    const y = middle.bounds.y + middle.bounds.height / 2;

    assert.equal(snapNodeToPlacement(
        chain, placement, rendered, 'instance:middle',
        { x: Number.MIN_SAFE_INTEGER, y }, measure
    ).nodes['instance:middle'].column, 0);
    assert.equal(snapNodeToPlacement(
        chain, placement, rendered, 'instance:middle',
        { x: Number.MAX_SAFE_INTEGER, y }, measure
    ).nodes['instance:middle'].column, 2);
});

test('uses drop y for stable insertion order and semantic offset', () => {
    const firstParallel = node('instance:first-parallel', 'instance');
    const special = node('__proto__', 'instance');
    const lastParallel = node('instance:last-parallel', 'instance');
    const parallel = graph([firstParallel, special, lastParallel]);
    const columns = assignment([parallel.nodes.map(candidate => candidate.id)]);
    const placement = createPlacement(parallel, columns);
    const rendered = layoutSchematic(parallel, placement, measure);
    const firstCenter = rendered.nodes.get(firstParallel.id)!.bounds.y
        + rendered.nodes.get(firstParallel.id)!.bounds.height / 2;
    const column = rendered.columns[0];
    const snapped = snapNodeToPlacement(
        parallel,
        placement,
        rendered,
        special.id,
        { x: column.x + column.width / 2, y: firstCenter },
        measure
    );
    const originalSpecial = rendered.nodes.get(special.id)!;
    const originalSpecialCenter = originalSpecial.bounds.y
        + originalSpecial.bounds.height / 2;

    assert.deepEqual(Object.keys(snapped.nodes), [
        firstParallel.id,
        special.id,
        lastParallel.id,
    ]);
    assert.equal(snapped.nodes[firstParallel.id].order, 0);
    assert.equal(snapped.nodes[special.id].order, 1);
    assert.equal(snapped.nodes[lastParallel.id].order, 2);
    assert.equal(snapped.nodes[special.id].fixed, true);
    assert.equal(
        snapped.nodes[special.id].yOffset,
        firstCenter - originalSpecialCenter
    );
});

test('bounds extreme snapped offsets so the result remains layoutable', () => {
    const model = graph([first]);
    const columns = assignment([[first.id]]);
    const placement = createPlacement(model, columns);
    const rendered = layoutSchematic(model, placement, measure);
    const column = rendered.columns[0];

    for (const y of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
        const snapped = snapNodeToPlacement(
            model,
            placement,
            rendered,
            first.id,
            { x: column.x + column.width / 2, y },
            measure
        );

        assert.ok(
            Math.abs(snapped.nodes[first.id].yOffset)
                <= MAX_SCHEMATIC_PLACEMENT_OFFSET
        );
        assert.doesNotThrow(() => layoutSchematic(model, snapped, measure));
    }
});

test('keeps input output and inout boundary nodes in their assigned columns', () => {
    const model = graph([input, first, output, inout]);
    const columns = assignment([
        [input.id],
        [first.id],
        [output.id, inout.id],
    ]);
    const placement = createPlacement(model, columns);
    const rendered = layoutSchematic(model, placement, measure);

    for (const boundary of [input, output, inout]) {
        const current = placement.nodes[boundary.id].column;
        const snapped = snapNodeToPlacement(
            model,
            placement,
            rendered,
            boundary.id,
            {
                x: current === 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER,
                y: 123,
            },
            measure
        );
        assert.equal(snapped.nodes[boundary.id].column, current);
    }
});

test('moves a same-column node downward to its requested final order across refresh', () => {
    const model = graph([first, second, third]);
    const columns = assignment([[first.id, second.id, third.id]]);
    const placement = createPlacement(model, columns);
    const rendered = layoutSchematic(model, placement, measure);
    const column = rendered.columns[0];
    const thirdNode = rendered.nodes.get(third.id)!;
    const snapped = snapNodeToPlacement(
        model,
        placement,
        rendered,
        first.id,
        {
            x: column.x + column.width / 2,
            y: thirdNode.bounds.y + thirdNode.bounds.height + 16,
        },
        measure
    );

    assert.deepEqual(placementOrder(model, snapped, 0), [
        second.id,
        third.id,
        first.id,
    ]);
    assert.deepEqual(renderedRowOrder(model, snapped, 0), [
        second.id,
        third.id,
        first.id,
    ]);
    const refreshed = mergePlacement(model, columns, snapped);
    assert.deepEqual(placementOrder(model, refreshed, 0), [
        second.id,
        third.id,
        first.id,
    ]);
    assert.deepEqual(renderedRowOrder(model, refreshed, 0), [
        second.id,
        third.id,
        first.id,
    ]);
});

test('moves the last same-column node to the first final position', () => {
    const model = graph([first, second, third]);
    const columns = assignment([[first.id, second.id, third.id]]);
    const placement = createPlacement(model, columns);
    const rendered = layoutSchematic(model, placement, measure);
    const column = rendered.columns[0];
    const snapped = snapNodeToPlacement(
        model,
        placement,
        rendered,
        third.id,
        {
            x: column.x + column.width / 2,
            y: rendered.nodes.get(first.id)!.bounds.y - 16,
        },
        measure
    );

    assert.deepEqual(placementOrder(model, snapped, 0), [
        third.id,
        first.id,
        second.id,
    ]);
    assert.deepEqual(renderedRowOrder(model, snapped, 0), [
        third.id,
        first.id,
        second.id,
    ]);
});

test('inserts a same-column node between two existing rows', () => {
    const model = graph([first, second, third]);
    const columns = assignment([[first.id, second.id, third.id]]);
    const placement = createPlacement(model, columns);
    const rendered = layoutSchematic(model, placement, measure);
    const column = rendered.columns[0];
    const snapped = snapNodeToPlacement(
        model,
        placement,
        rendered,
        third.id,
        {
            x: column.x + column.width / 2,
            y: (nodeCenterY(rendered, first.id) + nodeCenterY(rendered, second.id)) / 2,
        },
        measure
    );

    assert.deepEqual(placementOrder(model, snapped, 0), [
        first.id,
        third.id,
        second.id,
    ]);
});

test('snaps a same-column batch once while preserving moved drop order', () => {
    const fourth = node('instance:fourth', 'instance');
    const model = graph([first, second, third, fourth]);
    const columns = assignment([[first.id, second.id, third.id, fourth.id]]);
    const placement = createPlacement(model, columns);
    const rendered = layoutSchematic(model, placement, measure);
    const column = rendered.columns[0];
    const x = column.x + column.width / 2;
    const secondCenter = nodeCenterY(rendered, second.id);
    const snapped = snapNodesToPlacement(
        model,
        placement,
        rendered,
        [{
            nodeId: first.id,
            dropCenter: { x, y: secondCenter + 12 },
        }, {
            nodeId: third.id,
            dropCenter: { x, y: secondCenter + 24 },
        }],
        measure
    );

    assert.deepEqual(placementOrder(model, snapped, 0), [
        second.id,
        first.id,
        third.id,
        fourth.id,
    ]);
    assert.equal(snapped.nodes[first.id].fixed, true);
    assert.equal(snapped.nodes[third.id].fixed, true);
    assert.deepEqual(
        placementOrder(model, mergePlacement(model, columns, snapped), 0),
        [second.id, first.id, third.id, fourth.id]
    );
});

test('snaps a cross-column batch with stable relative y and deterministic output', () => {
    const leftA = node('instance:left-a', 'instance');
    const rightA = node('instance:right-a', 'instance');
    const leftB = node('instance:left-b', 'instance');
    const rightB = node('instance:right-b', 'instance');
    const firstLane = connectedGraph([leftA, rightA]);
    const secondLane = connectedGraph([leftB, rightB]);
    const model: SchematicGraph = {
        ...firstLane,
        nodes: [...firstLane.nodes, ...secondLane.nodes],
        networks: [
            firstLane.networks[0],
            { ...secondLane.networks[0], id: 'network:second-lane' },
        ],
    };
    const columns = assignColumns(model);
    const placement = createPlacement(model, columns);
    const rendered = layoutSchematic(model, placement, measure);
    const leftColumn = rendered.columns[0];
    const rightColumn = rendered.columns[1];
    const drops = [{
        nodeId: leftA.id,
        dropCenter: {
            x: rightColumn.x + rightColumn.width / 2 + 1,
            y: nodeCenterY(rendered, rightA.id) + 32,
        },
    }, {
        nodeId: rightB.id,
        dropCenter: {
            x: leftColumn.x + leftColumn.width / 2 - 1,
            y: nodeCenterY(rendered, leftB.id) - 32,
        },
    }];

    const snapped = snapNodesToPlacement(
        model,
        placement,
        rendered,
        drops,
        measure
    );
    const repeated = snapNodesToPlacement(
        model,
        placement,
        rendered,
        drops,
        measure
    );

    assert.equal(snapped.nodes[leftA.id].column, 1);
    assert.equal(snapped.nodes[rightB.id].column, 0);
    assert.deepEqual(placementOrder(model, snapped, 0), [rightB.id, leftB.id]);
    assert.deepEqual(placementOrder(model, snapped, 1), [rightA.id, leftA.id]);
    const refreshed = mergePlacement(model, columns, snapped);
    assert.deepEqual(placementOrder(model, refreshed, 0), [rightB.id, leftB.id]);
    assert.deepEqual(placementOrder(model, refreshed, 1), [rightA.id, leftA.id]);
    assert.deepEqual(repeated, snapped);
});
