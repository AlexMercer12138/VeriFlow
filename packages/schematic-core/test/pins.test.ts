import assert from 'node:assert/strict';
import test from 'node:test';

import type {
    GraphNode,
    GraphPin,
    PinDirection,
    SchematicGraph,
    SchematicNetwork,
} from '../src/model';
import { pinKey, resolvePinSides, type PinKey } from '../src/pins';

if (false) {
    // @ts-expect-error PinKey values must be constructed through pinKey()
    const raw: PinKey = 'node\0pin';
    void raw;
}

function pin(id: string, direction: PinDirection): GraphPin {
    return {
        id,
        name: id.slice(id.lastIndexOf(':') + 1),
        direction,
        width: { kind: 'known', bits: 1 },
        readOnly: false,
    };
}

function node(
    id: string,
    kind: GraphNode['kind'],
    pins: GraphPin[]
): GraphNode {
    return {
        id,
        kind,
        label: id,
        pins,
        readOnly: false,
    };
}

function network(
    id: string,
    endpoints: Array<{ nodeId: string; pinId: string; role: PinDirection }>
): SchematicNetwork {
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

test('places loads left and drivers right', () => {
    const source = node('instance:source', 'instance', [
        pin('instance:source:data', 'driver'),
    ]);
    const sink = node('instance:sink', 'instance', [
        pin('instance:sink:data', 'load'),
    ]);
    const sides = resolvePinSides(graph([source, sink], [network('network:data', [
        { nodeId: source.id, pinId: source.pins[0].id, role: 'driver' },
        { nodeId: sink.id, pinId: sink.pins[0].id, role: 'load' },
    ])]));

    assert.equal(sides.get(pinKey(source.id, source.pins[0].id)), 'right');
    assert.equal(sides.get(pinKey(sink.id, sink.pins[0].id)), 'left');
    assert.equal([...sides.values()].includes('bottom' as never), false);
});

test('keeps NUL-containing node and pin identity pairs distinct', () => {
    const source = node('a', 'instance', [pin('b\0c', 'driver')]);
    const sink = node('a\0b', 'instance', [pin('c', 'load')]);
    const sourceKey = pinKey(source.id, source.pins[0].id);
    const sinkKey = pinKey(sink.id, sink.pins[0].id);
    const sides = resolvePinSides(graph([source, sink], [network(
        'network:collision',
        [
            { nodeId: source.id, pinId: source.pins[0].id, role: 'driver' },
            { nodeId: sink.id, pinId: sink.pins[0].id, role: 'load' },
        ]
    )]));

    assert.notEqual(sourceKey, sinkKey);
    assert.equal(pinKey(source.id, source.pins[0].id), sourceKey);
    assert.equal(sides.size, 2);
    assert.equal(sides.get(sourceKey), 'right');
    assert.equal(sides.get(sinkKey), 'left');

    const adversarialPairs = [
        ['', ''],
        ['"[', ']"'],
        ['\ud800', '\udfff'],
        ['\ud800\0"', '\udfff[]'],
        [':', '1:a'],
    ] as const;
    const adversarialKeys = adversarialPairs.map(([nodeId, pinId]) =>
        pinKey(nodeId, pinId)
    );
    assert.equal(new Set(adversarialKeys).size, adversarialPairs.length);
    assert.deepEqual(
        adversarialPairs.map(([nodeId, pinId]) => pinKey(nodeId, pinId)),
        adversarialKeys
    );
});

test('uses explicit peer roles to resolve bidirectional endpoints', () => {
    const driver = node('instance:driver', 'instance', [
        pin('instance:driver:out', 'driver'),
    ]);
    const load = node('instance:load', 'instance', [
        pin('instance:load:in', 'load'),
    ]);
    const bidirectionalLoad = node('instance:bidi-load', 'instance', [
        pin('instance:bidi-load:io', 'bidirectional'),
    ]);
    const bidirectionalDriver = node('instance:bidi-driver', 'instance', [
        pin('instance:bidi-driver:io', 'bidirectional'),
    ]);
    const sides = resolvePinSides(graph([
        driver,
        load,
        bidirectionalLoad,
        bidirectionalDriver,
    ], [
        network('network:driven', [
            { nodeId: driver.id, pinId: driver.pins[0].id, role: 'driver' },
            {
                nodeId: bidirectionalLoad.id,
                pinId: bidirectionalLoad.pins[0].id,
                role: 'bidirectional',
            },
        ]),
        network('network:loaded', [
            { nodeId: load.id, pinId: load.pins[0].id, role: 'load' },
            {
                nodeId: bidirectionalDriver.id,
                pinId: bidirectionalDriver.pins[0].id,
                role: 'bidirectional',
            },
        ]),
    ]));

    assert.equal(
        sides.get(pinKey(bidirectionalLoad.id, bidirectionalLoad.pins[0].id)),
        'left'
    );
    assert.equal(
        sides.get(pinKey(bidirectionalDriver.id, bidirectionalDriver.pins[0].id)),
        'right'
    );
});

test('resolves an all-bidirectional network from stable graph declaration order', () => {
    const boundary = node('port:shared', 'port', [
        pin('port:shared:shared', 'bidirectional'),
    ]);
    const firstInstance = node('instance:z-first', 'instance', [
        pin('instance:z-first:later-pin', 'bidirectional'),
        pin('instance:z-first:first-pin', 'bidirectional'),
    ]);
    const secondInstance = node('instance:a-second', 'instance', [
        pin('instance:a-second:io', 'bidirectional'),
    ]);
    const model = graph([boundary, firstInstance, secondInstance], [
        network('network:shared', [
            {
                nodeId: secondInstance.id,
                pinId: secondInstance.pins[0].id,
                role: 'bidirectional',
            },
            {
                nodeId: firstInstance.id,
                pinId: firstInstance.pins[1].id,
                role: 'bidirectional',
            },
            {
                nodeId: firstInstance.id,
                pinId: firstInstance.pins[0].id,
                role: 'bidirectional',
            },
            {
                nodeId: boundary.id,
                pinId: boundary.pins[0].id,
                role: 'bidirectional',
            },
        ]),
    ]);

    const expected = [
        [pinKey(boundary.id, boundary.pins[0].id), 'left'],
        [pinKey(firstInstance.id, firstInstance.pins[0].id), 'right'],
        [pinKey(firstInstance.id, firstInstance.pins[1].id), 'left'],
        [pinKey(secondInstance.id, secondInstance.pins[0].id), 'left'],
    ];
    assert.deepEqual([...resolvePinSides(model)], expected);
    assert.deepEqual([...resolvePinSides(model)], expected);
});

test('places top-level input right and output and inout left', () => {
    const input = node('port:input', 'port', [
        pin('port:input:value', 'driver'),
    ]);
    const output = node('port:output', 'port', [
        pin('port:output:value', 'load'),
    ]);
    const inout = node('port:inout', 'port', [
        pin('port:inout:value', 'bidirectional'),
    ]);
    const sides = resolvePinSides(graph([input, output, inout], []));

    assert.equal(sides.get(pinKey(input.id, input.pins[0].id)), 'right');
    assert.equal(sides.get(pinKey(output.id, output.pins[0].id)), 'left');
    assert.equal(sides.get(pinKey(inout.id, inout.pins[0].id)), 'left');
});
