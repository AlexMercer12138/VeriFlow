import * as assert from 'assert';

import {
    WorkspaceInterfaceProtocolLoader,
    type InterfaceProtocolLoaderHost,
} from '../archDesign/interfaceProtocolLoader';

type FileEntry = string | Error;

function protocol(id: string, defaultExpression: string): string {
    return JSON.stringify({
        format: 'veriflow-interface-protocol',
        schemaVersion: 1,
        id,
        name: 'Workspace Link',
        separator: '_',
        priority: 90,
        members: [
            {
                name: 'data',
                direction: 'master-to-slave',
                default: defaultExpression,
            },
            { name: 'ready', direction: 'slave-to-master' },
        ],
        recognitionGroups: [['data', 'ready']],
    });
}

function createHost(files: Map<string, FileEntry>): {
    host: InterfaceProtocolLoaderHost;
    fire(uri: string): void;
    watched(): string[];
} {
    const watchers = new Map<string, Set<() => void>>();
    return {
        host: {
            workspaceFolder(uri: string) {
                return uri.startsWith('vscode-remote://wsl/workspace/')
                    ? 'vscode-remote://wsl/workspace'
                    : undefined;
            },
            resolve(base: string, relative: string) {
                return new URL(relative, base.endsWith('/') ? base : `${base}/`).toString();
            },
            async readFile(uri: string) {
                const value = files.get(uri);
                if (value === undefined) {
                    const error = new Error(`missing: ${uri}`);
                    Object.assign(error, { code: 'FileNotFound' });
                    throw error;
                }
                if (value instanceof Error) throw value;
                return value;
            },
            watch(uri: string, listener: () => void) {
                const listeners = watchers.get(uri) ?? new Set<() => void>();
                listeners.add(listener);
                watchers.set(uri, listeners);
                return {
                    dispose(): void {
                        listeners.delete(listener);
                    },
                };
            },
        },
        fire(uri): void {
            for (const listener of watchers.get(uri) ?? []) listener();
        },
        watched(): string[] {
            return [...watchers.entries()]
                .filter(([, listeners]) => listeners.size > 0)
                .map(([uri]) => uri)
                .sort();
        },
    };
}

async function testBuiltinsAndWorkspaceOverride(): Promise<void> {
    const projectUri = 'vscode-remote://wsl/workspace/project.json';
    const protocolUri = 'vscode-remote://wsl/workspace/protocols/axi.json';
    const files = new Map<string, FileEntry>([
        [projectUri, JSON.stringify({
            schematic: { interface_protocols: ['protocols/axi.json'] },
        })],
        [protocolUri, protocol('amba.axi4', "4'ha")],
    ]);
    const harness = createHost(files);
    const loader = new WorkspaceInterfaceProtocolLoader(harness.host);
    const changes: number[] = [];
    loader.onDidInvalidate((generation: number) => changes.push(generation));

    const loaded = await loader.load('vscode-remote://wsl/workspace/design/soc.ad');

    assert.strictEqual(loaded.generation, 0);
    assert.deepStrictEqual(loaded.diagnostics, []);
    assert.strictEqual(loaded.catalog.entries.length, 4);
    const axi = loaded.catalog.entries.find(
        (entry: { protocol: { id: string } }) => entry.protocol.id === 'amba.axi4'
    );
    assert.strictEqual(axi?.source.kind, 'project');
    assert.strictEqual(axi?.source.source, protocolUri);
    assert.strictEqual(axi?.protocol.members[0].defaultExpression, "4'ha");
    assert.deepStrictEqual(harness.watched(), [projectUri, protocolUri]);

    harness.fire(protocolUri);
    assert.deepStrictEqual(changes, [1]);
    const refreshed = await loader.load('vscode-remote://wsl/workspace/design/soc.ad');
    assert.strictEqual(refreshed.generation, 1);
    loader.dispose();
    assert.deepStrictEqual(harness.watched(), []);
}

async function testPathAwareDiagnosticsAndCreateRefresh(): Promise<void> {
    const projectUri = 'vscode-remote://wsl/workspace/project.json';
    const missingUri = 'vscode-remote://wsl/workspace/protocols/missing.json';
    const files = new Map<string, FileEntry>([
        [projectUri, JSON.stringify({
            schematic: { interface_protocols: ['protocols/missing.json'] },
        })],
    ]);
    const harness = createHost(files);
    const loader = new WorkspaceInterfaceProtocolLoader(harness.host);
    let invalidations = 0;
    loader.onDidInvalidate(() => { invalidations += 1; });

    const missing = await loader.load('vscode-remote://wsl/workspace/soc.ad');
    assert.deepStrictEqual(missing.diagnostics, [{
        source: missingUri,
        path: '$',
        code: 'IF_PROTOCOL_FILE_NOT_FOUND',
        message: 'Interface protocol file not found',
    }]);
    assert.ok(harness.watched().includes(missingUri));

    files.set(missingUri, '{');
    harness.fire(missingUri);
    const invalid = await loader.load('vscode-remote://wsl/workspace/soc.ad');
    assert.strictEqual(invalidations, 1);
    assert.strictEqual(invalid.diagnostics[0].source, missingUri);
    assert.strictEqual(invalid.diagnostics[0].path, '$');
    assert.strictEqual(invalid.diagnostics[0].code, 'IF_PROTOCOL_JSON_SYNTAX');
    loader.dispose();
}

async function main(): Promise<void> {
    await testBuiltinsAndWorkspaceOverride();
    await testPathAwareDiagnosticsAndCreateRefresh();
    console.log('Interface protocol loader tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
