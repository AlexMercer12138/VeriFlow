import * as assert from 'assert';

import { ParserRequestQueue } from '../core/hdl/parserQueue';
import type { WorkspaceIndexInvalidation } from '../core/hdl/workspaceHdlIndex';
import { WorkspaceIndexStore } from '../core/hdl/workspaceIndexStore';
import type { PersistedWorkspaceIndex } from '../core/hdl/workspaceIndexTypes';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';
import { createWorkspaceIndexHarness } from './helpers/workspaceIndexFixture';

class MemoryMemento {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
            return;
        }
        this.values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    }

    set(key: string, value: unknown): void {
        this.values.set(key, value);
    }
}

class DeferredMemento {
    private readonly pending: Array<() => void> = [];

    get<T>(): T | undefined {
        return undefined;
    }

    update(_key: string, _value: unknown): Promise<void> {
        return new Promise(resolve => this.pending.push(resolve));
    }

    resolveNext(): void {
        const resolve = this.pending.shift();
        assert.ok(resolve, 'expected a pending memento update');
        resolve();
    }
}

async function testRoundTripPersistence(): Promise<void> {
    const value: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:tree-sitter-systemverilog@0.4.0',
        files: [{
            uri: 'file:///workspace/top.sv',
            mtimeMs: 1_725_000_000_123,
            size: 248,
            contentHash: 'sha256:top-source',
            includeUris: ['file:///workspace/defs.svh'],
            definitions: [{
                key: 'module:file:///workspace/top.sv:14',
                kind: 'module',
                name: 'top',
                uri: 'file:///workspace/top.sv',
                declarationStart: 14,
                declarationLine: 2,
                parameters: [{ name: 'WIDTH', defaultExpression: '8' }],
                ports: [{
                    name: 'data_i',
                    direction: 'input',
                    packedRange: '[WIDTH-1:0]',
                    width: { kind: 'symbolic', expression: 'WIDTH' },
                }],
                dependencies: ['child'],
                modelFingerprint: 'sha256:normalized-top+defs-source',
            }],
            diagnostics: [{
                severity: 'warning',
                code: 'HDL_INCLUDE_UNRESOLVED',
                message: 'include not found',
            }],
        }],
    };
    const store = new WorkspaceIndexStore(new MemoryMemento());

    await store.save(value);

    assert.deepStrictEqual(store.load(value.parserFingerprint), value);
}

async function testLoadRejectsFingerprintMismatch(): Promise<void> {
    const store = new WorkspaceIndexStore(new MemoryMemento());
    const value: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:a',
        files: [],
    };

    await store.save(value);

    assert.strictEqual(store.load('parser:b'), undefined);
}

async function testLoadRejectsSchemaMismatch(): Promise<void> {
    const memento = new MemoryMemento();
    const store = new WorkspaceIndexStore(memento);
    memento.set('veriflow.hdlWorkspaceIndex.v1', {
        schemaVersion: 2,
        parserFingerprint: 'parser:a',
        files: [],
    });

    assert.strictEqual(store.load('parser:a'), undefined);
}

async function testLoadRejectsMalformedCurrentSchema(): Promise<void> {
    const memento = new MemoryMemento();
    const store = new WorkspaceIndexStore(memento);
    const definition = {
        key: 'module:top',
        kind: 'module',
        name: 'top',
        uri: 'memory:/top.sv',
        declarationStart: 0,
        declarationLine: 1,
        parameters: [{ name: 'WIDTH', defaultExpression: '8' }],
        ports: [{
            name: 'data_i',
            direction: 'input',
            width: { kind: 'known', bits: 8 },
        }],
        dependencies: ['child'],
        modelFingerprint: 'definition-hash',
    };
    const file = {
        uri: 'memory:/top.sv',
        mtimeMs: 1,
        size: 32,
        contentHash: 'file-hash',
        includeUris: ['memory:/defs.svh'],
        definitions: [definition],
        diagnostics: [{ severity: 'warning', code: 'TEST', message: 'diagnostic' }],
    };
    const currentSchema = {
        schemaVersion: 1,
        parserFingerprint: 'parser:a',
        files: [file],
    };
    const malformedValues: unknown[] = [
        null,
        { schemaVersion: 1, parserFingerprint: 'parser:a' },
        { ...currentSchema, files: {} },
        { ...currentSchema, files: [{}] },
        { ...currentSchema, files: [{ ...file, definitions: [{}] }] },
        {
            ...currentSchema,
            files: [{
                ...file,
                definitions: [{ ...definition, parameters: [{ name: 1 }] }],
            }],
        },
        {
            ...currentSchema,
            files: [{
                ...file,
                definitions: [{ ...definition, ports: [{}] }],
            }],
        },
        {
            ...currentSchema,
            files: [{
                ...file,
                definitions: [{
                    ...definition,
                    ports: [{
                        ...definition.ports[0],
                        width: { kind: 'known', bits: '8' },
                    }],
                }],
            }],
        },
        {
            ...currentSchema,
            files: [{
                ...file,
                diagnostics: [{
                    ...file.diagnostics[0],
                    span: {
                        start: 0,
                        end: 1,
                        compositeParts: [{ uri: 'memory:/defs.svh', start: 'bad', end: 1 }],
                    },
                }],
            }],
        },
    ];

    for (const value of malformedValues) {
        memento.set('veriflow.hdlWorkspaceIndex.v1', value);
        assert.strictEqual(store.load('parser:a'), undefined);
    }
}

async function testClearRemovesPersistedIndex(): Promise<void> {
    const store = new WorkspaceIndexStore(new MemoryMemento());
    const value: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:a',
        files: [],
    };
    await store.save(value);

    await store.clear();

    assert.strictEqual(store.load(value.parserFingerprint), undefined);
}

async function testStoreWaitsForMementoUpdates(): Promise<void> {
    const memento = new DeferredMemento();
    const store = new WorkspaceIndexStore(memento);
    const value: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:a',
        files: [],
    };
    let saveComplete = false;
    const save = store.save(value).then(() => { saveComplete = true; });
    await Promise.resolve();
    assert.strictEqual(saveComplete, false);
    memento.resolveNext();
    await save;

    let clearComplete = false;
    const clear = store.clear().then(() => { clearComplete = true; });
    await Promise.resolve();
    assert.strictEqual(clearComplete, false);
    memento.resolveNext();
    await clear;
}

async function testDefinitionsExposeOneBasedDeclarationLines(): Promise<void> {
    const document = await parseWithRealWorker('memory:/declaration-lines.sv', [
        '// leading comment',
        'module top;',
        'endmodule',
        '',
        'interface bus_if;',
        'endinterface',
        '',
        'package widths_pkg;',
        'endpackage',
    ].join('\n'));

    assert.strictEqual(document.modules[0].declarationLine, 2);
    assert.strictEqual(document.interfaces[0].declarationLine, 5);
    assert.strictEqual(document.packages[0].declarationLine, 8);
}

async function testCompositeDefinitionsUseTheirOriginalDeclarationLines(): Promise<void> {
    const uri = 'memory:/composite-declaration-lines.sv';
    const document = await parseWithRealWorker(uri, [
        '`include "header.svh"',
        'module top;',
        '`include "module-body.svh"',
        'endmodule',
        'interface bus_if;',
        '`include "interface-body.svh"',
        'endinterface',
        'package widths_pkg;',
        '`include "package-body.svh"',
        'endpackage',
    ].join('\r\n'), {
        defines: {},
        resolvedIncludes: [
            {
                fromUri: uri,
                rawPath: 'header.svh',
                resolvedUri: 'memory:/header.svh',
                text: '// Unicode header \u{1F642}\r\n// second header line\r\n',
            },
            {
                fromUri: uri,
                rawPath: 'module-body.svh',
                resolvedUri: 'memory:/module-body.svh',
                text: '// module body\r\n// continues\r\n',
            },
            {
                fromUri: uri,
                rawPath: 'interface-body.svh',
                resolvedUri: 'memory:/interface-body.svh',
                text: '// interface body\r\n',
            },
            {
                fromUri: uri,
                rawPath: 'package-body.svh',
                resolvedUri: 'memory:/package-body.svh',
                text: '// package body\r\n',
            },
        ],
    });

    assert.strictEqual(document.modules[0].declarationLine, 2);
    assert.strictEqual(document.interfaces[0].declarationLine, 5);
    assert.strictEqual(document.packages[0].declarationLine, 8);
}

async function testInitialScanDuplicatesAndRefresh(): Promise<void> {
    const harness = createWorkspaceIndexHarness({
        'file:///ws/a.sv': 'module shared; endmodule',
        'file:///ws/b.v': 'module shared; endmodule',
        'file:///ws/child.v': 'module child; endmodule',
    });
    try {
        await harness.index.scan(['file:///ws']);

        assert.deepStrictEqual(
            harness.index.findDefinitions('shared').map(definition => definition.uri),
            ['file:///ws/a.sv', 'file:///ws/b.v']
        );
        assert.deepStrictEqual(
            harness.index.getDuplicateGroups().map(group => ({
                name: group.name,
                uris: group.definitions.map(definition => definition.uri),
            })),
            [{ name: 'shared', uris: ['file:///ws/a.sv', 'file:///ws/b.v'] }]
        );
        assert.strictEqual(harness.index.findDefinitions('child').length, 1);

        harness.files.set('file:///ws/child.v', 'module child2; endmodule');
        await harness.index.refreshUri('file:///ws/child.v');

        assert.strictEqual(harness.index.findDefinitions('child').length, 0);
        assert.strictEqual(harness.index.findDefinitions('child2').length, 1);
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function testWorkspacePersistenceAndUnchangedCache(): Promise<void> {
    const uri = 'file:///ws/cache.sv';
    const harness = createWorkspaceIndexHarness({
        [uri]: 'module cache_a; endmodule',
    });
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws']);
        assert.strictEqual(harness.parserCalls.length, 1);
        assert.strictEqual(harness.persistedWrites.length, 1);

        const summary = harness.index.findDefinitions('cache_a')[0];
        assert.deepStrictEqual(harness.index.getDefinition(summary.key), summary);
        assert.strictEqual(harness.index.getFile(uri)?.contentHash.length, 71);

        await harness.index.scan(['file:///ws']);
        assert.strictEqual(harness.parserCalls.length, 1);

        harness.files.set(uri, 'module cache_b; endmodule');
        await harness.index.scan(['file:///ws']);
        assert.strictEqual(harness.parserCalls.length, 2);
        assert.strictEqual(harness.index.findDefinitions('cache_a').length, 0);
        assert.strictEqual(harness.index.findDefinitions('cache_b').length, 1);

        const callsBeforeLoad = harness.parserCalls.length;
        await reloaded.load();
        assert.strictEqual(reloaded.findDefinitions('cache_b').length, 1);
        assert.strictEqual(harness.parserCalls.length, callsBeforeLoad);

        const reloadedEvents: WorkspaceIndexInvalidation[] = [];
        reloaded.onDidInvalidate(event => reloadedEvents.push(event));
        await reloaded.scan(['file:///ws']);
        assert.deepStrictEqual(reloadedEvents, []);
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testIncludeGraphTransitiveRefreshAndStructuralFingerprints(): Promise<void> {
    const topUri = 'file:///ws/top.sv';
    const defsUri = 'file:///ws/inc/defs.svh';
    const portsUri = 'file:///ws/inc/ports.svh';
    const nestedUri = 'file:///ws/inc/nested/common.svh';
    const bodyUri = 'file:///ws/inc/body.svh';
    const harness = createWorkspaceIndexHarness({
        [topUri]: [
            '`include "inc/defs.svh"',
            'module top (',
            '`include "inc/ports.svh"',
            ');',
            '`include "inc/body.svh"',
            'endmodule',
        ].join('\n'),
        [defsUri]: 'module included_only; endmodule',
        [portsUri]: '`include "nested/common.svh"',
        [nestedUri]: 'input logic [3:0] data_i',
        [bodyUri]: 'child_a u_child(.data_i(data_i));',
        'file:///ws/a/top_a.sv': [
            'module top_a (',
            '`include "common.svh"',
            '); endmodule',
        ].join('\n'),
        'file:///ws/a/common.svh': 'input logic a_i',
        'file:///ws/b/top_b.sv': [
            'module top_b (',
            '`include "common.svh"',
            '); endmodule',
        ].join('\n'),
        'file:///ws/b/common.svh': 'output logic b_o',
    });
    try {
        await harness.index.scan(['file:///ws']);

        const initialTop = harness.index.findDefinitions('top')[0];
        assert.deepStrictEqual(initialTop.ports.map(port => ({
            name: port.name,
            packedRange: port.packedRange,
        })), [{ name: 'data_i', packedRange: '[3:0]' }]);
        assert.deepStrictEqual(initialTop.dependencies, ['child_a']);
        assert.deepStrictEqual(
            harness.index.findDefinitions('top_a')[0].ports.map(port => port.name),
            ['a_i']
        );
        assert.deepStrictEqual(
            harness.index.findDefinitions('top_b')[0].ports.map(port => port.name),
            ['b_o']
        );
        assert.deepStrictEqual(
            harness.index.findDefinitions('included_only').map(definition => definition.uri),
            [defsUri]
        );
        assert.deepStrictEqual(
            harness.index.getDependentsOfInclude(nestedUri),
            [portsUri, topUri]
        );

        const topParseIndex = harness.parserCalls.findIndex(call => call.uri === topUri);
        const resolved = harness.parserOptions[topParseIndex].resolvedIncludes ?? [];
        assert.ok(resolved.some(include =>
            include.fromUri === portsUri
            && include.rawPath === 'nested/common.svh'
            && include.resolvedUri === nestedUri
        ));
        assert.ok(resolved.some(include =>
            include.fromUri === 'file:///ws/a/top_a.sv'
            && include.rawPath === 'common.svh'
            && include.resolvedUri === 'file:///ws/a/common.svh'
        ) === false, 'top parse should contain only its own resolved include closure');

        const callsBeforeNestedRefresh = harness.parserCalls.length;
        harness.files.set(nestedUri, 'input logic [7:0] data_i');
        await harness.index.refreshUri(nestedUri);
        const nestedRefreshUris = harness.parserCalls
            .slice(callsBeforeNestedRefresh)
            .map(call => call.uri)
            .sort();
        assert.deepStrictEqual(nestedRefreshUris, [nestedUri, portsUri, topUri]);
        const rangeChangedTop = harness.index.findDefinitions('top')[0];
        assert.strictEqual(rangeChangedTop.ports[0].packedRange, '[7:0]');
        assert.notStrictEqual(rangeChangedTop.modelFingerprint, initialTop.modelFingerprint);

        harness.files.set(bodyUri, 'child_b u_child(.data_i(data_i));');
        await harness.index.refreshUri(bodyUri);
        const bodyChangedTop = harness.index.findDefinitions('top')[0];
        assert.deepStrictEqual(bodyChangedTop.dependencies, ['child_b']);
        assert.notStrictEqual(
            bodyChangedTop.modelFingerprint,
            rangeChangedTop.modelFingerprint
        );
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function testAbortIsAtomicAndDoesNotPersistOrInvalidate(): Promise<void> {
    const harness = createWorkspaceIndexHarness({
        'file:///ws/a.sv': 'module a; endmodule',
        'file:///ws/b.sv': 'module b; endmodule',
        'file:///ws/c.sv': 'module c; endmodule',
    });
    const controller = new AbortController();
    const events: WorkspaceIndexInvalidation[] = [];
    harness.index.onDidInvalidate(event => events.push(event));
    harness.hooks.afterParse = () => controller.abort();
    try {
        await assert.rejects(
            harness.index.scan(['file:///ws'], controller.signal),
            error => error instanceof Error && error.name === 'AbortError'
        );

        assert.deepStrictEqual(harness.parserCalls.map(call => call.uri), ['file:///ws/a.sv']);
        assert.deepStrictEqual(harness.index.getAllDefinitions(), []);
        assert.strictEqual(harness.persistedWrites.length, 0);
        assert.deepStrictEqual(events, []);
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function testInvalidationRemoveAndConfigurationBatches(): Promise<void> {
    const topUri = 'file:///ws/top.sv';
    const portsUri = 'file:///ws/ports.svh';
    const configuredUri = 'file:///ws/configured.sv';
    const harness = createWorkspaceIndexHarness({
        [topUri]: [
            'module top (',
            '`include "ports.svh"',
            '); endmodule',
        ].join('\n'),
        [portsUri]: 'input logic [3:0] data_i',
        [configuredUri]: [
            '`ifdef USE_A',
            'module active_a; endmodule',
            '`else',
            'module active_b; endmodule',
            '`endif',
        ].join('\n'),
    });
    const events: WorkspaceIndexInvalidation[] = [];
    const listener = harness.index.onDidInvalidate(event => events.push(event));
    const onlyEvent = (): WorkspaceIndexInvalidation => {
        assert.strictEqual(events.length, 1);
        return events[0] as WorkspaceIndexInvalidation;
    };
    try {
        await harness.index.scan(['file:///ws']);
        const initialEvent = onlyEvent();
        assert.deepStrictEqual(initialEvent.changedUris, [configuredUri, portsUri, topUri]);
        assert.deepStrictEqual(initialEvent.affectedDocumentUris, [configuredUri, portsUri, topUri]);
        assert.deepStrictEqual(
            initialEvent.changedDefinitionKeys,
            harness.index.getAllDefinitions().map(definition => definition.key).sort()
        );
        assert.strictEqual(initialEvent.parserFingerprint, 'fixture-parser-v1');

        events.length = 0;
        await harness.index.scan(['file:///ws']);
        assert.deepStrictEqual(events, []);

        const topKey = harness.index.findDefinitions('top')[0].key;
        harness.files.set(portsUri, 'input logic [7:0] data_i');
        await harness.index.refreshUri(portsUri);
        const refreshEvent = onlyEvent();
        assert.deepStrictEqual(refreshEvent.changedUris, [portsUri]);
        assert.deepStrictEqual(refreshEvent.affectedDocumentUris, [portsUri, topUri]);
        assert.deepStrictEqual(refreshEvent.changedDefinitionKeys, [topKey]);

        events.length = 0;
        await harness.index.updateConfiguration({ USE_A: true });
        assert.strictEqual(harness.index.findDefinitions('active_b').length, 0);
        assert.strictEqual(harness.index.findDefinitions('active_a').length, 1);
        const configurationEvent = onlyEvent();
        assert.deepStrictEqual(configurationEvent.changedUris, []);
        assert.deepStrictEqual(
            configurationEvent.affectedDocumentUris,
            [configuredUri, portsUri, topUri]
        );
        assert.strictEqual(configurationEvent.changedDefinitionKeys.length, 2);

        events.length = 0;
        const callsBeforeSameConfiguration = harness.parserCalls.length;
        await harness.index.updateConfiguration({ USE_A: true });
        assert.strictEqual(harness.parserCalls.length, callsBeforeSameConfiguration);
        assert.deepStrictEqual(events, []);

        events.length = 0;
        await harness.index.removeUri(portsUri);
        assert.strictEqual(harness.index.getFile(portsUri), undefined);
        assert.deepStrictEqual(harness.index.findDefinitions('top')[0].ports, []);
        const removeEvent = onlyEvent();
        assert.deepStrictEqual(removeEvent.changedUris, [portsUri]);
        assert.deepStrictEqual(removeEvent.affectedDocumentUris, [portsUri, topUri]);

        listener.dispose();
        events.length = 0;
        harness.files.set(configuredUri, harness.files.get(configuredUri)!.replace(
            'active_a',
            'active_c'
        ));
        await harness.index.refreshUri(configuredUri);
        assert.deepStrictEqual(events, []);

        let disposedCalls = 0;
        harness.index.onDidInvalidate(() => { disposedCalls++; });
        harness.index.dispose();
        await assert.rejects(harness.index.refreshUri(configuredUri), /disposed/i);
        assert.strictEqual(disposedCalls, 0);
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function testPersistedResolveUsesTheExactDefinitionKey(): Promise<void> {
    const uri = 'file:///ws/exact.sv';
    const harness = createWorkspaceIndexHarness({
        [uri]: [
            'module same(input logic first_i); endmodule',
            'module same(output logic second_o); endmodule',
        ].join('\n'),
    });
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws']);
        const definitions = harness.index.findDefinitions('same');
        assert.strictEqual(definitions.length, 2);
        assert.notStrictEqual(definitions[0].key, definitions[1].key);

        await reloaded.load();
        const resolved = await reloaded.resolveDefinition(definitions[1].key);
        assert.deepStrictEqual(resolved.summary, definitions[1]);
        assert.strictEqual(resolved.document.uri, uri);
        assert.strictEqual(resolved.module?.declarationSpan.start, definitions[1].declarationStart);
        assert.deepStrictEqual(resolved.module?.ports.map(port => port.name), ['second_o']);
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testIndexPrioritiesAndInteractiveQueuePrecedence(): Promise<void> {
    const harness = createWorkspaceIndexHarness({
        'file:///ws/priority.sv': 'module priority; endmodule',
    });
    try {
        await harness.index.scan(['file:///ws']);
        assert.ok(harness.parserCalls.length > 0);
        assert.ok(harness.parserCalls.every(call => call.priority === 'background'));

        const queue = new ParserRequestQueue<{
            requestId: string;
            priority: 'interactive' | 'background';
        }>();
        queue.enqueue({ requestId: 'background-1', priority: 'background' });
        queue.enqueue({ requestId: 'background-2', priority: 'background' });
        queue.enqueue({ requestId: 'interactive', priority: 'interactive' });
        assert.strictEqual(queue.takeNext()?.requestId, 'interactive');
        assert.strictEqual(queue.takeNext()?.requestId, 'background-1');
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function main(): Promise<void> {
    await testRoundTripPersistence();
    await testLoadRejectsFingerprintMismatch();
    await testLoadRejectsSchemaMismatch();
    await testLoadRejectsMalformedCurrentSchema();
    await testClearRemovesPersistedIndex();
    await testStoreWaitsForMementoUpdates();
    await testDefinitionsExposeOneBasedDeclarationLines();
    await testCompositeDefinitionsUseTheirOriginalDeclarationLines();
    await testInitialScanDuplicatesAndRefresh();
    await testWorkspacePersistenceAndUnchangedCache();
    await testIncludeGraphTransitiveRefreshAndStructuralFingerprints();
    await testAbortIsAtomicAndDoesNotPersistOrInvalidate();
    await testInvalidationRemoveAndConfigurationBatches();
    await testPersistedResolveUsesTheExactDefinitionKey();
    await testIndexPrioritiesAndInteractiveQueuePrecedence();

    console.log('HDL workspace index tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
