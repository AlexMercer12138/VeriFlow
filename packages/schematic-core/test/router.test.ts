import assert from 'node:assert/strict';
import test from 'node:test';

import * as schematicCore from '../src';
import {
    pinKey,
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
import {
    orderedPathSegments,
    probeChannelConstraintAssignmentForTesting,
    probeRoutingAllocationTransactionForTesting,
    routeNetworksForTesting,
} from '../src/routing/router';

function segmentContainsTestPoint(
    segment: RoutedSchematic['networks'][number]['segments'][number],
    point: Readonly<{ x: number; y: number }>
): boolean {
    return segment.orientation === 'horizontal'
        ? segment.y === point.y && point.x >= segment.x1 && point.x <= segment.x2
        : segment.x === point.x && point.y >= segment.y1 && point.y <= segment.y2;
}

function terminalPoint(
    route: RoutedSchematic,
    terminal: RoutingNetworkRequest['terminals'][number]
): Readonly<{ x: number; y: number }> {
    return route.grid.nodes.find(node => node.id === terminal.nodeId)!
        .pinAnchors.find(pin => pin.id === terminal.pinId)!.point;
}

function terminalLegX(
    route: RoutedSchematic,
    networkId: string,
    terminal: RoutingNetworkRequest['terminals'][number]
): number {
    const point = terminalPoint(route, terminal);
    const network = route.networks.find(item => item.id === networkId)!;
    const path = network.paths.find(candidate =>
        candidate.to.nodeId === terminal.nodeId
            && candidate.to.pinId === terminal.pinId
    ) ?? network.paths.find(candidate => candidate.from.kind === 'terminal'
        && candidate.from.nodeId === terminal.nodeId
        && candidate.from.pinId === terminal.pinId);
    assert.ok(path);
    const segment = path.segments.find(candidate =>
        candidate.orientation === 'horizontal'
            && candidate.y === point.y
            && (candidate.x1 === point.x || candidate.x2 === point.x));
    assert.ok(segment && segment.orientation === 'horizontal');
    return segment.x1 === point.x ? segment.x2 : segment.x1;
}

function assertEveryTerminalAnchorConnected(
    route: RoutedSchematic,
    networks: readonly RoutingNetworkRequest[]
): void {
    for (const request of networks) {
        const network = route.networks.find(item => item.id === request.id)!;
        for (const terminal of request.terminals) {
            const point = terminalPoint(route, terminal);
            assert.equal(
                network.segments.some(segment =>
                    segmentContainsTestPoint(segment, point)
                ),
                true,
                `${request.id}:${terminal.nodeId}:${terminal.pinId} is disconnected`
            );
        }
    }
}

function assertNoDifferentNetworkCollinearOverlap(route: RoutedSchematic): void {
    const segments = route.networks.flatMap(network => network.segments);
    for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1;
            rightIndex < segments.length;
            rightIndex += 1) {
            const left = segments[leftIndex];
            const right = segments[rightIndex];
            if (left.networkId === right.networkId
                || left.orientation !== right.orientation) continue;
            const overlap = left.orientation === 'horizontal'
                && right.orientation === 'horizontal'
                ? left.y === right.y
                    && Math.max(left.x1, right.x1) < Math.min(left.x2, right.x2)
                : left.orientation === 'vertical'
                    && right.orientation === 'vertical'
                    && left.x === right.x
                    && Math.max(left.y1, right.y1) < Math.min(left.y2, right.y2);
            assert.equal(
                overlap,
                false,
                `${left.networkId} overlaps ${right.networkId}`
            );
        }
    }
}

function assertEveryAllocatedTrackReferenced(route: RoutedSchematic): void {
    const segments = route.networks.flatMap(network => network.segments);
    const referencesX = (track: number): boolean => segments.some(segment =>
        segment.orientation === 'vertical'
            ? segment.x === track
            : segment.x1 === track || segment.x2 === track
    );
    const referencesY = (track: number): boolean => segments.some(segment =>
        segment.orientation === 'horizontal'
            ? segment.y === track
            : segment.y1 === track || segment.y2 === track
    );
    for (const channel of route.grid.channels) {
        assert.equal(channel.trackX.every(referencesX), true);
    }
    for (const gap of route.grid.rowGaps) {
        assert.equal(gap.trackY.every(referencesY), true);
    }
    assert.equal(route.grid.outer.top.trackY.every(referencesY), true);
    assert.equal(route.grid.outer.bottom.trackY.every(referencesY), true);
}

function assertOrderedPathTraversal(
    points: readonly Readonly<{ x: number; y: number }>[],
    segments: readonly RoutedSchematic['networks'][number]['segments'][number][]
): void {
    let current = points[0];
    for (const segment of segments) {
        if (segment.orientation === 'horizontal') {
            assert.equal(current.y, segment.y);
            assert.ok(current.x === segment.x1 || current.x === segment.x2);
            current = {
                x: current.x === segment.x1 ? segment.x2 : segment.x1,
                y: segment.y,
            };
        } else {
            assert.equal(current.x, segment.x);
            assert.ok(current.y === segment.y1 || current.y === segment.y2);
            current = {
                x: segment.x,
                y: current.y === segment.y1 ? segment.y2 : segment.y1,
            };
        }
    }
    assert.deepEqual(current, points[points.length - 1]);
    for (let index = 1; index < segments.length; index += 1) {
        assert.notEqual(
            segments[index - 1].orientation,
            segments[index].orientation
        );
    }
}

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

test('prefers a clear H-V-H shortcut across non-adjacent columns', () => {
    const route = routeFixture({
        nodes: [
            routingNode('source', 0, 0),
            routingNode('middle', 1, 0, 40, 80),
            routingNode('sink', 2, 0, 40, 80),
        ],
        networks: [{
            id: 'network:shortcut',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
        options: { columnCount: 3 },
    });

    assert.deepEqual(
        route.networks[0].paths[0].segments.map(segment => segment.orientation),
        ['horizontal', 'vertical', 'horizontal']
    );
    assert.equal(route.grid.rowGaps.every(gap => gap.trackY.length === 0), true);
    assert.equal(route.grid.outer.top.trackY.length, 0);
    assert.equal(route.grid.outer.bottom.trackY.length, 0);
    for (const segment of route.networks[0].segments) {
        assert.equal(route.grid.nodes.some(node =>
            segmentIntersectsRectangleInterior(segment, node.bounds)
        ), false);
    }
});

test('collapses a forward collinear point sequence in traversal order', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const segments = orderedPathSegments('network:points', points);

    assert.deepEqual(segments, [{
        orientation: 'horizontal',
        networkId: 'network:points',
        y: 0,
        x1: 0,
        x2: 20,
    }]);
    assertOrderedPathTraversal(points, segments);
});

test('collapses a collinear overshoot without retaining the far interval', () => {
    const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }];
    const segments = orderedPathSegments('network:points', points);

    assert.deepEqual(segments, [{
        orientation: 'horizontal',
        networkId: 'network:points',
        y: 0,
        x1: 0,
        x2: 10,
    }]);
    assertOrderedPathTraversal(points, segments);
});

test('removes a collinear round trip that ends at its start', () => {
    const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 0 }];
    const segments = orderedPathSegments('network:points', points);

    assert.deepEqual(segments, []);
    assertOrderedPathTraversal(points, segments);
});

test('removes duplicate points and redundant bends before materialization', () => {
    const points = [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 20 },
    ];
    const segments = orderedPathSegments('network:points', points);

    assert.deepEqual(segments.map(segment => segment.orientation), [
        'horizontal',
        'vertical',
    ]);
    assertOrderedPathTraversal(points, segments);
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
    assertEveryAllocatedTrackReferenced(route);
});

test('routes inverted adjacent connections as H-V-H when endpoint levels are distinct', () => {
    const node = (
        id: string,
        column: number,
        side: 'left' | 'right',
        pinYs: readonly [number, number]
    ): RoutingGridNodeInput => ({
        id,
        column,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 60 },
        pinAnchors: [
            { id: `${side}-upper`, x: side === 'left' ? 0 : 100, y: pinYs[0] },
            { id: `${side}-lower`, x: side === 'left' ? 0 : 100, y: pinYs[1] },
        ],
    });
    const route = routeNetworks(
        [
            node('left', 0, 'right', [10, 40]),
            node('right', 1, 'left', [20, 30]),
        ],
        [
            {
                id: 'network:falling',
                terminals: [
                    { nodeId: 'left', pinId: 'right-upper', role: 'driver' },
                    { nodeId: 'right', pinId: 'left-lower', role: 'load' },
                ],
            },
            {
                id: 'network:rising',
                terminals: [
                    { nodeId: 'left', pinId: 'right-lower', role: 'driver' },
                    { nodeId: 'right', pinId: 'left-upper', role: 'load' },
                ],
            },
        ]
    );

    assert.deepEqual(route.networks.map(network =>
        network.paths[0].segments.map(segment => segment.orientation)
    ), [
        ['horizontal', 'vertical', 'horizontal'],
        ['horizontal', 'vertical', 'horizontal'],
    ]);
    assertNoDifferentNetworkCollinearOverlap(route);
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

test('routes equal-height fan-out without losing path traversal order', () => {
    const node = (
        id: string,
        column: number,
        order: number,
        pinId: 'left' | 'right'
    ): RoutingGridNodeInput => ({
        id,
        column,
        order,
        yOffset: 0,
        size: { width: 160, height: 120 },
        pinAnchors: [{
            id: pinId,
            x: pinId === 'left' ? 0 : 160,
            y: 50,
        }],
    });
    const networks: RoutingNetworkRequest[] = [{
        id: 'network:equal-height-fanout',
        terminals: [
            { nodeId: 'source', pinId: 'right', role: 'driver' },
            { nodeId: 'load-a', pinId: 'left', role: 'load' },
            { nodeId: 'load-b', pinId: 'left', role: 'load' },
        ],
    }];
    const route = routeNetworks([
        node('source', 0, 0, 'right'),
        node('load-a', 2, 0, 'left'),
        node('load-b', 2, 1, 'left'),
    ], networks);

    assert.equal(route.networks[0].paths.length, 2);
    assertEveryTerminalAnchorConnected(route, networks);
    assertEveryAllocatedTrackReferenced(route);
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
    assert.deepEqual(route.networks[0].paths.map(path =>
        path.segments.map(segment => segment.orientation)
    ), [
        ['horizontal', 'vertical', 'horizontal'],
        ['vertical', 'horizontal'],
    ]);
    assert.equal(route.networks[0].paths[1].from.kind, 'tree');
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
    const connectedTerminals = route.networks[0].paths.flatMap(path => [
        ...(path.from.kind === 'terminal' ? [path.from.terminal] : []),
        path.to,
    ]);
    assert.deepEqual(new Set(connectedTerminals.map(terminal =>
        pinKey(terminal.nodeId, terminal.pinId)
    )), new Set([
        pinKey('driver-a', 'right'),
        pinKey('driver-b', 'right'),
        pinKey('load-a', 'left'),
        pinKey('load-b', 'left'),
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
    assert.equal(route.networks[0].paths[0].from.kind, 'terminal');
    assert.equal(route.networks[0].paths[0].from.nodeId, 'a');
    assert.equal(route.networks[0].paths[0].from.pinId, 'right');
    assert.equal(route.networks[0].paths[1].from.kind, 'tree');
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

test('treats NUL-containing node and pin identities as distinct terminals', () => {
    const networks: RoutingNetworkRequest[] = [{
        id: 'network:nul-identities',
        terminals: [
            { nodeId: 'a', pinId: 'b\0c', role: 'driver' },
            { nodeId: 'a\0b', pinId: 'c', role: 'load' },
        ],
    }];
    const route = routeNetworks([
        {
            id: 'a',
            column: 0,
            order: 0,
            yOffset: 0,
            size: { width: 100, height: 40 },
            pinAnchors: [{ id: 'b\0c', x: 100, y: 20 }],
        },
        {
            id: 'a\0b',
            column: 1,
            order: 0,
            yOffset: 0,
            size: { width: 100, height: 40 },
            pinAnchors: [{ id: 'c', x: 0, y: 20 }],
        },
    ], networks);

    assert.equal(route.networks[0].paths.length, 1);
    assertEveryTerminalAnchorConnected(route, networks);
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

test('does not attach testing state or probes to routeNetworks', () => {
    assert.deepEqual(Object.getOwnPropertySymbols(routeNetworks), []);
    for (const name of [
        'orderedPathSegments',
        'probeChannelConstraintAssignmentForTesting',
        'probeRoutingAllocationTransactionForTesting',
        'routeNetworksForTesting',
    ]) {
        assert.equal(name in schematicCore, false);
    }
});

test('keeps large fan-out tree output and abstract demand linear', () => {
    const sinkCount = 1_024;
    type Diagnostics = Readonly<{
        realizedDemandSignatures: number;
        committedRouteMaterializations: number;
        incrementalCandidateMaterializations: number;
    }>;
    const routeFanout = (
        count: number,
        observer?: (diagnostics: Diagnostics) => void
    ): RoutedSchematic => routeNetworksForTesting([
            routingNode('source', 0, 0),
            ...Array.from({ length: count }, (_, index) =>
                routingNode(`sink:${index}`, index + 1, 0)
            ),
        ], [{
            id: 'network:large-fanout',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                ...Array.from({ length: count }, (_, index) => ({
                    nodeId: `sink:${index}`,
                    pinId: 'left',
                    role: 'load' as const,
                })),
            ],
        }], {}, observer);
    for (const count of [64, 256]) {
        assertEveryAllocatedTrackReferenced(routeFanout(count));
    }
    let diagnostics: Diagnostics | undefined;
    const route = routeFanout(sinkCount, value => {
        diagnostics = value;
    });

    assert.equal(route.networks[0].paths.length, sinkCount);
    assert.equal(route.networks[0].paths[0].from.kind, 'terminal');
    assert.equal(route.networks[0].paths.slice(1).every(path =>
        path.from.kind === 'tree'
    ), true);
    assert.ok(route.networks[0].paths.reduce(
        (sum, path) => sum + path.segments.length,
        0
    ) <= sinkCount * 5);
    assert.equal(route.grid.outer.top.trackY.length, 1);
    assert.ok(route.grid.channels.reduce(
        (sum, channel) => sum + channel.trackX.length,
        0
    ) <= sinkCount);
    assertEveryAllocatedTrackReferenced(route);
    assert.ok(diagnostics);
    assert.ok(diagnostics.realizedDemandSignatures <= 8);
    assert.ok(diagnostics.committedRouteMaterializations <= 8);
    assert.ok(
        diagnostics.incrementalCandidateMaterializations <= sinkCount * 3
    );
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

test('connects adjacent path endpoints using realized pin coordinates', () => {
    const node = (
        id: string,
        column: number,
        order: number,
        height: number,
        yOffset: number,
        pinId: 'left' | 'right'
    ): RoutingGridNodeInput => ({
        id,
        column,
        order,
        yOffset,
        size: { width: 100, height },
        pinAnchors: [{
            id: pinId,
            x: pinId === 'left' ? 0 : 100,
            y: 20,
        }],
    });
    const route = routeNetworks([
        node('left-predecessor', 0, 0, 100, 0, 'right'),
        node('source', 0, 1, 40, -100, 'right'),
        node('right-predecessor', 1, 0, 40, 0, 'left'),
        node('target', 1, 1, 40, -100, 'left'),
    ], [{
        id: 'network:realized-adjacent',
        terminals: [
            { nodeId: 'source', pinId: 'right', role: 'driver' },
            { nodeId: 'target', pinId: 'left', role: 'load' },
        ],
    }]);
    const path = route.networks[0].paths[0];
    const pinPoint = (nodeId: string, pinId: string) => route.grid.nodes
        .find(node => node.id === nodeId)!.pinAnchors
        .find(pin => pin.id === pinId)!.point;
    const pointTouches = (
        point: Readonly<{ x: number; y: number }>,
        segment: (typeof path.segments)[number]
    ): boolean => segment.orientation === 'horizontal'
        ? point.y === segment.y && point.x >= segment.x1 && point.x <= segment.x2
        : point.x === segment.x && point.y >= segment.y1 && point.y <= segment.y2;

    assert.equal(path.from.kind, 'terminal');
    assert.equal(pointTouches(path.from.point, path.segments[0]), true);
    assert.equal(pointTouches(
        pinPoint(path.to.nodeId, path.to.pinId),
        path.segments[path.segments.length - 1]
    ), true);
    assert.deepEqual(path.segments.map(segment => segment.orientation), [
        'horizontal', 'vertical', 'horizontal',
    ]);
});

test('routes the same geometry independently of network ID order', () => {
    const nodes = [
        routingNode('c0-upper', 0, 0),
        routingNode('c0-lower', 0, 1),
        routingNode('c1-upper', 1, 0),
        routingNode('c1-lower', 1, 1),
        routingNode('c2-upper', 2, 0),
        routingNode('c2-lower', 2, 1),
        routingNode('c3-upper', 3, 0),
        routingNode('c3-lower', 3, 1),
    ];
    const routeWithIds = (firstId: string, secondId: string) => routeNetworks(
        nodes,
        [
            {
                id: firstId,
                terminals: [
                    { nodeId: 'c0-upper', pinId: 'right', role: 'driver' },
                    { nodeId: 'c2-lower', pinId: 'left', role: 'load' },
                ],
            },
            {
                id: secondId,
                terminals: [
                    { nodeId: 'c1-lower', pinId: 'right', role: 'driver' },
                    { nodeId: 'c3-upper', pinId: 'left', role: 'load' },
                ],
            },
        ]
    );

    const first = routeWithIds('a', 'b');
    const renamed = routeWithIds('z', 'a');
    const geometryFor = (
        route: ReturnType<typeof routeNetworks>,
        networkId: string
    ) => route.networks.find(network => network.id === networkId)!.segments
        .map(segment => {
            const { networkId: _networkId, ...geometry } = segment;
            return geometry;
        });

    assert.equal(first.grid.channels[1].trackX.length, 2);
    assert.equal(renamed.grid.channels[1].trackX.length, 2);
    assert.deepEqual(geometryFor(first, 'a'), geometryFor(renamed, 'z'));
    assert.deepEqual(geometryFor(first, 'b'), geometryFor(renamed, 'a'));
});

test('orders forced adjacent tracks by pin geometry before network IDs', () => {
    const twoPinNode = (
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
            { id: `${side}-high`, x: side === 'left' ? 0 : 100, y: 10 },
            { id: `${side}-low`, x: side === 'left' ? 0 : 100, y: 30 },
        ],
    });
    const nodes = [
        twoPinNode('left', 0, 'right'),
        twoPinNode('right', 1, 'left'),
    ];
    const routeWithIds = (fallingId: string, risingId: string) => routeNetworks(
        nodes,
        [
            {
                id: fallingId,
                terminals: [
                    { nodeId: 'left', pinId: 'right-high', role: 'driver' },
                    { nodeId: 'right', pinId: 'left-low', role: 'load' },
                ],
            },
            {
                id: risingId,
                terminals: [
                    { nodeId: 'left', pinId: 'right-low', role: 'driver' },
                    { nodeId: 'right', pinId: 'left-high', role: 'load' },
                ],
            },
        ]
    );
    const geometryFor = (
        route: ReturnType<typeof routeNetworks>,
        id: string
    ) => route.networks.find(network => network.id === id)!.segments.map(
        segment => {
            const { networkId: _networkId, ...geometry } = segment;
            return geometry;
        }
    );

    const original = routeWithIds('a', 'b');
    const renamed = routeWithIds('z', 'a');

    assert.deepEqual(geometryFor(original, 'a'), geometryFor(renamed, 'z'));
    assert.deepEqual(geometryFor(original, 'b'), geometryFor(renamed, 'a'));
});

test('routes ordered shared adjacent module pins as H-V-H', () => {
    const twoPinNode = (
        id: string,
        column: number,
        side: 'left' | 'right',
        pinYs: readonly [number, number]
    ): RoutingGridNodeInput => ({
        id,
        column,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 50 },
        pinAnchors: [
            {
                id: `${side}-upper`,
                x: side === 'left' ? 0 : 100,
                y: pinYs[0],
            },
            {
                id: `${side}-lower`,
                x: side === 'left' ? 0 : 100,
                y: pinYs[1],
            },
        ],
    });
    const route = routeNetworks(
        [
            twoPinNode('left', 0, 'right', [10, 30]),
            twoPinNode('right', 1, 'left', [20, 40]),
        ],
        [
            {
                id: 'network:upper',
                terminals: [
                    { nodeId: 'left', pinId: 'right-upper', role: 'driver' },
                    { nodeId: 'right', pinId: 'left-upper', role: 'load' },
                ],
            },
            {
                id: 'network:lower',
                terminals: [
                    { nodeId: 'left', pinId: 'right-lower', role: 'driver' },
                    { nodeId: 'right', pinId: 'left-lower', role: 'load' },
                ],
            },
        ]
    );

    assert.deepEqual(route.networks.map(network =>
        network.paths[0].segments.map(segment => segment.orientation)
    ), [
        ['horizontal', 'vertical', 'horizontal'],
        ['horizontal', 'vertical', 'horizontal'],
    ]);
    assert.equal(route.grid.rowGaps.every(gap => gap.trackY.length === 0), true);
});

test('routes outer escapes independently of network ID order', () => {
    const nodes = [
        routingNode('left-top', 0, 0),
        routingNode('left-bottom', 0, 1),
        routingNode('right-top', 1, 0),
    ];
    const routeWithIds = (outerId: string, localId: string) => routeNetworks(
        nodes,
        [
            {
                id: outerId,
                terminals: [
                    { nodeId: 'left-top', pinId: 'left', role: 'bidirectional' },
                    { nodeId: 'right-top', pinId: 'left', role: 'bidirectional' },
                ],
            },
            {
                id: localId,
                terminals: [
                    { nodeId: 'left-top', pinId: 'right', role: 'bidirectional' },
                    { nodeId: 'left-bottom', pinId: 'left', role: 'bidirectional' },
                ],
            },
        ]
    );

    assert.doesNotThrow(() => routeWithIds('a', 'b'));
    assert.doesNotThrow(() => routeWithIds('z', 'a'));
});

test('orders ordinary source and target legs before a feedback endpoint', () => {
    const nodes = [
        routingNode('left-top', 0, 0),
        routingNode('left-bottom', 0, 1),
        routingNode('right-top', 1, 0),
        routingNode('right-bottom', 1, 1),
    ];
    const routeWithIds = (feedbackId: string, ordinaryId: string) => {
        const networks: RoutingNetworkRequest[] = [
            {
                id: feedbackId,
                terminals: [
                    {
                        nodeId: 'right-bottom',
                        pinId: 'left',
                        role: 'driver',
                    },
                    { nodeId: 'left-top', pinId: 'left', role: 'load' },
                ],
            },
            {
                id: ordinaryId,
                terminals: [
                    {
                        nodeId: 'left-top',
                        pinId: 'right',
                        role: 'bidirectional',
                    },
                    {
                        nodeId: 'left-bottom',
                        pinId: 'right',
                        role: 'bidirectional',
                    },
                ],
            },
        ];
        const route = routeNetworks(nodes, networks);
        const tracks = route.grid.channels[0].trackX;
        assert.equal(tracks.length, 3);
        assert.equal(
            terminalLegX(route, ordinaryId, networks[1].terminals[0]),
            tracks[0]
        );
        assert.equal(
            terminalLegX(route, ordinaryId, networks[1].terminals[1]),
            tracks[1]
        );
        assert.equal(
            terminalLegX(route, feedbackId, networks[0].terminals[0]),
            tracks[2]
        );
        assertNoDifferentNetworkCollinearOverlap(route);
        assertEveryTerminalAnchorConnected(route, networks);
        return route;
    };

    assert.doesNotThrow(() => routeWithIds('a', 'b'));
    assert.doesNotThrow(() => routeWithIds('z', 'a'));
});

test('keeps same-network source and target legs distinct in one channel', () => {
    const networks: RoutingNetworkRequest[] = [{
        id: 'ordinary',
        terminals: [
            {
                nodeId: 'left-top',
                pinId: 'right',
                role: 'bidirectional',
            },
            {
                nodeId: 'left-bottom',
                pinId: 'right',
                role: 'bidirectional',
            },
        ],
    }];
    const route = routeNetworks([
        routingNode('left-top', 0, 0),
        routingNode('left-bottom', 0, 1),
        routingNode('right-top', 1, 0),
    ], networks);
    const tracks = route.grid.channels[0].trackX;

    assert.equal(tracks.length, 2);
    assert.equal(terminalLegX(route, 'ordinary', networks[0].terminals[0]), tracks[0]);
    assert.equal(terminalLegX(route, 'ordinary', networks[0].terminals[1]), tracks[1]);
    assertEveryTerminalAnchorConnected(route, networks);
});

test('globally orders mixed ordinary and feedback channel legs', () => {
    const nodes = [
        routingNode('left-top', 0, 0),
        routingNode('left-middle', 0, 1),
        routingNode('left-bottom', 0, 2),
        routingNode('right-top', 1, 0),
        routingNode('right-middle', 1, 1),
        routingNode('right-bottom', 1, 2),
    ];
    const networks: RoutingNetworkRequest[] = [
        {
            id: 'left-ordinary',
            terminals: [
                { nodeId: 'left-top', pinId: 'right', role: 'bidirectional' },
                { nodeId: 'left-bottom', pinId: 'right', role: 'bidirectional' },
            ],
        },
        {
            id: 'right-ordinary',
            terminals: [
                { nodeId: 'right-top', pinId: 'left', role: 'bidirectional' },
                {
                    nodeId: 'right-middle',
                    pinId: 'left',
                    role: 'bidirectional',
                },
            ],
        },
        {
            id: 'feedback',
            terminals: [
                { nodeId: 'right-bottom', pinId: 'left', role: 'driver' },
                { nodeId: 'left-middle', pinId: 'left', role: 'load' },
            ],
        },
    ];
    const route = routeNetworks(nodes, networks);
    const tracks = route.grid.channels[0].trackX;

    assert.equal(tracks.length, 5);
    assert.deepEqual([
        terminalLegX(route, 'left-ordinary', networks[0].terminals[0]),
        terminalLegX(route, 'left-ordinary', networks[0].terminals[1]),
        terminalLegX(route, 'right-ordinary', networks[1].terminals[0]),
        terminalLegX(route, 'right-ordinary', networks[1].terminals[1]),
        terminalLegX(route, 'feedback', networks[2].terminals[0]),
    ], tracks);
    assertNoDifferentNetworkCollinearOverlap(route);
    assertEveryTerminalAnchorConnected(route, networks);
});

test('orders a feedback source before both attachments of a shared leg', () => {
    const nodes = [
        routingNode('left-top', 0, 0),
        routingNode('left-middle', 0, 1),
        routingNode('left-bottom', 0, 2),
        routingNode('right-top', 1, 0),
        routingNode('right-middle', 1, 1),
    ];
    const routeWithIds = (ordinaryId: string, feedbackId: string) => {
        const networks: RoutingNetworkRequest[] = [
            {
                id: ordinaryId,
                terminals: [
                    { nodeId: 'left-top', pinId: 'right', role: 'driver' },
                    { nodeId: 'right-middle', pinId: 'left', role: 'load' },
                ],
            },
            {
                id: feedbackId,
                terminals: [
                    { nodeId: 'left-middle', pinId: 'right', role: 'driver' },
                    { nodeId: 'left-bottom', pinId: 'left', role: 'load' },
                ],
            },
        ];
        const route = routeNetworks(nodes, networks);
        const tracks = route.grid.channels[0].trackX;

        assert.equal(tracks.length, 2);
        assert.equal(
            terminalLegX(route, feedbackId, networks[1].terminals[0]),
            tracks[0]
        );
        assert.equal(
            terminalLegX(route, ordinaryId, networks[0].terminals[0]),
            tracks[1]
        );
        assert.equal(
            terminalLegX(route, ordinaryId, networks[0].terminals[1]),
            tracks[1]
        );
        assertNoDifferentNetworkCollinearOverlap(route);
        assertEveryTerminalAnchorConnected(route, networks);
    };

    assert.doesNotThrow(() => routeWithIds('a', 'b'));
    assert.doesNotThrow(() => routeWithIds('z', 'a'));
});

test('preserves channel-leg multiplicity across one network tree', () => {
    const networks: RoutingNetworkRequest[] = [{
        id: 'tree',
        terminals: [
            { nodeId: 'left-top', pinId: 'right', role: 'bidirectional' },
            { nodeId: 'left-middle', pinId: 'right', role: 'bidirectional' },
            { nodeId: 'left-bottom', pinId: 'right', role: 'bidirectional' },
        ],
    }];
    let committedChannelLegIntents: number | undefined;
    const route = routeNetworksForTesting([
        routingNode('left-top', 0, 0),
        routingNode('left-middle', 0, 1),
        routingNode('left-bottom', 0, 2),
        routingNode('right-top', 1, 0),
    ], networks, {}, diagnostics => {
        committedChannelLegIntents = diagnostics.committedChannelLegIntents;
    });

    assert.equal(route.grid.channels[0].trackX.length, 3);
    assert.equal(new Set(networks[0].terminals.map(terminal =>
        terminalLegX(route, 'tree', terminal)
    )).size, 3);
    assert.equal(committedChannelLegIntents, 3);
    assertEveryTerminalAnchorConnected(route, networks);
});

test('chooses feedback lane using realized added wire length', () => {
    const tallNode = (
        id: string,
        column: number,
        pinId: 'left' | 'right'
    ): RoutingGridNodeInput => ({
        id,
        column,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 1_000 },
        pinAnchors: [{
            id: pinId,
            x: pinId === 'left' ? 0 : 100,
            y: 990,
        }],
    });
    const route = routeNetworks([
        tallNode('load', 0, 'left'),
        tallNode('driver', 1, 'right'),
        routingNode('lower-left', 0, 1),
        routingNode('lower-right', 1, 1),
    ], [{
        id: 'network:bottom-is-shorter',
        terminals: [
            { nodeId: 'driver', pinId: 'right', role: 'driver' },
            { nodeId: 'load', pinId: 'left', role: 'load' },
        ],
    }]);

    assert.equal(route.grid.outer.top.trackY.length, 0);
    assert.equal(route.grid.outer.bottom.trackY.length, 1);
});

test('grows a network tree by reusing an equal-cost existing trunk', () => {
    const route = routeFixture({
        nodes: [
            routingNode('left-upper', 0, 0),
            routingNode('left-middle', 0, 1),
            routingNode('root', 0, 2),
            routingNode('middle-upper', 1, 0),
            routingNode('middle-middle', 1, 1),
            routingNode('middle-lower', 1, 2),
            routingNode('sink-far', 2, 0),
            routingNode('right-middle', 2, 1),
            routingNode('sink-near', 2, 2),
        ],
        networks: [{
            id: 'network:dynamic-tree',
            terminals: [
                { nodeId: 'sink-far', pinId: 'left', role: 'load' },
                { nodeId: 'root', pinId: 'right', role: 'driver' },
                { nodeId: 'sink-near', pinId: 'left', role: 'load' },
            ],
        }],
    });

    assert.deepEqual(
        route.grid.rowGaps.map(gap => gap.trackY.length),
        [0, 1]
    );
    assert.equal(route.networks[0].paths.length, 2);
});

test('connects the next terminal to the existing tree at a segment interior', () => {
    const route = routeFixture({
        nodes: [
            routingNode('root', 0, 0),
            routingNode('left-middle', 0, 1),
            routingNode('left-lower', 0, 2),
            routingNode('middle-upper', 1, 0),
            routingNode('middle-middle', 1, 1),
            routingNode('middle-lower', 1, 2),
            routingNode('right-upper', 2, 0),
            routingNode('right-middle', 2, 1),
            routingNode('branch', 2, 2, 40, 1_000),
            routingNode('far', 3, 0),
            routingNode('far-middle', 3, 1),
            routingNode('far-lower', 3, 2),
        ],
        networks: [{
            id: 'network:segment-attachment',
            terminals: [
                { nodeId: 'branch', pinId: 'left', role: 'load' },
                { nodeId: 'root', pinId: 'right', role: 'driver' },
                { nodeId: 'far', pinId: 'left', role: 'load' },
            ],
        }],
    });
    const network = route.networks[0];

    assert.equal(network.paths[0].to.nodeId, 'far');
    const attachment = network.paths[1].from as unknown as Readonly<{
        kind: string;
        point: Readonly<{ x: number; y: number }>;
    }>;
    assert.equal(attachment.kind, 'tree');
    assert.equal(network.paths[0].segments.some(segment =>
        segment.orientation === 'horizontal'
            ? attachment.point.y === segment.y
                && attachment.point.x >= segment.x1
                && attachment.point.x <= segment.x2
            : attachment.point.x === segment.x
                && attachment.point.y >= segment.y1
                && attachment.point.y <= segment.y2
    ), true);
    const interiorBranch = network.segments.some(horizontalSegment =>
        horizontalSegment.orientation === 'horizontal'
        && network.segments.some(verticalSegment =>
            verticalSegment.orientation === 'vertical'
            && verticalSegment.x > horizontalSegment.x1
            && verticalSegment.x < horizontalSegment.x2
            && horizontalSegment.y >= verticalSegment.y1
            && horizontalSegment.y <= verticalSegment.y2
        )
    );
    assert.equal(interiorBranch, true);
});

test('selects the globally cheapest terminal as the tree grows', () => {
    const nodes: RoutingGridNodeInput[] = [];
    for (let column = 0; column <= 4; column += 1) {
        nodes.push(routingNode(
            column === 0 ? 'root'
                : column === 3 ? 'seed'
                    : column === 4 ? 'extension'
                        : `upper-${column}`,
            column,
            0
        ));
        nodes.push(routingNode(`middle-${column}`, column, 1));
        nodes.push(routingNode(
            column === 2 ? 'branch' : `lower-${column}`,
            column,
            2,
            40,
            column === 2 ? 1_000 : 0
        ));
    }
    const route = routeNetworks(nodes, [{
        id: 'network:global-cheapest',
        terminals: [
            { nodeId: 'branch', pinId: 'left', role: 'load' },
            { nodeId: 'extension', pinId: 'left', role: 'load' },
            { nodeId: 'root', pinId: 'right', role: 'driver' },
            { nodeId: 'seed', pinId: 'left', role: 'load' },
        ],
    }]);

    assert.deepEqual(route.networks[0].paths.map(path => path.to.nodeId), [
        'seed',
        'extension',
        'branch',
    ]);
});

test('selects the terminal with the shortest realized added route', () => {
    const node = (
        id: string,
        column: number,
        pinY: number
    ): RoutingGridNodeInput => ({
        id,
        column,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 1_000 },
        pinAnchors: [
            { id: 'left', x: 0, y: pinY },
            { id: 'right', x: 100, y: pinY },
        ],
    });
    const nodes = [
        node('root', 0, 500),
        node('near', 1, 500),
        node('far', 2, 0),
    ];
    const root = { nodeId: 'root', pinId: 'left', role: 'driver' as const };
    const near = { nodeId: 'near', pinId: 'left', role: 'load' as const };
    const far = { nodeId: 'far', pinId: 'left', role: 'load' as const };
    const length = (path: RoutedSchematic['networks'][number]['paths'][number]) =>
        path.segments.reduce((sum, segment) => sum + (
            segment.orientation === 'horizontal'
                ? segment.x2 - segment.x1
                : segment.y2 - segment.y1
        ), 0);
    const route = routeNetworks(nodes, [{
        id: 'network:data',
        terminals: [root, near, far],
    }]);
    const nearOnly = routeNetworks(nodes, [{
        id: 'network:data',
        terminals: [root, near],
    }]);
    const farOnly = routeNetworks(nodes, [{
        id: 'network:data',
        terminals: [root, far],
    }]);

    assert.equal(length(nearOnly.networks[0].paths[0]), 1_212);
    assert.equal(length(farOnly.networks[0].paths[0]), 844);
    assert.equal(route.networks[0].paths[0].to.nodeId, 'far');
});

test('routes multi-terminal geometry independently of network IDs', () => {
    const nodes: RoutingGridNodeInput[] = [];
    for (let column = 0; column < 4; column += 1) {
        nodes.push(
            routingNode(`a${column}`, column, 0),
            routingNode(`b${column}`, column, 1),
            routingNode(`sp${column}`, column, 2)
        );
    }
    const network = (
        id: string,
        prefix: 'a' | 'b'
    ): RoutingNetworkRequest => ({
        id,
        terminals: [
            { nodeId: `${prefix}0`, pinId: 'right', role: 'driver' },
            { nodeId: `${prefix}2`, pinId: 'left', role: 'load' },
            { nodeId: `${prefix}3`, pinId: 'left', role: 'load' },
        ],
    });
    const geometryFor = (
        route: ReturnType<typeof routeNetworks>,
        id: string
    ) => route.networks.find(item => item.id === id)!.segments.map(segment => {
        const { networkId: _networkId, ...geometry } = segment;
        return geometry;
    });
    const original = routeNetworks(nodes, [
        network('a', 'a'),
        network('b', 'b'),
    ]);
    const renamed = routeNetworks(nodes, [
        network('z', 'a'),
        network('a', 'b'),
    ]);

    assert.deepEqual(geometryFor(original, 'a'), geometryFor(renamed, 'z'));
    assert.deepEqual(geometryFor(original, 'b'), geometryFor(renamed, 'a'));
});

test('connects every incremental path between its attachment and new terminal', () => {
    const route = routeFixture({
        nodes: [
            routingNode('root', 0, 0),
            routingNode('left-lower', 0, 1),
            routingNode('middle-upper', 1, 0),
            routingNode('middle-lower', 1, 1),
            routingNode('sink-upper', 2, 0),
            routingNode('sink-lower', 2, 1),
        ],
        networks: [{
            id: 'network:path-attachments',
            terminals: [
                { nodeId: 'sink-lower', pinId: 'left', role: 'load' },
                { nodeId: 'root', pinId: 'right', role: 'driver' },
                { nodeId: 'sink-upper', pinId: 'left', role: 'load' },
            ],
        }],
    });
    const network = route.networks[0];
    const pointTouches = (
        point: Readonly<{ x: number; y: number }>,
        segment: (typeof network.segments)[number]
    ): boolean => segment.orientation === 'horizontal'
        ? point.y === segment.y && point.x >= segment.x1 && point.x <= segment.x2
        : point.x === segment.x && point.y >= segment.y1 && point.y <= segment.y2;
    const pinPoint = (nodeId: string, pinId: string) => route.grid.nodes
        .find(node => node.id === nodeId)!.pinAnchors
        .find(pin => pin.id === pinId)!.point;
    let priorTree: typeof network.segments = [];

    for (const path of network.paths) {
        assert.ok(path.segments.length > 0);
        assert.equal(pointTouches(path.from.point, path.segments[0]), true);
        assert.equal(pointTouches(
            pinPoint(path.to.nodeId, path.to.pinId),
            path.segments[path.segments.length - 1]
        ), true);
        if (path.from.kind === 'tree') {
            assert.equal(priorTree.some(segment =>
                pointTouches(path.from.point, segment)
            ), true);
        }
        priorTree = simplifySegments([...priorTree, ...path.segments]);
    }
});

test('keeps an unselected feedback preview out of final track demand', () => {
    const tallNode = (
        id: string,
        column: number,
        pinId: 'left' | 'right'
    ): RoutingGridNodeInput => ({
        id,
        column,
        order: 0,
        yOffset: 0,
        size: { width: 100, height: 1_000 },
        pinAnchors: [{
            id: pinId,
            x: pinId === 'left' ? 0 : 100,
            y: 10,
        }],
    });
    const route = routeNetworks([
        tallNode('load', 0, 'left'),
        tallNode('driver', 1, 'right'),
        routingNode('spacer', 2, 0),
        routingNode('lower-left', 0, 1),
        routingNode('lower-middle', 1, 1),
        routingNode('lower-right', 2, 1),
    ], [{
        id: 'network:top-is-shorter',
        terminals: [
            { nodeId: 'driver', pinId: 'right', role: 'driver' },
            { nodeId: 'load', pinId: 'left', role: 'load' },
        ],
    }]);

    assert.equal(route.grid.outer.top.trackY.length, 1);
    assert.equal(route.grid.outer.bottom.trackY.length, 0);
});

test('orders global legs and isolates a rejected fallback branch', () => {
    const nodes: RoutingGridNodeInput[] = [];
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 3; row += 1) {
            nodes.push(routingNode(`n${column}${row}`, column, row));
        }
    }
    const route = routeNetworks(nodes, [
        {
            id: 'network:a',
            terminals: [
                { nodeId: 'n02', pinId: 'left', role: 'bidirectional' },
                { nodeId: 'n10', pinId: 'right', role: 'bidirectional' },
            ],
        },
        {
            id: 'network:b',
            terminals: [
                { nodeId: 'n21', pinId: 'left', role: 'bidirectional' },
                { nodeId: 'n20', pinId: 'left', role: 'bidirectional' },
            ],
        },
    ]);

    // The globally ordered primary is valid, so no fourth fallback track remains.
    assert.equal(route.grid.channels[1].trackX.length, 3);
    assert.equal(route.grid.rowGaps.reduce(
        (sum, gap) => sum + gap.trackY.length,
        0
    ), 1);
    assert.equal(
        route.grid.outer.top.trackY.length
            + route.grid.outer.bottom.trackY.length,
        1
    );
    assert.equal(route.networks.some(network =>
        network.paths[0].segments.length === 5
    ), true);

    // A true preflight failure must leave the committed journal unchanged.
    const result = probeRoutingAllocationTransactionForTesting([
        routingNode('left', 0, 0),
        routingNode('right', 1, 0),
    ], {
        nodeId: 'left',
        pinId: 'right',
        role: 'bidirectional',
    });

    assert.equal(result.rejected, true);
    assert.deepEqual(result.afterRejected, result.before);
    assert.equal(
        result.afterCommitted.actionCount,
        result.before.actionCount + 1
    );
    assert.equal(
        result.afterCommitted.channelTrackCounts[0],
        result.before.channelTrackCounts[0] + 1
    );
    assert.notEqual(result.afterCommitted.demand, result.before.demand);
});

test('topologically orders channel legs and rejects a cycle transactionally', () => {
    const result = probeChannelConstraintAssignmentForTesting();

    assert.deepEqual(result.chainTracks, [0, 1, 2]);
    assert.equal(result.cycleRejected, true);
    assert.deepEqual(result.afterRejected, result.before);
    assert.equal(
        result.afterCommitted.actionCount,
        result.before.actionCount + 1
    );
    assert.equal(
        result.afterCommitted.trackCount,
        result.before.trackCount + 1
    );
});
