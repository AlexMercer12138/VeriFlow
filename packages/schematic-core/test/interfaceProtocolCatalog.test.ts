import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BUILTIN_INTERFACE_PROTOCOL_IDS,
    createInterfaceProtocolCatalog,
    findInterfaceProtocol,
} from '../src/interfaces';

function customAxi(defaultExpression: string): Record<string, unknown> {
    return {
        format: 'veriflow-interface-protocol',
        schemaVersion: 1,
        id: 'amba.axi4',
        name: 'Project AXI4',
        separator: '_',
        priority: 250,
        members: [
            {
                name: 'awaddr',
                direction: 'master-to-slave',
                default: defaultExpression,
            },
        ],
        recognitionGroups: [['awaddr']],
    };
}

test('loads the stable built-in catalog through parsed JSON definitions', () => {
    const catalog = createInterfaceProtocolCatalog();

    assert.deepEqual(BUILTIN_INTERFACE_PROTOCOL_IDS, [
        'amba.axi4',
        'amba.axis',
        'amba.apb',
        'amba.ahb-lite',
    ]);
    assert.deepEqual(catalog.entries.map(entry => entry.protocol.id), [
        'amba.axi4',
        'amba.axis',
        'amba.apb',
        'amba.ahb-lite',
    ]);
    assert.equal(catalog.diagnostics.length, 0);
    assert.equal(catalog.entries.every(entry => entry.source.kind === 'builtin'), true);
    assert.equal(catalog.entries.some(entry => entry.protocol.id.includes('axi4-lite')), false);
    assert.ok(Object.isFrozen(catalog));
    assert.ok(Object.isFrozen(catalog.entries));
    assert.ok(Object.isFrozen(catalog.entries[0].protocol));

    for (const entry of catalog.entries) {
        const names = new Set(entry.protocol.members.map(member => member.name.toLowerCase()));
        assert.equal(names.has('aclk'), false, `${entry.protocol.id} contains aclk`);
        assert.equal(names.has('aresetn'), false, `${entry.protocol.id} contains aresetn`);
        assert.equal(names.has('pclk'), false, `${entry.protocol.id} contains pclk`);
        assert.equal(names.has('presetn'), false, `${entry.protocol.id} contains presetn`);
        assert.equal(names.has('hclk'), false, `${entry.protocol.id} contains hclk`);
        assert.equal(names.has('hresetn'), false, `${entry.protocol.id} contains hresetn`);
    }
    const ahb = findInterfaceProtocol(catalog, 'amba.ahb-lite');
    assert.ok(ahb);
    const ready = ahb.protocol.members.find(member => member.name === 'hready');
    assert.deepEqual(ready?.aliases, ['hreadyout']);
});

test('replaces a built-in protocol as one project-owned definition', () => {
    const catalog = createInterfaceProtocolCatalog([{
        source: '/workspace/protocols/axi.json',
        value: customAxi("1'b1"),
    }]);
    const axi = findInterfaceProtocol(catalog, 'amba.axi4');

    assert.ok(axi);
    assert.equal(axi.protocol.name, 'Project AXI4');
    assert.equal(axi.protocol.members.length, 1);
    assert.equal(axi.protocol.members[0].defaultExpression, "1'b1");
    assert.deepEqual(axi.source, {
        kind: 'project',
        source: '/workspace/protocols/axi.json',
        overrides: 'builtin:axi4.json',
    });
    assert.equal(catalog.entries.length, 4);
    assert.equal(catalog.diagnostics.length, 0);
});

test('keeps a built-in intact when its project replacement is invalid', () => {
    const catalog = createInterfaceProtocolCatalog([{
        source: '/workspace/protocols/axi.json',
        value: customAxi('unsafe_call()'),
    }]);
    const axi = findInterfaceProtocol(catalog, 'amba.axi4');

    assert.ok(axi);
    assert.equal(axi.protocol.name, 'AXI4');
    assert.equal(axi.source.kind, 'builtin');
    assert.deepEqual(catalog.diagnostics.map(item => [
        item.source,
        item.path,
        item.code,
    ]), [[
        '/workspace/protocols/axi.json',
        '$.members[0].default',
        'IF_PROTOCOL_DEFAULT',
    ]]);
});

test('diagnoses unsupported project protocol schemas without adding them', () => {
    const value = customAxi('0');
    value.id = 'project.future';
    value.schemaVersion = 2;
    const catalog = createInterfaceProtocolCatalog([{
        source: '/workspace/protocols/future.json',
        value,
    }]);

    assert.equal(findInterfaceProtocol(catalog, 'project.future'), undefined);
    assert.deepEqual(catalog.diagnostics.map(item => [item.path, item.code]), [[
        '$.schemaVersion',
        'IF_PROTOCOL_SCHEMA_UNSUPPORTED',
    ]]);
});

test('uses the last project definition for one custom protocol ID', () => {
    const first = customAxi('0');
    first.id = 'project.custom';
    first.name = 'First';
    const second = customAxi("1'b1");
    second.id = 'project.custom';
    second.name = 'Second';

    const catalog = createInterfaceProtocolCatalog([
        { source: '/workspace/protocols/first.json', value: first },
        { source: '/workspace/protocols/second.json', value: second },
    ]);
    const matches = catalog.entries.filter(entry =>
        entry.protocol.id === 'project.custom'
    );

    assert.equal(matches.length, 1);
    assert.equal(matches[0].protocol.name, 'Second');
    assert.deepEqual(matches[0].source, {
        kind: 'project',
        source: '/workspace/protocols/second.json',
        overrides: '/workspace/protocols/first.json',
    });
});
