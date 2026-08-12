import assert from 'node:assert/strict';
import test from 'node:test';

import {
    INTERFACE_PROTOCOL_FORMAT,
    INTERFACE_PROTOCOL_SCHEMA_VERSION,
    parseInterfaceProtocolText,
    parseInterfaceProtocolValue,
    type InterfaceProtocolReadResult,
} from '../src/interfaces';

function protocol(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        format: 'veriflow-interface-protocol',
        schemaVersion: 1,
        id: 'amba.axi4',
        name: 'AXI4',
        separator: '_',
        priority: 100,
        members: [
            { name: 'awaddr', direction: 'master-to-slave', default: '0' },
            { name: 'awvalid', direction: 'master-to-slave', default: "1'b0" },
            { name: 'awready', direction: 'slave-to-master', default: "1'b0" },
        ],
        recognitionGroups: [['awaddr', 'awvalid']],
        ...overrides,
    };
}

function invalidDiagnostics(result: InterfaceProtocolReadResult) {
    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid protocol');
    return result.diagnostics;
}

test('parses a complete protocol into an owned deeply frozen value', () => {
    const member = { name: 'awaddr', direction: 'master-to-slave', default: '0' };
    const source = protocol({
        members: [member],
        recognitionGroups: [['awaddr']],
    });
    const result = parseInterfaceProtocolValue(source);

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.equal(INTERFACE_PROTOCOL_FORMAT, 'veriflow-interface-protocol');
    assert.equal(INTERFACE_PROTOCOL_SCHEMA_VERSION, 1);
    assert.deepEqual(result.protocol, {
        format: 'veriflow-interface-protocol',
        schemaVersion: 1,
        id: 'amba.axi4',
        name: 'AXI4',
        separator: '_',
        priority: 100,
        members: [{
            name: 'awaddr',
            direction: 'master-to-slave',
            defaultExpression: '0',
        }],
        recognitionGroups: [['awaddr']],
    });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.protocol));
    assert.ok(Object.isFrozen(result.protocol.members));
    assert.ok(Object.isFrozen(result.protocol.members[0]));
    assert.ok(Object.isFrozen(result.protocol.recognitionGroups[0]));

    member.name = 'changed';
    (source.members as unknown[]).push({ name: 'injected' });
    assert.equal(result.protocol.members[0].name, 'awaddr');
    assert.equal(result.protocol.members.length, 1);
});

test('reports JSON syntax and keeps unknown positive schemas read-only', () => {
    assert.deepEqual(invalidDiagnostics(parseInterfaceProtocolText('{')), [{
        path: '$',
        code: 'IF_PROTOCOL_JSON_SYNTAX',
        message: 'Interface protocol is not valid JSON',
    }]);

    const result = parseInterfaceProtocolValue(protocol({
        schemaVersion: 2,
        future: { enabled: true },
    }));
    assert.equal(result.status, 'unsupported');
    if (result.status !== 'unsupported') return;
    assert.equal(result.schemaVersion, 2);
    assert.equal((result.value.future as { enabled?: unknown }).enabled, true);
    assert.equal(Object.getPrototypeOf(result.value.future), null);
    assert.ok(Object.isFrozen(result.value.future));
});

test('rejects duplicate members case-insensitively and invalid recognition groups', () => {
    const result = parseInterfaceProtocolValue(protocol({
        members: [
            { name: 'awaddr', direction: 'master-to-slave' },
            { name: 'AWADDR', direction: 'master-to-slave' },
        ],
        recognitionGroups: [
            [],
            ['missing'],
            ['awaddr'],
            ['AWADDR'],
        ],
    }));

    assert.deepEqual(invalidDiagnostics(result).map(item => [item.path, item.code]), [
        ['$.members[1].name', 'IF_PROTOCOL_DUPLICATE_MEMBER'],
        ['$.recognitionGroups[0]', 'IF_PROTOCOL_RECOGNITION_GROUP'],
        ['$.recognitionGroups[1][0]', 'IF_PROTOCOL_RECOGNITION_MEMBER'],
        ['$.recognitionGroups[3]', 'IF_PROTOCOL_DUPLICATE_RECOGNITION_GROUP'],
    ]);
});

test('validates header fields, member directions, separators, priority, and defaults', () => {
    const result = parseInterfaceProtocolValue(protocol({
        id: '',
        name: '',
        separator: 4,
        priority: 1.5,
        members: [{
            name: '',
            direction: 'sideways',
            default: 'side_effect()',
        }],
        recognitionGroups: 'all',
    }));

    assert.deepEqual(invalidDiagnostics(result).map(item => [item.path, item.code]), [
        ['$.id', 'IF_PROTOCOL_ID'],
        ['$.members[0].default', 'IF_PROTOCOL_DEFAULT'],
        ['$.members[0].direction', 'IF_PROTOCOL_MEMBER_DIRECTION'],
        ['$.members[0].name', 'IF_PROTOCOL_MEMBER_NAME'],
        ['$.name', 'IF_PROTOCOL_NAME'],
        ['$.priority', 'IF_PROTOCOL_PRIORITY'],
        ['$.recognitionGroups', 'IF_PROTOCOL_TYPE'],
        ['$.separator', 'IF_PROTOCOL_SEPARATOR'],
    ]);
});

test('uses a zero priority when omitted and accepts an empty string separator', () => {
    const value = protocol({ separator: '', priority: undefined });
    delete value.priority;
    const result = parseInterfaceProtocolValue(value);

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.equal(result.protocol.priority, 0);
    assert.equal(result.protocol.separator, '');
});

test('normalizes unique case-insensitive member aliases', () => {
    const result = parseInterfaceProtocolValue(protocol({
        members: [{
            name: 'hready',
            aliases: ['hreadyout'],
            direction: 'slave-to-master',
        }],
        recognitionGroups: [['hready']],
    }));

    assert.equal(result.status, 'editable');
    if (result.status !== 'editable') return;
    assert.deepEqual(result.protocol.members[0].aliases, ['hreadyout']);

    const invalid = parseInterfaceProtocolValue(protocol({
        members: [{
            name: 'hready',
            aliases: ['HREADY', 'hreadyout', 'HREADYOUT'],
            direction: 'slave-to-master',
        }],
        recognitionGroups: [['hready']],
    }));
    assert.deepEqual(invalidDiagnostics(invalid).map(item => [item.path, item.code]), [
        ['$.members[0].aliases[0]', 'IF_PROTOCOL_DUPLICATE_MEMBER_SUFFIX'],
        ['$.members[0].aliases[2]', 'IF_PROTOCOL_DUPLICATE_MEMBER_SUFFIX'],
    ]);
});

test('does not read inherited fields or invoke caller-controlled array methods', () => {
    const inherited = Object.create({ id: 'inherited' }) as Record<string, unknown>;
    Object.assign(inherited, protocol());
    delete inherited.id;
    assert.deepEqual(
        invalidDiagnostics(parseInterfaceProtocolValue(inherited)).map(item => item.path),
        ['$.id']
    );

    const members = [{ name: 'awaddr', direction: 'master-to-slave' }];
    let calls = 0;
    Object.defineProperty(members, 'map', {
        value: () => {
            calls += 1;
            return [];
        },
    });
    const result = parseInterfaceProtocolValue(protocol({
        members,
        recognitionGroups: [['awaddr']],
    }));
    assert.equal(result.status, 'editable');
    assert.equal(calls, 0);
});

test('turns unreadable caller-owned values into one stable diagnostic', () => {
    const value = protocol();
    Object.defineProperty(value, 'members', {
        enumerable: true,
        get: () => {
            throw new Error('unreadable');
        },
    });

    assert.deepEqual(invalidDiagnostics(parseInterfaceProtocolValue(value)), [{
        path: '$',
        code: 'IF_PROTOCOL_VALUE',
        message: 'Interface protocol contains an unreadable or non-JSON value',
    }]);
});
