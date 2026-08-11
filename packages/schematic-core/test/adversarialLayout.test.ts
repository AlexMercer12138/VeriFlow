import assert from 'node:assert/strict';
import test from 'node:test';

import {
    layoutSchematic,
    segmentIntersectsRectangleInterior,
    serializeSchematicRenderModel,
    type Rectangle,
    type RouteSegment,
    type SchematicRenderModel,
} from '../src';
import { adversarialSchematicFixture } from './fixtures';

function rendered(): SchematicRenderModel {
    const fixture = adversarialSchematicFixture();
    return layoutSchematic(fixture.graph, fixture.placement, text => text.length * 7);
}

function rectanglesOverlap(left: Readonly<Rectangle>, right: Readonly<Rectangle>): boolean {
    return Math.max(left.x, right.x) < Math.min(left.x + left.width, right.x + right.width)
        && Math.max(left.y, right.y) < Math.min(left.y + left.height, right.y + right.height);
}

function collinearOverlap(left: Readonly<RouteSegment>, right: Readonly<RouteSegment>): boolean {
    if (left.orientation !== right.orientation) return false;
    return left.orientation === 'horizontal' && right.orientation === 'horizontal'
        ? left.y === right.y && Math.max(left.x1, right.x1) < Math.min(left.x2, right.x2)
        : left.orientation === 'vertical' && right.orientation === 'vertical'
            ? left.x === right.x && Math.max(left.y1, right.y1) < Math.min(left.y2, right.y2)
            : false;
}

function perpendicularIntersection(
    left: Readonly<RouteSegment>,
    right: Readonly<RouteSegment>
): { x: number; y: number } | undefined {
    const horizontal = left.orientation === 'horizontal'
        ? left
        : right.orientation === 'horizontal' ? right : undefined;
    const vertical = left.orientation === 'vertical'
        ? left
        : right.orientation === 'vertical' ? right : undefined;
    if (!horizontal || !vertical
        || vertical.x <= horizontal.x1 || vertical.x >= horizontal.x2
        || horizontal.y <= vertical.y1 || horizontal.y >= vertical.y2) {
        return undefined;
    }
    return { x: vertical.x, y: horizontal.y };
}

test('keeps long node text and many pin labels inside their module body', () => {
    const result = rendered();
    const wide = result.nodes.get('instance:wide-source')!;
    assert.equal(wide.pins.length, 12);
    for (const label of [wide.title, wide.renderedSubtitle!, ...wide.pins.map(pin => ({
        bounds: pin.clipBounds,
    }))]) {
        assert.equal(
            label.bounds.x >= wide.bounds.x
                && label.bounds.y >= wide.bounds.y
                && label.bounds.x + label.bounds.width <= wide.bounds.x + wide.bounds.width
                && label.bounds.y + label.bounds.height <= wide.bounds.y + wide.bounds.height,
            true
        );
    }
});

test('preserves a long network name without canvas label geometry', () => {
    const result = rendered();
    const route = result.networks.find(candidate => candidate.id === 'network:lane-a')!;
    assert.equal(route.selectionDescription, 'lane_a_with_an_intentionally_long_network_label');
    assert.equal(route.displayName, route.selectionDescription);
    assert.equal(route.label, undefined);
});

test('separates unequal-width nodes in adjacent columns', () => {
    const result = rendered();
    const wide = result.nodes.get('instance:wide-source')!;
    const narrow = result.nodes.get('instance:middle-top')!;
    assert.ok(wide.bounds.width > narrow.bounds.width);
    assert.ok(wide.bounds.x + wide.bounds.width < narrow.bounds.x);
});

test('routes three networks competing for one channel without collinear overlap', () => {
    const result = rendered();
    const routes = ['network:lane-a', 'network:lane-b', 'network:lane-c']
        .map(id => result.networks.find(route => route.id === id)!);
    for (let left = 0; left < routes.length; left += 1) {
        for (let right = left + 1; right < routes.length; right += 1) {
            assert.equal(routes[left].segments.some(first =>
                routes[right].segments.some(second => collinearOverlap(first, second))
            ), false);
        }
    }
});

test('emits a junction only for a fanout point with at least three directions', () => {
    const result = rendered();
    const fanout = result.junctions.filter(junction =>
        junction.networkId === 'network:fanout'
    );
    assert.ok(fanout.length > 0);
    assert.ok(fanout.every(junction => junction.directions.size >= 3));
});

test('allows perpendicular different-network crossings without creating junctions', () => {
    const result = rendered();
    const first = result.networks.find(route => route.id === 'network:cross-a')!;
    const second = result.networks.find(route => route.id === 'network:cross-b')!;
    const crossings = first.segments.flatMap(left => second.segments.flatMap(right => {
        const point = perpendicularIntersection(left, right);
        return point ? [point] : [];
    }));
    assert.ok(crossings.length > 0);
    assert.ok(crossings.every(point => !result.junctions.some(junction =>
        junction.point.x === point.x && junction.point.y === point.y
    )));
});

test('uses both top and bottom outer lanes for feedback networks', () => {
    const result = rendered();
    const nodeTop = Math.min(...[...result.nodes.values()].map(node => node.bounds.y));
    const nodeBottom = Math.max(...[...result.nodes.values()].map(node =>
        node.bounds.y + node.bounds.height
    ));
    const feedback = result.networks.filter(route => route.id.startsWith('network:feedback'));
    assert.equal(feedback.length, 2);
    assert.ok(feedback.every(route => route.feedback));
    assert.ok(feedback.some(route => route.segments.some(segment =>
        segment.orientation === 'horizontal' && segment.y < nodeTop
    )));
    assert.ok(feedback.some(route => route.segments.some(segment =>
        segment.orientation === 'horizontal' && segment.y > nodeBottom
    )));
});

test('preserves disconnected islands and a pinless module without overlap', () => {
    const result = rendered();
    const empty = result.nodes.get('instance:empty-island')!;
    assert.deepEqual(empty.pins, []);
    for (const node of result.nodes.values()) {
        if (node.id === empty.id) continue;
        assert.equal(rectanglesOverlap(empty.bounds, node.bounds), false);
    }
});

test('keeps every node label and route segment within public bounds', () => {
    const result = rendered();
    const containsPoint = (x: number, y: number): boolean =>
        x >= result.bounds.x && y >= result.bounds.y
        && x <= result.bounds.x + result.bounds.width
        && y <= result.bounds.y + result.bounds.height;
    for (const node of result.nodes.values()) {
        assert.ok(containsPoint(node.bounds.x, node.bounds.y));
        assert.ok(containsPoint(
            node.bounds.x + node.bounds.width,
            node.bounds.y + node.bounds.height
        ));
    }
    for (const route of result.networks) {
        for (const segment of route.segments) {
            assert.ok(segment.orientation === 'horizontal'
                ? containsPoint(segment.x1, segment.y) && containsPoint(segment.x2, segment.y)
                : containsPoint(segment.x, segment.y1) && containsPoint(segment.x, segment.y2));
        }
    }
});

test('never materializes network labels in adversarial layouts', () => {
    const result = rendered();
    assert.ok(result.networks.every(route => route.label === undefined));
});

test('keeps adversarial routes orthogonal obstacle-free and distinct', () => {
    const result = rendered();
    const segments = result.networks.flatMap(route => route.segments);
    for (const segment of segments) {
        assert.notEqual(
            segment.orientation === 'horizontal' ? segment.x1 : segment.y1,
            segment.orientation === 'horizontal' ? segment.x2 : segment.y2
        );
        for (const node of result.nodes.values()) {
            assert.equal(segmentIntersectsRectangleInterior(segment, node.bounds), false);
        }
    }
    for (let left = 0; left < segments.length; left += 1) {
        for (let right = left + 1; right < segments.length; right += 1) {
            if (segments[left].networkId === segments[right].networkId) continue;
            assert.equal(collinearOverlap(segments[left], segments[right]), false);
        }
    }
});

test('serializes the adversarial fixture deterministically', () => {
    const fixture = adversarialSchematicFixture();
    const measure = (text: string): number => text.length * 7;
    assert.deepEqual(
        serializeSchematicRenderModel(layoutSchematic(fixture.graph, fixture.placement, measure)),
        serializeSchematicRenderModel(layoutSchematic(fixture.graph, fixture.placement, measure))
    );
});
