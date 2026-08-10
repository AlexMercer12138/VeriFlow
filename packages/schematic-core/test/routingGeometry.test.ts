import assert from 'node:assert/strict';
import test from 'node:test';

import {
    deriveJunctions,
    horizontal,
    HorizontalReservationIndex,
    segmentIntersectsRectangleInterior,
    simplifySegments,
    splitSegmentsAtBranchPoints,
    vertical,
    VerticalReservationIndex,
    type Rectangle,
    type RouteSegment,
} from '../src';
import { reservationIndexDiagnostics } from '../src/routing/occupancy';

test('normalizes and merges same-network collinear intervals', () => {
    const input: RouteSegment[] = [
        { orientation: 'horizontal', networkId: 'n', x1: 20, x2: 0, y: 10 },
        { orientation: 'horizontal', networkId: 'n', x1: 40, x2: 20, y: 10 },
        { orientation: 'vertical', networkId: 'n', x: 40, y1: 30, y2: 10 },
    ];
    const original = structuredClone(input);

    const simplified = simplifySegments(input);

    assert.deepEqual(simplified, [
        horizontal('n', 0, 40, 10),
        vertical('n', 40, 10, 30),
    ]);
    assert.deepEqual(input, original);
});

test('removes zero-length segments', () => {
    assert.deepEqual(simplifySegments([
        horizontal('n', 10, 10, 20),
        vertical('n', 30, 40, 40),
    ]), []);
});

test('rejects coordinates outside the finite integer grid', () => {
    for (const build of [
        () => horizontal('n', 0.5, 10, 20),
        () => horizontal('n', 0, Number.NaN, 20),
        () => horizontal('n', 0, Number.MAX_SAFE_INTEGER + 1, 20),
        () => vertical('n', Number.POSITIVE_INFINITY, 0, 10),
        () => simplifySegments([{
            orientation: 'vertical' as const,
            networkId: 'n',
            x: 10,
            y1: 0,
            y2: Number.NEGATIVE_INFINITY,
        }]),
    ]) {
        assert.throws(build, {
            name: 'RangeError',
            message: /finite integer grid coordinate/,
        });
    }
});

test('unions duplicate contained overlapping and adjacent same-network intervals', () => {
    assert.deepEqual(simplifySegments([
        horizontal('n', 0, 50, 10),
        horizontal('n', 10, 20, 10),
        horizontal('n', 20, 60, 10),
        horizontal('n', 0, 50, 10),
    ]), [horizontal('n', 0, 60, 10)]);
});

test('rejects different-network collinear open-interval overlap', () => {
    for (const segments of [
        [
            horizontal('first', 0, 20, 10),
            horizontal('second', 10, 30, 10),
        ],
        [
            vertical('first', 10, 0, 20),
            vertical('second', 10, 10, 30),
        ],
    ]) {
        assert.throws(() => simplifySegments(segments), {
            name: 'RangeError',
            message: /different networks.*collinear open interval/,
        });
    }
});

test('returns canonical segment order independently of input order', () => {
    const segments = [
        vertical('z-network', 20, 0, 10),
        horizontal('a-network', 20, 0, 10),
        vertical('a-network', 30, 20, 0),
    ];

    assert.deepEqual(
        simplifySegments(segments),
        simplifySegments([...segments].reverse())
    );
});

test('simplifies many unrelated lanes without a global quadratic scan', {
    timeout: 30_000,
}, () => {
    const segments = Array.from({ length: 32_000 }, (_, index) =>
        horizontal(`network:${index}`, 0, 10, index)
    );

    const simplified = simplifySegments(segments);

    assert.equal(simplified.length, segments.length);
});

test('allows different networks to touch at endpoints and cross perpendicularly', () => {
    assert.deepEqual(simplifySegments([
        horizontal('__proto__', 0, 20, 10),
        horizontal('constructor', 20, 40, 10),
        vertical('crossing', 10, 0, 20),
    ]), [
        horizontal('__proto__', 0, 20, 10),
        horizontal('constructor', 20, 40, 10),
        vertical('crossing', 10, 0, 20),
    ]);
});

test('detects only intersections with a module rectangle interior', () => {
    const moduleBounds: Rectangle = { x: 10, y: 10, width: 20, height: 20 };

    assert.equal(segmentIntersectsRectangleInterior(
        horizontal('n', 0, 40, 20), moduleBounds
    ), true);
    assert.equal(segmentIntersectsRectangleInterior(
        vertical('n', 20, 0, 40), moduleBounds
    ), true);
    assert.equal(segmentIntersectsRectangleInterior(
        horizontal('n', 10, 20, 20), moduleBounds
    ), true, 'a boundary endpoint followed by interior wire is blocked');
    assert.equal(segmentIntersectsRectangleInterior(
        horizontal('n', 15, 15, 20), moduleBounds
    ), false, 'a zero-length segment has no occupied interior');
});

test('allows module boundary and pin endpoint touches', () => {
    const moduleBounds: Rectangle = { x: 10, y: 10, width: 20, height: 20 };

    for (const segment of [
        horizontal('n', 0, 10, 20),
        horizontal('n', 0, 40, 10),
        horizontal('n', 0, 40, 30),
        vertical('n', 10, 0, 40),
        vertical('n', 30, 0, 40),
        horizontal('n', 0, 10, 10),
    ]) {
        assert.equal(
            segmentIntersectsRectangleInterior(segment, moduleBounds),
            false
        );
    }
});

test('rejects invalid module rectangles', () => {
    const segment = horizontal('n', 0, 10, 0);
    for (const rectangle of [
        { x: 0.5, y: 0, width: 10, height: 10 },
        { x: 0, y: Number.NaN, width: 10, height: 10 },
        { x: 0, y: 0, width: -1, height: 10 },
        { x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY },
        { x: Number.MAX_SAFE_INTEGER, y: 0, width: 10, height: 10 },
    ]) {
        assert.throws(
            () => segmentIntersectsRectangleInterior(segment, rectangle),
            RangeError
        );
    }
});

test('reserves vertical channel tracks using open-interval conflicts', () => {
    const reservations = new VerticalReservationIndex();

    assert.equal(reservations.reserve('channel:0', 0, 'first', 20, 0), true);
    assert.equal(
        reservations.hasConflict('channel:0', 0, 'first', 10, 30),
        false,
        'a network may reuse its own track interval'
    );
    assert.equal(
        reservations.reserve('channel:0', 0, 'first', 10, 30),
        true
    );
    assert.equal(
        reservations.hasConflict('channel:0', 0, 'second', 20, 40),
        true
    );
    assert.equal(
        reservations.reserve('channel:0', 0, 'second', 20, 40),
        false
    );
    assert.equal(
        reservations.hasConflict('channel:0', 0, 'second', 30, 40),
        false,
        'different networks may touch at interval endpoints'
    );
});

test('isolates vertical reservations by channel and track with prototype-safe keys', () => {
    const reservations = new VerticalReservationIndex();
    assert.equal(reservations.reserve('__proto__', 0, 'constructor', 0, 20), true);

    assert.equal(
        reservations.hasConflict('__proto__', 0, '__proto__', 10, 15),
        true
    );
    assert.equal(
        reservations.hasConflict('__proto__', 1, '__proto__', 10, 15),
        false
    );
    assert.equal(
        reservations.hasConflict('constructor', 0, '__proto__', 10, 15),
        false
    );
});

test('reserves horizontal corridor tracks independently from vertical crossings', () => {
    const horizontalReservations = new HorizontalReservationIndex();
    const verticalReservations = new VerticalReservationIndex();

    assert.equal(
        horizontalReservations.reserve('corridor:0', 2, 'horizontal', 0, 40),
        true
    );
    assert.equal(
        verticalReservations.reserve('channel:0', 2, 'vertical', 0, 40),
        true
    );
    assert.equal(
        horizontalReservations.hasConflict(
            'corridor:0', 2, 'other', 10, 20
        ),
        true
    );
    assert.equal(
        horizontalReservations.hasConflict(
            'corridor:1', 2, 'other', 10, 20
        ),
        false
    );
});

test('rejects invalid reservation tracks and interval coordinates', () => {
    const verticalReservations = new VerticalReservationIndex();
    const horizontalReservations = new HorizontalReservationIndex();

    for (const reserve of [
        () => verticalReservations.reserve('channel', -1, 'n', 0, 10),
        () => verticalReservations.reserve('channel', 0.5, 'n', 0, 10),
        () => horizontalReservations.reserve('corridor', 0, 'n', 0, Number.NaN),
        () => horizontalReservations.hasConflict(
            'corridor', Number.POSITIVE_INFINITY, 'n', 0, 10
        ),
    ]) {
        assert.throws(reserve, RangeError);
    }
});

test('keeps vertical reservations as canonical same-network unions', () => {
    const reservations = new VerticalReservationIndex();
    assert.equal(reservations.reserve('channel', 0, 'n', 20, 30), true);
    assert.equal(reservations.reserve('channel', 0, 'n', 0, 10), true);
    assert.equal(reservations.reserve('channel', 0, 'n', 10, 20), true);
    assert.equal(reservations.reserve('channel', 0, 'point', 15, 15), true);

    assert.deepEqual(reservations.reservations('channel', 0), [
        { networkId: 'n', y1: 0, y2: 30 },
    ]);
});

test('merges same-network reservations transitively', () => {
    const reservations = new VerticalReservationIndex();
    reservations.reserve('channel', 0, 'n', 0, 10);
    reservations.reserve('channel', 0, 'n', 20, 30);
    reservations.reserve('channel', 0, 'n', 40, 50);

    assert.equal(reservations.reserve('channel', 0, 'n', 5, 45), true);
    assert.deepEqual(reservations.reservations('channel', 0), [
        { networkId: 'n', y1: 0, y2: 50 },
    ]);
});

test('leaves reservation state unchanged when a merge candidate conflicts', () => {
    const reservations = new VerticalReservationIndex();
    reservations.reserve('channel', 0, 'first', 0, 10);
    reservations.reserve('channel', 0, 'second', 20, 30);
    const before = reservations.reservations('channel', 0);

    assert.equal(
        reservations.reserve('channel', 0, 'first', 5, 25),
        false
    );
    assert.deepEqual(reservations.reservations('channel', 0), before);
    assert.equal(
        reservations.reserve('channel', 0, 'first', 10, 20),
        true,
        'endpoint contact may extend up to another network'
    );
    assert.deepEqual(reservations.reservations('channel', 0), [
        { networkId: 'first', y1: 0, y2: 20 },
        { networkId: 'second', y1: 20, y2: 30 },
    ]);
});

test('returns detached readonly reservation snapshots', () => {
    const reservations = new HorizontalReservationIndex();
    reservations.reserve('corridor', 0, '__proto__', 0, 20);
    const snapshot = reservations.reservations('corridor', 0) as Array<{
        networkId: string;
        x1: number;
        x2: number;
    }>;
    snapshot[0].x1 = 999;
    snapshot.push({ networkId: 'constructor', x1: 20, x2: 30 });

    assert.deepEqual(reservations.reservations('corridor', 0), [
        { networkId: '__proto__', x1: 0, x2: 20 },
    ]);
});

test('deduplicates a large repeated reservation without linear growth', {
    timeout: 30_000,
}, () => {
    const reservations = new VerticalReservationIndex();
    for (let index = 0; index < 50_000; index += 1) {
        assert.equal(reservations.reserve('channel', 0, 'n', 0, 10), true);
    }

    assert.deepEqual(reservations.reservations('channel', 0), [
        { networkId: 'n', y1: 0, y2: 10 },
    ]);
});

test('updates monotonic track reservations without copying prior entries', {
    timeout: 30_000,
}, () => {
    const count = 32_000;
    const ascending = new VerticalReservationIndex();
    const descending = new VerticalReservationIndex();
    for (let index = 0; index < count; index += 1) {
        ascending.reserve('channel', 0, `network:${index}`, index * 2, index * 2 + 1);
        const reverseIndex = count - index - 1;
        descending.reserve(
            'channel',
            0,
            `network:${reverseIndex}`,
            reverseIndex * 2,
            reverseIndex * 2 + 1
        );
    }

    for (const reservations of [ascending, descending]) {
        const diagnostics = reservationIndexDiagnostics(reservations);
        assert.equal(diagnostics.nodeCount, count);
        assert.ok(diagnostics.height < 128);
        assert.ok(diagnostics.nodeVisits < count * 128);
        const snapshot = reservations.reservations('channel', 0);
        assert.equal(snapshot.length, count);
        assert.deepEqual(snapshot[0], {
            networkId: 'network:0',
            y1: 0,
            y2: 1,
        });
        assert.deepEqual(snapshot[count - 1], {
            networkId: `network:${count - 1}`,
            y1: (count - 1) * 2,
            y2: (count - 1) * 2 + 1,
        });
    }
});

test('keeps deterministic shuffled insertion updates sublinear', {
    timeout: 30_000,
}, () => {
    const count = 16_384;
    const reservations = new HorizontalReservationIndex();
    for (let order = 0; order < count; order += 1) {
        const index = (order * 4_051) & (count - 1);
        reservations.reserve(
            'corridor',
            0,
            `network:${index}`,
            index * 2,
            index * 2 + 1
        );
    }

    const diagnostics = reservationIndexDiagnostics(reservations);
    assert.equal(diagnostics.nodeCount, count);
    assert.ok(diagnostics.height < 128);
    assert.ok(diagnostics.nodeVisits < count * 128);
    const snapshot = reservations.reservations('corridor', 0);
    assert.equal(snapshot.length, count);
    assert.ok(snapshot.every((reservation, index) =>
        reservation.x1 === index * 2 && reservation.x2 === index * 2 + 1
    ));
});

test('keeps every three-node rotation pattern balanced and ordered', () => {
    const insertionOrders = [
        [3, 2, 1],
        [1, 2, 3],
        [3, 1, 2],
        [1, 3, 2],
    ];

    for (const order of insertionOrders) {
        const reservations = new VerticalReservationIndex();
        for (const index of order) {
            reservations.reserve(
                'channel',
                0,
                `network:${index}`,
                index * 4,
                index * 4 + 1
            );
        }

        assert.deepEqual(reservations.reservations('channel', 0), [
            { networkId: 'network:1', y1: 4, y2: 5 },
            { networkId: 'network:2', y1: 8, y2: 9 },
            { networkId: 'network:3', y1: 12, y2: 13 },
        ]);
        assert.equal(reservationIndexDiagnostics(reservations).height, 2);
    }
});

test('keeps the index usable after a union removes the balanced root', () => {
    const reservations = new VerticalReservationIndex();
    for (const index of [4, 2, 6, 1, 3, 5, 7]) {
        reservations.reserve(
            'channel',
            0,
            'shared',
            index * 4,
            index * 4 + 1
        );
    }

    assert.equal(reservations.reserve('channel', 0, 'shared', 8, 25), true);
    assert.equal(
        reservations.hasConflict('channel', 0, 'other', 20, 21),
        true
    );
    assert.deepEqual(reservations.reservations('channel', 0), [
        { networkId: 'shared', y1: 4, y2: 5 },
        { networkId: 'shared', y1: 8, y2: 25 },
        { networkId: 'shared', y1: 28, y2: 29 },
    ]);
    assert.ok(reservationIndexDiagnostics(reservations).height <= 2);
});

test('splits merged same-network segments at branch points', () => {
    const input = [
        horizontal('n', 20, 0, 10),
        horizontal('n', 0, 20, 10),
        vertical('n', 10, 0, 10),
    ];

    assert.deepEqual(splitSegmentsAtBranchPoints(input), [
        horizontal('n', 0, 10, 10),
        horizontal('n', 10, 20, 10),
        vertical('n', 10, 0, 10),
    ]);
    assert.deepEqual(input, [
        horizontal('n', 0, 20, 10),
        horizontal('n', 0, 20, 10),
        vertical('n', 10, 0, 10),
    ]);
});

test('derives junctions only from at least three same-network directions', () => {
    const junctions = deriveJunctions([
        horizontal('four', 0, 20, 20),
        vertical('four', 10, 10, 30),
        horizontal('tee', 0, 20, 10),
        vertical('tee', 10, 0, 10),
        horizontal('straight', 0, 20, 0),
        horizontal('bend', 0, 10, 30),
        vertical('bend', 10, 30, 40),
    ]);

    assert.deepEqual(junctions, [
        {
            networkId: 'four',
            point: { x: 10, y: 20 },
            directions: new Set(['north', 'east', 'south', 'west']),
        },
        {
            networkId: 'tee',
            point: { x: 10, y: 10 },
            directions: new Set(['north', 'east', 'west']),
        },
    ]);
});

test('does not derive junctions from different-network crossings', () => {
    assert.deepEqual(deriveJunctions([
        horizontal('__proto__', 0, 20, 10),
        vertical('constructor', 10, 0, 20),
    ]), []);
});

test('does not let duplicate or overlapping segments invent directions', () => {
    assert.deepEqual(deriveJunctions([
        horizontal('n', 0, 10, 10),
        horizontal('n', 0, 10, 10),
        horizontal('n', 5, 10, 10),
        vertical('n', 10, 10, 20),
        vertical('n', 10, 10, 20),
    ]), []);
});

test('enumerates every active horizontal at endpoint junctions', () => {
    assert.deepEqual(deriveJunctions([
        horizontal('grid', 0, 20, 0),
        horizontal('grid', 0, 20, 10),
        vertical('grid', 5, 0, 10),
        vertical('grid', 15, 0, 10),
    ]), [
        {
            networkId: 'grid',
            point: { x: 5, y: 0 },
            directions: new Set(['east', 'south', 'west']),
        },
        {
            networkId: 'grid',
            point: { x: 5, y: 10 },
            directions: new Set(['north', 'east', 'west']),
        },
        {
            networkId: 'grid',
            point: { x: 15, y: 0 },
            directions: new Set(['east', 'south', 'west']),
        },
        {
            networkId: 'grid',
            point: { x: 15, y: 10 },
            directions: new Set(['north', 'east', 'west']),
        },
    ]);
});

test('derives junctions across many unrelated networks without global pair scans', {
    timeout: 30_000,
}, () => {
    const segments = Array.from({ length: 32_000 }, (_, index) =>
        horizontal(`network:${index}`, 0, 10, index)
    );

    const junctions = deriveJunctions(segments);

    assert.deepEqual(junctions, []);
});

test('indexes perpendicular candidates within one large network', {
    timeout: 30_000,
}, () => {
    const segmentCount = 16_000;
    const segments: RouteSegment[] = Array.from(
        { length: segmentCount },
        (_, index) =>
            horizontal('shared', 0, 10, index)
    );
    for (let index = 0; index < segmentCount; index += 1) {
        segments.push(vertical('shared', 100 + index, 0, segmentCount));
    }

    const junctions = deriveJunctions(segments);

    assert.deepEqual(junctions, []);
});
