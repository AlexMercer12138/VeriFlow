import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_ROUTING_TRACKS,
    ROUTING_GRID_DEFAULTS,
    allocateChannelTrack,
    allocateCorridorTrack,
    createRoutingGrid,
    planCorridors,
    realizeRoutingGrid,
    type CorridorCandidate,
    type RealizedRoutingGrid,
    type RoutingGrid,
    type RoutingGridNodeInput,
} from '../src';

if (false) {
    const realized = null as unknown as RealizedRoutingGrid;
    // @ts-expect-error realized module bounds are deeply readonly
    realized.nodes[0].bounds.x = 1;
    // @ts-expect-error realized pin points are deeply readonly
    realized.nodes[0].pinAnchors[0].point.y = 1;
    // @ts-expect-error realized arrays are readonly
    realized.nodes.push(realized.nodes[0]);

    const grid = null as unknown as RoutingGrid;
    const outer = {
        kind: 'outer-top',
        lane: 0,
        span: [0, 0] as const,
    } as const;
    // @ts-expect-error explicit track indices apply only to internal corridors
    allocateCorridorTrack(grid, outer, 0);
}

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

function countedGetter<T>(
    reads: Record<string, number>,
    key: string,
    value: T
): () => T {
    return () => {
        reads[key] = (reads[key] ?? 0) + 1;
        return value;
    };
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

test('keeps empty and single-column grids free of invented adjacent channels', () => {
    const empty = createRoutingGrid([]);
    assert.equal(empty.columns.length, 0);
    assert.equal(empty.channels.length, 0);
    assert.equal(empty.rowGaps.length, 0);
    assert.throws(() => planCorridors(empty, 0, 0), RangeError);
    assert.deepEqual(realizeRoutingGrid(empty), {
        metrics: ROUTING_GRID_DEFAULTS,
        width: 0,
        height: 2 * ROUTING_GRID_DEFAULTS.minimumOuterMargin,
        columns: [],
        channels: [],
        rowGaps: [],
        outer: {
            top: {
                y: 0,
                height: ROUTING_GRID_DEFAULTS.minimumOuterMargin,
                trackY: [],
            },
            bottom: {
                y: ROUTING_GRID_DEFAULTS.minimumOuterMargin,
                height: ROUTING_GRID_DEFAULTS.minimumOuterMargin,
                trackY: [],
            },
        },
        nodes: [],
    });

    const emptyColumn = createRoutingGrid([], { columnCount: 1 });
    assert.equal(emptyColumn.channels.length, 0);
    assert.deepEqual(planCorridors(emptyColumn, 0, 0), [
        { kind: 'outer-top', lane: 0, span: [0, 0] },
        { kind: 'outer-bottom', lane: 0, span: [0, 0] },
    ]);

    const single = createRoutingGrid([
        routingNode('only', 0, 0, 100, 40),
    ], { columnCount: 1 });
    assert.equal(single.channels.length, 0);
    assert.equal(single.rowGaps.length, 0);
    assert.deepEqual(planCorridors(single, 0, 0), [
        { kind: 'outer-top', lane: 0, span: [0, 0] },
        { kind: 'outer-bottom', lane: 0, span: [0, 0] },
    ]);
    const top = planCorridors(single, 0, 0)
        .find(candidate => candidate.kind === 'outer-top');
    assert.ok(top);
    allocateCorridorTrack(single, top);
    const realized = realizeRoutingGrid(single);
    assert.equal(realized.channels.length, 0);
    assert.equal(realized.outer.top.trackY.length, 1);
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

test('rejects direct allocation of a blocked internal corridor atomically', () => {
    const grid = createRoutingGrid([
        routingNode('shifted-upper', 0, 0, 100, 40, 10),
        routingNode('lower', 0, 1, 100, 40),
        routingNode('peer-upper', 1, 0, 100, 40),
        routingNode('peer-lower', 1, 1, 100, 40),
    ], { columnCount: 2 });
    const before = {
        channels: grid.channels.map(channel => channel.tracks.trackCount),
        rowGaps: grid.rowGaps.map(gap => gap.tracks.trackCount),
        top: grid.outer.top.trackCount,
        bottom: grid.outer.bottom.trackCount,
    };

    assert.deepEqual(planCorridors(grid, 0, 1), [
        { kind: 'outer-top', lane: 0, span: [0, 1] },
        { kind: 'outer-bottom', lane: 0, span: [0, 1] },
    ]);
    assert.throws(() => allocateCorridorTrack(grid, {
        kind: 'internal',
        rowGap: 0,
        span: [0, 1],
    }), {
        name: 'RangeError',
        message: /blocked.*complete column span/i,
    });
    assert.deepEqual({
        channels: grid.channels.map(channel => channel.tracks.trackCount),
        rowGaps: grid.rowGaps.map(gap => gap.tracks.trackCount),
        top: grid.outer.top.trackCount,
        bottom: grid.outer.bottom.trackCount,
    }, before);
});

test('rejects unknown and malformed corridor candidates atomically at runtime', () => {
    const grid = createRoutingGrid(unequalLayout(), { columnCount: 4 });
    const before = {
        channels: grid.channels.map(channel => channel.tracks.trackCount),
        rowGaps: grid.rowGaps.map(gap => gap.tracks.trackCount),
        top: grid.outer.top.trackCount,
        bottom: grid.outer.bottom.trackCount,
    };
    const invalidCandidates = [
        { kind: 'not-a-corridor', lane: 1, span: [0, 1] },
        { kind: 'outer-top', lane: 0 },
        { kind: 'internal', rowGap: 0, span: '0,1' },
        null,
    ];

    for (const candidate of invalidCandidates) {
        assert.throws(
            () => allocateCorridorTrack(
                grid,
                candidate as unknown as CorridorCandidate
            ),
            {
                name: 'RangeError',
                message: /corridor candidate/i,
            }
        );
        assert.deepEqual({
            channels: grid.channels.map(channel => channel.tracks.trackCount),
            rowGaps: grid.rowGaps.map(gap => gap.tracks.trackCount),
            top: grid.outer.top.trackCount,
            bottom: grid.outer.bottom.trackCount,
        }, before);
    }
});

test('allocates from one snapshot of a time-varying internal candidate', () => {
    const grid = createRoutingGrid([
        routingNode('c0-upper', 0, 0, 100, 40),
        routingNode('c0-middle', 0, 1, 100, 40),
        routingNode('c0-lower', 0, 2, 100, 40),
        routingNode('blocking-upper', 1, 0, 100, 40, 2),
        routingNode('c1-middle', 1, 1, 100, 40),
        routingNode('c1-lower', 1, 2, 100, 40),
    ], { columnCount: 2 });
    assert.deepEqual(planCorridors(grid, 0, 1), [
        { kind: 'internal', rowGap: 1, span: [0, 1] },
        { kind: 'outer-top', lane: 0, span: [0, 1] },
        { kind: 'outer-bottom', lane: 0, span: [0, 1] },
    ]);
    let kindReads = 0;
    let rowGapReads = 0;
    let spanReads = 0;
    const candidate = {
        get kind(): 'internal' {
            kindReads += 1;
            return 'internal';
        },
        get rowGap(): number {
            rowGapReads += 1;
            return rowGapReads <= 4 ? 1 : 0;
        },
        get span(): readonly [number, number] {
            spanReads += 1;
            return [0, 1];
        },
    };

    const handle = allocateCorridorTrack(
        grid,
        candidate as unknown as CorridorCandidate
    );

    assert.deepEqual(handle, {
        kind: 'internal',
        rowGap: 1,
        track: 0,
        span: [0, 1],
    });
    assert.equal(kindReads, 1);
    assert.equal(rowGapReads, 1);
    assert.equal(spanReads, 1);
    assert.deepEqual(
        grid.rowGaps.map(gap => gap.tracks.trackCount),
        [0, 1]
    );
});

test('allocates outer tracks from one kind lane and span snapshot', () => {
    const grid = createRoutingGrid([
        routingNode('left', 0, 0, 100, 40),
        routingNode('right', 1, 0, 100, 40),
        routingNode('far-right', 2, 0, 100, 40),
    ], { columnCount: 3 });
    const reads: Record<string, number> = {};
    const span = [0, 1];
    Object.defineProperties(span, {
        0: {
            configurable: true,
            enumerable: true,
            get(): number {
                reads['span.0'] = (reads['span.0'] ?? 0) + 1;
                return reads['span.0'] === 1 ? 0 : 1;
            },
        },
        1: {
            configurable: true,
            enumerable: true,
            get(): number {
                reads['span.1'] = (reads['span.1'] ?? 0) + 1;
                return reads['span.1'] === 1 ? 1 : 2;
            },
        },
    });
    const candidate = {
        get kind(): 'outer-top' | 'outer-bottom' {
            reads.kind = (reads.kind ?? 0) + 1;
            return reads.kind === 1 ? 'outer-top' : 'outer-bottom';
        },
        get lane(): number {
            reads.lane = (reads.lane ?? 0) + 1;
            return reads.lane === 1 ? 0 : 1;
        },
        get span(): number[] {
            reads.span = (reads.span ?? 0) + 1;
            return span;
        },
    };

    const handle = allocateCorridorTrack(
        grid,
        candidate as unknown as CorridorCandidate
    );

    assert.deepEqual(handle, {
        kind: 'outer-top',
        lane: 0,
        span: [0, 1],
    });
    assert.deepEqual(reads, {
        kind: 1,
        lane: 1,
        span: 1,
        'span.0': 1,
        'span.1': 1,
    });
    assert.equal(grid.outer.top.trackCount, 1);
    assert.equal(grid.outer.bottom.trackCount, 0);
});

test('rejects throwing candidate getters and outer track arguments atomically', () => {
    const grid = createRoutingGrid([
        routingNode('only', 0, 0, 100, 40),
    ], { columnCount: 1 });
    const before = {
        top: grid.outer.top.trackCount,
        bottom: grid.outer.bottom.trackCount,
    };
    const thrown = new Error('candidate getter failed');
    const throwingCandidate = Object.defineProperties({}, {
        kind: {
            get(): never {
                throw thrown;
            },
        },
        span: { value: [0, 0] },
    });
    assert.throws(
        () => allocateCorridorTrack(
            grid,
            throwingCandidate as unknown as CorridorCandidate
        ),
        error => error === thrown
    );
    const outer = planCorridors(grid, 0, 0)
        .find(candidate => candidate.kind === 'outer-top');
    assert.ok(outer);
    assert.throws(
        () => (allocateCorridorTrack as unknown as (
            target: RoutingGrid,
            candidate: CorridorCandidate,
            track: number
        ) => unknown)(grid, outer, 0),
        {
            name: 'RangeError',
            message: /outer.*explicit track/i,
        }
    );
    assert.deepEqual({
        top: grid.outer.top.trackCount,
        bottom: grid.outer.bottom.trackCount,
    }, before);
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

test('realizes multiple tracks in stable exact-pitch order for every pool kind', () => {
    const grid = createRoutingGrid([
        routingNode('left-upper', 0, 0, 100, 40),
        routingNode('left-lower', 0, 1, 100, 40),
        routingNode('middle-upper', 1, 0, 120, 40),
        routingNode('middle-lower', 1, 1, 120, 40),
        routingNode('right-upper', 2, 0, 100, 40),
        routingNode('right-lower', 2, 1, 100, 40),
    ], { columnCount: 3 });
    const channelHandles = Array.from(
        { length: 3 },
        () => allocateChannelTrack(grid, 0)
    );
    const internal = planCorridors(grid, 0, 2, 0)
        .find(candidate => candidate.kind === 'internal');
    assert.ok(internal);
    const internalHandles = Array.from(
        { length: 3 },
        () => allocateCorridorTrack(grid, internal)
    );
    const topHandles = Array.from({ length: 3 }, () => {
        const candidate = planCorridors(grid, 0, 2, 0)
            .find(corridor => corridor.kind === 'outer-top');
        assert.ok(candidate);
        const handle = allocateCorridorTrack(grid, candidate);
        if (handle.kind === 'internal') assert.fail('expected an outer track');
        return handle;
    });
    const bottomHandles = Array.from({ length: 2 }, () => {
        const candidate = planCorridors(grid, 0, 2, 0)
            .find(corridor => corridor.kind === 'outer-bottom');
        assert.ok(candidate);
        const handle = allocateCorridorTrack(grid, candidate);
        if (handle.kind === 'internal') assert.fail('expected an outer track');
        return handle;
    });

    assert.deepEqual(channelHandles.map(handle => handle.track), [0, 1, 2]);
    assert.deepEqual(internalHandles.map(handle => handle.track), [0, 1, 2]);
    assert.deepEqual(topHandles.map(handle => handle.lane), [0, 1, 2]);
    assert.deepEqual(bottomHandles.map(handle => handle.lane), [0, 1]);

    const realized = realizeRoutingGrid(grid);
    assert.equal(
        realized.channels[0].width,
        ROUTING_GRID_DEFAULTS.minimumChannelWidth
            + 3 * ROUTING_GRID_DEFAULTS.trackPitch
    );
    assert.equal(
        realized.rowGaps[0].height,
        ROUTING_GRID_DEFAULTS.minimumRowGap
            + 3 * ROUTING_GRID_DEFAULTS.trackPitch
    );
    assert.equal(
        realized.outer.top.height,
        ROUTING_GRID_DEFAULTS.minimumOuterMargin
            + 3 * ROUTING_GRID_DEFAULTS.trackPitch
    );
    assert.equal(
        realized.outer.bottom.height,
        ROUTING_GRID_DEFAULTS.minimumOuterMargin
            + 2 * ROUTING_GRID_DEFAULTS.trackPitch
    );
    assert.deepEqual(
        realized.channels[0].trackX.slice(1).map((value, index) =>
            value - realized.channels[0].trackX[index]
        ),
        [ROUTING_GRID_DEFAULTS.trackPitch, ROUTING_GRID_DEFAULTS.trackPitch]
    );
    assert.deepEqual(
        realized.rowGaps[0].trackY.slice(1).map((value, index) =>
            value - realized.rowGaps[0].trackY[index]
        ),
        [ROUTING_GRID_DEFAULTS.trackPitch, ROUTING_GRID_DEFAULTS.trackPitch]
    );
    assert.deepEqual(
        realized.outer.top.trackY.slice(1).map((value, index) =>
            value - realized.outer.top.trackY[index]
        ),
        [-ROUTING_GRID_DEFAULTS.trackPitch, -ROUTING_GRID_DEFAULTS.trackPitch]
    );
    assert.deepEqual(
        realized.outer.bottom.trackY.slice(1).map((value, index) =>
            value - realized.outer.bottom.trackY[index]
        ),
        [ROUTING_GRID_DEFAULTS.trackPitch]
    );
});

function realizedDemandVariant(
    addMiddleChannelTrack: boolean,
    addLowerRowGapTrack: boolean
) {
    const nodes = Array.from({ length: 4 }, (_, column) =>
        Array.from({ length: 3 }, (_, row) =>
            routingNode(
                `node-${column}-${row}`,
                column,
                row,
                100 + column * 20 + row * 2,
                40 + row * 10
            )
        )
    ).flat();
    const grid = createRoutingGrid(nodes, { columnCount: 4 });
    allocateChannelTrack(grid, 0);
    allocateChannelTrack(grid, 2);
    const upperGap = planCorridors(grid, 0, 3, 0)
        .find(candidate => candidate.kind === 'internal'
            && candidate.rowGap === 0);
    assert.ok(upperGap);
    allocateCorridorTrack(grid, upperGap);
    if (addMiddleChannelTrack) allocateChannelTrack(grid, 1);
    if (addLowerRowGapTrack) {
        const lowerGap = planCorridors(grid, 0, 3, 1)
            .find(candidate => candidate.kind === 'internal'
                && candidate.rowGap === 1);
        assert.ok(lowerGap);
        allocateCorridorTrack(grid, lowerGap);
    }
    return realizeRoutingGrid(grid);
}

test('moves nothing left of an affected channel or above an affected row gap', () => {
    const baseline = realizedDemandVariant(false, false);
    const widerMiddleChannel = realizedDemandVariant(true, false);
    const tallerLowerGap = realizedDemandVariant(false, true);

    assert.deepEqual(
        widerMiddleChannel.columns.slice(0, 2),
        baseline.columns.slice(0, 2)
    );
    assert.deepEqual(widerMiddleChannel.channels[0], baseline.channels[0]);
    assert.deepEqual(
        widerMiddleChannel.nodes.filter(node => node.column <= 1),
        baseline.nodes.filter(node => node.column <= 1)
    );
    assert.deepEqual(
        widerMiddleChannel.channels.map(channel => channel.width),
        [
            baseline.channels[0].width,
            baseline.channels[1].width + ROUTING_GRID_DEFAULTS.trackPitch,
            baseline.channels[2].width,
        ]
    );

    assert.deepEqual(tallerLowerGap.rowGaps[0], baseline.rowGaps[0]);
    assert.deepEqual(
        tallerLowerGap.nodes.filter(node => node.row <= 1),
        baseline.nodes.filter(node => node.row <= 1)
    );
    assert.deepEqual(
        tallerLowerGap.rowGaps.map(gap => gap.height),
        [
            baseline.rowGaps[0].height,
            baseline.rowGaps[1].height + ROUTING_GRID_DEFAULTS.trackPitch,
        ]
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

test('deep-freezes realized geometry and abstract handles without cache mutation', () => {
    const grid = createRoutingGrid(unequalLayout(), { columnCount: 4 });
    const channelHandle = allocateChannelTrack(grid, 0);
    const internal = planCorridors(grid, 0, 3, 0)
        .find(candidate => candidate.kind === 'internal');
    assert.ok(internal);
    const corridorHandle = allocateCorridorTrack(grid, internal);
    const realized = realizeRoutingGrid(grid);
    const snapshot = structuredClone(realized);

    for (const value of [
        realized,
        realized.metrics,
        realized.columns,
        realized.columns[0],
        realized.channels,
        realized.channels[0],
        realized.channels[0].trackX,
        realized.rowGaps,
        realized.rowGaps[0],
        realized.rowGaps[0].trackY,
        realized.outer,
        realized.outer.top,
        realized.outer.top.trackY,
        realized.nodes,
        realized.nodes[0],
        realized.nodes[0].bounds,
        realized.nodes[0].pinAnchors,
        realized.nodes[0].pinAnchors[0],
        realized.nodes[0].pinAnchors[0].point,
        channelHandle,
        corridorHandle,
        corridorHandle.span,
    ]) {
        assert.equal(Object.isFrozen(value), true);
    }
    assert.throws(() => {
        (realized.nodes[0].bounds as { x: number }).x = 999;
    }, TypeError);
    assert.throws(() => {
        (realized.channels[0].trackX as number[]).push(999);
    }, TypeError);
    assert.throws(() => {
        (corridorHandle.span as [number, number])[0] = 999;
    }, TypeError);
    assert.strictEqual(realizeRoutingGrid(grid), realized);
    assert.deepEqual(realized, snapshot);
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

test('reads every external create-grid field once before normalization', () => {
    const reads: Record<string, number> = {};
    const pin = Object.defineProperties({}, {
        id: { enumerable: true, get: countedGetter(reads, 'pin.id', 'pin') },
        x: { enumerable: true, get: countedGetter(reads, 'pin.x', 100) },
        y: { enumerable: true, get: countedGetter(reads, 'pin.y', 20) },
    });
    const pins = [pin];
    let pinElementReads = 0;
    Object.defineProperty(pins, '0', {
        configurable: true,
        enumerable: true,
        get(): object {
            pinElementReads += 1;
            return pin;
        },
    });
    const size = Object.defineProperties({}, {
        width: { enumerable: true, get: countedGetter(reads, 'size.width', 100) },
        height: { enumerable: true, get: countedGetter(reads, 'size.height', 40) },
    });
    const node = Object.defineProperties({}, {
        id: { enumerable: true, get: countedGetter(reads, 'node.id', 'node') },
        column: { enumerable: true, get: countedGetter(reads, 'node.column', 0) },
        order: { enumerable: true, get: countedGetter(reads, 'node.order', 0) },
        yOffset: { enumerable: true, get: countedGetter(reads, 'node.yOffset', 0) },
        size: { enumerable: true, get: countedGetter(reads, 'node.size', size) },
        pinAnchors: {
            enumerable: true,
            get: countedGetter(reads, 'node.pinAnchors', pins),
        },
    });
    const nodes = [node];
    let nodeElementReads = 0;
    Object.defineProperty(nodes, '0', {
        configurable: true,
        enumerable: true,
        get(): object {
            nodeElementReads += 1;
            return node;
        },
    });
    const options = Object.defineProperties({}, {
        columnCount: {
            enumerable: true,
            get: countedGetter(reads, 'options.columnCount', 1),
        },
        gridStep: {
            enumerable: true,
            get: countedGetter(reads, 'options.gridStep', 2),
        },
        pinEscape: {
            enumerable: true,
            get: countedGetter(reads, 'options.pinEscape', 12),
        },
        safetyMargin: {
            enumerable: true,
            get: countedGetter(reads, 'options.safetyMargin', 4),
        },
        trackPitch: {
            enumerable: true,
            get: countedGetter(reads, 'options.trackPitch', 12),
        },
        minimumChannelWidth: {
            enumerable: true,
            get: countedGetter(reads, 'options.minimumChannelWidth', 32),
        },
        minimumRowGap: {
            enumerable: true,
            get: countedGetter(reads, 'options.minimumRowGap', 32),
        },
        minimumOuterMargin: {
            enumerable: true,
            get: countedGetter(reads, 'options.minimumOuterMargin', 16),
        },
    });

    const grid = createRoutingGrid(
        nodes as unknown as RoutingGridNodeInput[],
        options
    );
    const realized = realizeRoutingGrid(grid);

    assert.equal(realized.nodes[0].bounds.width, 100);
    assert.equal(realized.nodes[0].pinAnchors[0].point.x, 100);
    assert.deepEqual(reads, {
        'options.columnCount': 1,
        'options.gridStep': 1,
        'options.pinEscape': 1,
        'options.safetyMargin': 1,
        'options.trackPitch': 1,
        'options.minimumChannelWidth': 1,
        'options.minimumRowGap': 1,
        'options.minimumOuterMargin': 1,
        'node.id': 1,
        'node.column': 1,
        'node.order': 1,
        'node.yOffset': 1,
        'node.size': 1,
        'node.pinAnchors': 1,
        'size.width': 1,
        'size.height': 1,
        'pin.id': 1,
        'pin.x': 1,
        'pin.y': 1,
    });
    assert.equal(nodeElementReads, 1);
    assert.equal(pinElementReads, 1);
});

test('rejects time-varying size getters from one consistent snapshot', () => {
    for (const changing of ['width', 'height'] as const) {
        let reads = 0;
        const size = {
            get width(): number {
                if (changing !== 'width') return 100;
                reads += 1;
                return reads === 1 ? 100 : 200;
            },
            get height(): number {
                if (changing !== 'height') return 40;
                reads += 1;
                return reads === 1 ? 40 : 100;
            },
        };
        const pin = changing === 'width'
            ? { id: 'outside', x: 150, y: 20 }
            : { id: 'outside', x: 50, y: 80 };

        assert.throws(() => createRoutingGrid([{
            id: changing,
            column: 0,
            order: 0,
            yOffset: 0,
            size,
            pinAnchors: [pin],
        }]), RangeError);
        assert.equal(reads, 1);
    }
});

test('normalizes time-varying pin getters from their first values', () => {
    let xReads = 0;
    let yReads = 0;
    const pin = {
        id: 'pin',
        get x(): number {
            xReads += 1;
            return xReads === 1 ? 50 : 150;
        },
        get y(): number {
            yReads += 1;
            return yReads === 1 ? 20 : 80;
        },
    };
    const grid = createRoutingGrid([{
        id: 'node',
        column: 0,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 40 },
        pinAnchors: [pin],
    }]);

    const realized = realizeRoutingGrid(grid);
    assert.equal(xReads, 1);
    assert.equal(yReads, 1);
    assert.deepEqual(realized.nodes[0].pinAnchors[0].point, {
        x: 50,
        y: ROUTING_GRID_DEFAULTS.minimumOuterMargin + 20,
    });
});

test('isolates the routing grid from mutations after input snapshotting', () => {
    const pin = { id: 'right', x: 100, y: 20 };
    const size = { width: 100, height: 40 };
    const node: RoutingGridNodeInput = {
        id: 'original',
        column: 0,
        order: 0,
        yOffset: 0,
        size,
        pinAnchors: [pin],
    };
    const nodes = [node];
    const options = { columnCount: 1 };
    const grid = createRoutingGrid(nodes, options);

    (node as { id: string }).id = 'mutated';
    size.width = 200;
    pin.x = 200;
    nodes.push(routingNode('late', 0, 1, 100, 40));
    options.columnCount = 2;

    const realized = realizeRoutingGrid(grid);
    assert.equal(grid.columns.length, 1);
    assert.deepEqual(realized.nodes, [{
        id: 'original',
        column: 0,
        row: 0,
        bounds: {
            x: 0,
            y: ROUTING_GRID_DEFAULTS.minimumOuterMargin,
            width: 100,
            height: 40,
        },
        pinAnchors: [{
            id: 'right',
            point: {
                x: 100,
                y: ROUTING_GRID_DEFAULTS.minimumOuterMargin + 20,
            },
        }],
    }]);
});

test('supports track pitch whose half remains aligned to a custom grid step', () => {
    const grid = createRoutingGrid([
        routingNode('left', 0, 0, 100, 40),
        routingNode('right', 1, 0, 100, 40),
    ], {
        columnCount: 2,
        gridStep: 4,
        trackPitch: 8,
        pinEscape: 12,
        safetyMargin: 4,
        minimumChannelWidth: 32,
        minimumRowGap: 32,
        minimumOuterMargin: 16,
    });
    allocateChannelTrack(grid, 0);

    const realized = realizeRoutingGrid(grid);
    for (const value of [
        realized.width,
        realized.height,
        ...realized.channels.flatMap(channel => [
            channel.x,
            channel.width,
            ...channel.trackX,
        ]),
        ...realized.nodes.flatMap(node => [
            node.bounds.x,
            node.bounds.y,
            node.bounds.width,
            node.bounds.height,
        ]),
    ]) {
        assert.equal(value % 4, 0);
    }
});

test('preflights near-safe cumulative track demand atomically for every pool', () => {
    const nearSafePitch = Math.floor(
        (Number.MAX_SAFE_INTEGER - 1_024) / 4
    ) * 4;
    const options = { trackPitch: nearSafePitch };

    const channelGrid = createRoutingGrid([
        routingNode('left', 0, 0, 100, 40),
        routingNode('right', 1, 0, 100, 40),
    ], { ...options, columnCount: 2 });
    allocateChannelTrack(channelGrid, 0);
    assert.throws(() => allocateChannelTrack(channelGrid, 0), {
        name: 'RangeError',
        message: /finite integer routing grid/i,
    });
    assert.equal(channelGrid.channels[0].tracks.trackCount, 1);
    const channelRealized = realizeRoutingGrid(channelGrid);
    assert.equal(Number.isSafeInteger(channelRealized.width), true);
    assert.equal(channelRealized.width % ROUTING_GRID_DEFAULTS.gridStep, 0);
    assert.equal(
        channelRealized.channels[0].width,
        ROUTING_GRID_DEFAULTS.minimumChannelWidth + nearSafePitch
    );

    const rowGrid = createRoutingGrid([
        routingNode('upper', 0, 0, 100, 40),
        routingNode('lower', 0, 1, 100, 40),
    ], { ...options, columnCount: 1 });
    const internal = planCorridors(rowGrid, 0, 0, 0)
        .find(candidate => candidate.kind === 'internal');
    assert.ok(internal);
    allocateCorridorTrack(rowGrid, internal);
    assert.throws(() => allocateCorridorTrack(rowGrid, internal), RangeError);
    assert.equal(rowGrid.rowGaps[0].tracks.trackCount, 1);

    const outerGrid = createRoutingGrid([
        routingNode('only', 0, 0, 100, 40),
    ], { ...options, columnCount: 1 });
    const firstTop = planCorridors(outerGrid, 0, 0)
        .find(candidate => candidate.kind === 'outer-top');
    assert.ok(firstTop);
    allocateCorridorTrack(outerGrid, firstTop);
    const overflowingTop = planCorridors(outerGrid, 0, 0)
        .find(candidate => candidate.kind === 'outer-top');
    assert.ok(overflowingTop);
    assert.throws(
        () => allocateCorridorTrack(outerGrid, overflowingTop),
        RangeError
    );
    assert.equal(outerGrid.outer.top.trackCount, 1);
    assert.equal(outerGrid.outer.bottom.trackCount, 0);
});

test('handles maximum track index without allocating intermediate handles', () => {
    const grid = createRoutingGrid([
        routingNode('left', 0, 0, 100, 40),
        routingNode('right', 1, 0, 100, 40),
    ], { columnCount: 2 });

    const handle = allocateChannelTrack(grid, 0, MAX_ROUTING_TRACKS - 1);
    assert.equal(handle.track, MAX_ROUTING_TRACKS - 1);
    assert.equal(grid.channels[0].tracks.trackCount, MAX_ROUTING_TRACKS);
    assert.throws(() => allocateChannelTrack(grid, 0), RangeError);
    assert.equal(grid.channels[0].tracks.trackCount, MAX_ROUTING_TRACKS);
});

test('keeps representable near-safe node geometry aligned and rejects overflow', () => {
    const nearSafeEven = Math.floor(
        (Number.MAX_SAFE_INTEGER - 1_024) / 2
    ) * 2;
    const wide = createRoutingGrid([{
        ...routingNode('wide', 0, 0, 100, 40),
        size: { width: nearSafeEven, height: 40 },
        pinAnchors: [],
    }]);
    const wideRealized = realizeRoutingGrid(wide);
    assert.equal(wideRealized.width, nearSafeEven);
    assert.equal(Number.isSafeInteger(wideRealized.width), true);
    assert.equal(wideRealized.width % ROUTING_GRID_DEFAULTS.gridStep, 0);

    const low = createRoutingGrid([
        routingNode('low', 0, 0, 100, 40, nearSafeEven),
    ]);
    const lowRealized = realizeRoutingGrid(low);
    assert.equal(Number.isSafeInteger(lowRealized.height), true);
    assert.equal(lowRealized.height % ROUTING_GRID_DEFAULTS.gridStep, 0);

    const halfWidth = Math.floor(Number.MAX_SAFE_INTEGER / 4) * 2;
    const overflowingWidth = createRoutingGrid([
        routingNode('left-wide', 0, 0, halfWidth, 40),
        routingNode('right-wide', 1, 0, halfWidth, 40),
    ], { columnCount: 2 });
    const before = overflowingWidth.channels.map(
        channel => channel.tracks.trackCount
    );
    assert.throws(() => realizeRoutingGrid(overflowingWidth), RangeError);
    assert.deepEqual(
        overflowingWidth.channels.map(channel => channel.tracks.trackCount),
        before
    );

    const overflowingOffsetInput = [
        routingNode(
            'too-low',
            0,
            0,
            100,
            40,
            Number.MAX_SAFE_INTEGER - 1
        ),
    ];
    const original = structuredClone(overflowingOffsetInput);
    assert.throws(
        () => createRoutingGrid(overflowingOffsetInput),
        RangeError
    );
    assert.deepEqual(overflowingOffsetInput, original);
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
