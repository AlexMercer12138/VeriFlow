import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyArchDesignEdit,
    ArchDesignEditError,
    createEmptyArchDesign,
    parseArchDesignValue,
    type ArchDesign,
} from '../src/archDesign';

function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const parsed = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (parsed.status !== 'editable') throw new Error('expected editable design');
    return parsed.design;
}

function plainRecord<T>(value: Readonly<Record<string, T>> | undefined): Record<string, T> {
    return Object.fromEntries(Object.entries(value ?? {}));
}

test('adds an instance without mutating the source design', () => {
    const source = createEmptyArchDesign('soc_top');

    const next = applyArchDesignEdit(source, {
        type: 'addInstance',
        instance: { name: 'u_core', module: 'core' },
    });

    assert.deepEqual(source.instances, []);
    assert.deepEqual(next.instances, [{ name: 'u_core', module: 'core' }]);
    assert.ok(Object.isFrozen(next));
    assert.ok(Object.isFrozen(next.instances));
    assert.ok(Object.isFrozen(next.instances[0]));
});

test('renames an instance and every stable reference to it', () => {
    const source = designOf({
        instances: [{ name: 'u_old', module: 'consumer' }],
        connections: [{
            name: 'data',
            endpoints: [{ kind: 'instance', instance: 'u_old', port: 'data_i' }],
            defaults: { 'u_old.data_i': "8'h11" },
        }],
        defaults: { 'u_old.enable': "1'b1" },
        presentation: {
            nodes: {
                'instance:u_old': {
                    column: 2,
                    order: 1,
                    offset: 16,
                    userPositioned: true,
                },
            },
        },
    });

    const next = applyArchDesignEdit(source, {
        type: 'renameInstance',
        name: 'u_old',
        nextName: 'u_new',
    });

    assert.equal(next.instances[0].name, 'u_new');
    assert.deepEqual(next.connections[0].endpoints, [{
        kind: 'instance', instance: 'u_new', port: 'data_i',
    }]);
    assert.deepEqual(plainRecord(next.connections[0].defaults), {
        'u_new.data_i': "8'h11",
    });
    assert.deepEqual(plainRecord(next.defaults), { 'u_new.enable': "1'b1" });
    assert.deepEqual(plainRecord(next.presentation.nodes), {
        'instance:u_new': {
            column: 2,
            order: 1,
            offset: 16,
            userPositioned: true,
        },
    });
    assert.equal(source.instances[0].name, 'u_old');
});

test('removes an instance and drops only references that become empty', () => {
    const source = designOf({
        ports: [{ name: 'clk', direction: 'input' }],
        instances: [
            { name: 'u_remove', module: 'consumer' },
            { name: 'u_keep', module: 'consumer' },
        ],
        connections: [{
            name: 'shared',
            endpoints: [
                { kind: 'port', port: 'clk' },
                { kind: 'instance', instance: 'u_remove', port: 'clk' },
                { kind: 'instance', instance: 'u_keep', port: 'clk' },
            ],
            defaults: { 'u_remove.clk': "1'b0", 'u_keep.clk': "1'b1" },
        }, {
            name: 'removed_only',
            endpoints: [{ kind: 'instance', instance: 'u_remove', port: 'enable' }],
        }],
        defaults: { 'u_remove.enable': "1'b1", 'u_keep.enable': "1'b0" },
        presentation: {
            nodes: {
                'instance:u_remove': { column: 1, order: 0 },
                'instance:u_keep': { column: 2, order: 0 },
            },
        },
    });

    const next = applyArchDesignEdit(source, {
        type: 'removeInstance', name: 'u_remove',
    });

    assert.deepEqual(next.instances.map(instance => instance.name), ['u_keep']);
    assert.deepEqual(next.connections.map(connection => connection.name), ['shared']);
    assert.deepEqual(next.connections[0].endpoints, [
        { kind: 'port', port: 'clk' },
        { kind: 'instance', instance: 'u_keep', port: 'clk' },
    ]);
    assert.deepEqual(plainRecord(next.connections[0].defaults), {
        'u_keep.clk': "1'b1",
    });
    assert.deepEqual(plainRecord(next.defaults), { 'u_keep.enable': "1'b0" });
    assert.deepEqual(plainRecord(next.presentation.nodes), {
        'instance:u_keep': { column: 2, order: 0 },
    });
});

test('sets and clears one instance parameter override', () => {
    const source = designOf({
        instances: [{ name: 'u_core', module: 'core', parameters: { WIDTH: 8 } }],
    });
    const set = applyArchDesignEdit(source, {
        type: 'setInstanceParameter',
        instance: 'u_core',
        parameter: 'ENABLED',
        value: true,
    });
    const cleared = applyArchDesignEdit(set, {
        type: 'setInstanceParameter',
        instance: 'u_core',
        parameter: 'WIDTH',
    });

    assert.deepEqual(plainRecord(set.instances[0].parameters), {
        ENABLED: true, WIDTH: 8,
    });
    assert.deepEqual(plainRecord(cleared.instances[0].parameters), { ENABLED: true });
});

test('adds and updates a top-level port with cascading rename references', () => {
    const source = designOf({
        ports: [{ name: 'sink', direction: 'output' }],
        connections: [{
            name: 'data',
            endpoints: [{ kind: 'port', port: 'sink' }],
            defaults: { 'sink.value': "1'b1" },
        }],
        defaults: { 'sink.value': "1'b0" },
        presentation: { nodes: { 'port:sink': { column: 3, order: 0 } } },
    });
    const added = applyArchDesignEdit(source, {
        type: 'addPort',
        port: { name: 'source', direction: 'input', width: 8 },
    });
    const updated = applyArchDesignEdit(added, {
        type: 'updatePort',
        name: 'sink',
        port: { name: 'result', direction: 'output', width: { expression: 'WIDTH' } },
    });

    assert.deepEqual(updated.ports, [
        { name: 'result', direction: 'output', width: { expression: 'WIDTH' } },
        { name: 'source', direction: 'input', width: 8 },
    ]);
    assert.deepEqual(updated.connections[0].endpoints, [{ kind: 'port', port: 'result' }]);
    assert.deepEqual(plainRecord(updated.connections[0].defaults), {
        'result.value': "1'b1",
    });
    assert.deepEqual(plainRecord(updated.defaults), { 'result.value': "1'b0" });
    assert.deepEqual(plainRecord(updated.presentation.nodes), {
        'port:result': { column: 3, order: 0 },
    });
});

test('removes a top-level port and its scalar references', () => {
    const source = designOf({
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'sink', direction: 'output' },
        ],
        connections: [{
            name: 'data',
            endpoints: [
                { kind: 'port', port: 'source' },
                { kind: 'port', port: 'sink' },
            ],
            defaults: { 'sink.value': "1'b0" },
        }],
        defaults: { 'sink.value': "1'b1" },
    });

    const next = applyArchDesignEdit(source, { type: 'removePort', name: 'sink' });

    assert.deepEqual(next.ports.map(port => port.name), ['source']);
    assert.deepEqual(next.connections[0].endpoints, [{ kind: 'port', port: 'source' }]);
    assert.equal(next.connections[0].defaults, undefined);
    assert.deepEqual(plainRecord(next.defaults), {});
});

test('connects endpoints by creating extending and merging networks', () => {
    const source = designOf({
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'first', direction: 'output' },
            { name: 'second', direction: 'output' },
        ],
    });
    const created = applyArchDesignEdit(source, {
        type: 'connect',
        source: { kind: 'port', port: 'source' },
        target: { kind: 'port', port: 'first' },
    });
    const separate = applyArchDesignEdit(created, {
        type: 'connect',
        source: { kind: 'port', port: 'second' },
        target: { kind: 'instance', instance: 'missing', port: 'data' },
    });
    const merged = applyArchDesignEdit(separate, {
        type: 'connect',
        source: { kind: 'port', port: 'first' },
        target: { kind: 'port', port: 'second' },
    });

    assert.equal(created.connections[0].name, 'net_1');
    assert.deepEqual(separate.connections.map(connection => connection.name), [
        'net_1', 'net_2',
    ]);
    assert.deepEqual(merged.connections.map(connection => connection.name), ['net_1']);
    assert.deepEqual(merged.connections[0].endpoints, [
        { kind: 'port', port: 'source' },
        { kind: 'port', port: 'first' },
        { kind: 'port', port: 'second' },
        { kind: 'instance', instance: 'missing', port: 'data' },
    ]);
});

test('disconnects endpoints and removes only empty networks', () => {
    const source = designOf({
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'sink', direction: 'output' },
        ],
        connections: [{
            name: 'data',
            endpoints: [
                { kind: 'port', port: 'source' },
                { kind: 'port', port: 'sink' },
            ],
            defaults: { 'sink.value': "1'b0" },
        }],
    });
    const one = applyArchDesignEdit(source, {
        type: 'disconnect', connection: 'data', endpoint: { kind: 'port', port: 'sink' },
    });
    const empty = applyArchDesignEdit(one, {
        type: 'disconnect', connection: 'data', endpoint: { kind: 'port', port: 'source' },
    });

    assert.deepEqual(one.connections[0].endpoints, [{ kind: 'port', port: 'source' }]);
    assert.equal(one.connections[0].defaults, undefined);
    assert.deepEqual(empty.connections, []);
});

test('renames and removes scalar connections', () => {
    const source = designOf({
        connections: [{ name: 'old_net', endpoints: [] }],
    });
    const renamed = applyArchDesignEdit(source, {
        type: 'renameConnection', name: 'old_net', nextName: 'new_net',
    });
    const removed = applyArchDesignEdit(renamed, {
        type: 'removeConnection', name: 'new_net',
    });

    assert.equal(renamed.connections[0].name, 'new_net');
    assert.deepEqual(removed.connections, []);
});

test('sets and clears design and connection defaults', () => {
    const source = designOf({
        connections: [{
            name: 'data',
            endpoints: [{ kind: 'port', port: 'sink' }],
        }],
    });
    const designDefault = applyArchDesignEdit(source, {
        type: 'setDefault', endpoint: 'sink.value', expression: "1'b0",
    });
    const connectionDefault = applyArchDesignEdit(designDefault, {
        type: 'setDefault',
        connection: 'data',
        endpoint: 'sink.value',
        expression: "1'b1",
    });
    const cleared = applyArchDesignEdit(connectionDefault, {
        type: 'setDefault', connection: 'data', endpoint: 'sink.value',
    });

    assert.deepEqual(plainRecord(designDefault.defaults), { 'sink.value': "1'b0" });
    assert.deepEqual(plainRecord(connectionDefault.connections[0].defaults), {
        'sink.value': "1'b1",
    });
    assert.equal(cleared.connections[0].defaults, undefined);
});

test('replaces export settings and presentation with detached snapshots', () => {
    const source = createEmptyArchDesign('soc_top');
    const exported = applyArchDesignEdit(source, {
        type: 'setExport', language: 'systemverilog', output: 'generated/soc.sv',
    });
    const presentation = {
        nodes: { 'instance:u_core': { column: 1, order: 0 } },
        viewport: { x: 10, y: 20, zoom: 1.25 },
    };
    const presented = applyArchDesignEdit(exported, {
        type: 'setPresentation', presentation,
    });
    presentation.nodes['instance:u_core'].column = 99;

    assert.deepEqual(exported.export, {
        language: 'systemverilog', output: 'generated/soc.sv',
    });
    assert.deepEqual(plainRecord(presented.presentation.nodes), {
        'instance:u_core': { column: 1, order: 0 },
    });
    assert.deepEqual(presented.presentation.viewport, { x: 10, y: 20, zoom: 1.25 });
});

test('rejects duplicate and unknown edit targets without mutating the source', () => {
    const source = designOf({
        ports: [{ name: 'clk', direction: 'input' }],
        instances: [{ name: 'u_core', module: 'core' }],
        connections: [{ name: 'data', endpoints: [] }],
    });
    const before = JSON.stringify(source);

    for (const edit of [
        { type: 'addPort', port: { name: 'clk', direction: 'input' } },
        { type: 'addInstance', instance: { name: 'u_core', module: 'other' } },
        { type: 'renameConnection', name: 'missing', nextName: 'next' },
        { type: 'removeInstance', name: 'missing' },
    ] as const) {
        assert.throws(
            () => applyArchDesignEdit(source, edit),
            ArchDesignEditError
        );
    }
    assert.equal(JSON.stringify(source), before);
});

test('retains own prototype-like dictionary keys without prototype mutation', () => {
    const source = designOf({ instances: [{ name: 'u_core', module: 'core' }] });
    const next = applyArchDesignEdit(source, {
        type: 'setInstanceParameter',
        instance: 'u_core',
        parameter: '__proto__',
        value: 'VALUE',
    });

    assert.equal(Object.prototype.hasOwnProperty.call(
        next.instances[0].parameters,
        '__proto__'
    ), true);
    assert.equal(next.instances[0].parameters?.['__proto__'], 'VALUE');
    assert.equal(({} as { VALUE?: unknown }).VALUE, undefined);
});

test('sets and clears an explicit interface protocol or role override', () => {
    const source = designOf({ instances: [{ name: 'u_dma', module: 'dma' }] });
    const set = applyArchDesignEdit(source, {
        type: 'setInterfaceOverride',
        instance: 'u_dma',
        interface: 'M_AXI',
        protocol: 'amba.axi4',
        role: 'master',
    });
    const cleared = applyArchDesignEdit(set, {
        type: 'clearInterfaceOverride',
        instance: 'u_dma',
        interface: 'M_AXI',
    });

    assert.deepEqual(plainRecord(set.interfaceOverrides), {
        'u_dma.M_AXI': { protocol: 'amba.axi4', role: 'master' },
    });
    assert.deepEqual(plainRecord(cleared.interfaceOverrides), {});
    assert.deepEqual(plainRecord(source.interfaceOverrides), {});
});

test('connects one-to-one interfaces and sets and clears connection defaults', () => {
    const source = designOf({
        instances: [
            { name: 'u_dma', module: 'dma' },
            { name: 'u_regs', module: 'regs' },
        ],
    });
    const connected = applyArchDesignEdit(source, {
        type: 'connectInterface',
        connection: {
            name: 'control_axi',
            master: { kind: 'instance', instance: 'u_dma', interface: 'M_AXI' },
            slave: { kind: 'instance', instance: 'u_regs', interface: 'S_AXI' },
        },
    });
    const defaulted = applyArchDesignEdit(connected, {
        type: 'setInterfaceDefault',
        connection: 'control_axi',
        member: 'wlast',
        expression: "1'b1",
    });
    const cleared = applyArchDesignEdit(defaulted, {
        type: 'setInterfaceDefault',
        connection: 'control_axi',
        member: 'wlast',
    });
    const removed = applyArchDesignEdit(cleared, {
        type: 'removeInterfaceConnection',
        name: 'control_axi',
    });

    assert.deepEqual(connected.interfaceConnections[0], {
        name: 'control_axi',
        master: { kind: 'instance', instance: 'u_dma', interface: 'M_AXI' },
        slave: { kind: 'instance', instance: 'u_regs', interface: 'S_AXI' },
    });
    assert.deepEqual(plainRecord(defaulted.interfaceConnections[0].defaults), {
        wlast: "1'b1",
    });
    assert.equal(cleared.interfaceConnections[0].defaults, undefined);
    assert.deepEqual(removed.interfaceConnections, []);
});

test('promotes one module pin as a declaration and connection in one edit', () => {
    const source = designOf({ instances: [{ name: 'u_core', module: 'core' }] });
    const promoted = applyArchDesignEdit(source, {
        type: 'promotePort',
        source: { kind: 'instance', instance: 'u_core', port: 'result' },
        port: { name: 'result', direction: 'output', width: 16 },
        connection: 'result_net',
    });

    assert.deepEqual(promoted.ports, [{ name: 'result', direction: 'output', width: 16 }]);
    assert.deepEqual(promoted.connections, [{
        name: 'result_net',
        endpoints: [
            { kind: 'instance', instance: 'u_core', port: 'result' },
            { kind: 'port', port: 'result' },
        ],
    }]);
    assert.deepEqual(source.ports, []);
    assert.deepEqual(source.connections, []);
});

test('promotes Master and Slave interfaces with inverted inner boundary endpoints', () => {
    const source = designOf({
        instances: [
            { name: 'u_dma', module: 'dma' },
            { name: 'u_regs', module: 'regs' },
        ],
    });
    const master = applyArchDesignEdit(source, {
        type: 'promoteInterface',
        source: {
            endpoint: { kind: 'instance', instance: 'u_dma', interface: 'M_AXI' },
            protocol: 'amba.axi4',
            role: 'master',
            members: [
                { member: 'awaddr', port: 'M_AXI_AWADDR', width: 32 },
                { member: 'awvalid', port: 'M_AXI_AWVALID', width: 1 },
            ],
        },
        port: 'm_axi',
        memberPrefix: 'M_AXI',
        connection: 'm_axi_boundary',
    });
    const both = applyArchDesignEdit(master, {
        type: 'promoteInterface',
        source: {
            endpoint: { kind: 'instance', instance: 'u_regs', interface: 'S_AXI' },
            protocol: 'amba.axi4',
            role: 'slave',
            members: [{ member: 'awaddr', port: 'S_AXI_AWADDR', width: 32 }],
        },
        port: 's_axi',
        memberPrefix: 'S_AXI',
        connection: 's_axi_boundary',
    });

    assert.deepEqual(both.interfacePorts, [{
        name: 'm_axi',
        protocol: 'amba.axi4',
        role: 'master',
        memberPrefix: 'M_AXI',
        members: [
            { member: 'awaddr', width: 32 },
            { member: 'awvalid', width: 1 },
        ],
    }, {
        name: 's_axi',
        protocol: 'amba.axi4',
        role: 'slave',
        memberPrefix: 'S_AXI',
        members: [{ member: 'awaddr', width: 32 }],
    }]);
    assert.deepEqual(both.interfaceConnections, [{
        name: 'm_axi_boundary',
        master: { kind: 'instance', instance: 'u_dma', interface: 'M_AXI' },
        slave: { kind: 'port', port: 'm_axi' },
    }, {
        name: 's_axi_boundary',
        master: { kind: 'port', port: 's_axi' },
        slave: { kind: 'instance', instance: 'u_regs', interface: 'S_AXI' },
    }]);
});

test('resynchronizes a promoted interface from its current peer explicitly', () => {
    const source = designOf({
        instances: [{ name: 'u_dma', module: 'dma' }],
        interfacePorts: [{
            name: 'm_axi',
            protocol: 'amba.axi4',
            role: 'master',
            memberPrefix: 'M_AXI',
            members: [{ member: 'awaddr', width: 32 }],
        }],
        interfaceConnections: [{
            name: 'boundary',
            master: { kind: 'instance', instance: 'u_dma', interface: 'M_AXI' },
            slave: { kind: 'port', port: 'm_axi' },
        }],
    });
    const next = applyArchDesignEdit(source, {
        type: 'resyncInterfacePort',
        port: 'm_axi',
        source: {
            endpoint: { kind: 'instance', instance: 'u_dma', interface: 'M_AXI' },
            protocol: 'amba.axi4',
            role: 'master',
            members: [
                { member: 'awaddr', port: 'M_AXI_AWADDR', width: 64 },
                { member: 'wdata', port: 'M_AXI_WDATA', width: 64 },
            ],
        },
    });

    assert.equal(next.interfacePorts[0].memberPrefix, 'M_AXI');
    assert.deepEqual(next.interfacePorts[0].members, [
        { member: 'awaddr', width: 64 },
        { member: 'wdata', width: 64 },
    ]);

    assert.throws(() => applyArchDesignEdit(source, {
        type: 'resyncInterfacePort',
        port: 'm_axi',
        source: {
            endpoint: { kind: 'instance', instance: 'u_other', interface: 'M_AXI' },
            protocol: 'amba.axi4',
            role: 'master',
            members: [{ member: 'awaddr', port: 'M_AXI_AWADDR', width: 64 }],
        },
    }), /current peer/);
});

test('rejects self-connected and already-connected interface endpoints', () => {
    const endpoint = { kind: 'instance', instance: 'u_dma', interface: 'M_AXI' } as const;
    const source = designOf({
        instances: [{ name: 'u_dma', module: 'dma' }, { name: 'u_regs', module: 'regs' }],
        interfaceConnections: [{
            name: 'existing',
            master: endpoint,
            slave: { kind: 'instance', instance: 'u_regs', interface: 'S_AXI' },
        }],
    });

    assert.throws(() => applyArchDesignEdit(createEmptyArchDesign('soc_top'), {
        type: 'connectInterface',
        connection: { name: 'self', master: endpoint, slave: endpoint },
    }), /itself/);
    assert.throws(() => applyArchDesignEdit(source, {
        type: 'connectInterface',
        connection: {
            name: 'duplicate',
            master: endpoint,
            slave: { kind: 'port', port: 'external' },
        },
    }), /already occupied/);
});

test('rejects duplicate promotion names and occupied source members atomically', () => {
    const source = designOf({
        ports: [{ name: 'result', direction: 'output' }],
        instances: [{ name: 'u_core', module: 'core' }],
        connections: [{
            name: 'occupied',
            endpoints: [{ kind: 'instance', instance: 'u_core', port: 'M_AXI_AWADDR' }],
        }],
    });
    const before = JSON.stringify(source);

    assert.throws(() => applyArchDesignEdit(source, {
        type: 'promotePort',
        source: { kind: 'instance', instance: 'u_core', port: 'result' },
        port: { name: 'result', direction: 'output' },
        connection: 'result_net',
    }), /already exists/);
    assert.throws(() => applyArchDesignEdit(source, {
        type: 'promoteInterface',
        source: {
            endpoint: { kind: 'instance', instance: 'u_core', interface: 'M_AXI' },
            protocol: 'amba.axi4',
            role: 'master',
            members: [{ member: 'awaddr', port: 'M_AXI_AWADDR', width: 32 }],
        },
        port: 'm_axi',
        memberPrefix: 'M_AXI',
        connection: 'boundary',
    }), /occupied/);
    assert.equal(JSON.stringify(source), before);
});

test('cascades instance and interface-port rename and removal references', () => {
    const source = designOf({
        instances: [{ name: 'u_old', module: 'dma' }],
        interfacePorts: [{
            name: 'm_axi',
            protocol: 'amba.axi4',
            role: 'master',
            memberPrefix: 'M_AXI',
            members: [{ member: 'awaddr', width: 32 }],
        }],
        interfaceOverrides: { 'u_old.M_AXI': { role: 'master' } },
        interfaceConnections: [{
            name: 'boundary',
            master: { kind: 'instance', instance: 'u_old', interface: 'M_AXI' },
            slave: { kind: 'port', port: 'm_axi' },
            defaults: { wlast: "1'b1" },
        }],
        presentation: {
            collapsedInterfaces: {
                'interface:instance:u_old:M_AXI': true,
                'interface:port:m_axi': false,
            },
        },
    });
    const renamedInstance = applyArchDesignEdit(source, {
        type: 'renameInstance', name: 'u_old', nextName: 'u_new',
    });
    const renamedPort = applyArchDesignEdit(renamedInstance, {
        type: 'renameInterfacePort',
        name: 'm_axi',
        nextName: 'memory_axi',
        nextMemberPrefix: 'MEM_AXI',
    });
    const removed = applyArchDesignEdit(renamedPort, {
        type: 'removeInterfacePort', name: 'memory_axi',
    });

    assert.deepEqual(plainRecord(renamedInstance.interfaceOverrides), {
        'u_new.M_AXI': { role: 'master' },
    });
    assert.equal(renamedInstance.interfaceConnections[0].master.kind, 'instance');
    assert.deepEqual(plainRecord(renamedInstance.presentation.collapsedInterfaces), {
        'interface:instance:u_new:M_AXI': true,
        'interface:port:m_axi': false,
    });
    assert.equal(renamedPort.interfacePorts[0].name, 'memory_axi');
    assert.equal(renamedPort.interfacePorts[0].memberPrefix, 'MEM_AXI');
    assert.deepEqual(renamedPort.interfaceConnections[0].slave, {
        kind: 'port', port: 'memory_axi',
    });
    assert.deepEqual(plainRecord(renamedPort.presentation.collapsedInterfaces), {
        'interface:instance:u_new:M_AXI': true,
        'interface:port:memory_axi': false,
    });
    assert.deepEqual(removed.interfacePorts, []);
    assert.deepEqual(removed.interfaceConnections, []);
    assert.deepEqual(plainRecord(removed.presentation.collapsedInterfaces), {
        'interface:instance:u_new:M_AXI': true,
    });
});
