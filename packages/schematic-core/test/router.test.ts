import assert from 'node:assert/strict';
import test from 'node:test';

import {
    routeNetworks,
    segmentIntersectsRectangleInterior,
    simplifySegments,
    type RoutingGridNodeInput,
    type RoutingNetworkRequest,
    type RoutedSchematic,
} from '../src';
import {
    routeFixture,
    routingNode,
    threeColumnFixture,
} from './fixtures';

if (false) {
    const routed = null as unknown as RoutedSchematic;
    // @ts-expect-error routed arrays are readonly
    routed.networks.push(routed.networks[0]);
    // @ts-expect-error routed segment objects are readonly
    routed.networks[0].segments[0].networkId = 'mutated';
    // @ts-expect-error routed endpoint snapshots are readonly
    routed.networks[0].paths[0].from.nodeId = 'mutated';
}

test('routes a non-adjacent connection as H-V-H-V-H', () => {
    const route = routeFixture(threeColumnFixture());

    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal', 'vertical', 'horizontal', 'vertical', 'horizontal']
    );
});

test('keeps every routed segment out of every module interior', () => {
    const route = routeFixture(threeColumnFixture());

    for (const segment of route.networks[0].segments) {
        for (const node of route.grid.nodes) {
            assert.equal(
                segmentIntersectsRectangleInterior(segment, node.bounds),
                false,
                `${segment.orientation} segment intersects ${node.id}`
            );
        }
    }
});

test('separates different networks on a shared adjacent channel', () => {
    const route = routeFixture({
        nodes: [
            routingNode('left-upper', 0, 0),
            routingNode('left-lower', 0, 1),
            routingNode('right-upper', 1, 0),
            routingNode('right-lower', 1, 1),
        ],
        networks: [
            {
                id: 'network:down',
                terminals: [
                    { nodeId: 'left-upper', pinId: 'right', role: 'driver' },
                    { nodeId: 'right-lower', pinId: 'left', role: 'load' },
                ],
            },
            {
                id: 'network:up',
                terminals: [
                    { nodeId: 'left-lower', pinId: 'right', role: 'driver' },
                    { nodeId: 'right-upper', pinId: 'left', role: 'load' },
                ],
            },
        ],
    });

    const verticalXs = route.networks.map(network => {
        const segment = network.paths[0].segments.find(
            candidate => candidate.orientation === 'vertical'
        );
        assert.ok(segment && segment.orientation === 'vertical');
        return segment.x;
    });
    assert.equal(new Set(verticalXs).size, 2);
    assert.equal(route.grid.channels[0].trackX.length, 4);
    assert.equal(route.networks.every(network =>
        network.paths[0].segments.map(segment => segment.orientation).join('-')
            === 'horizontal-vertical-horizontal-vertical-horizontal'
    ), true);
});

test('routes fan-out as one tree and reuses the same-network trunk', () => {
    const route = routeFixture({
        nodes: [
            routingNode('source', 0, 0),
            routingNode('left-lower', 0, 1),
            routingNode('middle-upper', 1, 0),
            routingNode('middle-lower', 1, 1),
            routingNode('sink-upper', 2, 0),
            routingNode('sink-lower', 2, 1),
        ],
        networks: [{
            id: 'network:fanout',
            terminals: [
                { nodeId: 'sink-lower', pinId: 'left', role: 'load' },
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink-upper', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.equal(route.networks[0].paths.length, 2);
    assert.equal(route.grid.channels[0].trackX.length, 1);
    assert.equal(route.grid.rowGaps[0].trackY.length, 1);
    assert.ok(route.networks[0].segments.length
        < route.networks[0].paths.flatMap(path => path.segments).length);
});

test('reuses one adjacent channel trunk for same-network fan-out', () => {
    const route = routeFixture({
        nodes: [
            routingNode('source', 0, 0),
            routingNode('left-middle', 0, 1),
            routingNode('left-lower', 0, 2),
            routingNode('right-upper', 1, 0),
            routingNode('sink-a', 1, 1),
            routingNode('sink-b', 1, 2),
        ],
        networks: [{
            id: 'network:adjacent-fanout',
            terminals: [
                { nodeId: 'sink-b', pinId: 'left', role: 'load' },
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink-a', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.equal(route.networks[0].paths.length, 2);
    assert.equal(route.grid.channels[0].trackX.length, 1);
    assert.equal(route.networks[0].paths.every(path =>
        path.segments.map(segment => segment.orientation).join('-')
            === 'horizontal-vertical-horizontal'
    ), true);
});

test('connects multi-driver networks without driver-load Cartesian expansion', () => {
    const route = routeFixture({
        nodes: [
            routingNode('driver-a', 0, 0),
            routingNode('driver-b', 0, 1),
            routingNode('middle-a', 1, 0),
            routingNode('middle-b', 1, 1),
            routingNode('load-a', 2, 0),
            routingNode('load-b', 2, 1),
        ],
        networks: [{
            id: 'network:multi-driver',
            terminals: [
                { nodeId: 'load-b', pinId: 'left', role: 'load' },
                { nodeId: 'driver-b', pinId: 'right', role: 'driver' },
                { nodeId: 'load-a', pinId: 'left', role: 'load' },
                { nodeId: 'driver-a', pinId: 'right', role: 'driver' },
            ],
        }],
    });

    assert.equal(route.networks[0].paths.length, 3);
    assert.deepEqual(new Set(route.networks[0].paths.flatMap(path => [
        `${path.from.nodeId}\0${path.from.pinId}`,
        `${path.to.nodeId}\0${path.to.pinId}`,
    ])), new Set([
        'driver-a\0right',
        'driver-b\0right',
        'load-a\0left',
        'load-b\0left',
    ]));
});

test('removes zero stages and consecutive redundant bends from every path', () => {
    const route = routeFixture(threeColumnFixture());

    for (const path of route.networks.flatMap(network => network.paths)) {
        path.segments.forEach((segment, index) => {
            assert.notEqual(
                segment.orientation === 'horizontal'
                    ? segment.x1
                    : segment.y1,
                segment.orientation === 'horizontal'
                    ? segment.x2
                    : segment.y2
            );
            if (index > 0) {
                assert.notEqual(
                    segment.orientation,
                    path.segments[index - 1].orientation
                );
            }
        });
    }
});

test('routes backward data flow only through an outer feedback lane', () => {
    const route = routeFixture({
        nodes: [
            routingNode('load', 0, 0),
            routingNode('middle', 1, 0),
            routingNode('driver', 2, 0),
        ],
        networks: [{
            id: 'network:feedback',
            terminals: [
                { nodeId: 'driver', pinId: 'right', role: 'driver' },
                { nodeId: 'load', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.equal(route.networks[0].feedback, true);
    assert.equal(route.grid.rowGaps.every(gap => gap.trackY.length === 0), true);
    assert.equal(
        route.grid.outer.top.trackY.length + route.grid.outer.bottom.trackY.length,
        1
    );
    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal', 'vertical', 'horizontal', 'vertical', 'horizontal']
    );
    for (const segment of route.networks[0].segments) {
        assert.equal(route.grid.nodes.some(node =>
            segmentIntersectsRectangleInterior(segment, node.bounds)
        ), false);
    }
});

test('treats a same-column driver-load network as feedback', () => {
    const route = routeFixture({
        nodes: [
            routingNode('driver', 0, 0),
            routingNode('load', 0, 1),
        ],
        networks: [{
            id: 'network:scc',
            terminals: [
                { nodeId: 'driver', pinId: 'right', role: 'driver' },
                { nodeId: 'load', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.equal(route.networks[0].feedback, true);
    assert.equal(
        route.grid.outer.top.trackY.length + route.grid.outer.bottom.trackY.length,
        1
    );
});

test('balances equal-cost feedback networks across top then bottom lanes', () => {
    const twoPinNode = (id: string, column: number) => ({
        id,
        column,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 40 },
        pinAnchors: [
            { id: 'left-a', x: 0, y: 16 },
            { id: 'left-b', x: 0, y: 24 },
            { id: 'right-a', x: 100, y: 16 },
            { id: 'right-b', x: 100, y: 24 },
        ],
    });
    const route = routeFixture({
        nodes: [twoPinNode('load', 0), twoPinNode('driver', 1)],
        networks: [
            {
                id: 'network:a',
                terminals: [
                    { nodeId: 'driver', pinId: 'right-a', role: 'driver' },
                    { nodeId: 'load', pinId: 'left-a', role: 'load' },
                ],
            },
            {
                id: 'network:b',
                terminals: [
                    { nodeId: 'driver', pinId: 'right-b', role: 'driver' },
                    { nodeId: 'load', pinId: 'left-b', role: 'load' },
                ],
            },
        ],
    });

    assert.equal(route.grid.outer.top.trackY.length, 1);
    assert.equal(route.grid.outer.bottom.trackY.length, 1);
    const outerYs = route.networks.map(network => {
        const horizontal = network.paths[0].segments.find(segment =>
            segment.orientation === 'horizontal'
            && Math.abs(segment.x2 - segment.x1) > 100
        );
        assert.ok(horizontal && horizontal.orientation === 'horizontal');
        return horizontal.y;
    });
    assert.deepEqual(outerYs, [
        route.grid.outer.top.trackY[0],
        route.grid.outer.bottom.trackY[0],
    ]);
    assert.doesNotThrow(() => simplifySegments(
        route.networks.flatMap(network => network.segments)
    ));
});

test('uses distinct endpoint tracks when both ends share one channel', () => {
    const route = routeFixture({
        nodes: [
            routingNode('upper', 0, 0),
            routingNode('lower', 0, 1),
            routingNode('spacer', 1, 0),
        ],
        networks: [{
            id: 'network:same-channel',
            terminals: [
                { nodeId: 'upper', pinId: 'right', role: 'bidirectional' },
                { nodeId: 'lower', pinId: 'right', role: 'bidirectional' },
            ],
        }],
    });

    assert.equal(route.grid.channels[0].trackX.length, 2);
    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal', 'vertical', 'horizontal', 'vertical', 'horizontal']
    );
});

test('gives same-channel feedback endpoints distinct escapes to the outer lane', () => {
    const route = routeFixture({
        nodes: [
            routingNode('driver', 0, 0),
            routingNode('load', 0, 1),
            routingNode('spacer', 1, 0),
        ],
        networks: [{
            id: 'network:same-channel-feedback',
            terminals: [
                { nodeId: 'driver', pinId: 'right', role: 'driver' },
                { nodeId: 'load', pinId: 'right', role: 'load' },
            ],
        }],
    });

    assert.equal(route.grid.channels[0].trackX.length, 2);
    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal', 'vertical', 'horizontal', 'vertical', 'horizontal']
    );
});

test('chooses the nearest stable internal corridor by terminal rows', () => {
    const route = routeFixture({
        nodes: [
            routingNode('upper-0', 0, 0),
            routingNode('middle-0', 0, 1),
            routingNode('source', 0, 2),
            routingNode('upper-1', 1, 0),
            routingNode('middle-1', 1, 1),
            routingNode('lower-1', 1, 2),
            routingNode('upper-2', 2, 0),
            routingNode('middle-2', 2, 1),
            routingNode('sink', 2, 2),
        ],
        networks: [{
            id: 'network:lower',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.equal(route.grid.rowGaps[0].trackY.length, 0);
    assert.equal(route.grid.rowGaps[1].trackY.length, 1);
});

test('breaks equal Manhattan corridor cost by stable corridor ID', () => {
    const route = routeFixture({
        nodes: [
            routingNode('upper-0', 0, 0),
            routingNode('source', 0, 1),
            routingNode('lower-0', 0, 2),
            routingNode('upper-1', 1, 0),
            routingNode('middle-1', 1, 1),
            routingNode('lower-1', 1, 2),
            routingNode('upper-2', 2, 0),
            routingNode('sink', 2, 1),
            routingNode('lower-2', 2, 2),
        ],
        networks: [{
            id: 'network:middle',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.equal(route.grid.rowGaps[0].trackY.length, 1);
    assert.equal(route.grid.rowGaps[1].trackY.length, 0);
});

test('falls back to an outer corridor when a middle column blocks the row gap', () => {
    const route = routeFixture({
        nodes: [
            routingNode('source', 0, 0),
            routingNode('lower-0', 0, 1),
            routingNode('blocker', 1, 0, 40, 2),
            routingNode('lower-1', 1, 1),
            routingNode('sink', 2, 0),
            routingNode('lower-2', 2, 1),
        ],
        networks: [{
            id: 'network:blocked',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.equal(route.grid.rowGaps[0].trackY.length, 0);
    assert.equal(
        route.grid.outer.top.trackY.length + route.grid.outer.bottom.trackY.length,
        1
    );
    for (const segment of route.networks[0].segments) {
        assert.equal(route.grid.nodes.some(node =>
            segmentIntersectsRectangleInterior(segment, node.bounds)
        ), false);
    }
});

test('returns explicit empty trees for empty and one-terminal networks', () => {
    const route = routeFixture({
        nodes: [routingNode('only', 0, 0)],
        networks: [
            { id: 'network:empty', terminals: [] },
            {
                id: 'network:one',
                terminals: [
                    { nodeId: 'only', pinId: 'right', role: 'bidirectional' },
                ],
            },
        ],
    });

    assert.deepEqual(route.networks.map(network => ({
        id: network.id,
        feedback: network.feedback,
        paths: network.paths,
        segments: network.segments,
    })), [
        { id: 'network:empty', feedback: false, paths: [], segments: [] },
        { id: 'network:one', feedback: false, paths: [], segments: [] },
    ]);
});

test('uses a stable tree root for a driverless bidirectional network', () => {
    const route = routeFixture({
        nodes: [
            routingNode('a', 0, 0),
            routingNode('b', 1, 0),
            routingNode('c', 2, 0),
        ],
        networks: [{
            id: 'network:driverless',
            terminals: [
                { nodeId: 'c', pinId: 'left', role: 'bidirectional' },
                { nodeId: 'b', pinId: 'left', role: 'bidirectional' },
                { nodeId: 'a', pinId: 'right', role: 'bidirectional' },
            ],
        }],
    });

    assert.equal(route.networks[0].feedback, false);
    assert.equal(route.networks[0].paths.length, 2);
    assert.equal(route.networks[0].paths.every(path =>
        path.from.nodeId === 'a' && path.from.pinId === 'right'
    ), true);
});

test('routes a one-column driverless network through an outer lane', () => {
    const route = routeFixture({
        nodes: [
            routingNode('upper', 0, 0),
            routingNode('lower', 0, 1),
        ],
        networks: [{
            id: 'network:one-column-driverless',
            terminals: [
                { nodeId: 'lower', pinId: 'left', role: 'bidirectional' },
                { nodeId: 'upper', pinId: 'right', role: 'bidirectional' },
            ],
        }],
    });

    assert.equal(route.networks[0].feedback, false);
    assert.equal(route.networks[0].paths.length, 1);
    assert.equal(
        route.grid.outer.top.trackY.length + route.grid.outer.bottom.trackY.length,
        1
    );
    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal', 'vertical', 'horizontal', 'vertical', 'horizontal']
    );
});

test('rejects malformed network terminals before allocating tracks', () => {
    const nodes = [
        routingNode('source', 0, 0),
        routingNode('sink', 1, 0),
        {
            ...routingNode('center-pin', 1, 1),
            pinAnchors: [{ id: 'center', x: 50, y: 20 }],
        },
    ];
    const invalidNetworks = [
        {
            id: 'network:duplicate-terminal',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'source', pinId: 'right', role: 'load' },
            ],
        },
        {
            id: 'network:unknown-node',
            terminals: [
                { nodeId: 'missing', pinId: 'right', role: 'driver' },
            ],
        },
        {
            id: 'network:unknown-pin',
            terminals: [
                { nodeId: 'source', pinId: 'missing', role: 'driver' },
            ],
        },
        {
            id: 'network:center-pin',
            terminals: [
                { nodeId: 'center-pin', pinId: 'center', role: 'driver' },
            ],
        },
        {
            id: 'network:invalid-role',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'invalid' },
            ],
        },
    ];

    for (const network of invalidNetworks) {
        assert.throws(() => routeNetworks(
            nodes,
            [network as unknown as RoutingNetworkRequest]
        ), RangeError);
    }
    assert.throws(() => routeNetworks(nodes, [
        { id: 'network:same', terminals: [] },
        { id: 'network:same', terminals: [] },
    ]), {
        name: 'RangeError',
        message: /network IDs must be unique strings/,
    });
});

test('snapshots external getters once and detaches routed terminal output', () => {
    const reads: Record<string, number> = {};
    const once = <T>(key: string, value: T): (() => T) => () => {
        reads[key] = (reads[key] ?? 0) + 1;
        return value;
    };
    const source = {
        get id() { return once('source.id', 'source')(); },
        get column() { return once('source.column', 0)(); },
        get order() { return once('source.order', 0)(); },
        get yOffset() { return once('source.yOffset', 0)(); },
        get size() {
            return once('source.size', { width: 100, height: 40 })();
        },
        get pinAnchors() {
            return once('source.pins', [
                { id: 'right', x: 100, y: 20 },
            ])();
        },
    } as RoutingGridNodeInput;
    const sink = {
        get id() { return once('sink.id', 'sink')(); },
        get column() { return once('sink.column', 1)(); },
        get order() { return once('sink.order', 0)(); },
        get yOffset() { return once('sink.yOffset', 0)(); },
        get size() {
            return once('sink.size', { width: 100, height: 40 })();
        },
        get pinAnchors() {
            return once('sink.pins', [
                { id: 'left', x: 0, y: 20 },
            ])();
        },
    } as RoutingGridNodeInput;
    const sourceTerminal = {
        nodeId: 'source', pinId: 'right', role: 'driver' as const,
    };
    const sinkTerminal = {
        nodeId: 'sink', pinId: 'left', role: 'load' as const,
    };
    const network = {
        get id() { return once('network.id', 'network:data')(); },
        get terminals() {
            return once('network.terminals', [sourceTerminal, sinkTerminal])();
        },
    } as RoutingNetworkRequest;

    const route = routeNetworks([source, sink], [network]);
    sourceTerminal.nodeId = 'mutated';
    sinkTerminal.pinId = 'mutated';

    assert.equal(
        Object.values(reads).every(count => count === 1),
        true,
        JSON.stringify(reads)
    );
    assert.equal(route.networks[0].paths[0].from.nodeId, 'source');
    assert.equal(route.networks[0].paths[0].to.pinId, 'left');
});

test('keeps network and path output stable across input permutations', () => {
    const nodes = [
        routingNode('left-upper', 0, 0),
        routingNode('left-lower', 0, 1),
        routingNode('right-upper', 1, 0),
        routingNode('right-lower', 1, 1),
    ];
    const networks: RoutingNetworkRequest[] = [
        {
            id: 'network:z',
            terminals: [
                { nodeId: 'right-lower', pinId: 'left', role: 'load' },
                { nodeId: 'left-upper', pinId: 'right', role: 'driver' },
            ],
        },
        {
            id: 'network:a',
            terminals: [
                { nodeId: 'right-upper', pinId: 'left', role: 'load' },
                { nodeId: 'left-lower', pinId: 'right', role: 'driver' },
            ],
        },
    ];

    const forward = routeNetworks(nodes, networks);
    const permuted = routeNetworks(nodes, [...networks].reverse().map(network => ({
        ...network,
        terminals: [...network.terminals].reverse(),
    })));

    assert.deepEqual(permuted, forward);
    assert.deepEqual(forward.networks.map(network => network.id), [
        'network:a',
        'network:z',
    ]);
});

test('rejects an unresolvable different-network collinear reservation conflict', () => {
    const twoPinsAtOnePoint = (
        id: string,
        column: number,
        side: 'left' | 'right'
    ): RoutingGridNodeInput => ({
        id,
        column,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 40 },
        pinAnchors: [
            { id: `${side}-a`, x: side === 'left' ? 0 : 100, y: 20 },
            { id: `${side}-b`, x: side === 'left' ? 0 : 100, y: 20 },
        ],
    });

    assert.throws(() => routeNetworks([
        twoPinsAtOnePoint('source', 0, 'right'),
        twoPinsAtOnePoint('sink', 1, 'left'),
    ], [
        {
            id: 'network:a',
            terminals: [
                { nodeId: 'source', pinId: 'right-a', role: 'driver' },
                { nodeId: 'sink', pinId: 'left-a', role: 'load' },
            ],
        },
        {
            id: 'network:b',
            terminals: [
                { nodeId: 'source', pinId: 'right-b', role: 'driver' },
                { nodeId: 'sink', pinId: 'left-b', role: 'load' },
            ],
        },
    ]), {
        name: 'RangeError',
        message: /reservation conflict/,
    });
});

test('returns a deeply frozen route snapshot', () => {
    const route = routeFixture(threeColumnFixture());
    const network = route.networks[0];
    const path = network.paths[0];

    for (const value of [
        route,
        route.networks,
        network,
        network.paths,
        path,
        path.from,
        path.to,
        path.segments,
        path.segments[0],
        network.segments,
        network.segments[0],
    ]) {
        assert.equal(Object.isFrozen(value), true);
    }
});

test('keeps large fan-out tree output and abstract demand linear', () => {
    const sinkCount = 1_024;
    const nodes = [
        routingNode('source', 0, 0),
        ...Array.from({ length: sinkCount }, (_, index) =>
            routingNode(`sink:${index}`, index + 1, 0)
        ),
    ];
    const route = routeNetworks(nodes, [{
        id: 'network:large-fanout',
        terminals: [
            { nodeId: 'source', pinId: 'right', role: 'driver' },
            ...Array.from({ length: sinkCount }, (_, index) => ({
                nodeId: `sink:${index}`,
                pinId: 'left',
                role: 'load' as const,
            })),
        ],
    }]);

    assert.equal(route.networks[0].paths.length, sinkCount);
    assert.equal(route.grid.outer.top.trackY.length, 1);
    assert.ok(route.grid.channels.reduce(
        (sum, channel) => sum + channel.trackX.length,
        0
    ) <= sinkCount + 1);
});

test('routes a clear aligned adjacent connection directly', () => {
    const route = routeFixture({
        nodes: [
            routingNode('source', 0, 0),
            routingNode('sink', 1, 0),
        ],
        networks: [{
            id: 'network:direct',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal']
    );
    assert.equal(route.grid.channels[0].trackX.length, 0);
});

test('routes an unaligned adjacent connection as H-V-H', () => {
    const route = routeFixture({
        nodes: [
            routingNode('source', 0, 0),
            routingNode('source-lower', 0, 1),
            routingNode('sink-upper', 1, 0),
            routingNode('sink', 1, 1),
        ],
        networks: [{
            id: 'network:adjacent',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal', 'vertical', 'horizontal']
    );
    assert.equal(route.grid.channels[0].trackX.length, 1);
});
