import assert from 'node:assert/strict';
import test from 'node:test';

import { assignColumns, layoutSchematic, resolvePinSides } from '../src';
import {
    createEmptyArchDesign,
    parseArchDesignValue,
    projectArchDesignGraph,
    projectArchDesignPlacement,
    validateArchDesign,
    type ArchDesign,
    type ArchDesignModuleDefinition,
} from '../src/archDesign';
import { createInterfaceProtocolCatalog } from '../src/interfaces';
import { pinKey } from '../src/pins';

function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const result = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (result.status !== 'editable') throw new Error('expected editable design');
    return result.design;
}

function assertUniqueAndLayoutable(design: ArchDesign, graph: ReturnType<
    typeof projectArchDesignGraph
>['graph']): void {
    const nodeIds = graph.nodes.map(node => node.id);
    const pinIds = graph.nodes.flatMap(node => node.pins.map(pin => pin.id));
    const networkIds = graph.networks.map(network => network.id);
    assert.equal(new Set(nodeIds).size, nodeIds.length);
    assert.equal(new Set(pinIds).size, pinIds.length);
    assert.equal(new Set(networkIds).size, networkIds.length);

    let columns: ReturnType<typeof assignColumns> | undefined;
    assert.doesNotThrow(() => {
        columns = assignColumns(graph);
    });
    assert.ok(columns);
    assert.equal(columns.nodeColumn.size, graph.nodes.length);
    assert.doesNotThrow(() => layoutSchematic(
        graph,
        undefined,
        text => text.length * 7
    ));
    let placement: ReturnType<typeof projectArchDesignPlacement> | undefined;
    assert.doesNotThrow(() => {
        placement = projectArchDesignPlacement(design, graph);
    });
    assert.ok(placement);
    assert.equal(Object.keys(placement.nodes).length, graph.nodes.length);
}

const coreDefinition: ArchDesignModuleDefinition = {
    key: 'rtl/core.sv#core',
    name: 'core',
    parameters: [],
    ports: [
        { name: 'clk', direction: 'input', width: { kind: 'known', bits: 1 } },
        { name: 'data_o', direction: 'output', width: { kind: 'known', bits: 8 } },
        { name: 'enable', direction: 'input', width: { kind: 'known', bits: 1 } },
    ],
};

const ioDefinition: ArchDesignModuleDefinition = {
    key: 'rtl/io_cell.sv#io_cell',
    name: 'io_cell',
    parameters: [],
    ports: [
        { name: 'data_i', direction: 'input', width: { kind: 'known', bits: 8 } },
        { name: 'gpio_o', direction: 'output', width: { kind: 'known', bits: 8 } },
        { name: 'gpio_i', direction: 'input', width: { kind: 'known', bits: 8 } },
    ],
};

test('projects ports from the selected duplicate module definition', () => {
    const first: ArchDesignModuleDefinition = {
        key: 'rtl/first/duplicate.v#duplicate',
        name: 'duplicate',
        parameters: [],
        ports: [{
            name: 'first_result',
            direction: 'output',
            width: { kind: 'known', bits: 1 },
        }],
    };
    const second: ArchDesignModuleDefinition = {
        key: 'rtl/second/duplicate.v#duplicate',
        name: 'duplicate',
        parameters: [],
        ports: [{
            name: 'second_result',
            direction: 'output',
            width: { kind: 'known', bits: 8 },
        }],
    };
    const design = designOf({
        instances: [{
            name: 'u_duplicate_0',
            module: 'duplicate',
            definitionKey: second.key,
        }],
    });

    const projection = projectArchDesignGraph(design, [first, second], {
        fileUri: 'file:///workspace/duplicate.ad',
    });
    const instance = projection.graph.nodes.find(
        node => node.id === 'instance:u_duplicate_0'
    );

    assert.equal(projection.validation.valid, true);
    assert.deepEqual(instance?.pins.map(pin => [pin.name, pin.width]), [[
        'second_result',
        { kind: 'known', bits: 8 },
    ]]);
    assert.equal(instance?.definitionKey, second.key);
});

test('keeps implicit zero sources out of the graph while preserving receiver networks', () => {
    const sink: ArchDesignModuleDefinition = {
        key: 'rtl/sink.v#sink',
        name: 'sink',
        parameters: [],
        ports: [
            { name: 'connected_i', direction: 'input', width: { kind: 'known', bits: 8 } },
            { name: 'open_i', direction: 'input', width: { kind: 'known', bits: 1 } },
        ],
    };
    const design = designOf({
        instances: [{ name: 'u_sink', module: 'sink' }],
        connections: [{
            name: 'driverless',
            endpoints: [{ kind: 'instance', instance: 'u_sink', port: 'connected_i' }],
        }],
    });

    const projection = projectArchDesignGraph(design, [sink], {
        fileUri: 'file:///workspace/implicit-zero.ad',
    });

    assert.equal(projection.validation.valid, true);
    assert.deepEqual(projection.graph.nodes.map(node => node.id), ['instance:u_sink']);
    assert.deepEqual(projection.graph.nodes.filter(node => node.kind === 'constant'), []);
    assert.deepEqual(projection.graph.networks.map(network => network.id), [
        'network:driverless',
    ]);
    assert.deepEqual(projection.graph.networks[0].endpoints, [{
        nodeId: 'instance:u_sink',
        pinId: 'instance:u_sink:connected_i',
        role: 'load',
    }]);
});

test('projects an ordered schema-v1 design and exposes inout feedback flow', () => {
    const presentation = {
        nodes: {
            'instance:u_core': { column: 7, order: 2, offset: 13, userPositioned: true },
        },
    };
    const design = designOf({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'result', direction: 'output', width: 8 },
            { name: 'gpio', direction: 'inout', width: 8 },
        ],
        instances: [
            { name: 'u_core', module: 'core' },
            { name: 'u_io', module: 'io_cell' },
        ],
        connections: [
            {
                name: 'clock',
                endpoints: [
                    { kind: 'port', port: 'clk' },
                    { kind: 'instance', instance: 'u_core', port: 'clk' },
                ],
            },
            {
                name: 'result',
                endpoints: [
                    { kind: 'instance', instance: 'u_core', port: 'data_o' },
                    { kind: 'port', port: 'result' },
                ],
            },
            {
                name: 'driverless',
                endpoints: [
                    { kind: 'instance', instance: 'u_io', port: 'data_i' },
                ],
                defaults: { 'u_io.data_i': "8'h5a" },
            },
            {
                name: 'gpio_drive',
                endpoints: [
                    { kind: 'instance', instance: 'u_io', port: 'gpio_o' },
                    { kind: 'port', port: 'gpio', signal: 'o' },
                ],
            },
            {
                name: 'gpio_readback',
                endpoints: [
                    { kind: 'port', port: 'gpio', signal: 'i' },
                    { kind: 'instance', instance: 'u_io', port: 'gpio_i' },
                ],
            },
        ],
        defaults: { 'u_core.enable': "1'b1" },
        presentation,
    });
    const presentationBefore = JSON.parse(JSON.stringify(design.presentation));

    const projection = projectArchDesignGraph(design, [coreDefinition, ioDefinition], {
        fileUri: 'file:///workspace/soc_top.ad',
    });
    const { graph } = projection;

    assert.deepEqual({
        fileUri: graph.fileUri,
        moduleKey: graph.moduleKey,
        moduleName: graph.moduleName,
    }, {
        fileUri: 'file:///workspace/soc_top.ad',
        moduleKey: 'arch-design:soc_top',
        moduleName: 'soc_top',
    });
    assert.deepEqual(graph.nodes.map(node => node.id), [
        'port:clk',
        'instance:u_core',
        'instance:u_io',
        'port:result',
        'port:gpio',
    ]);
    assert.deepEqual(graph.nodes.slice(0, 5).map(node => [
        node.id,
        node.kind,
        node.definitionKey,
        node.readOnly,
    ]), [
        ['port:clk', 'port', undefined, false],
        ['instance:u_core', 'instance', 'rtl/core.sv#core', false],
        ['instance:u_io', 'instance', 'rtl/io_cell.sv#io_cell', false],
        ['port:result', 'port', undefined, false],
        ['port:gpio', 'port', undefined, false],
    ]);
    assert.deepEqual(
        graph.nodes.find(node => node.id === 'instance:u_core')?.pins.map(pin => pin.name),
        ['clk', 'data_o', 'enable']
    );
    assert.deepEqual(
        graph.nodes.find(node => node.id === 'instance:u_io')?.pins.map(pin => pin.name),
        ['data_i', 'gpio_o', 'gpio_i']
    );
    const inoutNode = graph.nodes.find(node => node.id === 'port:gpio');
    assert.ok(inoutNode);
    assert.deepEqual(inoutNode.pins.map(pin => [pin.name, pin.direction]), [
        ['gpio_o', 'load'],
        ['gpio_t', 'load'],
        ['gpio_i', 'driver'],
    ]);
    assert.deepEqual(inoutNode.pins.map(pin => pin.width), [
        { kind: 'known', bits: 8 },
        { kind: 'known', bits: 8 },
        { kind: 'known', bits: 8 },
    ]);
    assert.equal(graph.nodes.some(node => node.id.startsWith('default:')), false);

    assert.deepEqual(graph.networks.map(network => network.id), [
        'network:clock',
        'network:result',
        'network:driverless',
        'network:gpio_drive',
        'network:gpio_readback',
    ]);
    assert.deepEqual(graph.networks.map(network => network.width), [
        { kind: 'known', bits: 1 },
        { kind: 'known', bits: 8 },
        { kind: 'known', bits: 8 },
        { kind: 'known', bits: 8 },
        { kind: 'known', bits: 8 },
    ]);
    assert.deepEqual(graph.networks.map(network =>
        network.endpoints.map(endpoint => endpoint.role)), [
        ['driver', 'load'],
        ['driver', 'load'],
        ['load'],
        ['driver', 'load'],
        ['driver', 'load'],
    ]);
    assert.deepEqual(graph.networks.map(network =>
        network.endpoints.map(endpoint => endpoint.nodeId)), [
        ['port:clk', 'instance:u_core'],
        ['instance:u_core', 'port:result'],
        ['instance:u_io'],
        ['instance:u_io', 'port:gpio'],
        ['port:gpio', 'instance:u_io'],
    ]);
    assert.deepEqual(
        projection.validation,
        validateArchDesign(design, [coreDefinition, ioDefinition])
    );
    assert.deepEqual(graph.diagnostics, []);
    assert.equal(projection.validation.valid, true);
    assert.ok(Object.isFrozen(projection.validation));
    assert.equal(JSON.stringify(design.presentation), JSON.stringify(presentationBefore));

    const sides = resolvePinSides(graph);
    const input = graph.nodes.find(node => node.id === 'port:clk')!;
    const output = graph.nodes.find(node => node.id === 'port:result')!;
    assert.equal(sides.get(pinKey(input.id, input.pins[0].id)), 'right');
    assert.equal(sides.get(pinKey(output.id, output.pins[0].id)), 'left');
    assert.equal(sides.get(pinKey(inoutNode.id, inoutNode.pins[0].id)), 'left');
    const columns = assignColumns(graph);
    assert.equal(columns.feedbackNetworkIds.has('network:gpio_readback'), true);
    assert.equal(columns.feedbackNetworkIds.has('network:gpio_drive'), true);
});

test('keeps defaults hidden when public keys collide with endpoint names', () => {
    const consumer: ArchDesignModuleDefinition = {
        key: 'rtl/consumer.sv#consumer',
        name: 'consumer',
        parameters: [],
        ports: [{ name: 't', direction: 'input', width: { kind: 'known', bits: 1 } }],
    };
    const design = designOf({
        ports: [
            { name: 'node', direction: 'inout', width: 8 },
            { name: 'source', direction: 'input' },
        ],
        instances: [{ name: 'node', module: 'consumer' }],
        connections: [{
            name: 'instance_t',
            endpoints: [
                { kind: 'port', port: 'source' },
                { kind: 'instance', instance: 'node', port: 't' },
            ],
        }],
        defaults: { 'node.o': "8'b0" },
    });

    const projection = projectArchDesignGraph(design, [consumer], {
        fileUri: 'file:///workspace/collision.ad',
    });
    assert.equal(projection.graph.nodes.some(node => node.id.startsWith('default:')), false);
    assert.equal(projection.graph.networks.some(network =>
        network.id.startsWith('network:default:')), false);
});

test('keeps identical connection defaults off a driverless network', () => {
    const design = designOf({
        ports: [
            { name: 'first', direction: 'output' },
            { name: 'second', direction: 'output' },
        ],
        connections: [{
            name: 'shared',
            endpoints: [
                { kind: 'port', port: 'first' },
                { kind: 'port', port: 'second' },
            ],
            defaults: {
                'first.value': "1'b0",
                'second.value': "1'b0",
            },
        }],
    });

    const projection = projectArchDesignGraph(design, [], {
        fileUri: 'file:///workspace/identical-defaults.ad',
    });
    const network = projection.graph.networks[0];

    assert.equal(projection.validation.valid, true);
    assert.deepEqual(projection.validation.effectiveDefaults, [{
        endpoint: 'first.value',
        expression: "1'b0",
        origin: 'connection',
        connection: 'shared',
    }, {
        endpoint: 'second.value',
        expression: "1'b0",
        origin: 'connection',
        connection: 'shared',
    }]);
    assert.deepEqual(projection.graph.nodes.map(node => node.id), [
        'port:first',
        'port:second',
    ]);
    assert.deepEqual(network.endpoints.map(endpoint => endpoint.role), [
        'load',
        'load',
    ]);
    assert.equal(network.endpoints.filter(endpoint => endpoint.role === 'driver').length, 0);
});

test('treats a bidirectional endpoint as a source without projecting a receiver default', () => {
    const bidirectionalDefinition: ArchDesignModuleDefinition = {
        key: 'rtl/pad.sv#pad',
        name: 'pad',
        parameters: [],
        ports: [{
            name: 'io',
            direction: 'inout',
            width: { kind: 'known', bits: 1 },
        }],
    };
    const withoutDefault = designOf({
        ports: [{ name: 'sink', direction: 'output' }],
        instances: [{ name: 'u_pad', module: 'pad' }],
        connections: [{
            name: 'pad_value',
            endpoints: [
                { kind: 'instance', instance: 'u_pad', port: 'io' },
                { kind: 'port', port: 'sink' },
            ],
        }],
    });

    const unconfigured = projectArchDesignGraph(withoutDefault, [bidirectionalDefinition], {
        fileUri: 'file:///workspace/bidirectional-source.ad',
    });

    assert.deepEqual(unconfigured.validation.diagnostics, []);
    assert.deepEqual(unconfigured.validation.effectiveDefaults, []);
    assert.deepEqual(unconfigured.graph.nodes.map(node => node.id), [
        'instance:u_pad',
        'port:sink',
    ]);

    const withDefault = {
        ...withoutDefault,
        defaults: { 'sink.value': "1'b0" },
    } as ArchDesign;
    const projection = projectArchDesignGraph(withDefault, [bidirectionalDefinition], {
        fileUri: 'file:///workspace/bidirectional-default.ad',
    });

    assert.deepEqual(projection.validation.diagnostics, []);
    assert.deepEqual(projection.validation.effectiveDefaults, []);
    assert.deepEqual(projection.graph.nodes.map(node => node.id), [
        'instance:u_pad',
        'port:sink',
    ]);
    assert.deepEqual(projection.graph.networks, [{
        id: 'network:pad_value',
        name: 'pad_value',
        width: { kind: 'known', bits: 1 },
        endpoints: [{
            nodeId: 'instance:u_pad',
            pinId: 'instance:u_pad:io',
            role: 'bidirectional',
        }, {
            nodeId: 'port:sink',
            pinId: 'port:sink:value',
            role: 'load',
        }],
    }]);

    const unsafeDefault = {
        ...withoutDefault,
        defaults: { 'sink.value': 'side_effect()' },
    } as ArchDesign;
    assert.deepEqual(
        validateArchDesign(unsafeDefault, [bidirectionalDefinition]).diagnostics.map(
            item => [item.path, item.code]
        ),
        [['$.defaults.sink.value', 'AD_DEFAULT_EXPRESSION']]
    );
});

test('keeps a receiver default off its driverless network', () => {
    const design = designOf({
        ports: [
            { name: 'defaulted', direction: 'output' },
            { name: 'peer', direction: 'output' },
        ],
        connections: [{
            name: 'shared',
            endpoints: [
                { kind: 'port', port: 'defaulted' },
                { kind: 'port', port: 'peer' },
            ],
            defaults: { 'defaulted.value': "1'b1" },
        }],
    });

    const projection = projectArchDesignGraph(design, [], {
        fileUri: 'file:///workspace/partial-default.ad',
    });

    assert.equal(projection.validation.valid, true);
    assert.deepEqual(projection.validation.diagnostics, []);
    assert.deepEqual(projection.validation.effectiveDefaults, [{
        endpoint: 'defaulted.value',
        expression: "1'b1",
        origin: 'connection',
        connection: 'shared',
    }]);
    assert.deepEqual(projection.graph.nodes.map(node => node.id), [
        'port:defaulted',
        'port:peer',
    ]);
    assert.deepEqual(projection.graph.networks[0].endpoints.map(endpoint => endpoint.role), [
        'load',
        'load',
    ]);
});

test('rejects conflicting defaults without projecting a driver or undriven cascades', () => {
    const design = designOf({
        ports: [
            { name: 'first', direction: 'output' },
            { name: 'second', direction: 'output' },
        ],
        connections: [{
            name: 'shared',
            endpoints: [
                { kind: 'port', port: 'first' },
                { kind: 'port', port: 'second' },
            ],
            defaults: {
                'first.value': "1'b0",
                'second.value': "1'b1",
            },
        }],
    });

    const projection = projectArchDesignGraph(design, [], {
        fileUri: 'file:///workspace/conflicting-defaults.ad',
    });

    assert.equal(projection.validation.valid, false);
    assert.deepEqual(projection.validation.diagnostics.map(item => [item.path, item.code]), [
        ['$.connections[0].defaults.second.value', 'AD_DEFAULT_CONFLICT'],
    ]);
    assert.deepEqual(projection.validation.effectiveDefaults, [{
        endpoint: 'first.value',
        expression: "1'b0",
        origin: 'connection',
        connection: 'shared',
    }, {
        endpoint: 'second.value',
        expression: "1'b1",
        origin: 'connection',
        connection: 'shared',
    }]);
    assert.deepEqual(projection.graph.nodes.map(node => node.id), [
        'port:first',
        'port:second',
    ]);
    assert.deepEqual(projection.graph.networks[0].endpoints.map(endpoint => endpoint.role), [
        'load',
        'load',
    ]);
    assert.equal(projection.graph.diagnostics[0].code, 'AD_DEFAULT_CONFLICT');
});

test('keeps a wide defaulted receiver network visible without a synthetic source', () => {
    const portNames = Array.from({ length: 600 }, (_, index) => `sink_${index}`);
    const consumer: ArchDesignModuleDefinition = {
        key: 'rtl/wide_consumer.sv#wide_consumer',
        name: 'wide_consumer',
        parameters: [],
        ports: portNames.map(name => ({
            name,
            direction: 'input' as const,
            width: { kind: 'known' as const, bits: 1 },
        })),
    };
    const design = designOf({
        instances: [{ name: 'u_consumer', module: 'wide_consumer' }],
        connections: [{
            name: 'wide_default',
            endpoints: portNames.map(port => ({
                kind: 'instance' as const,
                instance: 'u_consumer',
                port,
            })),
            defaults: Object.fromEntries(portNames.map(name => [
                `u_consumer.${name}`,
                "1'b0",
            ])),
        }],
    });

    const projection = projectArchDesignGraph(design, [consumer], {
        fileUri: 'file:///workspace/wide-default.ad',
    });
    const network = projection.graph.networks[0];
    const assignment = assignColumns(projection.graph);

    assert.equal(projection.validation.valid, true);
    assert.equal(projection.validation.effectiveDefaults.length, portNames.length);
    assert.equal(projection.graph.nodes.filter(node => node.kind === 'constant').length, 0);
    assert.equal(network.endpoints.length, portNames.length);
    assert.equal(network.endpoints.filter(endpoint => endpoint.role === 'driver').length, 0);
    assert.deepEqual(assignment.columns, [['instance:u_consumer']]);
    assert.deepEqual([...assignment.feedbackNetworkIds], []);
});

test('projects explicit Logic Utilities as editable nodes with stable pins', () => {
    const design = designOf({
        logic: [
            { name: 'u_constant', operation: 'constant', width: 8, expression: "8'h5a" },
            { name: 'u_not', operation: 'not', width: 8 },
            { name: 'u_and', operation: 'and', width: 8, inputCount: 3 },
            { name: 'u_or', operation: 'or', width: 8, inputCount: 2 },
            { name: 'u_xor', operation: 'xor', width: 8, inputCount: 2 },
            { name: 'u_nand', operation: 'nand', width: 8, inputCount: 2 },
            { name: 'u_nor', operation: 'nor', width: 8, inputCount: 2 },
            { name: 'u_xnor', operation: 'xnor', width: 8, inputCount: 2 },
            { name: 'u_mux', operation: 'mux', width: 8 },
            { name: 'u_concat', operation: 'concat', inputWidths: [4, 8] },
            { name: 'u_slice', operation: 'slice', inputWidth: 16, msb: 11, lsb: 4 },
            { name: 'u_replicate', operation: 'replicate', inputWidth: 2, count: 4 },
            { name: 'u_zero_extend', operation: 'zero-extend', inputWidth: 4, outputWidth: 8 },
            { name: 'u_sign_extend', operation: 'sign-extend', inputWidth: 4, outputWidth: 8 },
            { name: 'u_reduce_and', operation: 'reduce-and', inputWidth: 8 },
            { name: 'u_reduce_or', operation: 'reduce-or', inputWidth: 8 },
            { name: 'u_reduce_xor', operation: 'reduce-xor', inputWidth: 8 },
        ],
    });

    const projection = projectArchDesignGraph(design, [], {
        fileUri: 'file:///workspace/logic.ad',
    });
    const nodes = projection.graph.nodes;

    assert.equal(projection.validation.valid, true);
    assert.deepEqual(nodes.map(node => [node.id, node.kind, node.readOnly]), [
        ['logic:u_constant', 'constant', false],
        ['logic:u_not', 'expression', false],
        ['logic:u_and', 'expression', false],
        ['logic:u_or', 'expression', false],
        ['logic:u_xor', 'expression', false],
        ['logic:u_nand', 'expression', false],
        ['logic:u_nor', 'expression', false],
        ['logic:u_xnor', 'expression', false],
        ['logic:u_mux', 'expression', false],
        ['logic:u_concat', 'expression', false],
        ['logic:u_slice', 'expression', false],
        ['logic:u_replicate', 'expression', false],
        ['logic:u_zero_extend', 'expression', false],
        ['logic:u_sign_extend', 'expression', false],
        ['logic:u_reduce_and', 'expression', false],
        ['logic:u_reduce_or', 'expression', false],
        ['logic:u_reduce_xor', 'expression', false],
    ]);
    assert.deepEqual(nodes.map(node => [
        node.id,
        node.pins.map(pin => [pin.id, pin.name, pin.direction, pin.readOnly]),
    ]), [
        ['logic:u_constant', [['logic:u_constant:out', 'out', 'driver', false]]],
        ['logic:u_not', [
            ['logic:u_not:in', 'in', 'load', false],
            ['logic:u_not:out', 'out', 'driver', false],
        ]],
        ['logic:u_and', [
            ['logic:u_and:in0', 'in0', 'load', false],
            ['logic:u_and:in1', 'in1', 'load', false],
            ['logic:u_and:in2', 'in2', 'load', false],
            ['logic:u_and:out', 'out', 'driver', false],
        ]],
        ['logic:u_or', [
            ['logic:u_or:in0', 'in0', 'load', false],
            ['logic:u_or:in1', 'in1', 'load', false],
            ['logic:u_or:out', 'out', 'driver', false],
        ]],
        ['logic:u_xor', [
            ['logic:u_xor:in0', 'in0', 'load', false],
            ['logic:u_xor:in1', 'in1', 'load', false],
            ['logic:u_xor:out', 'out', 'driver', false],
        ]],
        ['logic:u_nand', [
            ['logic:u_nand:in0', 'in0', 'load', false],
            ['logic:u_nand:in1', 'in1', 'load', false],
            ['logic:u_nand:out', 'out', 'driver', false],
        ]],
        ['logic:u_nor', [
            ['logic:u_nor:in0', 'in0', 'load', false],
            ['logic:u_nor:in1', 'in1', 'load', false],
            ['logic:u_nor:out', 'out', 'driver', false],
        ]],
        ['logic:u_xnor', [
            ['logic:u_xnor:in0', 'in0', 'load', false],
            ['logic:u_xnor:in1', 'in1', 'load', false],
            ['logic:u_xnor:out', 'out', 'driver', false],
        ]],
        ['logic:u_mux', [
            ['logic:u_mux:in0', 'in0', 'load', false],
            ['logic:u_mux:in1', 'in1', 'load', false],
            ['logic:u_mux:select', 'select', 'load', false],
            ['logic:u_mux:out', 'out', 'driver', false],
        ]],
        ['logic:u_concat', [
            ['logic:u_concat:in0', 'in0', 'load', false],
            ['logic:u_concat:in1', 'in1', 'load', false],
            ['logic:u_concat:out', 'out', 'driver', false],
        ]],
        ...nodes.slice(10).map(node => [
            node.id,
            [
                [`${node.id}:in`, 'in', 'load', false],
                [`${node.id}:out`, 'out', 'driver', false],
            ],
        ]),
    ]);
    assert.equal(nodes.some(node => node.id.startsWith('default:')), false);
});

test('projects network widths without hiding mismatches or ambiguous symbols', () => {
    const widthModule: ArchDesignModuleDefinition = {
        key: 'rtl/widths.sv#widths',
        name: 'widths',
        parameters: [],
        ports: [
            { name: 'known_a', direction: 'output', width: { kind: 'known', bits: 8 } },
            { name: 'known_b', direction: 'input', width: { kind: 'known', bits: 8 } },
            { name: 'mismatch_source', direction: 'output', width: { kind: 'known', bits: 8 } },
            { name: 'mismatch', direction: 'input', width: { kind: 'known', bits: 4 } },
            { name: 'symbol_a', direction: 'output', width: { kind: 'symbolic', expression: 'W' } },
            { name: 'symbol_b', direction: 'input', width: { kind: 'symbolic', expression: 'W' } },
            { name: 'symbol_c_source', direction: 'output', width: { kind: 'symbolic', expression: 'W' } },
            { name: 'symbol_c', direction: 'input', width: { kind: 'symbolic', expression: 'V' } },
            { name: 'mixed_known_source', direction: 'output', width: { kind: 'known', bits: 8 } },
            { name: 'mixed_symbolic_sink', direction: 'input', width: { kind: 'symbolic', expression: 'W' } },
            { name: 'known_unknown_source', direction: 'output', width: { kind: 'known', bits: 8 } },
            { name: 'unknown_sink', direction: 'input', width: { kind: 'unknown' } },
        ],
    };
    const design = designOf({
        instances: [{ name: 'u_widths', module: 'widths' }],
        connections: [
            {
                name: 'known',
                endpoints: [
                    { kind: 'instance', instance: 'u_widths', port: 'known_a' },
                    { kind: 'instance', instance: 'u_widths', port: 'known_b' },
                ],
            },
            {
                name: 'mismatch',
                endpoints: [
                    { kind: 'instance', instance: 'u_widths', port: 'mismatch_source' },
                    { kind: 'instance', instance: 'u_widths', port: 'mismatch' },
                ],
            },
            {
                name: 'symbolic',
                endpoints: [
                    { kind: 'instance', instance: 'u_widths', port: 'symbol_a' },
                    { kind: 'instance', instance: 'u_widths', port: 'symbol_b' },
                ],
            },
            {
                name: 'ambiguous_symbolic',
                endpoints: [
                    { kind: 'instance', instance: 'u_widths', port: 'symbol_c_source' },
                    { kind: 'instance', instance: 'u_widths', port: 'symbol_c' },
                ],
            },
            {
                name: 'known_symbolic',
                endpoints: [
                    { kind: 'instance', instance: 'u_widths', port: 'mixed_known_source' },
                    { kind: 'instance', instance: 'u_widths', port: 'mixed_symbolic_sink' },
                ],
            },
            {
                name: 'known_unknown',
                endpoints: [
                    { kind: 'instance', instance: 'u_widths', port: 'known_unknown_source' },
                    { kind: 'instance', instance: 'u_widths', port: 'unknown_sink' },
                ],
            },
        ],
    });

    const projection = projectArchDesignGraph(design, [widthModule], {
        fileUri: 'file:///workspace/widths.ad',
    });

    assert.deepEqual(projection.graph.networks.map(network => [
        network.id,
        network.width,
    ]), [
        ['network:known', { kind: 'known', bits: 8 }],
        ['network:mismatch', { kind: 'unknown' }],
        ['network:symbolic', { kind: 'symbolic', expression: 'W' }],
        ['network:ambiguous_symbolic', { kind: 'unknown' }],
        ['network:known_symbolic', { kind: 'unknown' }],
        ['network:known_unknown', { kind: 'unknown' }],
    ]);
    assert.equal(projection.validation.valid, false);
    assert.equal(projection.validation.diagnostics.some(diagnostic =>
        diagnostic.code === 'AD_WIDTH_MISMATCH'), true);
});

test('keeps invalid intermediate graphs visible and maps path-aware diagnostics', () => {
    const unresolved = designOf({
        instances: [{ name: 'u_missing', module: 'missing' }],
    });

    const projection = projectArchDesignGraph(unresolved, [], {
        fileUri: 'file:///workspace/invalid.ad',
    });

    assert.equal(projection.validation.valid, false);
    assert.equal(projection.graph.diagnostics[0].code, 'AD_MODULE_UNRESOLVED');
    assert.deepEqual(projection.validation.diagnostics[0], {
        path: '$.instances[0].module',
        code: 'AD_MODULE_UNRESOLVED',
        message: 'No module definition is named missing',
    });
    assert.deepEqual(projection.graph.nodes[0], {
        id: 'instance:u_missing',
        kind: 'instance',
        label: 'u_missing',
        subtitle: 'missing',
        pins: [],
        readOnly: false,
    });
    assert.equal(projection.graph.diagnostics[0].severity, 'error');
    assert.match(projection.graph.diagnostics[0].message, /\$\.instances\[0\]\.module/);
    assert.ok(Object.isFrozen(projection.validation));
    assert.ok(Object.isFrozen(projection.validation.diagnostics));
    assert.ok(Object.isFrozen(projection.validation.diagnostics[0]));

    const badEndpoint = designOf({
        ports: [{ name: 'source', direction: 'input' }],
        connections: [{
            name: 'partial',
            endpoints: [
                { kind: 'port', port: 'source' },
                { kind: 'port', port: 'missing' },
            ],
        }],
    });
    const partial = projectArchDesignGraph(badEndpoint, [], {
        fileUri: 'file:///workspace/partial.ad',
    });

    assert.equal(partial.validation.valid, false);
    assert.deepEqual(partial.graph.networks[0].endpoints, [{
        nodeId: 'port:source',
        pinId: 'port:source:value',
        role: 'driver',
    }]);
    assert.equal(partial.graph.diagnostics[0].code, 'AD_ENDPOINT_UNKNOWN');
});

test('retains the first hostile catalog port declaration and remains layoutable', () => {
    const reads = new Map<string, number>();
    const once = <T>(key: string, value: T): T => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return value;
    };
    const firstWidth = {
        get kind() { return once('first.width.kind', 'known' as const); },
        get bits() { return once('first.width.bits', 1); },
    };
    const secondWidth = {
        get kind() { return once('second.width.kind', 'known' as const); },
        get bits() { return once('second.width.bits', 8); },
    };
    const firstPort = {
        get name() { return once('first.name', 'data'); },
        get direction() { return once('first.direction', 'input' as const); },
        get width() { return once('first.width', firstWidth); },
    };
    const secondPort = {
        get name() { return once('second.name', 'data'); },
        get direction() { return once('second.direction', 'output' as const); },
        get width() { return once('second.width', secondWidth); },
    };
    const definition = {
        get key() { return once('definition.key', 'rtl/duplicate.sv#duplicate'); },
        get name() { return once('definition.name', 'duplicate'); },
        get parameters() { return once('definition.parameters', []); },
        get ports() { return once('definition.ports', [firstPort, secondPort]); },
    } as ArchDesignModuleDefinition;
    const design = designOf({
        instances: [{ name: 'u_duplicate', module: 'duplicate' }],
        defaults: { 'u_duplicate.data': "1'b0" },
    });

    const projection = projectArchDesignGraph(design, [definition], {
        fileUri: 'file:///workspace/duplicate-port.ad',
    });
    const instance = projection.graph.nodes.find(node =>
        node.id === 'instance:u_duplicate'
    );

    assert.equal(projection.validation.valid, false);
    assert.deepEqual(projection.validation.diagnostics.map(item => [item.path, item.code]), [
        ['$.instances[0].module', 'AD_DEFINITION_PORT_DUPLICATE'],
    ]);
    assert.ok(instance);
    assert.deepEqual(instance.pins.map(pin => [pin.id, pin.name, pin.direction, pin.width]), [[
        'instance:u_duplicate:data',
        'data',
        'load',
        { kind: 'known', bits: 1 },
    ]]);
    assert.equal(new Set(instance.pins.map(pin => pin.id)).size, instance.pins.length);
    assert.equal(projection.graph.diagnostics[0].code, 'AD_DEFINITION_PORT_DUPLICATE');
    assert.doesNotThrow(() => layoutSchematic(
        projection.graph,
        undefined,
        text => text.length * 7
    ));
    assert.deepEqual(Object.fromEntries(reads), {
        'definition.key': 1,
        'definition.name': 1,
        'definition.parameters': 1,
        'definition.ports': 1,
        'first.name': 1,
        'first.direction': 1,
        'first.width': 1,
        'first.width.kind': 1,
        'first.width.bits': 1,
        'second.name': 1,
        'second.direction': 1,
        'second.width': 1,
        'second.width.kind': 1,
        'second.width.bits': 1,
    });
});

test('keeps duplicate top port declarations localized, unique, and layoutable', () => {
    const design = {
        ...createEmptyArchDesign('duplicate_ports'),
        ports: [
            { name: 'shared', direction: 'input' as const },
            { name: 'shared', direction: 'input' as const },
        ],
        connections: [{
            name: 'ambiguous_use',
            endpoints: [{ kind: 'port' as const, port: 'shared' }],
        }],
    } as ArchDesign;

    assert.deepEqual(validateArchDesign(design, []).diagnostics.map(item => [
        item.path,
        item.code,
    ]), [
        ['$.connections[0].endpoints[0].port', 'AD_ENDPOINT_AMBIGUOUS'],
        ['$.ports[1].name', 'AD_DUPLICATE_NAME'],
    ]);

    const projection = projectArchDesignGraph(design, [], {
        fileUri: 'file:///workspace/duplicate-ports.ad',
    });
    assert.deepEqual(projection.graph.nodes.map(node => node.id), [
        'port:shared',
        'port:shared:declaration:1',
    ]);
    assert.deepEqual(projection.graph.nodes.map(node => node.pins.map(pin => pin.id)), [
        ['port:shared:value'],
        ['port:shared:declaration:1:value'],
    ]);
    assert.deepEqual(projection.graph.networks[0].endpoints, []);
    assertUniqueAndLayoutable(design, projection.graph);
});

test('keeps duplicate instance declarations localized, unique, and layoutable', () => {
    const producer: ArchDesignModuleDefinition = {
        key: 'rtl/producer.sv#producer',
        name: 'producer',
        parameters: [],
        ports: [{
            name: 'data',
            direction: 'output',
            width: { kind: 'known', bits: 1 },
        }],
    };
    const design = {
        ...createEmptyArchDesign('duplicate_instances'),
        instances: [
            { name: 'u_shared', module: 'producer' },
            { name: 'u_shared', module: 'producer' },
        ],
        connections: [{
            name: 'ambiguous_use',
            endpoints: [{
                kind: 'instance' as const,
                instance: 'u_shared',
                port: 'data',
            }],
        }],
    } as ArchDesign;

    assert.deepEqual(validateArchDesign(design, [producer]).diagnostics.map(item => [
        item.path,
        item.code,
    ]), [
        ['$.connections[0].endpoints[0].instance', 'AD_ENDPOINT_AMBIGUOUS'],
        ['$.instances[1].name', 'AD_DUPLICATE_NAME'],
    ]);

    const projection = projectArchDesignGraph(design, [producer], {
        fileUri: 'file:///workspace/duplicate-instances.ad',
    });
    assert.deepEqual(projection.graph.nodes.map(node => node.id), [
        'instance:u_shared',
        'instance:u_shared:declaration:1',
    ]);
    assert.deepEqual(projection.graph.nodes.map(node => node.pins.map(pin => pin.id)), [
        ['instance:u_shared:data'],
        ['instance:u_shared:declaration:1:data'],
    ]);
    assert.deepEqual(projection.graph.networks[0].endpoints, []);
    assertUniqueAndLayoutable(design, projection.graph);
});

test('keeps duplicate connection declarations localized, unique, and layoutable', () => {
    const design = {
        ...createEmptyArchDesign('duplicate_connections'),
        ports: [{ name: 'source', direction: 'input' as const }],
        connections: [{
            name: 'shared_network',
            endpoints: [],
        }, {
            name: 'shared_network',
            endpoints: [],
        }],
    } as ArchDesign;

    assert.deepEqual(validateArchDesign(design, []).diagnostics.map(item => [
        item.path,
        item.code,
    ]), [
        ['$.connections[1].name', 'AD_DUPLICATE_NAME'],
    ]);

    const projection = projectArchDesignGraph(design, [], {
        fileUri: 'file:///workspace/duplicate-connections.ad',
    });
    assert.deepEqual(projection.graph.networks.map(network => network.id), [
        'network:shared_network',
        'network:shared_network:declaration:1',
    ]);
    assertUniqueAndLayoutable(design, projection.graph);
});

const interfaceCatalog = createInterfaceProtocolCatalog([{
    source: '/workspace/link.json',
    value: {
        format: 'veriflow-interface-protocol',
        schemaVersion: 1,
        id: 'project.link',
        name: 'Project Link',
        separator: '_',
        priority: 100,
        members: [
            { name: 'request', direction: 'master-to-slave' },
            { name: 'accept', direction: 'slave-to-master', default: "1'b0" },
            { name: 'tag', direction: 'master-to-slave', default: '0' },
        ],
        recognitionGroups: [['request', 'accept']],
    },
}]);

const interfaceMaster: ArchDesignModuleDefinition = {
    key: 'rtl/interface_master.sv#interface_master',
    name: 'interface_master',
    parameters: [],
    ports: [
        { name: 'BUS_REQUEST', direction: 'output', width: { kind: 'known', bits: 32 } },
        { name: 'BUS_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
    ],
};

const interfaceSlave: ArchDesignModuleDefinition = {
    key: 'rtl/interface_slave.sv#interface_slave',
    name: 'interface_slave',
    parameters: [],
    ports: [
        { name: 'LINK_REQUEST', direction: 'input', width: { kind: 'known', bits: 32 } },
        { name: 'LINK_ACCEPT', direction: 'output', width: { kind: 'known', bits: 1 } },
        { name: 'LINK_TAG', direction: 'input', width: { kind: 'known', bits: 4 } },
    ],
};

function interfaceDesign(presentation: ArchDesign['presentation'] = {}): ArchDesign {
    return designOf({
        instances: [
            { name: 'u_master', module: 'interface_master' },
            { name: 'u_slave', module: 'interface_slave' },
        ],
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'LINK' },
        }],
        presentation,
    });
}

test('projects recognized interfaces collapsed by default as one semantic route', () => {
    const design = interfaceDesign();
    const projection = projectArchDesignGraph(
        design,
        [interfaceMaster, interfaceSlave],
        { fileUri: 'file:///workspace/interfaces.ad', interfaceCatalog }
    );
    const masterNode = projection.graph.nodes.find(node => node.id === 'instance:u_master')!;
    const slaveNode = projection.graph.nodes.find(node => node.id === 'instance:u_slave')!;

    assert.deepEqual(masterNode.pins.map(pin => pin.id), [
        'interface:instance:u_master:BUS',
    ]);
    assert.deepEqual(slaveNode.pins.map(pin => pin.id), [
        'interface:instance:u_slave:LINK',
    ]);
    assert.deepEqual(masterNode.pins[0].interface, {
        id: 'interface:instance:u_master:BUS',
        protocol: 'project.link',
        protocolName: 'Project Link',
        role: 'master',
        roleSource: 'inferred',
        kind: 'aggregate',
        topLevel: false,
        collapsed: true,
    });
    assert.equal(masterNode.pins[0].direction, 'driver');
    assert.equal(slaveNode.pins[0].direction, 'load');
    assert.deepEqual(projection.graph.networks.map(network => ({
        id: network.id,
        endpoints: network.endpoints.map(endpoint => endpoint.pinId),
        renderWidth: network.renderWidth,
        interface: network.interface,
    })), [{
        id: 'network:interface:control',
        endpoints: [
            'interface:instance:u_master:BUS',
            'interface:instance:u_slave:LINK',
        ],
        renderWidth: 4,
        interface: {
            id: 'interface-connection:control',
            connection: 'control',
            protocol: 'project.link',
            protocolName: 'Project Link',
            collapsed: true,
        },
    }]);

    const sides = resolvePinSides(projection.graph);
    assert.equal(sides.get(pinKey(masterNode.id, masterNode.pins[0].id)), 'right');
    assert.equal(sides.get(pinKey(slaveNode.id, slaveNode.pins[0].id)), 'left');
    assertUniqueAndLayoutable(design, projection.graph);
});

test('expands both interface endpoints into declaration-ordered member routes and defaults', () => {
    const design = interfaceDesign({
        collapsedInterfaces: {
            'interface:instance:u_master:BUS': false,
            'interface:instance:u_slave:LINK': false,
        },
    });
    const projection = projectArchDesignGraph(
        design,
        [interfaceMaster, interfaceSlave],
        { fileUri: 'file:///workspace/interfaces.ad', interfaceCatalog }
    );
    const masterNode = projection.graph.nodes.find(node => node.id === 'instance:u_master')!;
    const slaveNode = projection.graph.nodes.find(node => node.id === 'instance:u_slave')!;

    assert.deepEqual(masterNode.pins.map(pin => pin.name), ['BUS_REQUEST', 'BUS_ACCEPT']);
    assert.deepEqual(slaveNode.pins.map(pin => pin.name), [
        'LINK_REQUEST',
        'LINK_ACCEPT',
        'LINK_TAG',
    ]);
    assert.deepEqual(masterNode.pins.map(pin => pin.interface?.member), [
        'request',
        'accept',
    ]);
    assert.deepEqual(projection.graph.networks.map(network => [
        network.id,
        network.interface?.member,
        network.renderWidth,
    ]), [
        ['network:interface:control:request', 'request', undefined],
        ['network:interface:control:accept', 'accept', undefined],
        ['network:interface:control:tag', 'tag', undefined],
    ]);
    assert.deepEqual(projection.graph.nodes.filter(node => node.kind === 'constant'), []);
    assert.deepEqual(projection.graph.networks[2].endpoints, [{
        nodeId: 'instance:u_slave',
        pinId: 'instance:u_slave:LINK_TAG',
        role: 'load',
    }]);
    assertUniqueAndLayoutable(design, projection.graph);
});

test('places top-level Slave interfaces left and Master interfaces right with metadata', () => {
    const design = designOf({
        interfacePorts: [{
            name: 's_link',
            protocol: 'project.link',
            role: 'slave',
            memberPrefix: 'S_LINK',
            members: [
                { member: 'request', width: 32 },
                { member: 'accept', width: 1 },
            ],
        }, {
            name: 'm_link',
            protocol: 'project.link',
            role: 'master',
            memberPrefix: 'M_LINK',
            members: [
                { member: 'request', width: 32 },
                { member: 'accept', width: 1 },
            ],
        }],
        presentation: {
            collapsedInterfaces: {
                'interface:port:s_link': false,
                'interface:port:m_link': false,
            },
        },
    });
    const projection = projectArchDesignGraph(design, [], {
        fileUri: 'file:///workspace/boundaries.ad',
        interfaceCatalog,
    });
    const slaveNode = projection.graph.nodes.find(node => node.id === 'interface:port:s_link')!;
    const masterNode = projection.graph.nodes.find(node => node.id === 'interface:port:m_link')!;

    assert.equal(slaveNode.kind, 'port');
    assert.deepEqual(slaveNode.pins.map(pin => pin.direction), ['driver', 'load']);
    assert.equal(slaveNode.pins[0].interface?.role, 'slave');
    assert.equal(slaveNode.pins[0].interface?.topLevel, true);
    assert.deepEqual(masterNode.pins.map(pin => pin.direction), ['load', 'driver']);
    assert.equal(masterNode.pins[0].interface?.role, 'master');
    const columns = assignColumns(projection.graph).nodeColumn;
    assert.equal(columns.get(slaveNode.id), 0);
    assert.ok(columns.get(masterNode.id)! > columns.get(slaveNode.id)!);
});
