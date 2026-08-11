import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseArchDesignText,
    parseArchDesignValue,
    semanticArchDesignFingerprint,
    serializeArchDesign,
    type ArchDesign,
} from '../src/archDesign';

function sourceDesign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'soc_top',
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'result', direction: 'output', width: 16 },
        ],
        instances: [{
            name: 'u_core',
            module: 'core',
            parameters: { WIDTH: 16, ENABLED: true },
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
            defaults: { wlast: "1'b1", awlen: "8'b0" },
        }],
        defaults: { 'u_core.reset': "1'b0", 'u_core.enable': "1'b1" },
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
        ...overrides,
    };
}

function editable(value: Record<string, unknown>): ArchDesign {
    const result = parseArchDesignValue(value);
    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') throw new Error('expected editable Arch Design');
    return result.design;
}

test('serializes normalized designs in fixed schema order and round trips', () => {
    const design = editable(sourceDesign());
    const source = serializeArchDesign(design);

    assert.equal(source.endsWith('\n'), true);
    assert.equal(source.includes('\t'), false);
    const topLevelKeys = Object.keys(JSON.parse(source));
    assert.deepEqual(topLevelKeys, [
        'format',
        'schemaVersion',
        'module',
        'ports',
        'instances',
        'connections',
        'interfaceConnections',
        'defaults',
        'export',
        'presentation',
    ]);
    assert.ok(source.indexOf('"ENABLED"') < source.indexOf('"WIDTH"'));
    assert.ok(source.indexOf('"u_core.enable"') < source.indexOf('"u_core.reset"'));
    assert.ok(source.indexOf('"awlen"') < source.indexOf('"wlast"'));

    const reparsed = parseArchDesignText(source);
    assert.equal(reparsed.status, 'editable');
    if (reparsed.status === 'editable') assert.deepEqual(reparsed.design, design);
});

test('canonicalizes dictionary insertion order without reordering declarations', () => {
    const left = editable(sourceDesign({
        ports: [
            { name: 'z_port', direction: 'input' },
            { name: 'a_port', direction: 'output' },
        ],
        instances: [{
            name: 'u_z',
            module: 'z_mod',
            parameters: { Z_VALUE: 2, A_VALUE: 1 },
        }, {
            name: 'u_a',
            module: 'a_mod',
        }],
        defaults: { 'u_z.z': "1'b0", 'u_a.a': "1'b1" },
    }));
    const right = editable(sourceDesign({
        ports: [
            { name: 'z_port', direction: 'input' },
            { name: 'a_port', direction: 'output' },
        ],
        instances: [{
            name: 'u_z',
            module: 'z_mod',
            parameters: { A_VALUE: 1, Z_VALUE: 2 },
        }, {
            name: 'u_a',
            module: 'a_mod',
        }],
        defaults: { 'u_a.a': "1'b1", 'u_z.z': "1'b0" },
    }));

    assert.equal(serializeArchDesign(left), serializeArchDesign(right));
    const value = JSON.parse(serializeArchDesign(left));
    assert.deepEqual(value.ports.map((port: { name: string }) => port.name), [
        'z_port',
        'a_port',
    ]);
    assert.deepEqual(value.instances.map((instance: { name: string }) => instance.name), [
        'u_z',
        'u_a',
    ]);
});

test('ignores presentation and output path when computing semantic fingerprints', () => {
    const original = editable(sourceDesign());
    const moved = editable(sourceDesign({
        export: { language: 'verilog', output: 'another/place/top.v' },
        presentation: {
            nodes: {
                'instance:u_core': {
                    column: 4,
                    order: 3,
                    offset: -24,
                    userPositioned: true,
                },
            },
            collapsedInterfaces: { 'u_core.m_axi_00': false },
            viewport: { x: -50, y: 80, zoom: 0.75 },
        },
    }));

    const fingerprint = semanticArchDesignFingerprint(original);
    assert.match(fingerprint, /^ad-v1-[0-9a-f]{16}$/);
    assert.equal(semanticArchDesignFingerprint(moved), fingerprint);
});

test('fingerprints every RTL-relevant semantic section and export language', () => {
    const original = editable(sourceDesign());
    const originalFingerprint = semanticArchDesignFingerprint(original);
    const variants = [
        sourceDesign({ module: 'changed_top' }),
        sourceDesign({ ports: [{ name: 'rst_n', direction: 'input' }] }),
        sourceDesign({
            instances: [{ name: 'u_core', module: 'other', parameters: { WIDTH: 16 } }],
        }),
        sourceDesign({
            connections: [{
                name: 'reset',
                endpoints: [{ kind: 'port', port: 'clk' }],
            }],
        }),
        sourceDesign({
            interfaceConnections: [{
                name: 'control',
                master: { instance: 'u_core', interface: 'm_axi_01' },
                slave: { instance: 'u_regs', interface: 's_axi' },
            }],
        }),
        sourceDesign({ defaults: { 'u_core.enable': "1'b0" } }),
        sourceDesign({ export: { language: 'systemverilog', output: 'generated/soc_top.sv' } }),
    ];

    for (const variant of variants) {
        assert.notEqual(
            semanticArchDesignFingerprint(editable(variant)),
            originalFingerprint
        );
    }
});

test('keeps fingerprints stable across deterministic serialization', () => {
    const design = editable(sourceDesign());
    const reparsed = parseArchDesignText(serializeArchDesign(design));
    assert.equal(reparsed.status, 'editable');
    if (reparsed.status !== 'editable') return;
    assert.equal(
        semanticArchDesignFingerprint(reparsed.design),
        semanticArchDesignFingerprint(design)
    );
});
