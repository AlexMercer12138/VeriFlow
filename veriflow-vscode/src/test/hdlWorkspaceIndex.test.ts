import * as assert from 'assert';

import type { HdlDocument } from '../core/hdl/model';
import { canonicalizeSourceUri } from '../core/hdl/preprocessor';
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

    keys(): string[] {
        return [...this.values.keys()];
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

    resolveAll(): void {
        while (this.pending.length > 0) {
            this.resolveNext();
        }
    }
}

function isCommittedWorkspaceIndexKey(key: string): boolean {
    return key.startsWith('veriflow.hdlWorkspaceIndex.v1') && !key.endsWith('.pending');
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
            preprocessingFingerprint: 'sha256:top-preprocessing',
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
    memento.set('veriflow.hdlWorkspaceIndex.v1', currentSchema);
    assert.deepStrictEqual(store.load('parser:a'), currentSchema);
    const malformedValues: unknown[] = [
        null,
        { schemaVersion: 1, parserFingerprint: 'parser:a' },
        { ...currentSchema, files: {} },
        { ...currentSchema, files: [{}] },
        { ...currentSchema, files: [{ ...file, preprocessingFingerprint: 1 }] },
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
        {
            ...currentSchema,
            files: [{
                ...file,
                unresolvedIncludes: [{
                    ownerUri: 'memory:/top.sv',
                    fromUri: 1,
                    rawPath: 'missing.svh',
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

async function testClearDoesNotResurrectLegacySnapshot(): Promise<void> {
    const memento = new MemoryMemento();
    const value: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:legacy',
        files: [],
    };
    memento.set('veriflow.hdlWorkspaceIndex.v1', value);
    const store = new WorkspaceIndexStore(memento);
    assert.deepStrictEqual(store.load(value.parserFingerprint), value);
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
    memento.resolveAll();
    await clear;
}

async function testStagedWorkspaceSnapshotIsIgnoredByLoad(): Promise<void> {
    const store = new WorkspaceIndexStore(new MemoryMemento());
    const committed: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:a',
        files: [],
    };
    const staged: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:b',
        files: [],
    };
    await store.save(committed);

    await store.stage(staged);
    assert.deepStrictEqual(store.load('parser:a'), committed);
    assert.strictEqual(store.load('parser:b'), undefined);

    await store.discardStaged();
    assert.deepStrictEqual(store.load('parser:a'), committed);
}

async function testStoreNamespacesConcurrentRootSnapshots(): Promise<void> {
    const memento = new MemoryMemento();
    const firstStore = new WorkspaceIndexStore(memento);
    const secondStore = new WorkspaceIndexStore(memento);
    const first: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:root-a',
        files: [],
    };
    const second: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser:root-b',
        files: [],
    };

    await Promise.all([firstStore.stage(first), secondStore.stage(second)]);
    assert.strictEqual(
        memento.keys().filter(key => key.endsWith('.pending')).length,
        2
    );
    await Promise.all([firstStore.save(first), secondStore.save(second)]);
    await Promise.all([firstStore.discardStaged(), secondStore.discardStaged()]);

    assert.deepStrictEqual(
        new WorkspaceIndexStore(memento).load(first.parserFingerprint),
        first
    );
    assert.deepStrictEqual(
        new WorkspaceIndexStore(memento).load(second.parserFingerprint),
        second
    );
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

async function testPersistenceIdentityIncludesDefines(): Promise<void> {
    const uri = 'file:///ws/persisted-defines.sv';
    const harness = createWorkspaceIndexHarness({
        [uri]: [
            '`ifdef USE_A',
            'module active_a; endmodule',
            '`else',
            'module active_b; endmodule',
            '`endif',
        ].join('\n'),
    });
    const configured = harness.createIndex({ USE_A: true });
    try {
        await harness.index.scan(['file:///ws']);
        assert.strictEqual(harness.index.findDefinitions('active_b').length, 1);

        await configured.load();
        assert.strictEqual(configured.findDefinitions('active_b').length, 0);
        await configured.updateConfiguration({ USE_A: true });
        assert.strictEqual(configured.findDefinitions('active_b').length, 0);
    } finally {
        harness.index.dispose();
        configured.dispose();
        await harness.dispose();
    }
}

async function testLoadedUnchangedFilesUsePersistedFastPath(): Promise<void> {
    const harness = createWorkspaceIndexHarness({
        'file:///ws/a.sv': 'module persisted_a; endmodule',
        'file:///ws/b.sv': 'module persisted_b; endmodule',
    });
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws']);
        assert.strictEqual(harness.parserCalls.length, 2);

        await reloaded.load();
        await reloaded.scan(['file:///ws']);

        assert.strictEqual(harness.parserCalls.length, 2);
        assert.strictEqual(reloaded.findDefinitions('persisted_a').length, 1);
        assert.strictEqual(reloaded.findDefinitions('persisted_b').length, 1);
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testLoadedOwnerRefreshesWhenResolvedIncludeChanges(): Promise<void> {
    const topUri = 'file:///ws/top.sv';
    const portsUri = 'file:///ws/ports.svh';
    const harness = createWorkspaceIndexHarness({
        [topUri]: [
            'module top (',
            '`include "ports.svh"',
            '); endmodule',
        ].join('\n'),
        [portsUri]: 'input logic old_i',
    });
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws']);
        await reloaded.load();
        harness.files.set(portsUri, 'output logic new_o');

        await reloaded.refreshUri(portsUri);

        assert.deepStrictEqual(
            reloaded.findDefinitions('top')[0].ports.map(port => port.name),
            ['new_o']
        );
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testLoadedScanRefreshesWhenIncludeMappingChanges(): Promise<void> {
    const topUri = 'file:///ws/top.sv';
    const aUri = 'file:///ws/a.svh';
    const bUri = 'file:///ws/b.svh';
    const harness = createWorkspaceIndexHarness({
        [topUri]: [
            'module mapped_top (',
            '`include "raw1.svh"',
            '`include "raw2.svh"',
            '); endmodule',
        ].join('\n'),
        [aUri]: [
            '`ifdef B_WAS_FIRST',
            'input logic selected_a',
            '`else',
            '`define A_WAS_FIRST',
            '`endif',
        ].join('\n'),
        [bUri]: [
            '`ifdef A_WAS_FIRST',
            'input logic selected_b',
            '`else',
            '`define B_WAS_FIRST',
            '`endif',
        ].join('\n'),
    });
    harness.includeMappings.set('raw1.svh', aUri);
    harness.includeMappings.set('raw2.svh', bUri);
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws']);
        assert.deepStrictEqual(
            harness.index.findDefinitions('mapped_top')[0].ports.map(port => port.name),
            ['selected_b']
        );
        const parserCallsBeforeReload = harness.parserCalls.length;

        await reloaded.load();
        harness.includeMappings.set('raw1.svh', bUri);
        harness.includeMappings.set('raw2.svh', aUri);
        await reloaded.scan(['file:///ws']);

        assert.deepStrictEqual(
            reloaded.findDefinitions('mapped_top')[0].ports.map(port => port.name),
            ['selected_a']
        );
        assert.deepStrictEqual(
            harness.parserCalls.slice(parserCallsBeforeReload).map(call => call.uri),
            [topUri]
        );
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testFullScanRemovesMissingFilesOnlyWithinRoots(): Promise<void> {
    const aUri = 'file:///ws/a.sv';
    const bUri = 'file:///ws/b.sv';
    const libraryUri = 'file:///lib/library.sv';
    const harness = createWorkspaceIndexHarness({
        [aUri]: 'module a; endmodule',
        [bUri]: 'module b; endmodule',
        [libraryUri]: 'module external_lib; endmodule',
    });
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws', 'file:///lib']);
        const removedKey = harness.index.findDefinitions('b')[0].key;
        harness.files.delete(bUri);

        await reloaded.load();
        const writesBeforeScan = harness.persistedWrites.length;
        const events: WorkspaceIndexInvalidation[] = [];
        reloaded.onDidInvalidate(event => events.push(event));
        await reloaded.scan(['file:///ws']);

        assert.strictEqual(reloaded.getFile(bUri), undefined);
        assert.strictEqual(reloaded.findDefinitions('b').length, 0);
        assert.strictEqual(reloaded.findDefinitions('a').length, 1);
        assert.strictEqual(reloaded.findDefinitions('external_lib').length, 1);
        assert.strictEqual(harness.persistedWrites.length, writesBeforeScan + 1);
        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0].changedUris, [bUri]);
        assert.deepStrictEqual(events[0].affectedDocumentUris, [bUri]);
        assert.deepStrictEqual(events[0].changedDefinitionKeys, [removedKey]);
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

async function testUnresolvedIncludeEdgesSurviveReloadAndRecreation(): Promise<void> {
    const topUri = 'file:///ws/missing-top.sv';
    const portsUri = 'file:///ws/ports.svh';
    const harness = createWorkspaceIndexHarness({
        [topUri]: [
            'module missing_top (',
            '`include "ports.svh"',
            '); endmodule',
        ].join('\n'),
    });
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws']);
        await reloaded.load();
        harness.files.set(portsUri, 'input logic created_i');

        await reloaded.refreshUri(portsUri);

        assert.deepStrictEqual(
            reloaded.findDefinitions('missing_top')[0].ports.map(port => port.name),
            ['created_i']
        );
        assert.deepStrictEqual(reloaded.getDependentsOfInclude(portsUri), [topUri]);

        harness.files.delete(portsUri);
        await reloaded.removeUri(portsUri);
        assert.deepStrictEqual(reloaded.findDefinitions('missing_top')[0].ports, []);

        harness.files.set(portsUri, 'output logic recreated_o');
        await reloaded.refreshUri(portsUri);
        assert.deepStrictEqual(
            reloaded.findDefinitions('missing_top')[0].ports.map(port => port.name),
            ['recreated_o']
        );
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testUnresolvedIncludeCandidateQueryIsReadOnly(): Promise<void> {
    const topUri = 'file:///A/top.sv';
    const includeUri = 'file:///B/shared/defs.svh';
    const rogueUri = 'file:///B/rogue.sv';
    const harness = createWorkspaceIndexHarness({
        [topUri]: [
            '`include "shared/defs.svh"',
            'module unresolved_owner; endmodule',
        ].join('\n'),
    });
    harness.includeMappings.set('shared/defs.svh', includeUri);
    const invalidations: WorkspaceIndexInvalidation[] = [];
    harness.index.onDidInvalidate(event => invalidations.push(event));
    try {
        await harness.index.scan(['file:///A']);
        assert.ok(harness.index.getFile(topUri)?.unresolvedIncludes?.some(include =>
            include.rawPath === 'shared/defs.svh'
        ));
        harness.files.set(canonicalizeSourceUri(includeUri), '`define SHARED_DEFS 1');
        const writesBeforeQuery = harness.persistedWrites.length;
        const parserCallsBeforeQuery = harness.parserCalls.length;
        invalidations.length = 0;
        const candidateIndex = harness.index as unknown as {
            canResolveUnresolvedInclude?: (uri: string) => Promise<boolean>;
        };

        assert.strictEqual(typeof candidateIndex.canResolveUnresolvedInclude, 'function');
        assert.strictEqual(
            await candidateIndex.canResolveUnresolvedInclude!(includeUri),
            true
        );
        assert.strictEqual(
            await candidateIndex.canResolveUnresolvedInclude!(rogueUri),
            false
        );
        assert.strictEqual(harness.persistedWrites.length, writesBeforeQuery);
        assert.strictEqual(harness.parserCalls.length, parserCallsBeforeQuery);
        assert.deepStrictEqual(invalidations, []);
        assert.strictEqual(harness.index.getFile(includeUri), undefined);

        await harness.index.refreshUri(includeUri);
        assert.ok(harness.index.getFile(includeUri));
        assert.ok(harness.index.getDependentsOfInclude(includeUri).includes(
            canonicalizeSourceUri(topUri)
        ));
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function testExternalIncludeWatchPlanIsReadOnly(): Promise<void> {
    const rootUri = 'file:///A';
    const topUri = `${rootUri}/top.sv`;
    const resolvedIncludeUri = 'file:///external/generated/defs.svh';
    const externalNonstandardIncludeUri = 'file:///external/generated/defs.inc';
    const localNonstandardIncludeUri = `${rootUri}/generated/local.inc`;
    const unresolvedCandidateUri = 'file:///external/future/created.svh';
    const rootContainedCandidateUri = `${rootUri}/future/local.svh`;
    const harness = createWorkspaceIndexHarness({
        [topUri]: [
            `\`include "${resolvedIncludeUri}"`,
            `\`include "${externalNonstandardIncludeUri}"`,
            `\`include "${localNonstandardIncludeUri}"`,
            `\`include "${unresolvedCandidateUri}"`,
            `\`include "${rootContainedCandidateUri}"`,
            'module watch_plan_owner; endmodule',
        ].join('\n'),
        [resolvedIncludeUri]: '`define GENERATED_DEFS 1',
        [externalNonstandardIncludeUri]: '`define EXTERNAL_INC 1',
        [localNonstandardIncludeUri]: '`define LOCAL_INC 1',
    });
    const invalidations: WorkspaceIndexInvalidation[] = [];
    harness.index.onDidInvalidate(event => invalidations.push(event));
    try {
        await harness.index.scan([rootUri]);
        const parserCallsBeforePlan = harness.parserCalls.length;
        const persistedWritesBeforePlan = harness.persistedWrites.length;
        const resolveCallsBeforePlan = harness.includeResolveCalls.length;
        invalidations.length = 0;

        const plan = harness.index.getWatchPlan([rootUri]);

        assert.deepStrictEqual(plan, {
            resolvedExternalIncludeUris: [
                canonicalizeSourceUri(resolvedIncludeUri),
                canonicalizeSourceUri(externalNonstandardIncludeUri),
                canonicalizeSourceUri(localNonstandardIncludeUri),
            ].sort(),
            unresolvedExternalCandidateUris: [canonicalizeSourceUri(unresolvedCandidateUri)],
        });
        for (const includeUri of [
            externalNonstandardIncludeUri,
            localNonstandardIncludeUri,
        ]) {
            assert.strictEqual(harness.index.getFile(includeUri), undefined);
            assert.deepStrictEqual(
                harness.index.getDependentsOfInclude(includeUri),
                [canonicalizeSourceUri(topUri)]
            );
        }
        assert.strictEqual(harness.parserCalls.length, parserCallsBeforePlan);
        assert.strictEqual(harness.persistedWrites.length, persistedWritesBeforePlan);
        assert.strictEqual(harness.includeResolveCalls.length, resolveCallsBeforePlan);
        assert.strictEqual(invalidations.length, 0);
        assert.strictEqual(harness.index.getFile(unresolvedCandidateUri), undefined);

        for (const [includeUri, replacement] of [
            [externalNonstandardIncludeUri, '`define EXTERNAL_INC 2'],
            [localNonstandardIncludeUri, '`define LOCAL_INC 2'],
        ] as const) {
            invalidations.length = 0;
            harness.files.set(canonicalizeSourceUri(includeUri), replacement);
            await harness.index.refreshUri(includeUri);
            assert.ok(invalidations.at(-1)?.affectedDocumentUris.includes(
                canonicalizeSourceUri(topUri)
            ));
        }

        invalidations.length = 0;
        harness.files.delete(canonicalizeSourceUri(externalNonstandardIncludeUri));
        await harness.index.removeUri(externalNonstandardIncludeUri);
        assert.ok(invalidations.at(-1)?.affectedDocumentUris.includes(
            canonicalizeSourceUri(topUri)
        ));
        assert.deepStrictEqual(
            harness.index.getDependentsOfInclude(externalNonstandardIncludeUri),
            []
        );

        const parserCallsBeforeRogue = harness.parserCalls.length;
        invalidations.length = 0;
        await harness.index.refreshUri('file:///external/generated/rogue.inc');
        assert.strictEqual(harness.parserCalls.length, parserCallsBeforeRogue);
        assert.deepStrictEqual(invalidations, []);
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

async function testAbortDuringSaveDoesNotCommitMemoryOrInvalidate(): Promise<void> {
    const harness = createWorkspaceIndexHarness({
        'file:///ws/save-abort.sv': 'module save_abort; endmodule',
    });
    const controller = new AbortController();
    const events: WorkspaceIndexInvalidation[] = [];
    harness.index.onDidInvalidate(event => events.push(event));
    let notifySaveStarted!: () => void;
    const saveStarted = new Promise<void>(resolve => { notifySaveStarted = resolve; });
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    harness.hooks.beforePersist = async () => {
        notifySaveStarted();
        await saveGate;
    };
    try {
        const scan = harness.index.scan(['file:///ws'], controller.signal);
        await saveStarted;
        controller.abort();
        releaseSave();

        await assert.rejects(
            scan,
            error => error instanceof Error && error.name === 'AbortError'
        );
        assert.deepStrictEqual(harness.index.getAllDefinitions(), []);
        assert.deepStrictEqual(events, []);

        const reloaded = harness.createIndex();
        try {
            await reloaded.load();
            assert.deepStrictEqual(reloaded.getAllDefinitions(), []);
        } finally {
            reloaded.dispose();
        }
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function testStageAbortIgnoresDiscardFailureAndKeepsCommittedSnapshot(): Promise<void> {
    const uri = 'file:///ws/stage-abort.sv';
    const harness = createWorkspaceIndexHarness({
        [uri]: 'module committed_old; endmodule',
    });
    const reloaded = harness.createIndex();
    const controller = new AbortController();
    const events: WorkspaceIndexInvalidation[] = [];
    harness.index.onDidInvalidate(event => events.push(event));
    try {
        await harness.index.scan(['file:///ws']);
        harness.files.set(uri, 'module staged_new___; endmodule');
        harness.hooks.beforePersist = call => {
            if (call.key.endsWith('.pending') && call.value !== undefined) {
                controller.abort();
            } else if (call.key.endsWith('.pending') && call.value === undefined) {
                throw new Error('discard failed');
            }
        };

        await assert.rejects(
            harness.index.refreshUri(uri, controller.signal),
            error => error instanceof Error && error.name === 'AbortError'
        );
        assert.strictEqual(harness.index.findDefinitions('committed_old').length, 1);
        assert.deepStrictEqual(events.slice(1), []);

        await reloaded.load();
        assert.strictEqual(reloaded.findDefinitions('committed_old').length, 1);
        assert.strictEqual(reloaded.findDefinitions('staged_new___').length, 0);
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testAbortAfterFormalCommitPointCompletesConsistently(): Promise<void> {
    const uri = 'file:///ws/formal-commit.sv';
    const harness = createWorkspaceIndexHarness({
        [uri]: 'module formal_old; endmodule',
    });
    const reloaded = harness.createIndex();
    const controller = new AbortController();
    const events: WorkspaceIndexInvalidation[] = [];
    harness.index.onDidInvalidate(event => events.push(event));
    try {
        await harness.index.scan(['file:///ws']);
        events.length = 0;
        harness.files.set(uri, 'module formal_new; endmodule');
        harness.hooks.beforePersist = call => {
            if (isCommittedWorkspaceIndexKey(call.key)) {
                controller.abort();
            }
        };

        await harness.index.refreshUri(uri, controller.signal);

        assert.strictEqual(harness.index.findDefinitions('formal_new').length, 1);
        assert.strictEqual(events.length, 1);
        await reloaded.load();
        assert.strictEqual(reloaded.findDefinitions('formal_new').length, 1);
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testFormalSaveFailureDoesNotCommitMemory(): Promise<void> {
    const uri = 'file:///ws/formal-failure.sv';
    const harness = createWorkspaceIndexHarness({
        [uri]: 'module failure_old; endmodule',
    });
    const reloaded = harness.createIndex();
    const events: WorkspaceIndexInvalidation[] = [];
    harness.index.onDidInvalidate(event => events.push(event));
    try {
        await harness.index.scan(['file:///ws']);
        events.length = 0;
        harness.files.set(uri, 'module failure_new; endmodule');
        harness.hooks.beforePersist = call => {
            if (isCommittedWorkspaceIndexKey(call.key)) {
                throw new Error('formal save failed');
            }
        };

        const controller = new AbortController();
        await assert.rejects(
            harness.index.refreshUri(uri, controller.signal),
            /formal save failed/
        );

        assert.strictEqual(harness.index.findDefinitions('failure_old').length, 1);
        assert.deepStrictEqual(events, []);
        await reloaded.load();
        assert.strictEqual(reloaded.findDefinitions('failure_old').length, 1);
    } finally {
        harness.index.dispose();
        reloaded.dispose();
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

async function testRemoveContinuesPastUnreadableDependents(): Promise<void> {
    const targetUri = 'file:///ws/target.svh';
    const readableUri = 'file:///ws/readable.sv';
    const unreadableUri = 'file:///ws/unreadable.sv';
    const harness = createWorkspaceIndexHarness({
        [targetUri]: 'module shared_target; endmodule',
        [readableUri]: [
            '`include "target.svh"',
            'module readable_parent; endmodule',
        ].join('\n'),
        [unreadableUri]: [
            '`include "target.svh"',
            'module unreadable_parent; endmodule',
        ].join('\n'),
    });
    try {
        await harness.index.scan(['file:///ws']);
        harness.files.delete(targetUri);
        harness.files.delete(unreadableUri);
        const writesBeforeRemove = harness.persistedWrites.length;
        const events: WorkspaceIndexInvalidation[] = [];
        harness.index.onDidInvalidate(event => events.push(event));

        await harness.index.removeUri(targetUri);

        assert.strictEqual(harness.index.getFile(targetUri), undefined);
        assert.strictEqual(harness.index.getFile(unreadableUri), undefined);
        assert.strictEqual(harness.index.findDefinitions('shared_target').length, 0);
        assert.strictEqual(harness.index.findDefinitions('unreadable_parent').length, 0);
        assert.strictEqual(harness.index.findDefinitions('readable_parent').length, 1);
        assert.strictEqual(harness.persistedWrites.length, writesBeforeRemove + 1);
        assert.strictEqual(events.length, 1);
        assert.deepStrictEqual(events[0].changedUris, [targetUri, unreadableUri]);
        assert.deepStrictEqual(
            events[0].affectedDocumentUris,
            [readableUri, targetUri, unreadableUri]
        );
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

async function testResolveRefreshesStalePersistedSummary(): Promise<void> {
    const uri = 'file:///ws/stale-resolve.sv';
    const harness = createWorkspaceIndexHarness({
        [uri]: 'module old_name(input logic old_i); endmodule',
    });
    const reloaded = harness.createIndex();
    try {
        await harness.index.scan(['file:///ws']);
        const oldSummary = harness.index.findDefinitions('old_name')[0];
        harness.files.set(uri, 'module new_name(output logic new_o); endmodule');

        await reloaded.load();
        const resolved = await reloaded.resolveDefinition(oldSummary.key);

        assert.strictEqual(resolved.summary.key, oldSummary.key);
        assert.strictEqual(resolved.summary.name, 'new_name');
        assert.notStrictEqual(resolved.summary.modelFingerprint, oldSummary.modelFingerprint);
        assert.strictEqual(resolved.module?.name, 'new_name');
        assert.deepStrictEqual(resolved.summary.ports.map(port => port.name), ['new_o']);
        assert.deepStrictEqual(resolved.module?.ports.map(port => port.name), ['new_o']);
    } finally {
        harness.index.dispose();
        reloaded.dispose();
        await harness.dispose();
    }
}

async function testIndexPrioritiesAndInteractiveQueuePrecedence(): Promise<void> {
    const harness = createWorkspaceIndexHarness({
        'file:///ws/a.sv': 'module background_a; endmodule',
        'file:///ws/b.sv': 'module background_b; endmodule',
        'file:///ws/c.sv': 'module background_c; endmodule',
    });
    const completionOrder: string[] = [];
    let interactive: Promise<void> | undefined;
    harness.hooks.onDispatch = call => {
        if (call.uri === 'file:///ws/a.sv' && interactive === undefined) {
            interactive = harness.index.parseOpenDocument(
                'file:///ws/interactive.sv',
                1,
                'module interactive; endmodule'
            ).then(() => { completionOrder.push('interactive'); });
        }
    };
    harness.hooks.afterParse = call => { completionOrder.push(call.uri); };
    try {
        await harness.index.scan(['file:///ws']);
        await interactive;
        assert.ok(harness.parserCalls.length > 0);
        assert.strictEqual(
            harness.parserCalls.find(call => call.uri === 'file:///ws/interactive.sv')?.priority,
            'interactive'
        );
        assert.ok(completionOrder.indexOf('interactive') > completionOrder.indexOf(
            'file:///ws/a.sv'
        ));
        assert.ok(completionOrder.indexOf('interactive') < completionOrder.indexOf(
            'file:///ws/b.sv'
        ));
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function testBackgroundDiskParsesDoNotCancelDirtyLiveParse(): Promise<void> {
    const uri = 'file:///ws/shared.sv';
    const diskText = 'module shared(input logic disk_i); endmodule';
    const harness = createWorkspaceIndexHarness({ [uri]: diskText });
    let dirtyLive: Promise<HdlDocument> | undefined;
    harness.hooks.onDispatch = call => {
        if (call.uri === uri && call.priority === 'background' && !dirtyLive) {
            dirtyLive = harness.index.parseOpenDocument(
                uri,
                2,
                'module shared(input logic dirty_i); endmodule'
            );
        }
    };
    try {
        const scan = harness.index.scan(['file:///ws']);
        await waitUntil(() => dirtyLive !== undefined, 'dirty live parse during scan');
        await Promise.all([scan, dirtyLive!]);

        const summary = harness.index.findDefinitions('shared')[0];
        const reloaded = harness.createIndex();
        try {
            await reloaded.load();
            dirtyLive = undefined;
            harness.hooks.onDispatch = call => {
                if (call.uri === uri && call.priority === 'background' && !dirtyLive) {
                    dirtyLive = reloaded.parseOpenDocument(
                        uri,
                        3,
                        'module shared(input logic newer_dirty_i); endmodule'
                    );
                }
            };
            const resolve = reloaded.resolveDefinition(summary.key);
            await waitUntil(() => dirtyLive !== undefined, 'dirty live parse during resolve');
            await Promise.all([resolve, dirtyLive!]);
        } finally {
            reloaded.dispose();
        }

        const sameUriCalls = harness.parserCalls.flatMap((call, index) =>
            call.uri === uri ? [{
                priority: call.priority,
                cacheMode: harness.parserOptions[index].cacheMode ?? 'document',
            }] : []
        );
        assert.deepStrictEqual(sameUriCalls, [
            { priority: 'background', cacheMode: 'ephemeral' },
            { priority: 'interactive', cacheMode: 'document' },
            { priority: 'background', cacheMode: 'ephemeral' },
            { priority: 'interactive', cacheMode: 'document' },
        ]);
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
    await testClearDoesNotResurrectLegacySnapshot();
    await testStoreWaitsForMementoUpdates();
    await testStagedWorkspaceSnapshotIsIgnoredByLoad();
    await testStoreNamespacesConcurrentRootSnapshots();
    await testDefinitionsExposeOneBasedDeclarationLines();
    await testCompositeDefinitionsUseTheirOriginalDeclarationLines();
    await testInitialScanDuplicatesAndRefresh();
    await testWorkspacePersistenceAndUnchangedCache();
    await testPersistenceIdentityIncludesDefines();
    await testLoadedUnchangedFilesUsePersistedFastPath();
    await testLoadedOwnerRefreshesWhenResolvedIncludeChanges();
    await testLoadedScanRefreshesWhenIncludeMappingChanges();
    await testFullScanRemovesMissingFilesOnlyWithinRoots();
    await testIncludeGraphTransitiveRefreshAndStructuralFingerprints();
    await testUnresolvedIncludeEdgesSurviveReloadAndRecreation();
    await testUnresolvedIncludeCandidateQueryIsReadOnly();
    await testExternalIncludeWatchPlanIsReadOnly();
    await testAbortIsAtomicAndDoesNotPersistOrInvalidate();
    await testAbortDuringSaveDoesNotCommitMemoryOrInvalidate();
    await testStageAbortIgnoresDiscardFailureAndKeepsCommittedSnapshot();
    await testAbortAfterFormalCommitPointCompletesConsistently();
    await testFormalSaveFailureDoesNotCommitMemory();
    await testInvalidationRemoveAndConfigurationBatches();
    await testRemoveContinuesPastUnreadableDependents();
    await testPersistedResolveUsesTheExactDefinitionKey();
    await testResolveRefreshesStalePersistedSummary();
    await testIndexPrioritiesAndInteractiveQueuePrecedence();
    await testBackgroundDiskParsesDoNotCancelDirtyLiveParse();

    console.log('HDL workspace index tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
