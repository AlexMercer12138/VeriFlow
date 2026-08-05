import * as assert from 'assert';
import Module = require('module');
import * as path from 'path';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';

function withModuleStubs<T>(stubs: Record<string, unknown>, load: () => T): T {
    const loader = Module as typeof Module & {
        _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    };
    const originalLoad = loader._load;
    loader._load = function loadWithStubs(
        request: string,
        parent: NodeModule | undefined,
        isMain: boolean
    ): unknown {
        if (Object.prototype.hasOwnProperty.call(stubs, request)) {
            return stubs[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return load();
    } finally {
        loader._load = originalLoad;
    }
}

function definition(
    key: string,
    name: string,
    uri: string,
    declarationLine: number,
    modelFingerprint: string
): HdlDefinitionSummary {
    return {
        key,
        kind: 'module',
        name,
        uri,
        declarationStart: declarationLine * 10,
        declarationLine,
        parameters: [{ name: 'WIDTH', defaultExpression: '8' }],
        ports: [{
            name: 'data_i',
            direction: 'input',
            packedRange: '[WIDTH-1:0]',
            width: { kind: 'symbolic', expression: 'WIDTH' },
        }],
        dependencies: [],
        modelFingerprint,
    };
}

type FakeIndex = {
    definitions: HdlDefinitionSummary[];
    getAllDefinitions(kind?: string): HdlDefinitionSummary[];
    getDefinition(key: string): HdlDefinitionSummary | undefined;
};

function indexOf(definitions: HdlDefinitionSummary[]): FakeIndex {
    return {
        definitions,
        getAllDefinitions(kind?: string): HdlDefinitionSummary[] {
            return kind && kind !== 'module' ? [] : [...this.definitions];
        },
        getDefinition(key: string): HdlDefinitionSummary | undefined {
            return this.definitions.find(item => item.key === key);
        },
    };
}

type PostedMessage = { type: string; [key: string]: any };

function createHarness(initialDefinitions: HdlDefinitionSummary[]) {
    const posted: PostedMessage[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const generatedConfigs: any[] = [];
    let currentIndex: FakeIndex | undefined = indexOf(initialDefinitions);
    let receiveMessage: ((message: any) => Promise<void> | void) | undefined;
    let disposeView: (() => void) | undefined;
    const disposable = { dispose(): void {} };
    const webview = {
        options: {},
        html: '',
        postMessage(message: PostedMessage): Promise<boolean> {
            posted.push(message);
            return Promise.resolve(true);
        },
        onDidReceiveMessage(listener: (message: any) => Promise<void> | void) {
            receiveMessage = listener;
            return disposable;
        },
    };
    const view = {
        visible: true,
        webview,
        onDidChangeVisibility(): typeof disposable { return disposable; },
        onDidDispose(listener: () => void): typeof disposable {
            disposeView = listener;
            return disposable;
        },
    };
    class FakeGenerator {
        generate(config: any, outputDir: string): string {
            generatedConfigs.push(config);
            return path.join(outputDir, `${config.name}.v`);
        }
    }
    const vscodeStub = {
        Uri: { file: (filepath: string) => ({ fsPath: filepath }) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: path.join('C:', 'workspace') } }],
            openTextDocument: async (uri: unknown) => uri,
        },
        window: {
            showWarningMessage(message: string): void { warnings.push(message); },
            showErrorMessage(message: string): void { errors.push(message); },
            showInformationMessage(): void {},
            showTextDocument: async (): Promise<void> => undefined,
        },
    };
    delete require.cache[require.resolve('../testbenchPanel')];
    const panelModule = withModuleStubs({
        vscode: vscodeStub,
        '../core/testbenchGenerator': undefined,
        './core/testbenchGenerator': { TestbenchGenerator: FakeGenerator },
        './config': { getSettings: () => ({ testbenchOutputDir: '.' }) },
    }, () => require('../testbenchPanel') as {
        TestbenchPanelProvider: new (
            context: unknown,
            getIndex: () => FakeIndex | undefined
        ) => {
            resolveWebviewView(view: unknown, context: unknown, token: unknown): void;
            refreshModules(): void;
            dispose(): void;
        };
    });
    const provider = new panelModule.TestbenchPanelProvider(
        { extensionUri: { value: 'file:///extension' } },
        () => currentIndex
    );
    provider.resolveWebviewView(view, {}, {});
    return {
        provider,
        posted,
        warnings,
        errors,
        generatedConfigs,
        setIndex(index: FakeIndex | undefined): void { currentIndex = index; },
        async send(message: any): Promise<void> {
            assert.ok(receiveMessage, 'webview message listener was registered');
            await receiveMessage!(message);
        },
        disposeView(): void { disposeView?.(); },
    };
}

function latest(messages: PostedMessage[], type: string): PostedMessage {
    const match = [...messages].reverse().find(message => message.type === type);
    assert.ok(match, `expected a ${type} message`);
    return match;
}

async function testExactChoicesAndResolvedAdd(): Promise<void> {
    const definitions = [
        definition('a', 'alu', 'file:///C:/workspace/rtl/alu.sv', 4, 'fp-a'),
        definition('b', 'alu', 'file:///C:/workspace/ip/alu.sv', 8, 'fp-b'),
        definition('c', 'alu', 'file:///C:/workspace/ip/alu.sv', 19, 'fp-c'),
        definition('remote', '\\remote.core ', 'vscode-remote://ssh-remote+lab/work/core.sv', 2, 'fp-r'),
    ];
    const harness = createHarness(definitions);

    await harness.send({ type: 'getModules' });
    const modules = latest(harness.posted, 'modules').modules as Array<{
        label: string;
        description: string;
        definitionKey: string;
    }>;
    assert.deepStrictEqual(
        modules.map(item => item.definitionKey).sort(),
        ['a', 'b', 'c', 'remote']
    );
    assert.ok(modules.find(item => item.definitionKey === 'a')?.description.includes('rtl/alu.sv'));
    assert.ok(modules.find(item => item.definitionKey === 'b')?.description.endsWith(':8'));
    assert.ok(modules.find(item => item.definitionKey === 'c')?.description.endsWith(':19'));
    assert.strictEqual(
        modules.find(item => item.definitionKey === 'remote')?.description,
        'vscode-remote://ssh-remote+lab/work/core.sv'
    );

    await harness.send({ type: 'addModule', definitionKey: 'b' });
    const localEntry = latest(harness.posted, 'moduleAdded').entry;
    assert.strictEqual(localEntry.definitionKey, 'b');
    assert.strictEqual(localEntry.modelFingerprint, 'fp-b');
    assert.strictEqual(localEntry.verilogModuleName, 'alu');
    assert.deepStrictEqual(localEntry.ports.map((port: any) => port.name), ['data_i']);
    assert.deepStrictEqual(localEntry.params.map((parameter: any) => parameter.name), ['WIDTH']);

    await harness.send({ type: 'addModule', definitionKey: 'remote' });
    const remoteEntry = latest(harness.posted, 'moduleAdded').entry;
    assert.strictEqual(remoteEntry.definitionKey, 'remote');
    assert.strictEqual(remoteEntry.instanceName, 'u_remote_core');
    assert.strictEqual(remoteEntry.filepath, 'vscode-remote://ssh-remote+lab/work/core.sv');
}

async function testLiveResolutionAndFingerprintRejection(): Promise<void> {
    const original = definition('selected', 'alu', 'file:///C:/workspace/rtl/alu.sv', 4, 'fp-1');
    const duplicate = definition('duplicate', 'alu', 'file:///C:/workspace/ip/alu.sv', 1, 'fp-other');
    const harness = createHarness([original, duplicate]);
    await harness.send({ type: 'addModule', definitionKey: original.key });
    await harness.send({ type: 'updatePortSignal', index: 0, portName: 'data_i', value: 'payload' });
    await harness.send({ type: 'updateParamValue', index: 0, paramName: 'WIDTH', value: '16' });

    harness.setIndex(indexOf([{ ...original }, duplicate]));
    harness.provider.refreshModules();
    await harness.send({ type: 'generate', config: { name: 'tb_live' } });
    assert.strictEqual(harness.generatedConfigs.length, 1);
    assert.strictEqual(harness.generatedConfigs[0].modules[0].definitionKey, original.key);
    assert.strictEqual(harness.generatedConfigs[0].modules[0].port_signals.data_i, 'payload');
    assert.strictEqual(harness.generatedConfigs[0].modules[0].param_values.WIDTH, '16');
    assert.strictEqual(harness.generatedConfigs[0].modules[0].filepath, undefined);

    harness.setIndex(indexOf([{ ...original, modelFingerprint: 'fp-2' }, duplicate]));
    harness.provider.refreshModules();
    const changed = latest(harness.posted, 'moduleValidity');
    assert.match(changed.entries[0].error, /changed/i);
    await harness.send({ type: 'generate', config: { name: 'tb_changed' } });
    assert.strictEqual(harness.generatedConfigs.length, 1);
    assert.match(latest(harness.posted, 'error').message, /changed/i);

    harness.setIndex(indexOf([duplicate]));
    harness.provider.refreshModules();
    const missing = latest(harness.posted, 'moduleValidity');
    assert.match(missing.entries[0].error, /no longer available/i);
    await harness.send({ type: 'generate', config: { name: 'tb_missing' } });
    assert.strictEqual(harness.generatedConfigs.length, 1);
    assert.match(latest(harness.posted, 'error').message, /no longer available/i);
}

async function testDisposedPanelIgnoresOldMessages(): Promise<void> {
    const item = definition('selected', 'alu', 'file:///C:/workspace/rtl/alu.sv', 4, 'fp-1');
    const harness = createHarness([item]);
    const postsBeforeDispose = harness.posted.length;
    harness.provider.dispose();
    await harness.send({ type: 'addModule', definitionKey: item.key });
    await harness.send({ type: 'generate', config: { name: 'tb_stale' } });
    assert.strictEqual(harness.posted.length, postsBeforeDispose);
    assert.strictEqual(harness.generatedConfigs.length, 0);
    assert.deepStrictEqual(harness.warnings, []);
    assert.deepStrictEqual(harness.errors, []);
}

async function main(): Promise<void> {
    await testExactChoicesAndResolvedAdd();
    await testLiveResolutionAndFingerprintRejection();
    await testDisposedPanelIgnoresOldMessages();
    console.log('testbench panel tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
