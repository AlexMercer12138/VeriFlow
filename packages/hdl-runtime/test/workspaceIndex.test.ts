import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeSourceUri } from '@veriflow/hdl-core/preprocessor';
import { HdlParserClient } from '@veriflow/hdl-runtime/parserClient';
import { WorkspaceHdlIndex } from '@veriflow/hdl-runtime/workspaceHdlIndex';
import { WorkspaceIndexStore } from '@veriflow/hdl-runtime/workspaceIndexStore';
import type { PersistedWorkspaceIndex } from '@veriflow/hdl-runtime/workspaceIndexTypes';

class MemoryState {
    readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, structuredClone(value));
        }
        return Promise.resolve();
    }
}

function createParser(): HdlParserClient {
    const packageRoot = path.resolve(__dirname, '..', '..');
    const workspaceRoot = path.resolve(packageRoot, '..', '..');
    return new HdlParserClient({
        workerPath: path.join(packageRoot, 'dist', 'parserWorker.js'),
        runtimeWasmPath: path.join(
            workspaceRoot,
            'veriflow-vscode',
            'media',
            'parsers',
            'web-tree-sitter.wasm'
        ),
        languageWasmPath: path.join(
            workspaceRoot,
            'veriflow-vscode',
            'media',
            'parsers',
            'tree-sitter-systemverilog.wasm'
        ),
    });
}

test('workspace index scans definitions, dependencies, and persisted snapshots', async () => {
    const root = 'file:///workspace';
    const topUri = canonicalizeSourceUri(`${root}/top.sv`);
    const childUri = canonicalizeSourceUri(`${root}/child.sv`);
    const files = new Map<string, string>([
        [topUri, 'module top; child u_child(); endmodule\n'],
        [childUri, 'module child; endmodule\n'],
    ]);
    const state = new MemoryState();
    const parser = createParser();
    const makeIndex = (): WorkspaceHdlIndex => new WorkspaceHdlIndex({
        parser,
        store: new WorkspaceIndexStore(state),
        parserFingerprint: 'runtime-package-test',
        defines: {},
        findFiles: async () => [...files.keys()],
        readFile: async uri => {
            const text = files.get(canonicalizeSourceUri(uri));
            if (text === undefined) {
                throw new Error(`missing fixture ${uri}`);
            }
            return { text, version: 1, mtimeMs: 1, size: Buffer.byteLength(text) };
        },
        includeCandidates: () => [],
        resolveInclude: async () => undefined,
    });
    const index = makeIndex();

    try {
        await index.scan([root]);
        const top = index.findDefinitions('top', 'module');
        const child = index.findDefinitions('child', 'module');

        assert.equal(top.length, 1);
        assert.equal(child.length, 1);
        assert.deepEqual(top[0].dependencies, ['child']);
        assert.equal(index.getFile(topUri)?.definitions[0].key, top[0].key);

        const reloaded = makeIndex();
        await reloaded.load();
        assert.deepEqual(
            reloaded.getAllDefinitions('module').map(definition => definition.name).sort(),
            ['child', 'top']
        );
        reloaded.dispose();
    } finally {
        index.dispose();
        await parser.dispose();
    }
});

test('workspace store rejects malformed current-schema snapshots', async () => {
    const state = new MemoryState();
    const store = new WorkspaceIndexStore(state);
    const valid: PersistedWorkspaceIndex = {
        schemaVersion: 1,
        parserFingerprint: 'parser-v1',
        files: [],
    };

    await store.save(valid);
    assert.deepEqual(store.load('parser-v1'), valid);

    for (const key of state.values.keys()) {
        state.values.set(key, { ...valid, files: [{ uri: 42 }] });
    }
    assert.equal(new WorkspaceIndexStore(state).load('parser-v1'), undefined);
});
