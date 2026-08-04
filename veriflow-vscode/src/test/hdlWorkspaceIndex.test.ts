import * as assert from 'assert';

import { WorkspaceIndexStore } from '../core/hdl/workspaceIndexStore';
import type { PersistedWorkspaceIndex } from '../core/hdl/workspaceIndexTypes';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';

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

async function main(): Promise<void> {
    await testRoundTripPersistence();
    await testLoadRejectsFingerprintMismatch();
    await testLoadRejectsSchemaMismatch();
    await testLoadRejectsMalformedCurrentSchema();
    await testClearRemovesPersistedIndex();
    await testStoreWaitsForMementoUpdates();
    await testDefinitionsExposeOneBasedDeclarationLines();
    await testCompositeDefinitionsUseTheirOriginalDeclarationLines();

    console.log('HDL workspace index tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
