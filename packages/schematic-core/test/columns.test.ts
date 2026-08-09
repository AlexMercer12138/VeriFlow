import assert from 'node:assert/strict';
import test from 'node:test';

import { assignColumns } from '../src';
import type {
    GraphNode,
    GraphPin,
    PinDirection,
    SchematicGraph,
    SchematicNetwork,
} from '../src/model';

type Endpoint = SchematicNetwork['endpoints'][number];

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
    directions: readonly PinDirection[]
): GraphNode {
    return {
        id,
        kind,
        label: id,
        pins: directions.map((direction, index) =>
            pin(id, `pin${index}`, direction)
        ),
        readOnly: false,
    };
}

function endpoint(
    graphNode: GraphNode,
    pinIndex: number,
    role = graphNode.pins[pinIndex].direction
): Endpoint {
    return {
        nodeId: graphNode.id,
        pinId: graphNode.pins[pinIndex].id,
        role,
    };
}

function network(id: string, endpoints: Endpoint[]): SchematicNetwork {
    return {
        id,
        name: id,
        width: { kind: 'known', bits: 1 },
        endpoints,
    };
}

function graph(
    nodes: GraphNode[],
    networks: SchematicNetwork[]
): SchematicGraph {
    return {
        fileUri: 'file:///top.sv',
        moduleKey: 'module:top:0',
        moduleName: 'top',
        nodes,
        networks,
        diagnostics: [],
    };
}

test('returns no columns for an empty graph', () => {
    const assignment = assignColumns(graph([], []));

    assert.deepEqual(assignment.columns, []);
    assert.deepEqual([...assignment.nodeColumn], []);
    assert.deepEqual([...assignment.feedbackNetworkIds], []);
});

test('places a lone internal node in the first occupied column', () => {
    const internal = node('instance:internal', 'instance', []);

    const assignment = assignColumns(graph([internal], []));

    assert.deepEqual(assignment.columns, [['instance:internal']]);
    assert.equal(assignment.nodeColumn.get(internal.id), 0);
});

test('places a lone right boundary in the first occupied column', () => {
    const output = node('port:output', 'port', ['load']);

    const assignment = assignColumns(graph([output], []));

    assert.deepEqual(assignment.columns, [['port:output']]);
    assert.equal(assignment.nodeColumn.get(output.id), 0);
});

test('ranks a no-input chain and island from column zero', () => {
    const source = node('instance:source', 'instance', ['driver']);
    const island = node('instance:island', 'instance', []);
    const sink = node('instance:sink', 'instance', ['load', 'driver']);
    const output = node('port:output', 'port', ['load']);
    const model = graph([source, island, sink, output], [
        network('network:source-sink', [endpoint(source, 0), endpoint(sink, 0)]),
        network('network:sink-output', [endpoint(sink, 1), endpoint(output, 0)]),
    ]);

    const assignment = assignColumns(model);

    assert.deepEqual(assignment.columns, [
        ['instance:source', 'instance:island'],
        ['instance:sink'],
        ['port:output'],
    ]);
});

test('assigns a driver-to-load chain to increasing columns', () => {
    const input = node('port:input', 'port', ['driver']);
    const first = node('instance:first', 'instance', ['load', 'driver']);
    const second = node('instance:second', 'instance', ['load', 'driver']);
    const output = node('port:output', 'port', ['load']);
    const model = graph([input, first, second, output], [
        network('network:input-first', [endpoint(input, 0), endpoint(first, 0)]),
        network('network:first-second', [endpoint(first, 1), endpoint(second, 0)]),
        network('network:second-output', [endpoint(second, 1), endpoint(output, 0)]),
    ]);

    const assignment = assignColumns(model);

    assert.deepEqual(assignment.columns, [
        ['port:input'],
        ['instance:first'],
        ['instance:second'],
        ['port:output'],
    ]);
});

test('keeps fan-out peers in graph source order instead of ID order', () => {
    const input = node('port:input', 'port', ['driver']);
    const sourceFirst = node('instance:z-source-first', 'instance', ['load']);
    const sourceSecond = node('instance:a-source-second', 'instance', ['load']);
    const output = node('port:output', 'port', ['load']);
    const model = graph([input, sourceFirst, sourceSecond, output], [
        network('network:fan-out', [
            endpoint(sourceSecond, 0),
            endpoint(input, 0),
            endpoint(sourceFirst, 0),
        ]),
        network('network:output', [endpoint(input, 0), endpoint(output, 0)]),
    ]);

    const assignment = assignColumns(model);

    assert.deepEqual(assignment.columns[1], [
        'instance:z-source-first',
        'instance:a-source-second',
    ]);
    assert.equal(assignment.nodeColumn.get(output.id), 2);
});

test('places disconnected internal islands deterministically', () => {
    const input = node('port:input', 'port', ['driver']);
    const island = node('instance:island', 'instance', ['load']);
    const connected = node('instance:connected', 'instance', ['load', 'driver']);
    const output = node('port:output', 'port', ['load']);
    const model = graph([input, island, connected, output], [
        network('network:input', [endpoint(input, 0), endpoint(connected, 0)]),
        network('network:output', [endpoint(connected, 1), endpoint(output, 0)]),
    ]);

    const assignment = assignColumns(model);

    assert.deepEqual(assignment.columns, [
        ['port:input'],
        ['instance:island', 'instance:connected'],
        ['port:output'],
    ]);
});

test('condenses feedback and identifies every network internal to its SCC', () => {
    const input = node('port:input', 'port', ['driver']);
    const first = node('instance:a', 'instance', ['load', 'driver', 'load']);
    const second = node('instance:b', 'instance', ['load', 'driver']);
    const output = node('port:output', 'port', ['load']);
    const model = graph([input, first, second, output], [
        network('network:input-a', [endpoint(input, 0), endpoint(first, 0)]),
        network('network:a-b', [endpoint(first, 1), endpoint(second, 0)]),
        network('network:b-a', [endpoint(second, 1), endpoint(first, 2)]),
        network('network:b-output', [endpoint(second, 1), endpoint(output, 0)]),
    ]);

    const assignment = assignColumns(model);

    assert.equal(assignment.nodeColumn.get(input.id), 0);
    assert.equal(assignment.nodeColumn.get(first.id), 1);
    assert.equal(assignment.nodeColumn.get(second.id), 1);
    assert.equal(assignment.nodeColumn.get(output.id), 2);
    assert.deepEqual([...assignment.feedbackNetworkIds], [
        'network:a-b',
        'network:b-a',
    ]);
});

test('keeps output and inout ports together on the final right boundary', () => {
    const input = node('port:input', 'port', ['driver']);
    const inout = node('port:inout', 'port', ['bidirectional']);
    const internal = node('instance:internal', 'instance', ['load', 'driver']);
    const output = node('port:output', 'port', ['load']);
    const model = graph([input, inout, internal, output], [
        network('network:input', [endpoint(input, 0), endpoint(internal, 0)]),
        network('network:output', [endpoint(internal, 1), endpoint(output, 0)]),
        network('network:inout', [endpoint(internal, 1), endpoint(inout, 0)]),
    ]);

    const assignment = assignColumns(model);

    assert.deepEqual(assignment.columns, [
        ['port:input'],
        ['instance:internal'],
        ['port:inout', 'port:output'],
    ]);
});

test('infers one driverless source from graph order without mutating semantics', () => {
    const sourceFirst = node('instance:z-source-first', 'instance', ['bidirectional']);
    const sourceSecond = node('instance:a-source-second', 'instance', ['bidirectional']);
    const sink = node('instance:sink', 'instance', ['bidirectional']);
    const shared = network('network:shared', [
        endpoint(sink, 0),
        endpoint(sourceSecond, 0),
        endpoint(sourceFirst, 0),
    ]);
    const model = graph([sourceFirst, sourceSecond, sink], [shared]);
    const originalEndpoints = structuredClone(shared.endpoints);

    const assignment = assignColumns(model);

    assert.equal(assignment.nodeColumn.get(sourceFirst.id), 0);
    assert.equal(assignment.nodeColumn.get(sourceSecond.id), 1);
    assert.equal(assignment.nodeColumn.get(sink.id), 1);
    assert.deepEqual(shared.endpoints, originalEndpoints);
});

test('prefers a bidirectional endpoint over a load as driverless source', () => {
    const load = node('instance:load', 'instance', ['load']);
    const bidirectional = node('instance:bidirectional', 'instance', [
        'bidirectional',
    ]);
    const model = graph([load, bidirectional], [network('network:driverless', [
        endpoint(load, 0),
        endpoint(bidirectional, 0),
    ])]);

    const assignment = assignColumns(model);

    assert.equal(assignment.nodeColumn.get(bidirectional.id), 0);
    assert.equal(assignment.nodeColumn.get(load.id), 1);
});

test('does not treat a driverless placement source as self-cycle feedback', () => {
    const shared = node('instance:shared', 'instance', [
        'bidirectional',
        'load',
    ]);
    const model = graph([shared], [network('network:driverless-self', [
        endpoint(shared, 0),
        endpoint(shared, 1),
    ])]);

    const assignment = assignColumns(model);

    assert.deepEqual([...assignment.feedbackNetworkIds], []);
});

test('keeps inferred placement cycles out of semantic feedback', () => {
    const first = node('instance:first', 'instance', [
        'bidirectional',
        'load',
    ]);
    const second = node('instance:second', 'instance', ['load', 'driver']);
    const model = graph([first, second], [
        network('network:inferred-forward', [
            endpoint(first, 0),
            endpoint(second, 0),
        ]),
        network('network:explicit-return', [
            endpoint(second, 1),
            endpoint(first, 1),
        ]),
    ]);

    const assignment = assignColumns(model);

    assert.equal(
        assignment.nodeColumn.get(first.id),
        assignment.nodeColumn.get(second.id)
    );
    assert.deepEqual([...assignment.feedbackNetworkIds], []);
});

test('marks an explicit driver-to-bidirectional self-cycle as feedback', () => {
    const shared = node('instance:shared', 'instance', [
        'driver',
        'bidirectional',
    ]);
    const model = graph([shared], [network('network:explicit-bidi-self', [
        endpoint(shared, 0),
        endpoint(shared, 1),
    ])]);

    const assignment = assignColumns(model);

    assert.deepEqual(
        [...assignment.feedbackNetworkIds],
        ['network:explicit-bidi-self']
    );
});

test('deduplicates endpoint pairs and retains self-cycle feedback semantics', () => {
    const source = node('instance:source', 'instance', ['driver', 'driver']);
    const target = node('instance:target', 'instance', ['load', 'load', 'driver']);
    const model = graph([source, target], [
        network('network:duplicates', [
            endpoint(source, 0),
            endpoint(source, 1),
            endpoint(target, 0),
            endpoint(target, 1),
        ]),
        network('network:self-cycle', [endpoint(target, 2), endpoint(target, 0)]),
    ]);

    const assignment = assignColumns(model);

    assert.equal(assignment.nodeColumn.get(source.id), 0);
    assert.equal(assignment.nodeColumn.get(target.id), 1);
    assert.deepEqual([...assignment.feedbackNetworkIds], ['network:self-cycle']);
});

test('returns deeply equal deterministic results on repeated runs', () => {
    const input = node('port:input', 'port', ['driver']);
    const first = node('instance:first', 'instance', ['load']);
    const second = node('instance:second', 'instance', ['load']);
    const model = graph([input, first, second], [network('network:data', [
        endpoint(second, 0),
        endpoint(first, 0),
        endpoint(input, 0),
    ])]);

    assert.deepEqual(assignColumns(model), assignColumns(model));
});

test('handles a deep dependency chain without recursive overflow', () => {
    const input = node('port:input', 'port', ['driver']);
    const internalCount = 15_000;
    const internals = Array.from({ length: internalCount }, (_, index) =>
        node(`instance:deep-${index}`, 'instance', ['bidirectional'])
    );
    const networks = [
        network('network:deep-input', [
            endpoint(input, 0),
            endpoint(internals[0], 0, 'load'),
        ]),
        ...Array.from({ length: internalCount - 1 }, (_, index) =>
            network(`network:deep-${index}`, [
                endpoint(internals[index], 0, 'driver'),
                endpoint(internals[index + 1], 0, 'load'),
            ])
        ),
    ];

    const assignment = assignColumns(graph([input, ...internals], networks));

    assert.equal(assignment.nodeColumn.get(input.id), 0);
    assert.equal(
        assignment.nodeColumn.get(internals[internals.length - 1].id),
        internalCount
    );
});

test('handles wide fan-out while preserving graph source order', () => {
    const input = node('port:input', 'port', ['driver']);
    const sinkCount = 20_000;
    const sinks = Array.from({ length: sinkCount }, (_, index) =>
        node(`instance:fanout-${index}`, 'instance', ['load'])
    );
    const shared = network('network:wide-fanout', [
        endpoint(input, 0),
        ...sinks.map(sink => endpoint(sink, 0)),
    ]);

    const assignment = assignColumns(graph([input, ...sinks], [shared]));

    assert.equal(assignment.columns[1].length, sinkCount);
    assert.equal(assignment.columns[1][0], sinks[0].id);
    assert.equal(
        assignment.columns[1][assignment.columns[1].length - 1],
        sinks[sinks.length - 1].id
    );
});

test('handles many disconnected nodes without argument-list overflow', () => {
    const nodeCount = 150_000;
    const nodes = Array.from({ length: nodeCount }, (_, index) =>
        node(`instance:disconnected-${index}`, 'instance', [])
    );

    const assignment = assignColumns(graph(nodes, []));

    assert.equal(assignment.nodeColumn.size, nodeCount);
    assert.equal(assignment.columns.flat().length, nodeCount);
});
