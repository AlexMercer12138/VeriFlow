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
        }],
    });
    const one = applyArchDesignEdit(source, {
        type: 'disconnect', connection: 'data', endpoint: { kind: 'port', port: 'sink' },
    });
    const empty = applyArchDesignEdit(one, {
        type: 'disconnect', connection: 'data', endpoint: { kind: 'port', port: 'source' },
    });

    assert.deepEqual(one.connections[0].endpoints, [{ kind: 'port', port: 'source' }]);
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
