import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ROUTING_GRID_DEFAULTS,
    allocateChannelTrack,
    allocateCorridorTrack,
    createRoutingGrid,
    planCorridors,
    realizeRoutingGrid,
    type RoutingGridNodeInput,
} from '../src';

function routingNode(
    id: string,
    column: number,
    order: number,
    width: number,
    height: number,
    yOffset = 0
): RoutingGridNodeInput {
    return {
        id,
        column,
        order,
        yOffset,
        size: { width, height },
        pinAnchors: [
            { id: `${id}:left`, x: 0, y: height / 2 },
            { id: `${id}:right`, x: width, y: height / 2 },
        ],
    };
}

function unequalLayout(): RoutingGridNodeInput[] {
    return [
        routingNode('input', 0, 0, 96, 40),
        routingNode('wide', 1, 0, 220, 80),
        routingNode('middle', 1, 1, 162, 72),
        routingNode('tall', 2, 0, 180, 120),
        routingNode('lower', 2, 1, 200, 76),
        routingNode('output', 3, 0, 96, 40),
    ];
}

test('creates exactly one compact vertical channel between adjacent columns', () => {
    const grid = createRoutingGrid(unequalLayout(), { columnCount: 4 });

    assert.deepEqual(grid.columns.map(column => ({
        index: column.index,
        width: column.width,
        nodeIds: column.nodeIds,
    })), [
        { index: 0, width: 96, nodeIds: ['input'] },
        { index: 1, width: 220, nodeIds: ['wide', 'middle'] },
        { index: 2, width: 200, nodeIds: ['tall', 'lower'] },
        { index: 3, width: 96, nodeIds: ['output'] },
    ]);
    assert.deepEqual(grid.channels.map(channel => ({
        index: channel.index,
        columns: channel.columns,
        trackCount: channel.tracks.trackCount,
    })), [
        { index: 0, columns: [0, 1], trackCount: 0 },
        { index: 1, columns: [1, 2], trackCount: 0 },
        { index: 2, columns: [2, 3], trackCount: 0 },
    ]);

    const realized = realizeRoutingGrid(grid);
    assert.deepEqual(
        realized.channels.map(channel => channel.width),
        [
            ROUTING_GRID_DEFAULTS.minimumChannelWidth,
            ROUTING_GRID_DEFAULTS.minimumChannelWidth,
            ROUTING_GRID_DEFAULTS.minimumChannelWidth,
        ]
    );
});

test('returns only internal corridors clear across the complete requested span', () => {
    const nodes = [
        routingNode('c0-upper', 0, 0, 100, 40),
        routingNode('c0-lower', 0, 1, 100, 40),
        routingNode('c1-upper-blocks-gap-0', 1, 0, 100, 40, 2),
        routingNode('c1-middle', 1, 1, 100, 40),
        routingNode('c1-lower', 1, 2, 100, 40),
        routingNode('c2-upper', 2, 0, 100, 40),
        routingNode('c2-middle', 2, 1, 100, 40),
        routingNode('c2-lower', 2, 2, 100, 40),
        routingNode('c3-upper', 3, 0, 100, 40),
    ];
    const grid = createRoutingGrid(nodes, { columnCount: 4 });

    assert.deepEqual(planCorridors(grid, 0, 3), [
        { kind: 'internal', rowGap: 1, span: [0, 3] },
        { kind: 'outer-top', lane: 0, span: [0, 3] },
        { kind: 'outer-bottom', lane: 0, span: [0, 3] },
    ]);
    assert.deepEqual(planCorridors(grid, 2, 3, 0), [
        { kind: 'internal', rowGap: 0, span: [2, 3] },
        { kind: 'internal', rowGap: 1, span: [2, 3] },
        { kind: 'outer-top', lane: 0, span: [2, 3] },
        { kind: 'outer-bottom', lane: 0, span: [2, 3] },
    ]);
});

test('falls back to deterministic outer corridors when local gaps are blocked', () => {
    const nodes = [
        routingNode('upper', 0, 0, 100, 40, 2),
        routingNode('lower', 0, 1, 100, 40),
        routingNode('peer-upper', 1, 0, 100, 40),
        routingNode('peer-lower', 1, 1, 100, 40),
    ];
    const grid = createRoutingGrid(nodes, { columnCount: 2 });

    assert.deepEqual(planCorridors(grid, 0, 1), [
        { kind: 'outer-top', lane: 0, span: [0, 1] },
        { kind: 'outer-bottom', lane: 0, span: [0, 1] },
    ]);

    const top = allocateCorridorTrack(
        grid,
        planCorridors(grid, 0, 1)[0]
    );
    assert.deepEqual(top, {
        kind: 'outer-top',
        lane: 0,
        span: [0, 1],
    });
    assert.deepEqual(planCorridors(grid, 0, 1), [
        { kind: 'outer-top', lane: 1, span: [0, 1] },
        { kind: 'outer-bottom', lane: 0, span: [0, 1] },
    ]);
    const realized = realizeRoutingGrid(grid);
    assert.equal(
        realized.outer.top.height,
        ROUTING_GRID_DEFAULTS.minimumOuterMargin
            + ROUTING_GRID_DEFAULTS.trackPitch
    );
    assert.equal(
        realized.outer.bottom.height,
        ROUTING_GRID_DEFAULTS.minimumOuterMargin
    );
    assert.equal(realized.outer.top.trackY.length, 1);
    assert.equal(realized.outer.bottom.trackY.length, 0);
});

test('blocks a nominal row gap when an offset moves a module across it', () => {
    const grid = createRoutingGrid([
        routingNode('shifted-upper', 0, 0, 100, 40, 80),
        routingNode('pushed-lower', 0, 1, 100, 40),
        routingNode('peer-upper', 1, 0, 100, 40),
        routingNode('peer-lower', 1, 1, 100, 40),
    ], { columnCount: 2 });

    assert.deepEqual(planCorridors(grid, 0, 1), [
        { kind: 'outer-top', lane: 0, span: [0, 1] },
        { kind: 'outer-bottom', lane: 0, span: [0, 1] },
    ]);
});

test('track demand enlarges only its affected horizontal and vertical gaps', () => {
    const nodes = [
        ...unequalLayout(),
        routingNode('bottom-left', 1, 2, 170, 74),
        routingNode('bottom-right', 2, 2, 190, 78),
    ];
    const grid = createRoutingGrid(nodes, { columnCount: 4 });
    allocateChannelTrack(grid, 1);
    allocateChannelTrack(grid, 1);
    const internal = planCorridors(grid, 0, 3, 0)
        .find(candidate => candidate.kind === 'internal');
    assert.ok(internal);
    allocateCorridorTrack(grid, internal);

    const realized = realizeRoutingGrid(grid);

    assert.deepEqual(realized.channels.map(channel => channel.width), [
        ROUTING_GRID_DEFAULTS.minimumChannelWidth,
        ROUTING_GRID_DEFAULTS.minimumChannelWidth
            + 2 * ROUTING_GRID_DEFAULTS.trackPitch,
        ROUTING_GRID_DEFAULTS.minimumChannelWidth,
    ]);
    assert.deepEqual(realized.rowGaps.map(gap => gap.height), [
        ROUTING_GRID_DEFAULTS.minimumRowGap
            + ROUTING_GRID_DEFAULTS.trackPitch,
        ROUTING_GRID_DEFAULTS.minimumRowGap,
    ]);
    assert.equal(realized.outer.top.height, ROUTING_GRID_DEFAULTS.minimumOuterMargin);
    assert.equal(
        realized.outer.bottom.height,
        ROUTING_GRID_DEFAULTS.minimumOuterMargin
    );
});

test('realizes unequal nodes pin anchors and tracks once on an integer grid', () => {
    const grid = createRoutingGrid(unequalLayout(), { columnCount: 4 });
    const channelTrack = allocateChannelTrack(grid, 0);
    const candidate = planCorridors(grid, 0, 3, 0)
        .find(corridor => corridor.kind === 'internal');
    assert.ok(candidate);
    const corridorTrack = allocateCorridorTrack(grid, candidate);
    const realized = realizeRoutingGrid(grid);

    assert.strictEqual(realizeRoutingGrid(grid), realized);
    assert.throws(() => allocateChannelTrack(grid, 0), /already realized/);
    assert.throws(
        () => allocateCorridorTrack(grid, candidate),
        /already realized/
    );

    const wide = realized.nodes.find(node => node.id === 'wide');
    const middle = realized.nodes.find(node => node.id === 'middle');
    const tall = realized.nodes.find(node => node.id === 'tall');
    assert.ok(wide && middle && tall);
    assert.equal(wide.bounds.width, 220);
    assert.equal(middle.bounds.x, wide.bounds.x + 28);
    assert.ok(middle.bounds.y >= wide.bounds.y + wide.bounds.height);
    assert.equal(tall.bounds.width, 180);
    assert.equal(
        wide.pinAnchors[1].point.x,
        wide.bounds.x + wide.bounds.width
    );
    assert.equal(
        wide.pinAnchors[1].point.y,
        wide.bounds.y + wide.bounds.height / 2
    );

    assert.equal(
        realized.channels[channelTrack.channel].trackX[channelTrack.track]
            % ROUTING_GRID_DEFAULTS.gridStep,
        0
    );
    assert.equal(
        realized.rowGaps[corridorTrack.rowGap].trackY[corridorTrack.track]
            % ROUTING_GRID_DEFAULTS.gridStep,
        0
    );
    for (const value of [
        realized.width,
        realized.height,
        ...realized.columns.flatMap(column => [column.x, column.width]),
        ...realized.channels.flatMap(channel => [channel.x, channel.width]),
        ...realized.rowGaps.flatMap(gap => [gap.y, gap.height]),
        ...realized.nodes.flatMap(node => [
            node.bounds.x,
            node.bounds.y,
            node.bounds.width,
            node.bounds.height,
            ...node.pinAnchors.flatMap(pin => [pin.point.x, pin.point.y]),
        ]),
    ]) {
        assert.equal(Number.isSafeInteger(value), true);
        assert.equal(value % ROUTING_GRID_DEFAULTS.gridStep, 0);
    }
});

test('keeps sparse and empty columns compact and deterministic', () => {
    const nodes = [
        routingNode('__proto__', 0, 0, 98, 42, 1),
        routingNode('constructor', 3, 0, 162, 74, -1),
    ];
    const original = structuredClone(nodes);
    const firstGrid = createRoutingGrid(nodes, { columnCount: 4 });
    const secondGrid = createRoutingGrid(nodes, { columnCount: 4 });

    const first = realizeRoutingGrid(firstGrid);
    const second = realizeRoutingGrid(secondGrid);

    assert.deepEqual(first, second);
    assert.deepEqual(nodes, original);
    assert.deepEqual(first.columns.map(column => column.width), [98, 0, 0, 162]);
    assert.deepEqual(
        first.channels.map(channel => channel.width),
        [
            ROUTING_GRID_DEFAULTS.minimumChannelWidth,
            ROUTING_GRID_DEFAULTS.minimumChannelWidth,
            ROUTING_GRID_DEFAULTS.minimumChannelWidth,
        ]
    );
    assert.deepEqual(first.nodes.map(node => node.id), ['__proto__', 'constructor']);
});

test('snaps finite measured geometry and offsets onto the routing grid', () => {
    const grid = createRoutingGrid([{
        id: 'fractional',
        column: 0,
        order: 0,
        yOffset: 1.5,
        size: { width: 100.5, height: 41.25 },
        pinAnchors: [
            { id: 'left', x: 0, y: 20.625 },
            { id: 'right', x: 100.5, y: 20.625 },
        ],
    }]);

    const realized = realizeRoutingGrid(grid);
    assert.deepEqual(realized.nodes[0].bounds, {
        x: 0,
        y: ROUTING_GRID_DEFAULTS.minimumOuterMargin + 2,
        width: 102,
        height: 42,
    });
    assert.deepEqual(realized.nodes[0].pinAnchors, [
        {
            id: 'left',
            point: {
                x: 0,
                y: ROUTING_GRID_DEFAULTS.minimumOuterMargin + 22,
            },
        },
        {
            id: 'right',
            point: {
                x: 102,
                y: ROUTING_GRID_DEFAULTS.minimumOuterMargin + 22,
            },
        },
    ]);
});

test('rejects unsafe abstract grid track and span inputs without partial mutation', () => {
    for (const build of [
        () => createRoutingGrid([
            routingNode('negative-column', -1, 0, 100, 40),
        ]),
        () => createRoutingGrid([
            routingNode('unsafe-column', Number.MAX_SAFE_INTEGER, 0, 100, 40),
        ]),
        () => createRoutingGrid([
            routingNode('nan-size', 0, 0, Number.NaN, 40),
        ]),
        () => createRoutingGrid([
            routingNode('infinite-offset', 0, 0, 100, 40, Number.POSITIVE_INFINITY),
        ]),
        () => createRoutingGrid([
            routingNode('outside-pin', 0, 0, 100, 40),
            {
                ...routingNode('bad-pin', 1, 0, 100, 40),
                pinAnchors: [{ id: 'bad', x: 101, y: 20 }],
            },
        ]),
        () => createRoutingGrid([], { columnCount: Number.NaN }),
        () => createRoutingGrid([], {
            gridStep: 2,
            trackPitch: 2,
            minimumChannelWidth: 32,
            minimumRowGap: 32,
            minimumOuterMargin: 16,
        }),
        () => createRoutingGrid([], {
            trackPitch: Number.MAX_SAFE_INTEGER - 3,
        }),
    ]) {
        assert.throws(build, RangeError);
    }

    const grid = createRoutingGrid(unequalLayout(), { columnCount: 4 });
    for (const allocate of [
        () => allocateChannelTrack(grid, -1),
        () => allocateChannelTrack(grid, 3),
        () => allocateChannelTrack(grid, 0, -1),
        () => allocateChannelTrack(grid, 0, Number.POSITIVE_INFINITY),
        () => planCorridors(grid, -1, 3),
        () => planCorridors(grid, 2, 1),
        () => planCorridors(grid, 0, 4),
    ]) {
        assert.throws(allocate, RangeError);
    }
    assert.deepEqual(grid.channels.map(channel => channel.tracks.trackCount), [0, 0, 0]);
});
