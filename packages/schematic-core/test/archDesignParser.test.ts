import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseArchDesignText,
    parseArchDesignValue,
    type ArchDesignReadResult,
} from '../src/archDesign';

function minimalDesign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'soc_top',
        ports: [],
        instances: [],
        connections: [],
        interfacePorts: [],
        interfaceOverrides: {},
        interfaceConnections: [],
        defaults: {},
        export: {},
        presentation: {},
        ...overrides,
    };
}

function invalidDiagnostics(result: ArchDesignReadResult) {
    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid Arch Design');
    return result.diagnostics;
}

test('parses a complete schema-v1 document into an owned frozen snapshot', () => {
    const source = JSON.stringify(minimalDesign({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'gpio', direction: 'inout', width: { expression: 'GPIO_WIDTH' } },
        ],
        instances: [{
            name: 'u_core',
            module: 'core',
            definitionKey: 'module:file:///workspace/rtl/core.v:0',
            parameters: { WIDTH: 32, ENABLED: true, MODE: '"FAST"' },
        }],
        connections: [{
            name: 'clock',
            endpoints: [
                { kind: 'port', port: 'clk' },
                { kind: 'instance', instance: 'u_core', port: 'clk' },
            ],
            defaults: { 'u_core.enable': "1'b1" },
        }],
        interfacePorts: [{
            name: 's_axi',
            protocol: 'amba.axi4',
            role: 'slave',
            memberPrefix: 'S_AXI',
            members: [
                { member: 'awaddr', width: 32 },
                { member: 'wdata', width: { expression: 'DATA_WIDTH' } },
            ],
        }],
        interfaceOverrides: {
            'u_core.M_AXI': { protocol: 'amba.axi4', role: 'master' },
            'u_core.m_axi': { protocol: 'amba.axi4', role: 'slave' },
        },
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'instance', instance: 'u_core', interface: 'M_AXI' },
            slave: { kind: 'port', port: 's_axi' },
            defaults: { wlast: "1'b1" },
        }],
        defaults: { 'u_core.enable': "1'b1" },
        export: { language: 'verilog', output: 'generated/soc_top.v' },
        presentation: {
            nodes: {
                'instance:u_core': {
                    column: 1,
                    order: 0,
                    offset: 8,
                    userPositioned: true,
                },
            },
            collapsedInterfaces: { 'u_core.m_axi_00': true },
        },
    }));

    const result = parseArchDesignText(source);

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.equal(result.design.module, 'soc_top');
    assert.equal(
        Reflect.get(result.design.instances[0], 'definitionKey'),
        'module:file:///workspace/rtl/core.v:0'
    );
    assert.equal(result.design.instances[0].parameters?.WIDTH, 32);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.design));
    assert.ok(Object.isFrozen(result.design.connections));
    assert.ok(Object.isFrozen(result.design.connections[0].endpoints));
    assert.ok(Object.isFrozen(result.design.interfacePorts[0].members));
    assert.equal(Object.getPrototypeOf(result.design.interfaceOverrides), null);
    assert.equal(result.design.interfaceOverrides['u_core.M_AXI'].role, 'master');
    assert.equal(result.design.interfaceOverrides['u_core.m_axi'].role, 'slave');
});

test('keeps legacy schema-v1 instances without a definition reference', () => {
    const result = parseArchDesignValue(minimalDesign({
        instances: [{ name: 'u_core', module: 'core' }],
    }));

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.deepEqual(result.design.instances, [{ name: 'u_core', module: 'core' }]);
});

test('normalizes omitted interface sections for legacy schema-v1 documents', () => {
    const value = minimalDesign();
    delete value.interfacePorts;
    delete value.interfaceOverrides;

    const result = parseArchDesignValue(value);

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.deepEqual(result.design.interfacePorts, []);
    assert.deepEqual(Object.keys(result.design.interfaceOverrides), []);
    assert.equal(Object.getPrototypeOf(result.design.interfaceOverrides), null);
});

test('ignores unknown presentation fields', () => {
    const result = parseArchDesignValue(minimalDesign({
        presentation: { camera: { x: 10, y: 20, zoom: 1.25 } },
    }));

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.deepEqual(result.design.presentation, {});
});

test('rejects malformed interface declarations, overrides, endpoints, and unsafe defaults', () => {
    const result = parseArchDesignValue(minimalDesign({
        interfacePorts: [{
            name: 's_axi',
            protocol: '',
            role: 'unknown',
            memberPrefix: '',
            members: [
                { member: '', width: 0 },
                { member: 'awaddr', width: 32 },
                { member: 'awaddr', width: 64 },
            ],
        }],
        interfaceOverrides: {
            valid: { protocol: '', role: 'unknown' },
            broken: null,
        },
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'module', instance: 'u_core', interface: 'm_axi' },
            slave: { kind: 'port', port: '' },
            defaults: { wlast: "1'b1; injected = 1'b1" },
        }],
    }));

    const paths = invalidDiagnostics(result).map(item => item.path);
    for (const path of [
        '$.interfacePorts[0].protocol',
        '$.interfacePorts[0].role',
        '$.interfacePorts[0].memberPrefix',
        '$.interfacePorts[0].members[0].member',
        '$.interfacePorts[0].members[0].width',
        '$.interfacePorts[0].members[2].member',
        '$.interfaceOverrides.valid.protocol',
        '$.interfaceOverrides.valid.role',
        '$.interfaceOverrides.broken',
        '$.interfaceConnections[0].master.kind',
        '$.interfaceConnections[0].slave.port',
        '$.interfaceConnections[0].defaults.wlast',
    ]) {
        assert.ok(paths.includes(path), `missing diagnostic for ${path}`);
    }
});

test('rejects duplicate top-level interface names and names shared with scalar ports', () => {
    const result = parseArchDesignValue(minimalDesign({
        ports: [{ name: 's_axi', direction: 'input' }],
        interfacePorts: [
            {
                name: 's_axi',
                protocol: 'amba.axi4',
                role: 'slave',
                memberPrefix: 's_axi',
                members: [{ member: 'awaddr', width: 32 }],
            },
            {
                name: 's_axi',
                protocol: 'amba.axi4',
                role: 'slave',
                memberPrefix: 's_axi_2',
                members: [{ member: 'awaddr', width: 32 }],
            },
        ],
    }));

    assert.deepEqual(invalidDiagnostics(result).map(item => [item.path, item.code]), [
        ['$.interfacePorts[0].name', 'AD_DUPLICATE_NAME'],
        ['$.interfacePorts[1].name', 'AD_DUPLICATE_NAME'],
    ]);
});

test('owns and freezes interface dictionaries containing prototype-hostile keys', () => {
    const source = JSON.parse('{"format":"vik-veriflow.arch-design","schemaVersion":1,'
        + '"module":"soc_top","ports":[],"instances":[],"connections":[],'
        + '"interfacePorts":[],"interfaceOverrides":{'
        + '"__proto__":{"protocol":"amba.axi4","role":"master"},'
        + '"constructor":{"protocol":"amba.apb","role":"slave"}},'
        + '"interfaceConnections":[],"defaults":{},"export":{},"presentation":{}}');
    const result = parseArchDesignValue(source);

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.equal(Object.getPrototypeOf(result.design.interfaceOverrides), null);
    assert.equal(result.design.interfaceOverrides.__proto__.role, 'master');
    assert.equal(
        (Reflect.get(result.design.interfaceOverrides, 'constructor') as { role: string }).role,
        'slave'
    );
    assert.ok(Object.isFrozen(result.design.interfaceOverrides.__proto__));
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});

test('reports invalid JSON and the wrong format without throwing', () => {
    assert.deepEqual(invalidDiagnostics(parseArchDesignText('{')), [{
        path: '$',
        code: 'AD_JSON_SYNTAX',
        message: 'Arch Design is not valid JSON',
    }]);

    const diagnostics = invalidDiagnostics(parseArchDesignValue(minimalDesign({
        format: 'vivado.bd',
    })));
    assert.deepEqual(diagnostics.map(item => [item.path, item.code]), [
        ['$.format', 'AD_FORMAT'],
    ]);
});

test('keeps an unknown positive schema version available for read-only use', () => {
    const value = minimalDesign({ schemaVersion: 2, futureField: { enabled: true } });
    const result = parseArchDesignValue(value);

    assert.equal(result.status, 'unsupported');
    if (result.status !== 'unsupported') return;
    assert.equal(result.schemaVersion, 2);
    assert.deepEqual(result.value.futureField, { enabled: true });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.value));
    assert.ok(Object.isFrozen(result.value.futureField));
});

test('collects deterministic path diagnostics for malformed current fields', () => {
    const result = parseArchDesignValue(minimalDesign({
        module: 'bad-name',
        ports: [{ name: '', direction: 'sideways', width: 0 }],
        instances: [{
            name: 'u_core',
            module: '',
            parameters: { WIDTH: { value: 8 } },
        }],
        connections: [{
            name: 'clock',
            endpoints: [
                { kind: 'port', port: '', signal: 'bad' },
                { kind: 'mystery' },
            ],
            defaults: { target: 1 },
        }],
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'instance', instance: 'u_core' },
            slave: null,
        }],
        defaults: { target: false },
        export: { language: 'vhdl', output: 12 },
        presentation: {
            nodes: {
                u_core: {
                    column: -1,
                    order: 1.5,
                    offset: 'low',
                    userPositioned: 'yes',
                },
            },
            collapsedInterfaces: { control: 'yes' },
        },
    }));

    const paths = invalidDiagnostics(result).map(item => item.path);
    for (const path of [
        '$.module',
        '$.ports[0].name',
        '$.ports[0].direction',
        '$.ports[0].width',
        '$.instances[0].module',
        '$.instances[0].parameters.WIDTH',
        '$.connections[0].endpoints[0].port',
        '$.connections[0].endpoints[0].signal',
        '$.connections[0].endpoints[1].kind',
        '$.connections[0].defaults.target',
        '$.interfaceConnections[0].master.interface',
        '$.interfaceConnections[0].slave',
        '$.defaults.target',
        '$.export.language',
        '$.export.output',
        '$.presentation.nodes.u_core.column',
        '$.presentation.nodes.u_core.order',
        '$.presentation.nodes.u_core.offset',
        '$.presentation.nodes.u_core.userPositioned',
        '$.presentation.collapsedInterfaces.control',
    ]) {
        assert.ok(paths.includes(path), `missing diagnostic for ${path}`);
    }
    assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)));
});

test('rejects duplicate named semantic objects at the duplicate declaration', () => {
    const result = parseArchDesignValue(minimalDesign({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'clk', direction: 'output' },
        ],
        instances: [
            { name: 'u_core', module: 'core' },
            { name: 'u_core', module: 'other' },
        ],
        connections: [
            { name: 'data', endpoints: [] },
            { name: 'data', endpoints: [] },
        ],
        interfaceConnections: [
            {
                name: 'control',
                master: { kind: 'instance', instance: 'u_core', interface: 'm_axi' },
                slave: { kind: 'instance', instance: 'u_regs', interface: 's_axi' },
            },
            {
                name: 'control',
                master: { kind: 'instance', instance: 'u_core', interface: 'm_axi_01' },
                slave: { kind: 'instance', instance: 'u_regs', interface: 's_axi_01' },
            },
        ],
    }));

    assert.deepEqual(invalidDiagnostics(result).map(item => [item.path, item.code]), [
        ['$.connections[1].name', 'AD_DUPLICATE_NAME'],
        ['$.instances[1].name', 'AD_DUPLICATE_NAME'],
        ['$.interfaceConnections[1].name', 'AD_DUPLICATE_NAME'],
        ['$.ports[1].name', 'AD_DUPLICATE_NAME'],
    ]);
});

test('orders diagnostics independently of the host locale', () => {
    const result = parseArchDesignValue(minimalDesign({
        defaults: {
            a_target: false,
            Z_target: false,
        },
    }));

    assert.deepEqual(invalidDiagnostics(result).map(item => item.path), [
        '$.defaults.Z_target',
        '$.defaults.a_target',
    ]);
});

test('uses own properties and prototype-free dictionaries in normalized output', () => {
    const inherited = Object.create({ module: 'inherited_top' }) as Record<string, unknown>;
    Object.assign(inherited, minimalDesign());
    delete inherited.module;

    const inheritedResult = parseArchDesignValue(inherited);
    assert.deepEqual(invalidDiagnostics(inheritedResult).map(item => item.path), ['$.module']);

    const source = '{"format":"vik-veriflow.arch-design","schemaVersion":1,'
        + '"module":"soc_top","ports":[],"instances":[],"connections":[],'
        + '"interfaceConnections":[],"defaults":{"__proto__":"1\'b0"},'
        + '"export":{},"presentation":{}}';
    const result = parseArchDesignText(source);
    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.equal(Object.getPrototypeOf(result.design.defaults), null);
    assert.equal(result.design.defaults.__proto__, "1'b0");
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});

test('detaches normalized data from a caller-owned input object', () => {
    const port = { name: 'clk', direction: 'input' };
    const value = minimalDesign({ ports: [port] });
    const result = parseArchDesignValue(value);
    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;

    port.name = 'changed';
    (value.ports as unknown[]).push({ name: 'rst_n', direction: 'input' });

    assert.deepEqual(result.design.ports, [{ name: 'clk', direction: 'input' }]);
});

test('does not invoke caller-controlled array iteration methods', () => {
    const port = { name: 'clk', direction: 'input' };
    const ports = [port];
    const endpoint = { kind: 'port', port: 'clk' };
    const injected = { kind: 'instance', instance: 'injected', port: 'data' };
    const endpoints = [endpoint];
    let methodCalls = 0;
    Object.defineProperty(ports, 'forEach', {
        value: () => {
            methodCalls += 1;
        },
    });
    Object.defineProperty(endpoints, 'flatMap', {
        value: () => {
            methodCalls += 1;
            return [injected];
        },
    });

    const result = parseArchDesignValue(minimalDesign({
        ports,
        connections: [{ name: 'clock', endpoints }],
    }));

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.equal(methodCalls, 0);
    assert.deepEqual(result.design.ports, [{ name: 'clk', direction: 'input' }]);
    assert.deepEqual(result.design.connections[0].endpoints, [{ kind: 'port', port: 'clk' }]);
    assert.equal(Object.isFrozen(port), false);
    assert.equal(Object.isFrozen(endpoint), false);
    assert.equal(Object.isFrozen(injected), false);
});

test('clones unknown-version arrays without invoking their map property', () => {
    const futureItem = { enabled: true };
    const futureArray = [futureItem];
    let methodCalls = 0;
    Object.defineProperty(futureArray, 'map', {
        value: () => {
            methodCalls += 1;
            return [{ injected: true }];
        },
    });

    const result = parseArchDesignValue(minimalDesign({
        schemaVersion: 2,
        futureArray,
    }));

    assert.equal(result.status, 'unsupported');
    if (result.status !== 'unsupported') return;
    assert.equal(methodCalls, 0);
    assert.deepEqual(result.value.futureArray, [{ enabled: true }]);
    assert.equal(Object.isFrozen(futureItem), false);
});

test('rejects sparse arrays instead of reading inherited index values', () => {
    const inheritedPort = { name: 'polluted', direction: 'input' };
    const ports: unknown[] = [];
    ports.length = 1;
    Object.setPrototypeOf(ports, { 0: inheritedPort });

    const current = parseArchDesignValue(minimalDesign({ ports }));
    assert.deepEqual(invalidDiagnostics(current).map(item => [item.path, item.code]), [
        ['$.ports', 'AD_VALUE'],
    ]);
    assert.equal(Object.isFrozen(inheritedPort), false);

    const futureArray: unknown[] = [];
    futureArray.length = 1;
    Object.setPrototypeOf(futureArray, { 0: inheritedPort });
    const future = parseArchDesignValue(minimalDesign({
        schemaVersion: 2,
        futureArray,
    }));
    assert.deepEqual(invalidDiagnostics(future).map(item => [item.path, item.code]), [
        ['$', 'AD_VALUE'],
    ]);
    assert.equal(Object.isFrozen(inheritedPort), false);
});

test('snapshots unknown-version header getters exactly once', () => {
    const value = minimalDesign({ schemaVersion: 2 });
    let formatReads = 0;
    let versionReads = 0;
    Object.defineProperty(value, 'format', {
        enumerable: true,
        get: () => ++formatReads === 1 ? 'vik-veriflow.arch-design' : 'changed-format',
    });
    Object.defineProperty(value, 'schemaVersion', {
        enumerable: true,
        get: () => ++versionReads === 1 ? 2 : 3,
    });

    const result = parseArchDesignValue(value);

    assert.equal(result.status, 'unsupported');
    if (result.status !== 'unsupported') return;
    assert.equal(formatReads, 1);
    assert.equal(versionReads, 1);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.value.format, 'vik-veriflow.arch-design');
    assert.equal(result.value.schemaVersion, 2);
});

test('snapshots array items before normalizing getter-mutated input', () => {
    const inheritedPort = { name: 'polluted', direction: 'output' };
    const ports: unknown[] = [];
    const firstPort = { name: 'clk', direction: 'input' };
    Object.defineProperty(ports, '0', {
        enumerable: true,
        configurable: true,
        get: () => {
            delete ports[1];
            Object.setPrototypeOf(ports, { 1: inheritedPort });
            return firstPort;
        },
    });
    ports[1] = { name: 'rst_n', direction: 'input' };

    const current = parseArchDesignValue(minimalDesign({ ports }));
    assert.deepEqual(invalidDiagnostics(current).map(item => [item.path, item.code]), [
        ['$.ports', 'AD_VALUE'],
    ]);
    assert.equal(Object.isFrozen(firstPort), false);
    assert.equal(Object.isFrozen(inheritedPort), false);

    const futureArray: unknown[] = [];
    Object.defineProperty(futureArray, '0', {
        enumerable: true,
        configurable: true,
        get: () => {
            delete futureArray[1];
            Object.setPrototypeOf(futureArray, { 1: inheritedPort });
            return { enabled: true };
        },
    });
    futureArray[1] = { enabled: false };
    const future = parseArchDesignValue(minimalDesign({
        schemaVersion: 2,
        futureArray,
    }));
    assert.deepEqual(invalidDiagnostics(future).map(item => [item.path, item.code]), [
        ['$', 'AD_VALUE'],
    ]);
    assert.equal(Object.isFrozen(inheritedPort), false);
});

test('does not read unknown top-level fields in the current schema', () => {
    const value = minimalDesign();
    let unknownReads = 0;
    Object.defineProperty(value, 'futureField', {
        enumerable: true,
        get: () => {
            unknownReads += 1;
            throw new Error('current schema must ignore this field');
        },
    });

    const result = parseArchDesignValue(value);

    assert.equal(result.status, 'editable');
    assert.equal(unknownReads, 0);
});

test('rejects dictionaries whose getter replaces a later own key with an inherited value', () => {
    const inheritedDefault = "1'b1";
    const defaults: Record<string, unknown> = {};
    Object.defineProperty(defaults, 'a_target', {
        enumerable: true,
        configurable: true,
        get: () => {
            delete defaults.b_target;
            Object.setPrototypeOf(defaults, { b_target: inheritedDefault });
            return "1'b0";
        },
    });
    defaults.b_target = "1'b0";

    const current = parseArchDesignValue(minimalDesign({ defaults }));
    assert.deepEqual(invalidDiagnostics(current).map(item => [item.path, item.code]), [
        ['$.defaults', 'AD_VALUE'],
    ]);

    const futureObject: Record<string, unknown> = {};
    Object.defineProperty(futureObject, 'a', {
        enumerable: true,
        configurable: true,
        get: () => {
            delete futureObject.b;
            Object.setPrototypeOf(futureObject, { b: inheritedDefault });
            return 1;
        },
    });
    futureObject.b = 2;
    const future = parseArchDesignValue(minimalDesign({
        schemaVersion: 2,
        futureObject,
    }));
    assert.deepEqual(invalidDiagnostics(future).map(item => [item.path, item.code]), [
        ['$', 'AD_VALUE'],
    ]);
});

test('does not accept an inherited schema version introduced by the format getter', () => {
    const value = minimalDesign({ schemaVersion: 2 });
    Object.defineProperty(value, 'format', {
        enumerable: true,
        configurable: true,
        get: () => {
            delete value.schemaVersion;
            Object.setPrototypeOf(value, { schemaVersion: 2 });
            return 'vik-veriflow.arch-design';
        },
    });

    const result = parseArchDesignValue(value);

    assert.deepEqual(invalidDiagnostics(result).map(item => [item.path, item.code]), [
        ['$.schemaVersion', 'AD_SCHEMA_VERSION'],
    ]);
});
