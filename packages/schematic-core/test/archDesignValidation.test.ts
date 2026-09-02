import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createEmptyArchDesign,
    parseArchDesignValue,
    validateArchDesign,
    type ArchDesign,
    type ArchDesignModuleDefinition,
} from '../src/archDesign';
import { resolveArchDesign } from '../src/archDesign/resolution';

function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const result = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (result.status !== 'editable') throw new Error('expected editable design');
    return result.design;
}

const coreDefinition: ArchDesignModuleDefinition = {
    key: 'rtl/core.sv#core',
    name: 'core',
    parameters: [
        { name: 'WIDTH', defaultExpression: '8' },
        { name: 'ENABLED' },
    ],
    ports: [
        { name: 'clk', direction: 'output', width: { kind: 'known', bits: 1 } },
        { name: 'result', direction: 'output', width: { kind: 'symbolic', expression: 'WIDTH' } },
    ],
};

const definitions: readonly ArchDesignModuleDefinition[] = [coreDefinition];

function pathCodes(result: ReturnType<typeof validateArchDesign>): [string, string][] {
    return result.diagnostics.map(item => [item.path, item.code]);
}

test('accepts an instance whose module resolves uniquely', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core' }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, true);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.effectiveDefaults, []);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.diagnostics));
    assert.ok(Object.isFrozen(result.effectiveDefaults));
});

test('reports an unresolved instance module', () => {
    const design = designOf({
        instances: [{ name: 'u_missing', module: 'missing' }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, false);
    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].module', 'AD_MODULE_UNRESOLVED'],
    ]);
    assert.ok(Object.isFrozen(result.diagnostics[0]));
});

test('reports an ambiguous instance module without selecting a definition', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core', parameters: { UNKNOWN: 1 } }],
    });
    const duplicate = { ...coreDefinition, key: 'generated/core.sv#core' };

    const result = validateArchDesign(design, [coreDefinition, duplicate]);

    assert.equal(result.valid, false);
    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].module', 'AD_MODULE_AMBIGUOUS'],
    ]);
});

test('resolves an ambiguous module by its exact definition key', () => {
    const alternate: ArchDesignModuleDefinition = {
        ...coreDefinition,
        key: 'generated/core.sv#core',
        parameters: [{ name: 'ALTERNATE' }],
        ports: [{
            name: 'alternate_result',
            direction: 'output',
            width: { kind: 'known', bits: 4 },
        }],
    };
    const design = designOf({
        instances: [{
            name: 'u_core',
            module: 'core',
            definitionKey: alternate.key,
            parameters: { ALTERNATE: 1 },
        }],
    });

    const result = resolveArchDesign(design, [coreDefinition, alternate]);

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.instances[0].definition?.key, alternate.key);
    assert.deepEqual(
        result.instances[0].definition?.ports.map(port => port.name),
        ['alternate_result']
    );
});

test('does not guess another definition when an explicit key is stale', () => {
    const design = designOf({
        instances: [{
            name: 'u_core',
            module: 'core',
            definitionKey: 'module:file:///workspace/missing.v:0',
        }],
    });

    const result = validateArchDesign(design, definitions);

    assert.deepEqual(pathCodes(result), [[
        '$.instances[0].definitionKey',
        'AD_MODULE_UNRESOLVED',
    ]]);
});

test('reports an override absent from the resolved module parameter declarations', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core', parameters: { DEPTH: 16 } }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, false);
    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].parameters.DEPTH', 'AD_PARAMETER_UNKNOWN'],
    ]);
});

test('accepts an override on a declared module parameter', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core', parameters: { WIDTH: 32 } }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, true);
    assert.deepEqual(result.diagnostics, []);
});

test('orders semantic diagnostics deterministically by path and code', () => {
    const design = designOf({
        instances: [{
            name: 'u_core',
            module: 'core',
            parameters: {
                a_unknown: 1,
                Z_UNKNOWN: 2,
            },
        }, {
            name: 'u_valid_1',
            module: 'core',
        }, {
            name: 'u_missing_2',
            module: 'missing',
        }, {
            name: 'u_valid_3',
            module: 'core',
        }, {
            name: 'u_valid_4',
            module: 'core',
        }, {
            name: 'u_valid_5',
            module: 'core',
        }, {
            name: 'u_valid_6',
            module: 'core',
        }, {
            name: 'u_valid_7',
            module: 'core',
        }, {
            name: 'u_valid_8',
            module: 'core',
        }, {
            name: 'u_valid_9',
            module: 'core',
        }, {
            name: 'u_ambiguous_10',
            module: 'duplicate',
        }],
    });
    const duplicateDefinitions: readonly ArchDesignModuleDefinition[] = [
        { ...coreDefinition, key: 'rtl/duplicate-a.sv#duplicate', name: 'duplicate' },
        { ...coreDefinition, key: 'rtl/duplicate-b.sv#duplicate', name: 'duplicate' },
        coreDefinition,
    ];

    const result = validateArchDesign(design, duplicateDefinitions);

    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].parameters.Z_UNKNOWN', 'AD_PARAMETER_UNKNOWN'],
        ['$.instances[0].parameters.a_unknown', 'AD_PARAMETER_UNKNOWN'],
        ['$.instances[10].module', 'AD_MODULE_AMBIGUOUS'],
        ['$.instances[2].module', 'AD_MODULE_UNRESOLVED'],
    ]);
});

test('reports unknown top-level, instance, and instance-port endpoints', () => {
    const definition: ArchDesignModuleDefinition = {
        key: 'rtl/source.sv#source',
        name: 'source',
        parameters: [],
        ports: [{ name: 'data_o', direction: 'output', width: { kind: 'known', bits: 8 } }],
    };
    const design = designOf({
        instances: [{ name: 'u_source', module: 'source' }],
        connections: [{
            name: 'unknown_top',
            endpoints: [{ kind: 'port', port: 'missing' }],
        }, {
            name: 'unknown_instance',
            endpoints: [{ kind: 'instance', instance: 'u_missing', port: 'data_o' }],
        }, {
            name: 'unknown_instance_port',
            endpoints: [{ kind: 'instance', instance: 'u_source', port: 'missing' }],
        }],
    });

    const result = validateArchDesign(design, [definition]);

    assert.deepEqual(pathCodes(result), [
        ['$.connections[0].endpoints[0].port', 'AD_ENDPOINT_UNKNOWN'],
        ['$.connections[1].endpoints[0].instance', 'AD_ENDPOINT_UNKNOWN'],
        ['$.connections[2].endpoints[0].port', 'AD_ENDPOINT_UNKNOWN'],
    ]);
});

test('enforces scalar signal selectors on top-level ports', () => {
    const design = designOf({
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'sink', direction: 'output' },
            { name: 'bus', direction: 'inout', width: 8 },
        ],
        connections: [{
            name: 'input_i',
            endpoints: [{ kind: 'port', port: 'source', signal: 'i' }],
        }, {
            name: 'output_o',
            endpoints: [{ kind: 'port', port: 'sink', signal: 'o' }],
        }, {
            name: 'inout_implicit',
            endpoints: [{ kind: 'port', port: 'bus' }],
        }, {
            name: 'inout_value',
            endpoints: [{ kind: 'port', port: 'bus', signal: 'value' }],
        }],
        defaults: {
            'sink.value': "1'b0",
            'bus.o': "1'b0",
        },
    });

    const result = validateArchDesign(design, []);

    assert.deepEqual(pathCodes(result), [
        ['$.connections[0].endpoints[0].signal', 'AD_PORT_SIGNAL'],
        ['$.connections[1].endpoints[0].signal', 'AD_PORT_SIGNAL'],
        ['$.connections[2].endpoints[0].signal', 'AD_PORT_SIGNAL'],
        ['$.connections[3].endpoints[0].signal', 'AD_PORT_SIGNAL'],
    ]);
});

test('reports duplicate scalar endpoints at their later declarations', () => {
    const design = designOf({
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'sink', direction: 'output' },
        ],
        connections: [{
            name: 'first',
            endpoints: [
                { kind: 'port', port: 'source' },
                { kind: 'port', port: 'sink' },
                { kind: 'port', port: 'sink', signal: 'value' },
            ],
        }, {
            name: 'second',
            endpoints: [{ kind: 'port', port: 'source', signal: 'value' }],
        }],
    });

    const result = validateArchDesign(design, []);

    assert.deepEqual(pathCodes(result), [
        ['$.connections[0].endpoints[2]', 'AD_ENDPOINT_DUPLICATE'],
        ['$.connections[1].endpoints[0]', 'AD_ENDPOINT_DUPLICATE'],
    ]);
});

test('does not cascade connection-default membership errors from a duplicate endpoint', () => {
    const design = designOf({
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'sink', direction: 'output' },
        ],
        connections: [{
            name: 'first',
            endpoints: [
                { kind: 'port', port: 'source' },
                { kind: 'port', port: 'sink' },
            ],
        }, {
            name: 'duplicate',
            endpoints: [{ kind: 'port', port: 'sink' }],
            defaults: { 'sink.value': "1'b0" },
        }],
    });

    assert.deepEqual(pathCodes(validateArchDesign(design, [])), [
        ['$.connections[1].endpoints[0]', 'AD_ENDPOINT_DUPLICATE'],
    ]);
});

test('reports each definite scalar driver after the first', () => {
    const design = designOf({
        ports: [
            { name: 'first', direction: 'input' },
            { name: 'second', direction: 'input' },
            { name: 'sink', direction: 'output' },
        ],
        connections: [{
            name: 'contended',
            endpoints: [
                { kind: 'port', port: 'first' },
                { kind: 'port', port: 'second' },
                { kind: 'port', port: 'sink' },
            ],
        }],
    });

    const result = validateArchDesign(design, []);

    assert.deepEqual(pathCodes(result), [
        ['$.connections[0].endpoints[1]', 'AD_MULTIPLE_DRIVERS'],
    ]);
});

test('compares only known scalar endpoint widths', () => {
    const unknownSource: ArchDesignModuleDefinition = {
        key: 'rtl/unknown_source.sv#unknown_source',
        name: 'unknown_source',
        parameters: [],
        ports: [{ name: 'data_o', direction: 'output', width: { kind: 'unknown' } }],
    };
    const design = designOf({
        ports: [
            { name: 'wide', direction: 'input', width: 8 },
            { name: 'narrow', direction: 'output', width: 4 },
            { name: 'symbolic', direction: 'input', width: { expression: 'WIDTH' } },
            { name: 'known', direction: 'output', width: 3 },
            { name: 'unknown_sink', direction: 'output', width: 7 },
        ],
        instances: [{ name: 'u_unknown', module: 'unknown_source' }],
        connections: [{
            name: 'mismatch',
            endpoints: [
                { kind: 'port', port: 'wide' },
                { kind: 'port', port: 'narrow' },
            ],
        }, {
            name: 'symbolic_width',
            endpoints: [
                { kind: 'port', port: 'symbolic' },
                { kind: 'port', port: 'known' },
            ],
        }, {
            name: 'unknown_width',
            endpoints: [
                { kind: 'instance', instance: 'u_unknown', port: 'data_o' },
                { kind: 'port', port: 'unknown_sink' },
            ],
        }],
    });

    const result = validateArchDesign(design, [unknownSource]);

    assert.deepEqual(pathCodes(result), [
        ['$.connections[0].endpoints[1]', 'AD_WIDTH_MISMATCH'],
    ]);
});

test('allows only scalar or full-port widths on an inout t endpoint', () => {
    for (const width of [1, 8]) {
        const design = designOf({
            ports: [
                { name: 'control', direction: 'input', width },
                { name: 'bus', direction: 'inout', width: 8 },
            ],
            connections: [{
                name: 'control',
                endpoints: [
                    { kind: 'port', port: 'control' },
                    { kind: 'port', port: 'bus', signal: 't' },
                ],
            }],
            defaults: { 'bus.o': "8'b0" },
        });
        assert.deepEqual(validateArchDesign(design, []).diagnostics, []);
    }

    const invalid = designOf({
        ports: [
            { name: 'control', direction: 'input', width: 2 },
            { name: 'bus', direction: 'inout', width: 8 },
        ],
        connections: [{
            name: 'control',
            endpoints: [
                { kind: 'port', port: 'control' },
                { kind: 'port', port: 'bus', signal: 't' },
            ],
        }],
        defaults: { 'bus.o': "8'b0" },
    });

    assert.deepEqual(pathCodes(validateArchDesign(invalid, [])), [
        ['$.connections[0].endpoints[1]', 'AD_INOUT_T_WIDTH'],
    ]);
});

test('reports a required connected load with no definite driver or default', () => {
    const design = designOf({
        ports: [{ name: 'sink', direction: 'output', width: 8 }],
        connections: [{
            name: 'driverless',
            endpoints: [{ kind: 'port', port: 'sink' }],
        }],
    });

    assert.deepEqual(pathCodes(validateArchDesign(design, [])), [
        ['$.connections[0].endpoints[0]', 'AD_UNDRIVEN_INPUT'],
    ]);
});

test('reports unknown interface endpoints instead of a blanket unsupported error', () => {
    const emptyModule: ArchDesignModuleDefinition = {
        key: 'rtl/empty.sv#empty',
        name: 'empty',
        parameters: [],
        ports: [],
    };
    const design = designOf({
        instances: [
            { name: 'left', module: 'empty' },
            { name: 'right', module: 'empty' },
        ],
        interfaceConnections: [{
            name: 'first',
            master: { kind: 'instance', instance: 'left', interface: 'bus' },
            slave: { kind: 'instance', instance: 'right', interface: 'bus' },
        }, {
            name: 'second',
            master: { kind: 'instance', instance: 'right', interface: 'missing' },
            slave: { kind: 'instance', instance: 'left', interface: 'also_missing' },
        }],
    });

    assert.deepEqual(pathCodes(validateArchDesign(design, [emptyModule])), [
        ['$.interfaceConnections[0].master', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
        ['$.interfaceConnections[0].slave', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
        ['$.interfaceConnections[1].master', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
        ['$.interfaceConnections[1].slave', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
    ]);
});

test('uses connection defaults before design defaults for an undriven load', () => {
    const design = designOf({
        ports: [{ name: 'sink', direction: 'output' }],
        connections: [{
            name: 'data',
            endpoints: [{ kind: 'port', port: 'sink' }],
            defaults: { 'sink.value': "1'b1" },
        }],
        defaults: { 'sink.value': "1'b0" },
    });

    const result = validateArchDesign(design, []);

    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.effectiveDefaults, [{
        endpoint: 'sink.value',
        expression: "1'b1",
        origin: 'connection',
        connection: 'data',
    }]);
    assert.ok(Object.isFrozen(result.effectiveDefaults[0]));
});

test('uses design defaults for connected and completely unconnected loads', () => {
    const design = designOf({
        ports: [
            { name: 'connected', direction: 'output', width: 8 },
            { name: 'unconnected', direction: 'output', width: 8 },
        ],
        connections: [{
            name: 'driverless',
            endpoints: [{ kind: 'port', port: 'connected' }],
        }],
        defaults: {
            'connected.value': "8'h55",
            'unconnected.value': "8'haa",
        },
    });

    const result = validateArchDesign(design, []);

    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.effectiveDefaults, [{
        endpoint: 'connected.value',
        expression: "8'h55",
        origin: 'design',
    }, {
        endpoint: 'unconnected.value',
        expression: "8'haa",
        origin: 'design',
    }]);
});

test('uses implicit inout t defaults unless explicitly overridden', () => {
    const implicit = designOf({
        ports: [{ name: 'bus', direction: 'inout', width: 8 }],
        defaults: { 'bus.o': "8'b0" },
    });
    assert.deepEqual(
        validateArchDesign(implicit, []).effectiveDefaults.find(item => item.endpoint === 'bus.t'),
        { endpoint: 'bus.t', expression: "1'b1", origin: 'implicit-inout-t' }
    );

    const designOverride = designOf({
        ports: [{ name: 'bus', direction: 'inout', width: 8 }],
        defaults: { 'bus.o': "8'b0", 'bus.t': "1'b0" },
    });
    assert.deepEqual(
        validateArchDesign(designOverride, []).effectiveDefaults.find(
            item => item.endpoint === 'bus.t'
        ),
        { endpoint: 'bus.t', expression: "1'b0", origin: 'design' }
    );

    const connectionOverride = designOf({
        ports: [{ name: 'bus', direction: 'inout', width: 8 }],
        connections: [{
            name: 'control',
            endpoints: [{ kind: 'port', port: 'bus', signal: 't' }],
            defaults: { 'bus.t': "1'b0" },
        }],
        defaults: { 'bus.o': "8'b0", 'bus.t': "1'b1" },
    });
    assert.deepEqual(
        validateArchDesign(connectionOverride, []).effectiveDefaults.find(
            item => item.endpoint === 'bus.t'
        ),
        {
            endpoint: 'bus.t',
            expression: "1'b0",
            origin: 'connection',
            connection: 'control',
        }
    );
});

test('rejects defaults on driver and bidirectional endpoints', () => {
    const moduleDefinition: ArchDesignModuleDefinition = {
        key: 'rtl/bidir.sv#bidir',
        name: 'bidir',
        parameters: [],
        ports: [{ name: 'io', direction: 'inout', width: { kind: 'known', bits: 1 } }],
    };
    const design = designOf({
        ports: [{ name: 'source', direction: 'input' }],
        instances: [{ name: 'u_bidir', module: 'bidir' }],
        defaults: {
            'source.value': "1'b0",
            'u_bidir.io': "1'b0",
        },
    });

    assert.deepEqual(pathCodes(validateArchDesign(design, [moduleDefinition])), [
        ['$.defaults.source.value', 'AD_DEFAULT_RECEIVER'],
        ['$.defaults.u_bidir.io', 'AD_DEFAULT_RECEIVER'],
    ]);
});

test('rejects unknown and cross-namespace ambiguous default keys', () => {
    const moduleDefinition: ArchDesignModuleDefinition = {
        key: 'rtl/consumer.sv#consumer',
        name: 'consumer',
        parameters: [],
        ports: [{ name: 'value', direction: 'input', width: { kind: 'known', bits: 1 } }],
    };
    const design = designOf({
        ports: [
            { name: 'node', direction: 'output' },
            { name: 'top_source', direction: 'input' },
            { name: 'instance_source', direction: 'input' },
        ],
        instances: [{ name: 'node', module: 'consumer' }],
        connections: [{
            name: 'top',
            endpoints: [
                { kind: 'port', port: 'top_source' },
                { kind: 'port', port: 'node' },
            ],
        }, {
            name: 'instance',
            endpoints: [
                { kind: 'port', port: 'instance_source' },
                { kind: 'instance', instance: 'node', port: 'value' },
            ],
        }],
        defaults: {
            'missing.value': "1'b0",
            'node.value': "1'b0",
        },
    });

    assert.deepEqual(pathCodes(validateArchDesign(design, [moduleDefinition])), [
        ['$.defaults.missing.value', 'AD_DEFAULT_ENDPOINT'],
        ['$.defaults.node.value', 'AD_DEFAULT_ENDPOINT'],
    ]);
});

test('requires a connection default endpoint to belong to that connection', () => {
    const design = designOf({
        ports: [
            { name: 'left_source', direction: 'input' },
            { name: 'left', direction: 'output' },
            { name: 'right_source', direction: 'input' },
            { name: 'right', direction: 'output' },
        ],
        connections: [{
            name: 'left_net',
            endpoints: [
                { kind: 'port', port: 'left_source' },
                { kind: 'port', port: 'left' },
            ],
            defaults: { 'right.value': "1'b0" },
        }, {
            name: 'right_net',
            endpoints: [
                { kind: 'port', port: 'right_source' },
                { kind: 'port', port: 'right' },
            ],
        }],
    });

    assert.deepEqual(pathCodes(validateArchDesign(design, [])), [
        ['$.connections[0].defaults.right.value', 'AD_DEFAULT_CONNECTION'],
    ]);
});

test('rejects unsafe default expressions even when the endpoint is driven', () => {
    const invalidExpressions = [
        '',
        '`MACRO',
        'a // comment',
        'a /* comment',
        'a;b',
        'a\nb',
        'a\u0001b',
        '"quoted"',
        "foo'bar",
        '$system(COMMAND)',
        '$fopen(PATH)',
        '$fatal()',
        '$display(VALUE)',
        'side_effect()',
        'obj.delete()',
        'state++',
        '--state',
        '$signed(state++)',
        'state = value',
        'state += value',
        'state -= value',
        'state *= value',
        'state /= value',
        'state %= value',
        'state &= value',
        'state |= value',
        'state ^= value',
        'state <<= value',
        'state >>= value',
        '-> event_name',
        '->> event_name',
        '(a]',
        '{a',
        'a'.repeat(4097),
    ];
    for (const expression of invalidExpressions) {
        const parsed = designOf({
            ports: [
                { name: 'source', direction: 'input' },
                { name: 'sink', direction: 'output' },
            ],
            connections: [{
                name: 'driven',
                endpoints: [
                    { kind: 'port', port: 'source' },
                    { kind: 'port', port: 'sink' },
                ],
            }],
        });
        const design = {
            ...parsed,
            defaults: { 'sink.value': expression },
        } as ArchDesign;

        assert.deepEqual(
            pathCodes(validateArchDesign(design, [])),
            [['$.defaults.sink.value', 'AD_DEFAULT_EXPRESSION']],
            JSON.stringify(expression)
        );
    }
});

test('accepts common safe Verilog constant-expression forms', () => {
    const expressions = [
        "1'b0",
        "8'hff",
        "'1",
        'WIDTH',
        'configuration.WIDTH',
        'bus[7:0]',
        'configuration.bus[INDEX]',
        'left + right * scale / divisor % modulus',
        'left == right && lower <= upper || first != second',
        '~a & b',
        'select ? left : right',
        '{left, right}',
        '{4{data[1:0]}}',
        '$signed(value)',
        '$unsigned(value)',
        '$clog2(WIDTH)',
        '$bits(configuration.bus)',
        '$dimensions(configuration.bus)',
        '$high(configuration.bus)',
        '$increment(cfg.bus)',
        '$left(configuration.bus)',
        '$low(configuration.bus)',
        '$right(configuration.bus)',
        '$size(configuration.bus)',
        '$unpacked_dimensions(configuration.bus)',
    ];
    for (const expression of expressions) {
        const design = designOf({
            ports: [
                { name: 'source', direction: 'input', width: 8 },
                { name: 'sink', direction: 'output', width: 8 },
            ],
            connections: [{
                name: 'driven',
                endpoints: [
                    { kind: 'port', port: 'source' },
                    { kind: 'port', port: 'sink' },
                ],
            }],
            defaults: { 'sink.value': expression },
        });
        assert.deepEqual(validateArchDesign(design, []).diagnostics, [], expression);
    }
});

test('snapshots hostile catalog getters once during validation', () => {
    const reads = new Map<string, number>();
    const once = <T>(key: string, value: T): T => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return value;
    };
    const parameter = {
        get name() { return once('parameter.name', 'Z_LAST'); },
        get defaultExpression() { return once('parameter.defaultExpression', '1'); },
    };
    const width = {
        get kind() { return once('width.kind', 'known' as const); },
        get bits() { return once('width.bits', 1); },
    };
    const port = {
        get name() { return once('port.name', 'source'); },
        get direction() { return once('port.direction', 'output' as const); },
        get width() { return once('port.width', width); },
    };
    const parameterArray = new Proxy([parameter], {
        get(target, property, receiver) {
            if (property === 'length' || property === '0') {
                once(`parameters.${String(property)}`, undefined);
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const portArray = new Proxy([port], {
        get(target, property, receiver) {
            if (property === 'length' || property === '0') {
                once(`ports.${String(property)}`, undefined);
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const definition = {
        get key() { return once('definition.key', 'rtl/observed.sv#observed'); },
        get name() { return once('definition.name', 'observed'); },
        get parameters() { return once('definition.parameters', parameterArray); },
        get ports() { return once('definition.ports', portArray); },
    } as ArchDesignModuleDefinition;
    const catalog = new Proxy([definition], {
        get(target, property, receiver) {
            if (property === 'length' || property === '0') {
                once(`catalog.${String(property)}`, undefined);
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const design = designOf({
        instances: [{ name: 'u_observed', module: 'observed' }],
    });

    const result = validateArchDesign(design, catalog);

    assert.equal(result.valid, true);
    assert.deepEqual(Object.fromEntries(reads), {
        'catalog.length': 1,
        'catalog.0': 1,
        'definition.key': 1,
        'definition.name': 1,
        'definition.parameters': 1,
        'definition.ports': 1,
        'parameters.length': 1,
        'parameters.0': 1,
        'parameter.name': 1,
        'parameter.defaultExpression': 1,
        'ports.length': 1,
        'ports.0': 1,
        'port.name': 1,
        'port.direction': 1,
        'port.width': 1,
        'width.kind': 1,
        'width.bits': 1,
    });
});

test('snapshots every getter-backed design section and used field once during validation', () => {
    const reads = new Map<string, number>();
    const once = <T>(key: string, value: T): T => {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (count > 1) throw new Error(`${key} read more than once`);
        return value;
    };
    const observedArray = <T>(key: string, items: T[]): readonly T[] => new Proxy(items, {
        get(target, property, receiver) {
            if (property === 'length' || /^\d+$/.test(String(property))) {
                once(`${key}.${String(property)}`, undefined);
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const entry = <T>(scope: string, key: string, value: T): Readonly<Record<string, T>> => {
        const result: Record<string, T> = {};
        Object.defineProperty(result, key, {
            enumerable: true,
            get() { return once(`${scope}.${key}`, value); },
        });
        return result;
    };
    const sharedWidth = {
        get expression() { return once('width.expression', 'WIDTH'); },
    };
    const sourcePort = {
        get name() { return once('sourcePort.name', 'source'); },
        get direction() { return once('sourcePort.direction', 'input' as const); },
        get width() { return once('sourcePort.width', sharedWidth); },
    };
    const sinkPort = {
        get name() { return once('sinkPort.name', 'sink'); },
        get direction() { return once('sinkPort.direction', 'output' as const); },
        get width() { return once('sinkPort.width', sharedWidth); },
    };
    const instance = {
        get name() { return once('instance.name', 'u_producer'); },
        get module() { return once('instance.module', 'producer'); },
        get parameters() {
            return once('instance.parameters', entry('parameters', 'WIDTH', 8));
        },
    };
    const sourceEndpoint = {
        get kind() { return once('sourceEndpoint.kind', 'port' as const); },
        get port() { return once('sourceEndpoint.port', 'source'); },
        get signal() { return once('sourceEndpoint.signal', undefined); },
    };
    const sinkEndpoint = {
        get kind() { return once('sinkEndpoint.kind', 'port' as const); },
        get port() { return once('sinkEndpoint.port', 'sink'); },
        get signal() { return once('sinkEndpoint.signal', 'value' as const); },
    };
    const connection = {
        get name() { return once('connection.name', 'data'); },
        get endpoints() {
            return once(
                'connection.endpoints',
                observedArray('endpoints', [sourceEndpoint, sinkEndpoint])
            );
        },
        get defaults() {
            return once(
                'connection.defaults',
                entry('connectionDefaults', 'sink.value', "1'b1")
            );
        },
    };
    const ports = observedArray('ports', [sourcePort, sinkPort]);
    const instances = observedArray('instances', [instance]);
    const connections = observedArray('connections', [connection]);
    const interfaceConnections = observedArray('interfaceConnections', [{
        name: 'missing',
        master: { kind: 'port' as const, port: 'missing_master' },
        slave: { kind: 'port' as const, port: 'missing_slave' },
    }]);
    const designDefaults = entry('designDefaults', 'sink.value', "1'b0");
    const design = {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        get module() { return once('design.module', 'getter_top'); },
        get ports() { return once('design.ports', ports); },
        get instances() { return once('design.instances', instances); },
        get connections() { return once('design.connections', connections); },
        get interfaceConnections() {
            return once('design.interfaceConnections', interfaceConnections);
        },
        get defaults() { return once('design.defaults', designDefaults); },
        export: {},
        presentation: {},
    } as ArchDesign;
    const producer: ArchDesignModuleDefinition = {
        key: 'rtl/producer.sv#producer',
        name: 'producer',
        parameters: [{ name: 'WIDTH' }],
        ports: [{
            name: 'data',
            direction: 'output',
            width: { kind: 'known', bits: 1 },
        }],
    };

    let result: ReturnType<typeof validateArchDesign> | undefined;
    assert.doesNotThrow(() => {
        result = validateArchDesign(design, [producer]);
    });
    assert.ok(result);
    assert.deepEqual(pathCodes(result), [
        ['$.interfaceConnections[0].master', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
        ['$.interfaceConnections[0].slave', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
    ]);
    assert.deepEqual(Object.fromEntries(reads), {
        'design.module': 1,
        'design.ports': 1,
        'design.instances': 1,
        'design.connections': 1,
        'design.interfaceConnections': 1,
        'design.defaults': 1,
        'ports.length': 1,
        'ports.0': 1,
        'ports.1': 1,
        'sourcePort.name': 1,
        'sourcePort.direction': 1,
        'sourcePort.width': 1,
        'width.expression': 1,
        'sinkPort.name': 1,
        'sinkPort.direction': 1,
        'sinkPort.width': 1,
        'instances.length': 1,
        'instances.0': 1,
        'instance.name': 1,
        'instance.module': 1,
        'instance.parameters': 1,
        'parameters.WIDTH': 1,
        'connections.length': 1,
        'connections.0': 1,
        'connection.name': 1,
        'connection.endpoints': 1,
        'connection.defaults': 1,
        'endpoints.length': 1,
        'endpoints.0': 1,
        'endpoints.1': 1,
        'sourceEndpoint.kind': 1,
        'sourceEndpoint.port': 1,
        'sourceEndpoint.signal': 1,
        'sinkEndpoint.kind': 1,
        'sinkEndpoint.port': 1,
        'sinkEndpoint.signal': 1,
        'connectionDefaults.sink.value': 1,
        'interfaceConnections.length': 1,
        'interfaceConnections.0': 1,
        'designDefaults.sink.value': 1,
    });
});

test('captures design declaration slots before nested getters can replace later items', () => {
    const replacementPort = { name: 'mutated_port', direction: 'input' as const };
    const replacementInstance = { name: 'mutated_instance', module: 'empty' };
    const replacementConnection = { name: 'mutated_connection', endpoints: [] };
    const secondPort = { name: 'second_port', direction: 'input' as const };
    const secondInstance = { name: 'second_instance', module: 'empty' };
    const secondConnection = { name: 'second_connection', endpoints: [] };
    let defaultExpression = "1'b0";
    const defaults: Record<string, string> = {};
    Object.defineProperty(defaults, 'fallback.value', {
        enumerable: true,
        get() { return defaultExpression; },
    });
    const ports = [{
        get name() {
            ports[1] = replacementPort;
            instances[1] = replacementInstance;
            connections[1] = replacementConnection;
            defaultExpression = 'side_effect()';
            return 'first_port';
        },
        direction: 'input' as const,
    }, secondPort, {
        name: 'fallback',
        direction: 'output' as const,
    }];
    const instances = [{
        get name() {
            instances[1] = replacementInstance;
            return 'first_instance';
        },
        module: 'empty',
    }, secondInstance];
    const connections = [{
        get name() {
            connections[1] = replacementConnection;
            return 'first_connection';
        },
        endpoints: [],
    }, secondConnection];
    const design = {
        ...createEmptyArchDesign('slot_snapshot'),
        ports,
        instances,
        connections,
        defaults,
    } as ArchDesign;
    const empty: ArchDesignModuleDefinition = {
        key: 'rtl/empty.sv#empty',
        name: 'empty',
        parameters: [],
        ports: [],
    };

    const resolution = resolveArchDesign(design, [empty]);

    assert.deepEqual(resolution.ports.map(item => item.port.name), [
        'first_port',
        'second_port',
        'fallback',
    ]);
    assert.deepEqual(resolution.instances.map(item => item.instance.name), [
        'first_instance',
        'second_instance',
    ]);
    assert.deepEqual(resolution.connections.map(item => item.connection.name), [
        'first_connection',
        'second_connection',
    ]);
    assert.equal(resolution.effectiveDefaults.find(item =>
        item.endpoint === 'fallback.value'
    )?.expression, "1'b0");
});

test('captures connection default slots before reading nested endpoint fields', () => {
    let expression = "1'b0";
    const defaults: Record<string, string> = {};
    Object.defineProperty(defaults, 'sink.value', {
        enumerable: true,
        get() { return expression; },
    });
    const sourceEndpoint = {
        get kind() {
            expression = 'side_effect()';
            return 'port' as const;
        },
        port: 'source',
    };
    const design = {
        ...createEmptyArchDesign('connection_slot_snapshot'),
        ports: [
            { name: 'source', direction: 'input' as const },
            { name: 'sink', direction: 'output' as const },
        ],
        connections: [{
            name: 'data',
            endpoints: [sourceEndpoint, { kind: 'port' as const, port: 'sink' }],
            defaults,
        }],
    } as ArchDesign;

    const resolution = resolveArchDesign(design, []);

    assert.deepEqual(resolution.diagnostics, []);
    assert.equal(resolution.connections[0].connection.defaults?.['sink.value'], "1'b0");
});

test('retains catalog declaration order and owns the resolved snapshot', () => {
    const parameters = [
        { name: 'Z_LAST', defaultExpression: '2' },
        { name: 'A_FIRST', defaultExpression: '1' },
    ];
    const ports = [
        { name: 'z_port', direction: 'output' as const, width: { kind: 'known' as const, bits: 2 } },
        { name: 'a_port', direction: 'output' as const, width: { kind: 'known' as const, bits: 1 } },
    ];
    const definition: ArchDesignModuleDefinition = {
        key: 'rtl/ordered.sv#ordered',
        name: 'ordered',
        parameters,
        ports,
    };
    const design = designOf({ instances: [{ name: 'u_ordered', module: 'ordered' }] });

    const resolution = resolveArchDesign(design, [definition]);
    parameters[0].name = 'mutated';
    ports[0].name = 'mutated';
    ports[0].width.bits = 99;

    const snapshot = resolution.instances[0].definition!;
    assert.deepEqual(snapshot.parameters.map(item => item.name), ['Z_LAST', 'A_FIRST']);
    assert.deepEqual(snapshot.ports.map(item => item.name), ['z_port', 'a_port']);
    assert.deepEqual(snapshot.ports[0].width, { kind: 'known', bits: 2 });
    assert.ok(Object.isFrozen(snapshot.parameters));
    assert.ok(Object.isFrozen(snapshot.ports));
    assert.ok(Object.isFrozen(snapshot.ports[0].width));
    assert.equal(Reflect.has(snapshot, 'parametersByName'), false);
    assert.equal(Object.values(snapshot).some(value => value instanceof Map), false);
});

test('retains canonical identities and source paths on internally resolved defaults', () => {
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

    const resolution = resolveArchDesign(design, [consumer]);
    const defaults = resolution.effectiveDefaults;

    assert.deepEqual(resolution.diagnostics, []);
    assert.deepEqual(resolution.endpointTargets
        .filter(endpoint => endpoint.defaultKey === 'node.t')
        .map(endpoint => endpoint.identity), [
        'port:node:t',
        'instance:node:t',
    ]);
    assert.deepEqual(defaults.find(item => item.identity === 'port:node:o'), {
        identity: 'port:node:o',
        endpoint: 'node.o',
        declarationOrder: 1,
        sourcePath: '$.defaults.node.o',
        expression: "8'b0",
        origin: 'design',
    });
    assert.deepEqual(defaults.find(item => item.identity === 'port:node:t'), {
        identity: 'port:node:t',
        endpoint: 'node.t',
        declarationOrder: 2,
        sourcePath: '$.ports[0]',
        expression: "1'b1",
        origin: 'implicit-inout-t',
    });
});

test('uses indexes instead of peer and membership array scans per connection', () => {
    const busNames = Array.from({ length: 24 }, (_, index) => `bus_${index}`);
    const design = designOf({
        ports: [{ name: 'source', direction: 'input' }, ...busNames.map(name => ({
            name,
            direction: 'inout' as const,
            width: 8,
        }))],
        connections: [{
            name: 'indexed',
            endpoints: [{ kind: 'port', port: 'source' }, ...busNames.map(port => ({
                kind: 'port' as const,
                port,
                signal: 't' as const,
            }))],
            defaults: Object.fromEntries(busNames.map(name => [`${name}.t`, "1'b0"])),
        }],
        defaults: Object.fromEntries(busNames.map(name => [`${name}.o`, "8'b0"])),
    });
    const scans = { some: 0, includes: 0 };
    const someDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'some')!;
    const includesDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!;
    Object.defineProperty(Array.prototype, 'some', {
        ...someDescriptor,
        value: function (this: unknown[], ...args: unknown[]) {
            scans.some += 1;
            return Reflect.apply(
                someDescriptor.value as (...parameters: unknown[]) => unknown,
                this,
                args
            );
        },
    });
    Object.defineProperty(Array.prototype, 'includes', {
        ...includesDescriptor,
        value: function (this: unknown[], ...args: unknown[]) {
            scans.includes += 1;
            return Reflect.apply(
                includesDescriptor.value as (...parameters: unknown[]) => unknown,
                this,
                args
            );
        },
    });
    let resolution: ReturnType<typeof resolveArchDesign> | undefined;
    try {
        resolution = resolveArchDesign(design, []);
    } finally {
        Object.defineProperty(Array.prototype, 'some', someDescriptor);
        Object.defineProperty(Array.prototype, 'includes', includesDescriptor);
    }

    assert.ok(resolution);
    assert.deepEqual(resolution.diagnostics, []);
    assert.deepEqual(scans, { some: 0, includes: 0 });
});

test('owns mutable design instance endpoint connection array and dictionary inputs', () => {
    const parameters = { WIDTH: 8 };
    const instance = { name: 'u_consumer', module: 'consumer', parameters };
    const sourceEndpoint = { kind: 'port' as const, port: 'source' };
    const instanceEndpoint = {
        kind: 'instance' as const,
        instance: 'u_consumer',
        port: 'data_i',
    };
    const connectionDefaults = { 'u_consumer.data_i': "8'b0" };
    const connection = {
        name: 'data',
        endpoints: [sourceEndpoint, instanceEndpoint],
        defaults: connectionDefaults,
    };
    const instances = [instance];
    const connections: Array<{
        name: string;
        endpoints: Array<typeof sourceEndpoint | typeof instanceEndpoint>;
        defaults: Record<string, string>;
    }> = [connection];
    const design: ArchDesign = {
        ...createEmptyArchDesign('soc_top'),
        ports: [{ name: 'source', direction: 'input', width: 8 }],
        instances,
        connections,
    };
    const definition: ArchDesignModuleDefinition = {
        key: 'rtl/consumer.sv#consumer',
        name: 'consumer',
        parameters: [{ name: 'WIDTH', defaultExpression: '8' }],
        ports: [{ name: 'data_i', direction: 'input', width: { kind: 'known', bits: 8 } }],
    };

    const resolution = resolveArchDesign(design, [definition]);
    instance.name = 'mutated_instance';
    instance.module = 'mutated_module';
    parameters.WIDTH = 99;
    sourceEndpoint.port = 'mutated_source';
    instanceEndpoint.instance = 'mutated_instance';
    instanceEndpoint.port = 'mutated_port';
    connection.name = 'mutated_connection';
    connection.endpoints.push({ kind: 'port', port: 'mutated_extra' });
    connectionDefaults['u_consumer.data_i'] = "8'hff";
    instances.push({ name: 'added', module: 'consumer', parameters: { WIDTH: 1 } });
    connections.push({ name: 'added', endpoints: [], defaults: {} });

    assert.deepEqual(resolution.instances[0].instance, {
        name: 'u_consumer',
        module: 'consumer',
        parameters: { WIDTH: 8 },
    });
    assert.deepEqual(resolution.connections[0].connection, {
        name: 'data',
        endpoints: [
            { kind: 'port', port: 'source' },
            { kind: 'instance', instance: 'u_consumer', port: 'data_i' },
        ],
        defaults: { 'u_consumer.data_i': "8'b0" },
    });
    assert.deepEqual(resolution.connections[0].endpoints.map(endpoint => endpoint.endpoint), [
        { kind: 'port', port: 'source' },
        { kind: 'instance', instance: 'u_consumer', port: 'data_i' },
    ]);
    assert.ok(Object.isFrozen(resolution.instances[0].instance));
    assert.ok(Object.isFrozen(resolution.instances[0].instance.parameters));
    assert.ok(Object.isFrozen(resolution.connections[0].connection));
    assert.ok(Object.isFrozen(resolution.connections[0].connection.endpoints));
    assert.ok(Object.isFrozen(resolution.connections[0].connection.defaults));
    assert.ok(Object.isFrozen(resolution.connections[0].endpoints[0].endpoint));
});

test('owns the complete resolved design snapshot after caller mutation', () => {
    const symbolicWidth = { expression: 'WIDTH' };
    const ports: Array<{
        name: string;
        direction: 'input' | 'output';
        width: number | { expression: string };
    }> = [
        { name: 'source', direction: 'input' as const, width: symbolicWidth },
        { name: 'fallback', direction: 'output' as const, width: 8 },
    ];
    const parameters = { WIDTH: 8 };
    const instances = [{ name: 'u_consumer', module: 'consumer', parameters }];
    const sourceEndpoint = { kind: 'port' as const, port: 'source' };
    const consumerEndpoint = {
        kind: 'instance' as const,
        instance: 'u_consumer',
        port: 'data_i',
    };
    const connectionDefaults = { 'u_consumer.data_i': "8'b0" };
    const connections: Array<{
        name: string;
        endpoints: Array<typeof sourceEndpoint | typeof consumerEndpoint>;
        defaults: Record<string, string>;
    }> = [{
        name: 'data',
        endpoints: [sourceEndpoint, consumerEndpoint],
        defaults: connectionDefaults,
    }];
    const interfaceConnections = [{
        name: 'unsupported',
        master: { kind: 'instance', instance: 'u_consumer', interface: 'left' },
        slave: { kind: 'instance', instance: 'u_consumer', interface: 'right' },
    }];
    const defaults = { 'fallback.value': "8'h5a" };
    const design = {
        ...createEmptyArchDesign('owned_top'),
        ports,
        instances,
        connections,
        interfaceConnections,
        defaults,
    } as ArchDesign;
    const definition: ArchDesignModuleDefinition = {
        key: 'rtl/consumer.sv#consumer',
        name: 'consumer',
        parameters: [{ name: 'WIDTH' }],
        ports: [{
            name: 'data_i',
            direction: 'input',
            width: { kind: 'known', bits: 8 },
        }],
    };

    const resolution = resolveArchDesign(design, [definition]);
    const mutableDesign = design as unknown as { module: string };
    mutableDesign.module = 'mutated_top';
    ports[0].name = 'mutated_source';
    symbolicWidth.expression = 'MUTATED_WIDTH';
    ports.push({ name: 'added', direction: 'input', width: 1 });
    instances[0].name = 'mutated_instance';
    instances.push({ name: 'added', module: 'consumer', parameters: { WIDTH: 1 } });
    parameters.WIDTH = 99;
    sourceEndpoint.port = 'mutated_source';
    consumerEndpoint.instance = 'mutated_instance';
    connectionDefaults['u_consumer.data_i'] = "8'hff";
    connections[0].name = 'mutated_connection';
    connections.push({ name: 'added', endpoints: [], defaults: {} });
    interfaceConnections[0].name = 'mutated_interface';
    interfaceConnections.push({
        name: 'added',
        master: { kind: 'instance', instance: 'u_consumer', interface: 'left' },
        slave: { kind: 'instance', instance: 'u_consumer', interface: 'right' },
    });
    defaults['fallback.value'] = "8'hff";

    assert.equal(resolution.moduleName, 'owned_top');
    assert.deepEqual(resolution.ports.map(item => item.port), [
        { name: 'source', direction: 'input', width: { expression: 'WIDTH' } },
        { name: 'fallback', direction: 'output', width: 8 },
    ]);
    assert.deepEqual(resolution.instances[0].instance, {
        name: 'u_consumer',
        module: 'consumer',
        parameters: { WIDTH: 8 },
    });
    assert.deepEqual(resolution.connections[0].connection, {
        name: 'data',
        endpoints: [
            { kind: 'port', port: 'source' },
            { kind: 'instance', instance: 'u_consumer', port: 'data_i' },
        ],
        defaults: { 'u_consumer.data_i': "8'b0" },
    });
    assert.deepEqual(resolution.effectiveDefaults.find(item =>
        item.endpoint === 'fallback.value'
    ), {
        identity: 'port:fallback:value',
        endpoint: 'fallback.value',
        declarationOrder: 1,
        sourcePath: '$.defaults.fallback.value',
        expression: "8'h5a",
        origin: 'design',
    });
    assert.deepEqual(resolution.diagnostics.map(item => [item.path, item.code]), [
        ['$.interfaceConnections[0].master', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
        ['$.interfaceConnections[0].slave', 'AD_INTERFACE_ENDPOINT_UNKNOWN'],
    ]);
    assert.ok(Object.isFrozen(resolution.ports));
    assert.ok(Object.isFrozen(resolution.ports[0]));
    assert.ok(Object.isFrozen(resolution.ports[0].port));
    assert.ok(Object.isFrozen(resolution.ports[0].port.width));
});
