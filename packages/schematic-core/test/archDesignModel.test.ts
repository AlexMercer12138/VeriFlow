import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ARCH_DESIGN_FORMAT,
    ARCH_DESIGN_SCHEMA_VERSION,
    createEmptyArchDesign,
    type ArchDesign,
} from '../src';

function typedDesign(design: ArchDesign): ArchDesign {
    return design;
}

test('creates a deeply frozen minimal schema-v1 Arch Design', () => {
    const design = createEmptyArchDesign('soc_top');

    assert.deepEqual(design, {
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
    });
    assert.equal(ARCH_DESIGN_FORMAT, design.format);
    assert.equal(ARCH_DESIGN_SCHEMA_VERSION, design.schemaVersion);
    assert.ok(Object.isFrozen(design));
    assert.ok(Object.isFrozen(design.ports));
    assert.ok(Object.isFrozen(design.defaults));
    assert.ok(Object.isFrozen(design.export));
    assert.ok(Object.isFrozen(design.presentation));
});

test('models the complete schema-v1 document surface', () => {
    const design = typedDesign({
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'soc_top',
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'result', direction: 'output', width: 16 },
            { name: 'gpio', direction: 'inout', width: { expression: 'GPIO_WIDTH' } },
        ],
        instances: [{
            name: 'u_core',
            module: 'core',
            parameters: {
                ENABLED: true,
                WIDTH: 16,
                MODE: '"FAST"',
            },
        }],
        connections: [{
            name: 'clock',
            endpoints: [
                { kind: 'port', port: 'clk' },
                { kind: 'instance', instance: 'u_core', port: 'clk' },
            ],
            defaults: {
                'u_core.enable': "1'b1",
            },
        }, {
            name: 'gpio_readback',
            endpoints: [
                { kind: 'port', port: 'gpio', signal: 'i' },
                { kind: 'instance', instance: 'u_core', port: 'gpio_i' },
            ],
        }],
        interfaceConnections: [{
            name: 'control',
            protocol: 'axi4-lite',
            master: { instance: 'u_core', interface: 'm_axi_00' },
            slave: { instance: 'u_regs', interface: 's_axi' },
            defaults: {
                wlast: "1'b1",
            },
        }],
        defaults: {
            'u_core.enable': "1'b1",
        },
        export: {
            language: 'verilog',
            output: 'generated/soc_top.v',
        },
        presentation: {
            nodes: {
                'instance:u_core': {
                    column: 1,
                    order: 0,
                    offset: 8,
                    userPositioned: true,
                },
            },
            collapsedInterfaces: {
                'u_core.m_axi_00': true,
            },
            viewport: {
                x: 4,
                y: 8,
                zoom: 1.25,
            },
        },
    });

    assert.equal(design.ports[2].direction, 'inout');
    assert.deepEqual(design.connections[1].endpoints[0], {
        kind: 'port',
        port: 'gpio',
        signal: 'i',
    });
    assert.equal(design.interfaceConnections[0].master.interface, 'm_axi_00');
});

test('rejects an empty or non-plain module identifier', () => {
    for (const invalid of ['', '1soc', 'soc-top', 'soc top', '\\escaped ']) {
        assert.throws(
            () => createEmptyArchDesign(invalid),
            /valid Verilog identifier/
        );
    }
});
