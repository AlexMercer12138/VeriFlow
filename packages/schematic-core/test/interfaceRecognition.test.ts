import assert from 'node:assert/strict';
import test from 'node:test';

import type { WidthValue } from '@veriflow/hdl-core/model';

import {
    createInterfaceProtocolCatalog,
    recognizeModuleInterfaces,
    type InterfaceRecognitionPort,
} from '../src/interfaces';

const bit: WidthValue = { kind: 'known', bits: 1 };

function port(
    name: string,
    direction: InterfaceRecognitionPort['direction'],
    width: WidthValue = bit
): InterfaceRecognitionPort {
    return { name, direction, width };
}

function customProtocol(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        format: 'veriflow-interface-protocol',
        schemaVersion: 1,
        id: 'project.custom',
        name: 'Custom',
        separator: '_',
        priority: 10,
        members: [
            { name: 'request', direction: 'master-to-slave' },
            { name: 'accept', direction: 'slave-to-master' },
        ],
        recognitionGroups: [['request', 'accept']],
        ...overrides,
    };
}

test('recognizes multiple incomplete AXI4 interfaces and preserves declaration order', () => {
    const catalog = createInterfaceProtocolCatalog();
    const result = recognizeModuleInterfaces([
        port('M_AXI_00_AWVALID', 'output'),
        port('M_AXI_00_AWADDR', 'output', { kind: 'known', bits: 32 }),
        port('M_AXI_00_AWREADY', 'input'),
        port('m_axi_01_araddr', 'output', { kind: 'known', bits: 40 }),
        port('m_axi_01_arvalid', 'output'),
        port('m_axi_01_arready', 'input'),
    ], catalog);

    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.interfaces.map(item => [
        item.key,
        item.protocol,
        item.role,
        item.roleSource,
        item.members.map(member => member.port),
    ]), [
        [
            'M_AXI_00',
            'amba.axi4',
            'master',
            'inferred',
            ['M_AXI_00_AWVALID', 'M_AXI_00_AWADDR', 'M_AXI_00_AWREADY'],
        ],
        [
            'm_axi_01',
            'amba.axi4',
            'master',
            'inferred',
            ['m_axi_01_araddr', 'm_axi_01_arvalid', 'm_axi_01_arready'],
        ],
    ]);
    assert.deepEqual(result.interfaces[0].members[1].width, { kind: 'known', bits: 32 });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.interfaces[0].members));
});

test('groups interface prefixes case-insensitively while keeping the first spelling', () => {
    const result = recognizeModuleInterfaces([
        port('Control_AWADDR', 'input', { kind: 'known', bits: 32 }),
        port('control_awvalid', 'input'),
        port('CONTROL_AWREADY', 'output'),
    ], createInterfaceProtocolCatalog());

    assert.equal(result.interfaces.length, 1);
    assert.equal(result.interfaces[0].key, 'Control');
    assert.equal(result.interfaces[0].role, 'slave');
});

test('uses the longest complete member suffix and protocol separator', () => {
    const catalog = createInterfaceProtocolCatalog([{
        source: '/workspace/long.json',
        value: customProtocol({
            separator: '',
            members: [
                { name: 'addr', direction: 'master-to-slave' },
                { name: 'longaddr', direction: 'master-to-slave' },
            ],
            recognitionGroups: [['longaddr']],
        }),
    }]);
    const result = recognizeModuleInterfaces([
        port('buslongaddr', 'output', { kind: 'known', bits: 16 }),
    ], catalog);

    const custom = result.interfaces.find(item => item.protocol === 'project.custom');
    assert.ok(custom);
    assert.equal(custom.key, 'bus');
    assert.equal(custom.members[0].member, 'longaddr');
});

test('does not recognize ordinary ports below a protocol signature threshold', () => {
    const result = recognizeModuleInterfaces([
        port('data', 'output', { kind: 'known', bits: 32 }),
        port('ready', 'input'),
        port('valid', 'output'),
        port('m_axi_awaddr', 'output', { kind: 'known', bits: 32 }),
    ], createInterfaceProtocolCatalog());

    assert.deepEqual(result.interfaces, []);
    assert.deepEqual(result.diagnostics, []);
});

test('normalizes a member alias without protocol-specific recognition code', () => {
    const result = recognizeModuleInterfaces([
        port('s_ahb_haddr', 'input', { kind: 'known', bits: 32 }),
        port('s_ahb_htrans', 'input', { kind: 'known', bits: 2 }),
        port('s_ahb_hreadyout', 'output'),
    ], createInterfaceProtocolCatalog());

    const ahb = result.interfaces.find(item => item.protocol === 'amba.ahb-lite');
    assert.ok(ahb);
    const ready = ahb.members.find(member => member.member === 'hready');
    assert.equal(ready?.port, 's_ahb_hreadyout');
});

test('infers roles only from directions and ignores misleading interface names', () => {
    const result = recognizeModuleInterfaces([
        port('s_axi_awaddr', 'output', { kind: 'known', bits: 32 }),
        port('s_axi_awvalid', 'output'),
        port('s_axi_awready', 'input'),
        port('m_axi_araddr', 'input', { kind: 'known', bits: 32 }),
        port('m_axi_arvalid', 'input'),
        port('m_axi_arready', 'output'),
    ], createInterfaceProtocolCatalog());

    assert.deepEqual(result.interfaces.map(item => [item.key, item.role]), [
        ['s_axi', 'master'],
        ['m_axi', 'slave'],
    ]);
});

test('keeps an interface role unknown when direction evidence is tied or absent', () => {
    const catalog = createInterfaceProtocolCatalog([{
        source: '/workspace/custom.json',
        value: customProtocol(),
    }]);
    const result = recognizeModuleInterfaces([
        port('bus_request', 'output'),
        port('bus_accept', 'output'),
        port('io_request', 'inout'),
        port('io_accept', 'inout'),
    ], catalog);

    assert.deepEqual(result.interfaces.filter(item =>
        item.protocol === 'project.custom'
    ).map(item => [item.key, item.role, item.roleSource]), [
        ['bus', 'unknown', 'unknown'],
        ['io', 'unknown', 'unknown'],
    ]);
});

test('diagnoses an exact protocol tie instead of choosing by catalog order', () => {
    const second = customProtocol({ id: 'project.second', name: 'Second' });
    const catalog = createInterfaceProtocolCatalog([
        { source: '/workspace/first.json', value: customProtocol() },
        { source: '/workspace/second.json', value: second },
    ]);
    const result = recognizeModuleInterfaces([
        port('bus_request', 'output'),
        port('bus_accept', 'input'),
    ], catalog);

    assert.equal(result.interfaces.some(item => item.key === 'bus'), false);
    assert.deepEqual(result.diagnostics.map(item => [item.code, item.interfaceKey]), [[
        'IF_RECOGNITION_AMBIGUOUS',
        'bus',
    ]]);
    assert.deepEqual(result.diagnostics[0].protocols, [
        'project.custom',
        'project.second',
    ]);
});

test('uses signature specificity, member count, then priority to resolve candidates', () => {
    const weak = customProtocol({
        id: 'project.weak',
        name: 'Weak',
        priority: 999,
        recognitionGroups: [['request']],
    });
    const strong = customProtocol({
        id: 'project.strong',
        name: 'Strong',
        priority: 1,
    });
    const result = recognizeModuleInterfaces([
        port('bus_request', 'output'),
        port('bus_accept', 'input'),
    ], createInterfaceProtocolCatalog([
        { source: '/workspace/weak.json', value: weak },
        { source: '/workspace/strong.json', value: strong },
    ]));

    const bus = result.interfaces.find(item => item.key === 'bus');
    assert.equal(bus?.protocol, 'project.strong');
});

test('owns its port snapshot without invoking caller-controlled array methods', () => {
    const awaddr = port('m_axi_awaddr', 'output', { kind: 'known', bits: 32 });
    const ports = [awaddr, port('m_axi_awvalid', 'output')];
    let methodCalls = 0;
    Object.defineProperty(ports, 'map', {
        value: () => {
            methodCalls += 1;
            return [];
        },
    });

    const result = recognizeModuleInterfaces(ports, createInterfaceProtocolCatalog());
    (awaddr as { name: string }).name = 'changed';
    (awaddr.width as { bits: number }).bits = 1;

    assert.equal(methodCalls, 0);
    assert.equal(result.interfaces[0].members[0].port, 'm_axi_awaddr');
    assert.deepEqual(result.interfaces[0].members[0].width, { kind: 'known', bits: 32 });
});
