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
        interfaceConnections: [{
            name: 'control',
            protocol: 'axi4-lite',
            master: { instance: 'u_core', interface: 'm_axi_00' },
            slave: { instance: 'u_regs', interface: 's_axi' },
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
            viewport: { x: 10, y: 20, zoom: 1.25 },
        },
    }));

    const result = parseArchDesignText(source);

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.equal(result.design.module, 'soc_top');
    assert.equal(result.design.instances[0].parameters?.WIDTH, 32);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.design));
    assert.ok(Object.isFrozen(result.design.connections));
    assert.ok(Object.isFrozen(result.design.connections[0].endpoints));
    assert.ok(Object.isFrozen(result.design.presentation.viewport));
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
            protocol: '',
            master: { instance: 'u_core' },
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
            viewport: { x: 'left', y: 0, zoom: 0 },
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
        '$.interfaceConnections[0].protocol',
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
        '$.presentation.viewport.x',
        '$.presentation.viewport.zoom',
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
                master: { instance: 'u_core', interface: 'm_axi' },
                slave: { instance: 'u_regs', interface: 's_axi' },
            },
            {
                name: 'control',
                master: { instance: 'u_core', interface: 'm_axi_01' },
                slave: { instance: 'u_regs', interface: 's_axi_01' },
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
