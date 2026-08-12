import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createEmptyArchDesign,
    parseArchDesignValue,
    resolveArchDesign,
    validateArchDesign,
    type ArchDesign,
    type ArchDesignModuleDefinition,
} from '../src/archDesign';
import { createInterfaceProtocolCatalog } from '../src/interfaces';

function protocol(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
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
        ...overrides,
    };
}

const catalog = createInterfaceProtocolCatalog([{
    source: '/workspace/link.json',
    value: protocol(),
}]);

function moduleDefinition(
    name: string,
    ports: ArchDesignModuleDefinition['ports']
): ArchDesignModuleDefinition {
    return { key: `rtl/${name}.sv#${name}`, name, parameters: [], ports };
}

const master = moduleDefinition('master', [
    { name: 'BUS_REQUEST', direction: 'output', width: { kind: 'known', bits: 32 } },
    { name: 'BUS_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
    { name: 'BUS_TAG', direction: 'output', width: { kind: 'known', bits: 4 } },
]);

const slave = moduleDefinition('slave', [
    { name: 'LINK_REQUEST', direction: 'input', width: { kind: 'known', bits: 16 } },
    { name: 'LINK_ACCEPT', direction: 'output', width: { kind: 'known', bits: 1 } },
]);

function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const result = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (result.status !== 'editable') throw new Error('expected editable design');
    return result.design;
}

test('resolves inferred interfaces once and expands paired and open members', () => {
    const design = designOf({
        instances: [
            { name: 'u_master', module: 'master' },
            { name: 'u_slave', module: 'slave' },
        ],
        interfaceConnections: [{
            name: 'link',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'LINK' },
        }],
    });

    const resolution = resolveArchDesign(design, [master, slave], catalog);

    assert.deepEqual(resolution.interfaces.endpoints.map(item => [
        item.identity, item.protocol, item.role, item.roleSource, item.effectiveRole,
    ]), [
        ['interface:instance:u_master:BUS', 'project.link', 'master', 'inferred', 'master'],
        ['interface:instance:u_slave:LINK', 'project.link', 'slave', 'inferred', 'slave'],
    ]);
    assert.deepEqual(resolution.interfaces.connections[0].bindings.map(item => [
        item.member, item.sender.port, item.receiver.port,
    ]), [
        ['request', 'BUS_REQUEST', 'LINK_REQUEST'],
        ['accept', 'LINK_ACCEPT', 'BUS_ACCEPT'],
    ]);
    assert.deepEqual(resolution.interfaces.connections[0].openMembers.map(item => [
        item.member, item.sender.port,
    ]), [['tag', 'BUS_TAG']]);
    assert.deepEqual(resolution.interfaces.connections[0].defaults, []);
    assert.deepEqual(resolution.interfaces.occupancy.map(item => item.port), [
        'BUS_REQUEST', 'LINK_REQUEST', 'BUS_ACCEPT', 'LINK_ACCEPT', 'BUS_TAG',
    ]);
    assert.ok(Object.isFrozen(resolution.interfaces.connections[0].bindings));
});

test('inverts top-level roles at the inner boundary and honors explicit role overrides', () => {
    const ambiguousMaster = moduleDefinition('ambiguous_master', [
        { name: 'BUS_REQUEST', direction: 'inout', width: { kind: 'known', bits: 32 } },
        { name: 'BUS_ACCEPT', direction: 'inout', width: { kind: 'known', bits: 1 } },
    ]);
    const design = designOf({
        instances: [{ name: 'u_master', module: 'ambiguous_master' }],
        interfacePorts: [{
            name: 'm_link',
            protocol: 'project.link',
            role: 'master',
            memberPrefix: 'M_LINK',
            members: [
                { member: 'request', width: 32 },
                { member: 'accept', width: 1 },
            ],
        }],
        interfaceOverrides: { 'u_master.BUS': { role: 'master' } },
        interfaceConnections: [{
            name: 'boundary',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'port', port: 'm_link' },
        }],
    });

    const resolution = resolveArchDesign(design, [ambiguousMaster], catalog);
    const instance = resolution.interfaces.endpoints.find(item => item.endpoint.kind === 'instance');
    const boundary = resolution.interfaces.endpoints.find(item => item.endpoint.kind === 'port');

    assert.equal(instance?.role, 'master');
    assert.equal(instance?.roleSource, 'override');
    assert.equal(instance?.effectiveRole, 'master');
    assert.equal(boundary?.role, 'master');
    assert.equal(boundary?.roleSource, 'declared');
    assert.equal(boundary?.effectiveRole, 'slave');
    assert.equal(resolution.diagnostics.some(item => item.code === 'AD_INTERFACE_ROLE'), false);
});

test('uses connection defaults before protocol defaults for receiver-only members', () => {
    const receiver = moduleDefinition('receiver', [
        { name: 'BUS_REQUEST', direction: 'input', width: { kind: 'known', bits: 8 } },
        { name: 'BUS_ACCEPT', direction: 'output', width: { kind: 'known', bits: 1 } },
        { name: 'BUS_TAG', direction: 'input', width: { kind: 'known', bits: 4 } },
    ]);
    const senderWithoutTag = moduleDefinition('sender_without_tag', [
        { name: 'BUS_REQUEST', direction: 'output', width: { kind: 'known', bits: 8 } },
        { name: 'BUS_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
    ]);
    const design = designOf({
        instances: [
            { name: 'u_master', module: 'sender_without_tag' },
            { name: 'u_slave', module: 'receiver' },
        ],
        interfaceConnections: [{
            name: 'link',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'BUS' },
            defaults: { tag: "4'ha" },
        }],
    });
    const override = resolveArchDesign(design, [senderWithoutTag, receiver], catalog);
    assert.deepEqual(override.interfaces.connections[0].defaults.map(item => ({
        member: item.member,
        expression: item.expression,
        origin: item.origin,
        protocolExpression: item.protocolExpression,
    })), [{
        member: 'tag',
        expression: "4'ha",
        origin: 'connection',
        protocolExpression: '0',
    }]);

    const inherited = resolveArchDesign(designOf({
        ...design,
        interfaceConnections: [{
            ...design.interfaceConnections[0],
            defaults: {},
        }],
    }), [senderWithoutTag, receiver], catalog);
    assert.equal(inherited.interfaces.connections[0].defaults[0].expression, '0');
    assert.equal(inherited.interfaces.connections[0].defaults[0].origin, 'protocol');
});

test('reports semantic interface errors without deleting invalid intermediate data', () => {
    const noDefaultCatalog = createInterfaceProtocolCatalog([{
        source: '/workspace/link.json',
        value: protocol({
            members: [
                { name: 'request', direction: 'master-to-slave' },
                { name: 'accept', direction: 'slave-to-master' },
                { name: 'tag', direction: 'master-to-slave' },
            ],
        }),
    }]);
    const receiver = moduleDefinition('receiver', [
        { name: 'LINK_REQUEST', direction: 'input', width: { kind: 'known', bits: 32 } },
        { name: 'LINK_ACCEPT', direction: 'output', width: { kind: 'known', bits: 1 } },
        { name: 'LINK_TAG', direction: 'input', width: { kind: 'known', bits: 4 } },
    ]);
    const senderWithoutTag = moduleDefinition('sender_without_tag', [
        { name: 'BUS_REQUEST', direction: 'output', width: { kind: 'known', bits: 32 } },
        { name: 'BUS_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
    ]);
    const design = designOf({
        instances: [
            { name: 'u_master', module: 'sender_without_tag' },
            { name: 'u_slave', module: 'receiver' },
        ],
        connections: [{
            name: 'scalar_conflict',
            endpoints: [{ kind: 'instance', instance: 'u_slave', port: 'LINK_REQUEST' }],
            defaults: { 'u_slave.LINK_REQUEST': '0' },
        }],
        interfaceConnections: [{
            name: 'first',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'LINK' },
        }, {
            name: 'duplicate',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'port', port: 'missing' },
        }],
    });

    const resolution = resolveArchDesign(
        design,
        [senderWithoutTag, receiver],
        noDefaultCatalog
    );
    const codes = resolution.diagnostics.map(item => item.code);

    assert.ok(codes.includes('AD_INTERFACE_MEMBER_OCCUPIED'));
    assert.ok(codes.includes('AD_INTERFACE_DEFAULT_MISSING'));
    assert.ok(codes.includes('AD_INTERFACE_ENDPOINT_DUPLICATE'));
    assert.ok(codes.includes('AD_INTERFACE_ENDPOINT_UNKNOWN'));
    assert.equal(resolution.interfaces.connections.length, 2);
});

test('keeps width mismatches as warnings and detects stale promoted members', () => {
    const design = designOf({
        instances: [
            { name: 'u_master', module: 'master' },
            { name: 'u_slave', module: 'slave' },
        ],
        interfacePorts: [{
            name: 'stale',
            protocol: 'project.link',
            role: 'slave',
            memberPrefix: 'STALE',
            members: [{ member: 'removed_member', width: 1 }],
        }],
        interfaceConnections: [{
            name: 'link',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'LINK' },
        }],
    });

    const validation = validateArchDesign(design, [master, slave], catalog);

    assert.equal(validation.valid, false);
    assert.ok(validation.diagnostics.some(item => item.code === 'AD_INTERFACE_MEMBER_UNKNOWN'));
    assert.deepEqual(validation.warnings.map(item => item.code), ['AD_INTERFACE_WIDTH']);
    assert.match(validation.warnings[0].message, /32.*16/);

    const withoutStale = validateArchDesign(designOf({
        ...design,
        interfacePorts: [],
    }), [master, slave], catalog);
    assert.equal(withoutStale.valid, true);
    assert.deepEqual(withoutStale.diagnostics, []);
    assert.equal(withoutStale.warnings.length, 1);
});

test('surfaces exact protocol recognition ambiguity without silently choosing', () => {
    const ambiguousCatalog = createInterfaceProtocolCatalog([{
        source: '/workspace/first.json',
        value: protocol({ id: 'project.first', name: 'First' }),
    }, {
        source: '/workspace/second.json',
        value: protocol({ id: 'project.second', name: 'Second' }),
    }]);
    const ambiguous = moduleDefinition('ambiguous', [
        { name: 'BUS_REQUEST', direction: 'output', width: { kind: 'known', bits: 1 } },
        { name: 'BUS_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
    ]);
    const design = designOf({
        instances: [{ name: 'u_bus', module: 'ambiguous' }],
        defaults: { 'u_bus.BUS_ACCEPT': "1'b0" },
    });

    const resolution = resolveArchDesign(design, [ambiguous], ambiguousCatalog);

    assert.deepEqual(resolution.diagnostics.map(item => [item.path, item.code]), [[
        '$.instances[0]',
        'AD_INTERFACE_RECOGNITION_AMBIGUOUS',
    ]]);
    assert.match(resolution.diagnostics[0].message, /project\.first.*project\.second/);
    assert.deepEqual(resolution.interfaces.endpoints, []);
});
