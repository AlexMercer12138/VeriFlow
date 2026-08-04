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

async function testDefinitionsExposeZeroBasedDeclarationLines(): Promise<void> {
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

    assert.strictEqual(document.modules[0].declarationLine, 1);
    assert.strictEqual(document.interfaces[0].declarationLine, 4);
    assert.strictEqual(document.packages[0].declarationLine, 7);
}

async function main(): Promise<void> {
    await testRoundTripPersistence();
    await testLoadRejectsFingerprintMismatch();
    await testLoadRejectsSchemaMismatch();
    await testClearRemovesPersistedIndex();
    await testStoreWaitsForMementoUpdates();
    await testDefinitionsExposeZeroBasedDeclarationLines();

    console.log('HDL workspace index tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
