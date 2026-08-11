import assert from 'node:assert/strict';
import test from 'node:test';

import {
    layoutSchematic,
    measureSchematicNodeSize,
    pinKey,
    resolvePinSides,
    segmentIntersectsRectangleInterior,
    serializeSchematicRenderModel,
    type GraphNode,
    type GraphPin,
    type PinDirection,
    type Rectangle,
    type RouteSegment,
    type SchematicGraph,
    type SchematicNetwork,
    type SchematicPlacement,
    type SchematicRenderModel,
} from '../src';

if (false) {
    const rendered = null as unknown as SchematicRenderModel;
    // @ts-expect-error renderer maps have no mutation API
    rendered.nodes.set('node', rendered.nodes.values().next().value);
    // @ts-expect-error node bounds are deeply readonly
    rendered.nodes.values().next().value!.bounds.x = 1;
    // @ts-expect-error network arrays are readonly
    rendered.networks.push(rendered.networks[0]);
    // @ts-expect-error route segments are deeply readonly
    rendered.networks[0].segments[0].networkId = 'changed';
    // @ts-expect-error junction points are deeply readonly
    rendered.junctions[0].point.y = 1;
}

function pin(
    nodeId: string,
    name: string,
    direction: PinDirection
): GraphPin {
    return {
        id: `${nodeId}:${name}`,
        name,
        direction,
        width: { kind: 'known', bits: 1 },
        readOnly: false,
    };
}

function node(
    id: string,
    kind: GraphNode['kind'],
    label: string,
    pins: readonly [string, PinDirection][],
    subtitle?: string
): GraphNode {
    return {
        id,
        kind,
        label,
        subtitle,
        pins: pins.map(([name, direction]) => pin(id, name, direction)),
        readOnly: false,
    };
}

function endpoint(
    graphNode: GraphNode,
    pinIndex: number,
    role = graphNode.pins[pinIndex].direction
): SchematicNetwork['endpoints'][number] {
    return {
        nodeId: graphNode.id,
        pinId: graphNode.pins[pinIndex].id,
        role,
    };
}

function network(
    id: string,
    name: string,
    endpoints: SchematicNetwork['endpoints']
): SchematicNetwork {
    return {
        id,
        name,
        width: { kind: 'known', bits: 1 },
        endpoints,
    };
}

function complexGraph(): SchematicGraph {
    const input = node('port:input', 'port', 'clk_in', [['clk', 'driver']]);
    const first = node('instance:first', 'instance', 'u_first', [
        ['input_data', 'load'],
        ['chain_data', 'driver'],
        ['skipped_column_data', 'driver'],
    ], 'first_stage');
    const fanout = node('instance:fanout', 'instance', 'u_fanout_wide', [
        ['input_with_a_significantly_longer_declared_name', 'load'],
    ], 'fanout_stage_with_long_subtitle');
    const middle = node('instance:middle', 'instance', 'u_middle', [
        ['chain_data', 'load'],
        ['next_data', 'driver'],
        ['feedback_data', 'driver'],
        ['feedback_data_return', 'load'],
    ], 'middle_stage');
    const last = node('instance:last', 'instance', 'u_last', [
        ['next_data', 'load'],
        ['skipped_column_data', 'load'],
        ['result', 'driver'],
        ['shared_result', 'driver'],
    ], 'last_stage');
    const output = node('port:output', 'port', 'result_out', [['result', 'load']]);
    const inout = node('port:inout', 'port', 'shared_io', [['shared', 'bidirectional']]);

    return {
        fileUri: 'file:///top.sv',
        moduleKey: 'module:top:0',
        moduleName: 'top',
        nodes: [input, first, fanout, middle, last, output, inout],
        networks: [
            network('network:z-input-fanout', 'clk_distribution', [
                endpoint(input, 0),
                endpoint(first, 0),
                endpoint(fanout, 0),
            ]),
            network('network:y-first-middle', 'chain_data', [
                endpoint(first, 1),
                endpoint(middle, 0),
            ]),
            network('network:x-middle-last', 'next_data', [
                endpoint(middle, 1),
                endpoint(last, 0),
            ]),
            network('network:w-skipped', 'skipped_column_data', [
                endpoint(first, 2),
                endpoint(last, 1),
            ]),
            network('network:v-output', 'result_to_output', [
                endpoint(last, 2),
                endpoint(output, 0),
            ]),
            network('network:u-inout', 'result_to_shared_io', [
                endpoint(last, 3),
                endpoint(inout, 0),
            ]),
            network('network:t-feedback', 'middle_feedback', [
                endpoint(middle, 2),
                endpoint(middle, 3),
            ]),
        ],
        diagnostics: [],
    };
}

function isOrthogonal(segment: RouteSegment): boolean {
    return segment.orientation === 'horizontal'
        ? segment.x1 !== segment.x2
        : segment.y1 !== segment.y2;
}

function rectanglesOverlap(
    left: Readonly<Rectangle>,
    right: Readonly<Rectangle>
): boolean {
    return Math.max(left.x, right.x) < Math.min(
        left.x + left.width,
        right.x + right.width
    ) && Math.max(left.y, right.y) < Math.min(
        left.y + left.height,
        right.y + right.height
    );
}

function assertNoNodeIntersections(
    result: ReturnType<typeof layoutSchematic>
): void {
    const nodes = [...result.nodes.values()];
    for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
            assert.equal(
                rectanglesOverlap(nodes[left].bounds, nodes[right].bounds),
                false,
                `${nodes[left].id} overlaps ${nodes[right].id}`
            );
        }
    }
    for (const route of result.networks) {
        for (const segment of route.segments) {
            for (const rendered of nodes) {
                assert.equal(
                    segmentIntersectsRectangleInterior(segment, rendered.bounds),
                    false,
                    `${route.id} crosses ${rendered.id}`
                );
            }
        }
    }
}

function assertNoDifferentNetworkOverlaps(
    result: ReturnType<typeof layoutSchematic>
): void {
    const segments = result.networks.flatMap(route => route.segments);
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
            assert.equal(overlap, false, `${left.networkId} overlaps ${right.networkId}`);
        }
    }
}

test('composes a deterministic renderer model from graph through routing', () => {
    const graph = complexGraph();
    const placement: SchematicPlacement = {
        nodes: {
            'instance:first': {
                column: 1,
                order: 1,
                yOffset: 4,
                fixed: true,
            },
            'instance:fanout': {
                column: 1,
                order: 0,
                yOffset: 0,
                fixed: true,
            },
            'port:output': {
                column: 1,
                order: 0,
                yOffset: 0,
                fixed: true,
            },
            stale: {
                column: 99,
                order: 99,
                yOffset: 99,
                fixed: true,
            },
        },
    };
    const measure = (text: string): number => text.length * 7;

    const first = layoutSchematic(graph, placement, measure);
    const second = layoutSchematic(graph, placement, measure);

    assert.equal(first.nodes.size, graph.nodes.length);
    assert.deepEqual(
        first.networks.map(route => route.id),
        graph.networks.map(route => route.id),
        'rendered networks preserve graph source order'
    );
    assert.ok(first.networks.every(route => route.segments.every(isOrthogonal)));
    assert.ok(first.junctions.every(junction => junction.directions.size >= 3));
    assertNoNodeIntersections(first);
    assertNoDifferentNetworkOverlaps(first);

    const rightmost = Math.max(...first.columns.map(column => column.index));
    assert.equal(first.nodes.get('port:output')?.column, rightmost);
    assert.equal(first.nodes.get('port:inout')?.column, rightmost);
    assert.equal(first.networks.find(route => route.id === 'network:t-feedback')?.feedback, true);
    assert.deepEqual(
        serializeSchematicRenderModel(first),
        serializeSchematicRenderModel(second)
    );
});

test('uses realized node bodies and anchors while fitting labels with actual metrics', () => {
    const graph = complexGraph();
    const measure = (text: string): number => text.length * 9;
    const result = layoutSchematic(graph, undefined, measure);
    const sides = resolvePinSides(graph);

    for (const source of graph.nodes) {
        const rendered = result.nodes.get(source.id)!;
        assert.deepEqual(
            { width: rendered.bounds.width, height: rendered.bounds.height },
            {
                width: Math.ceil(measureSchematicNodeSize(source, sides).width / 2) * 2,
                height: Math.ceil(measureSchematicNodeSize(source, sides).height / 2) * 2,
            }
        );
        assert.deepEqual(
            rendered.pins.map(candidate => candidate.id),
            source.pins.map(candidate => candidate.id)
        );
        for (const candidate of rendered.pins) {
            assert.ok(
                candidate.anchor.x === rendered.bounds.x
                    || candidate.anchor.x === rendered.bounds.x
                        + rendered.bounds.width
            );
            assert.ok(candidate.clipBounds.x >= rendered.bounds.x);
            assert.ok(
                candidate.clipBounds.x + candidate.clipBounds.width
                    <= rendered.bounds.x + rendered.bounds.width
            );
        }
    }

    for (const route of result.networks) {
        assert.equal(route.selectionDescription, route.name);
        assert.equal(route.label, undefined);
    }
});

test('keeps network names semantic without producing canvas labels', () => {
    const graph = complexGraph();
    graph.networks[0].adapterLabel = '[7:0]';

    const measured: string[] = [];
    const result = layoutSchematic(graph, undefined, text => {
        measured.push(text);
        return text.length * 2;
    });
    const route = result.networks[0];

    assert.equal(route.name, 'clk_distribution');
    assert.equal(route.displayName, 'clk_distribution [7:0]');
    assert.equal(route.selectionDescription, 'clk_distribution');
    assert.equal(route.label, undefined);
    assert.equal(measured.includes(route.displayName), false);
});

test('includes nodes wires and junction dots in the public bounds', () => {
    const result = layoutSchematic(complexGraph(), undefined, text => text.length * 7);
    const containsRectangle = (candidate: Readonly<Rectangle>): boolean =>
        candidate.x >= result.bounds.x
        && candidate.y >= result.bounds.y
        && candidate.x + candidate.width <= result.bounds.x + result.bounds.width
        && candidate.y + candidate.height <= result.bounds.y + result.bounds.height;
    const containsPoint = (point: Readonly<{ x: number; y: number }>): boolean =>
        point.x >= result.bounds.x
        && point.y >= result.bounds.y
        && point.x <= result.bounds.x + result.bounds.width
        && point.y <= result.bounds.y + result.bounds.height;

    assert.ok([...result.nodes.values()].every(node => containsRectangle(node.bounds)));
    assert.ok(result.networks.every(route => route.segments.every(segment =>
        segment.orientation === 'horizontal'
            ? containsPoint({ x: segment.x1, y: segment.y })
                && containsPoint({ x: segment.x2, y: segment.y })
            : containsPoint({ x: segment.x, y: segment.y1 })
                && containsPoint({ x: segment.x, y: segment.y2 })
    )));
    assert.ok(result.junctions.every(junction => containsRectangle({
        x: junction.point.x - 3,
        y: junction.point.y - 3,
        width: 6,
        height: 6,
    })));
});

test('includes single-column feedback escape segments in public bounds', () => {
    const first = node('instance:first-scc', 'instance', 'first_scc', [
        ['from_second', 'load'],
        ['to_second', 'driver'],
    ]);
    const second = node('instance:second-scc', 'instance', 'second_scc', [
        ['from_first', 'load'],
        ['to_first', 'driver'],
    ]);
    const graph: SchematicGraph = {
        fileUri: 'file:///single-column-feedback.sv',
        moduleKey: 'module:single-column-feedback:0',
        moduleName: 'single_column_feedback',
        nodes: [first, second],
        networks: [
            network('network:first-second', 'first_to_second', [
                endpoint(first, 1),
                endpoint(second, 0),
            ]),
            network('network:second-first', 'second_to_first', [
                endpoint(second, 1),
                endpoint(first, 0),
            ]),
        ],
        diagnostics: [],
    };

    const result = layoutSchematic(graph, undefined, () => 10_000);
    const containsPoint = (x: number, y: number): boolean =>
        x >= result.bounds.x
        && y >= result.bounds.y
        && x <= result.bounds.x + result.bounds.width
        && y <= result.bounds.y + result.bounds.height;

    assert.equal(result.columns.length, 1);
    assert.ok(result.networks.every(route => route.feedback));
    for (const route of result.networks) {
        for (const segment of route.segments) {
            if (segment.orientation === 'horizontal') {
                assert.equal(
                    containsPoint(segment.x1, segment.y)
                        && containsPoint(segment.x2, segment.y),
                    true,
                    `${route.id} horizontal escape is outside public bounds`
                );
            } else {
                assert.equal(
                    containsPoint(segment.x, segment.y1)
                        && containsPoint(segment.x, segment.y2),
                    true,
                    `${route.id} vertical escape is outside public bounds`
                );
            }
        }
    }
});

test('returns compact serializable output for empty and terminal-only networks', () => {
    const empty: SchematicGraph = {
        fileUri: 'file:///empty.sv',
        moduleKey: 'module:empty:0',
        moduleName: 'empty',
        nodes: [],
        networks: [],
        diagnostics: [],
    };
    const emptyResult = layoutSchematic(empty, undefined, () => 0);
    assert.deepEqual(serializeSchematicRenderModel(emptyResult), {
        columns: [],
        nodes: [],
        networks: [],
        junctions: [],
        bounds: { x: 0, y: 0, width: 0, height: 0 },
    });
    assert.doesNotThrow(() => JSON.stringify(serializeSchematicRenderModel(emptyResult)));

    const boundary = node('port:single', 'port', 'single', [['value', 'driver']]);
    const terminalOnly: SchematicGraph = {
        ...empty,
        nodes: [boundary],
        networks: [
            network('network:one', 'one_terminal', [endpoint(boundary, 0)]),
            network('network:none', 'no_terminals', []),
        ],
    };
    const terminalResult = layoutSchematic(terminalOnly, undefined, text => text.length * 7);
    assert.deepEqual(
        terminalResult.networks.map(route => route.segments.length),
        [0, 0]
    );
});

test('rejects unknown endpoints and semantic role mismatches instead of miswiring', () => {
    const source = node('instance:source', 'instance', 'source', [['out', 'driver']]);
    const base: SchematicGraph = {
        fileUri: 'file:///invalid.sv',
        moduleKey: 'module:invalid:0',
        moduleName: 'invalid',
        nodes: [source],
        networks: [],
        diagnostics: [],
    };
    assert.throws(() => layoutSchematic({
        ...base,
        networks: [network('network:unknown', 'unknown', [{
            nodeId: source.id,
            pinId: 'missing',
            role: 'driver',
        }])],
    }, undefined, () => 0), {
        name: 'RangeError',
        message: /unknown.*pin.*network:unknown/i,
    });
    assert.throws(() => layoutSchematic({
        ...base,
        networks: [network('network:mismatch', 'mismatch', [{
            nodeId: source.id,
            pinId: source.pins[0].id,
            role: 'load',
        }])],
    }, undefined, () => 0), {
        name: 'RangeError',
        message: /role.*network:mismatch/i,
    });
});

test('serializes prototype-like and NUL-containing IDs without object-key loss', () => {
    const source = node('__proto__', 'port', 'source', [['nul\0out', 'driver']]);
    const sink = node('constructor\0sink', 'port', 'sink', [['__proto__', 'load']]);
    const graph: SchematicGraph = {
        fileUri: 'file:///special.sv',
        moduleKey: 'module:special:0',
        moduleName: 'special',
        nodes: [source, sink],
        networks: [network('__proto__\0network', 'special_name', [
            endpoint(source, 0),
            endpoint(sink, 0),
        ])],
        diagnostics: [],
    };

    const result = layoutSchematic(graph, undefined, text => text.length * 7);
    const serialized = serializeSchematicRenderModel(result);
    const roundTrip = JSON.parse(JSON.stringify(serialized)) as typeof serialized;

    assert.equal(result.nodes.get('__proto__')?.id, '__proto__');
    assert.equal(result.nodes.get('constructor\0sink')?.id, 'constructor\0sink');
    assert.deepEqual(roundTrip.nodes.map(candidate => candidate.id), graph.nodes.map(
        candidate => candidate.id
    ));
    assert.equal(roundTrip.networks[0].id, '__proto__\0network');
});

test('keeps colliding NUL node and pin pairs distinct through rendering', () => {
    const source = node('a', 'instance', 'source', [['b\0c', 'driver']]);
    const sink = node('a\0b', 'instance', 'sink', [['c', 'load']]);
    source.pins[0] = { ...source.pins[0], id: 'b\0c' };
    sink.pins[0] = { ...sink.pins[0], id: 'c' };
    const graph: SchematicGraph = {
        fileUri: 'file:///pin-key-collision.sv',
        moduleKey: 'module:pin-key-collision:0',
        moduleName: 'pin_key_collision',
        nodes: [source, sink],
        networks: [network('network:collision', 'collision', [
            endpoint(source, 0),
            endpoint(sink, 0),
        ])],
        diagnostics: [],
    };

    const result = layoutSchematic(graph, undefined, text => text.length * 7);
    const renderedSource = result.nodes.get(source.id)!;
    const renderedSink = result.nodes.get(sink.id)!;
    const serialized = serializeSchematicRenderModel(result);

    assert.notEqual(
        pinKey(source.id, source.pins[0].id),
        pinKey(sink.id, sink.pins[0].id)
    );
    assert.equal(renderedSource.pins[0].side, 'right');
    assert.equal(
        renderedSource.pins[0].anchor.x,
        renderedSource.bounds.x + renderedSource.bounds.width
    );
    assert.equal(renderedSink.pins[0].side, 'left');
    assert.equal(renderedSink.pins[0].anchor.x, renderedSink.bounds.x);
    assert.deepEqual(serialized.nodes.map(rendered => ({
        id: rendered.id,
        pinIds: rendered.pins.map(candidate => candidate.id),
    })), [
        { id: 'a', pinIds: ['b\0c'] },
        { id: 'a\0b', pinIds: ['c'] },
    ]);
});

test('exposes no runtime mutation path through maps arrays points or direction sets', () => {
    const result = layoutSchematic(complexGraph(), undefined, text => text.length * 7);
    const rendered = result.nodes.values().next().value!;
    const junction = result.junctions[0];
    assert.ok(junction, 'fan-out fixture should create a junction');

    assert.throws(() => (result.nodes as unknown as Map<string, unknown>).set(
        'changed',
        rendered
    ), TypeError);
    assert.throws(() => (result.networks as unknown as unknown[]).push({}), TypeError);
    assert.throws(() => {
        (rendered.bounds as Rectangle).x = -1;
    }, TypeError);
    assert.throws(() => (junction.directions as unknown as Set<string>).add('north'), TypeError);
    assert.throws(() => {
        (junction.point as { x: number }).x = -1;
    }, TypeError);
});

test('snapshots graph node pin network and endpoint getters once', () => {
    const input = node('port:observed-input', 'port', 'input', [['value', 'driver']]);
    const output = node('port:observed-output', 'port', 'output', [['value', 'load']]);
    const connected = network('network:observed', 'observed', [
        endpoint(input, 0),
        endpoint(output, 0),
    ]);
    const reads = new Map<string, number>();
    const observe = <T extends object>(value: T, label: string): T => new Proxy(value, {
        get(target, property, receiver) {
            if (typeof property === 'string') {
                const key = `${label}.${property}`;
                reads.set(key, (reads.get(key) ?? 0) + 1);
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const observedPins = [
        observe(input.pins[0], 'inputPin'),
        observe(output.pins[0], 'outputPin'),
    ];
    const observedNodes = [
        observe({ ...input, pins: [observedPins[0]] }, 'inputNode'),
        observe({ ...output, pins: [observedPins[1]] }, 'outputNode'),
    ];
    const observedEndpoints = connected.endpoints.map((value, index) =>
        observe(value, `endpoint${index}`)
    );
    const observedNetwork = observe({
        ...connected,
        endpoints: observedEndpoints,
    }, 'network');
    const base: SchematicGraph = {
        fileUri: 'file:///observed.sv',
        moduleKey: 'module:observed:0',
        moduleName: 'observed',
        nodes: observedNodes,
        networks: [observedNetwork],
        diagnostics: [],
    };
    const observedGraph = observe(base, 'graph');

    layoutSchematic(observedGraph, undefined, text => text.length * 7);

    for (const [key, count] of reads) {
        assert.equal(count, 1, `${key} was read ${count} times`);
    }
});

test('uses a safe width fallback for non-finite metrics and propagates measurer errors', () => {
    const graph = complexGraph();
    for (const width of [Number.NaN, Number.NEGATIVE_INFINITY, -10]) {
        const rendered = layoutSchematic(graph, undefined, () => width);
        assert.ok(rendered.networks.every(network => network.label === undefined));
        assert.doesNotThrow(() => JSON.stringify(serializeSchematicRenderModel(rendered)));
    }
    assert.throws(() => layoutSchematic(graph, undefined, () => {
        throw new Error('font backend unavailable');
    }), /font backend unavailable/);
});

test('never measures or places a network name on clear horizontal routes', () => {
    const input = node('port:label-input', 'port', 'input', [['value', 'driver']]);
    const output = node('port:label-output', 'port', 'output', [['value', 'load']]);
    const graph: SchematicGraph = {
        fileUri: 'file:///label.sv',
        moduleKey: 'module:label:0',
        moduleName: 'label',
        nodes: [input, output],
        networks: [network('network:label', 'short_name', [
            endpoint(input, 0),
            endpoint(output, 0),
        ])],
        diagnostics: [],
    };

    const measured: string[] = [];
    const rendered = layoutSchematic(graph, undefined, text => {
        measured.push(text);
        return text.length * 2;
    });
    const route = rendered.networks[0];

    assert.ok(route.segments.some(segment => segment.orientation === 'horizontal'));
    assert.equal(route.label, undefined);
    assert.equal(route.selectionDescription, 'short_name');
    assert.equal(measured.includes('short_name'), false);
});
