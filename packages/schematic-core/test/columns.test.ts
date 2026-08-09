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

    assert.equal(assignment.nodeColumn.get(sourceFirst.id), 1);
    assert.equal(assignment.nodeColumn.get(sourceSecond.id), 2);
    assert.equal(assignment.nodeColumn.get(sink.id), 2);
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

    assert.equal(assignment.nodeColumn.get(bidirectional.id), 1);
    assert.equal(assignment.nodeColumn.get(load.id), 2);
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

    assert.equal(assignment.nodeColumn.get(source.id), 1);
    assert.equal(assignment.nodeColumn.get(target.id), 2);
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
