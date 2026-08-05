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
    const disposable = { dispose(): void {} };
    type HarnessView = {
        posted: PostedMessage[];
        receiveMessage?: (message: any) => Promise<void> | void;
        disposeView?: () => void;
        view: any;
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
    const resolveView = (): HarnessView => {
        const state: HarnessView = { posted: [], view: undefined };
        const webview = {
            options: {},
            html: '',
            postMessage(message: PostedMessage): Promise<boolean> {
                state.posted.push(message);
                posted.push(message);
                return Promise.resolve(true);
            },
            onDidReceiveMessage(listener: (message: any) => Promise<void> | void) {
                state.receiveMessage = listener;
                return disposable;
            },
        };
        state.view = {
            visible: true,
            webview,
            onDidChangeVisibility(): typeof disposable { return disposable; },
            onDidDispose(listener: () => void): typeof disposable {
                state.disposeView = listener;
                return disposable;
            },
        };
        provider.resolveWebviewView(state.view, {}, {});
        return state;
    };
    let currentView = resolveView();
    return {
        provider,
        posted,
        warnings,
        errors,
        generatedConfigs,
        setIndex(index: FakeIndex | undefined): void { currentIndex = index; },
        get view() { return currentView; },
        resolveView(): HarnessView {
            currentView = resolveView();
            return currentView;
        },
        async send(message: any, target: HarnessView = currentView): Promise<void> {
            assert.ok(target.receiveMessage, 'webview message listener was registered');
            await target.receiveMessage!(message);
        },
        disposeView(target: HarnessView = currentView): void { target.disposeView?.(); },
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
    const changed = latest(harness.posted, 'syncEntries');
    assert.match(changed.entries[0].invalidReason, /changed/i);
    await harness.send({ type: 'generate', config: { name: 'tb_changed' } });
    assert.strictEqual(harness.generatedConfigs.length, 1);
    assert.match(latest(harness.posted, 'error').message, /changed/i);

    harness.setIndex(indexOf([duplicate]));
    harness.provider.refreshModules();
    const missing = latest(harness.posted, 'syncEntries');
    assert.match(missing.entries[0].invalidReason, /no longer available/i);
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

async function testReresolvedViewHydratesEntriesBeforeEditing(): Promise<void> {
    const a = definition('a', 'unit_a', 'file:///C:/workspace/a.sv', 1, 'fp-a');
    const b = definition('b', 'unit_b', 'file:///C:/workspace/b.sv', 1, 'fp-b');
    const harness = createHarness([a, b]);
    const firstView = harness.view;
    await harness.send({ type: 'addModule', definitionKey: a.key });
    await harness.send({
        type: 'updatePortSignal',
        index: 0,
        portName: 'data_i',
        value: 'a_payload',
    });
    await harness.send({
        type: 'updateParamValue',
        index: 0,
        paramName: 'WIDTH',
        value: '12',
    });

    harness.disposeView(firstView);
    const secondView = harness.resolveView();
    await harness.send({ type: 'getModules' }, secondView);
    assert.deepStrictEqual(
        secondView.posted.slice(-2).map(message => message.type),
        ['modules', 'syncEntries']
    );
    const snapshot = latest(secondView.posted, 'syncEntries');
    assert.strictEqual(snapshot.entries.length, 1);
    assert.strictEqual(snapshot.entries[0].definitionKey, a.key);
    assert.strictEqual(snapshot.entries[0].portSignalOverrides.data_i, 'a_payload');
    assert.strictEqual(snapshot.entries[0].paramValueOverrides.WIDTH, '12');
    assert.strictEqual(snapshot.entries[0].invalidReason, undefined);

    await harness.send({ type: 'addModule', definitionKey: b.key }, firstView);
    await harness.send({ type: 'addModule', definitionKey: b.key }, secondView);
    assert.strictEqual(latest(secondView.posted, 'moduleAdded').index, 1);
    await harness.send({
        type: 'updatePortSignal',
        index: 1,
        portName: 'data_i',
        value: 'b_payload',
    }, secondView);
    await harness.send({ type: 'generate', config: { name: 'tb_hydrated' } }, secondView);

    const generated = harness.generatedConfigs.at(-1);
    assert.deepStrictEqual(
        generated.modules.map((moduleConfig: any) => moduleConfig.definitionKey),
        [a.key, b.key]
    );
    assert.strictEqual(generated.modules[0].port_signals.data_i, 'a_payload');
    assert.strictEqual(generated.modules[1].port_signals.data_i, 'b_payload');
}

async function testPanelOverridesArePrototypeSafe(): Promise<void> {
    const special = definition(
        'special',
        'prototype_ports',
        'file:///C:/workspace/prototype_ports.sv',
        1,
        'fp-special'
    );
    special.parameters = [
        { name: '__proto__', defaultExpression: 'P_PROTO' },
        { name: 'constructor', defaultExpression: 'P_CTOR' },
        { name: 'toString', defaultExpression: 'P_STRING' },
    ];
    special.ports = ['__proto__', 'constructor', 'toString'].map(name => ({
        name,
        direction: 'input' as const,
        width: { kind: 'known' as const, bits: 1 },
    }));
    const harness = createHarness([special]);
    await harness.send({ type: 'addModule', definitionKey: special.key });
    await harness.send({
        type: 'updatePortSignal',
        index: 0,
        portName: '__proto__',
        value: 'sig_proto',
    });
    await harness.send({
        type: 'updateParamValue',
        index: 0,
        paramName: '__proto__',
        value: 'value_proto',
    });
    for (const name of ['constructor', 'toString']) {
        await harness.send({
            type: 'updatePortSignal',
            index: 0,
            portName: name,
            value: `sig_${name}`,
        });
        await harness.send({
            type: 'updateParamValue',
            index: 0,
            paramName: name,
            value: `value_${name}`,
        });
    }
    await harness.send({
        type: 'updatePortSignal',
        index: 0,
        portName: 'not_a_port',
        value: 'untrusted',
    });
    await harness.send({
        type: 'updatePortSignal',
        index: 0,
        portName: '__proto__',
        value: 42,
    });

    harness.provider.refreshModules();
    const synced = latest(harness.posted, 'syncEntries').entries[0];
    for (const name of ['__proto__', 'constructor', 'toString']) {
        assert.ok(Object.prototype.hasOwnProperty.call(synced.portSignalOverrides, name));
        assert.ok(Object.prototype.hasOwnProperty.call(synced.paramValueOverrides, name));
    }
    assert.ok(!Object.prototype.hasOwnProperty.call(
        synced.portSignalOverrides,
        'not_a_port'
    ));

    await harness.send({ type: 'generate', config: { name: 'tb_special_keys' } });
    const moduleConfig = harness.generatedConfigs.at(-1).modules[0];
    assert.strictEqual(moduleConfig.port_signals.__proto__, 'sig_proto');
    assert.strictEqual(moduleConfig.param_values.__proto__, 'value_proto');
    assert.ok(Object.prototype.hasOwnProperty.call(moduleConfig.port_signals, '__proto__'));
    assert.ok(Object.prototype.hasOwnProperty.call(moduleConfig.param_values, '__proto__'));
    const html = harness.view.view.webview.html as string;
    assert.ok(html.includes('hasOwn(entry.paramValueOverrides, p.name)'));
    assert.ok(html.includes('hasOwn(entry.portSignalOverrides, p.name)'));
    assert.match(
        html,
        /case 'moduleAdded':[\s\S]*renderModuleDetail\(moduleEntries\[selectedModuleIndex\], selectedModuleIndex\)/
    );
}

async function testDefaultInstanceNamesStayUnique(): Promise<void> {
    const plain = definition('plain', 'plain', 'file:///C:/workspace/plain.sv', 1, 'fp-p');
    const harness = createHarness([plain]);
    await harness.send({ type: 'addModule', definitionKey: plain.key });
    assert.strictEqual(latest(harness.posted, 'moduleAdded').entry.instanceName, 'u_plain');
    await harness.send({ type: 'addModule', definitionKey: plain.key });
    assert.strictEqual(latest(harness.posted, 'moduleAdded').entry.instanceName, 'u_plain_1');
    await harness.send({ type: 'removeModule', index: 0 });
    await harness.send({ type: 'addModule', definitionKey: plain.key });
    assert.strictEqual(latest(harness.posted, 'moduleAdded').entry.instanceName, 'u_plain');

    const dotted = definition(
        'dotted',
        '\\foo.bar ',
        'file:///C:/workspace/dotted.sv',
        1,
        'fp-dotted'
    );
    const dashed = definition(
        'dashed',
        '\\foo-bar ',
        'file:///C:/workspace/dashed.sv',
        1,
        'fp-dashed'
    );
    const escapedHarness = createHarness([dotted, dashed]);
    await escapedHarness.send({ type: 'addModule', definitionKey: dotted.key });
    await escapedHarness.send({ type: 'addModule', definitionKey: dashed.key });
    const escapedNames = escapedHarness.posted
        .filter(message => message.type === 'moduleAdded')
        .map(message => message.entry.instanceName);
    assert.deepStrictEqual(escapedNames, ['u_foo_bar', 'u_foo_bar_1']);
}

async function testGenerateRejectsDuplicateInstanceNames(): Promise<void> {
    const a = definition('a', 'unit_a', 'file:///C:/workspace/a.sv', 1, 'fp-a');
    const b = definition('b', 'unit_b', 'file:///C:/workspace/b.sv', 1, 'fp-b');
    const harness = createHarness([a, b]);
    await harness.send({ type: 'addModule', definitionKey: a.key });
    await harness.send({ type: 'addModule', definitionKey: b.key });
    await harness.send({
        type: 'updateInstanceName',
        index: 1,
        value: 'u_unit_a',
    });
    await harness.send({ type: 'generate', config: { name: 'tb_duplicate_instances' } });
    assert.strictEqual(harness.generatedConfigs.length, 0);
    assert.match(latest(harness.posted, 'error').message, /instance name.*unique/i);
}

async function testGenerateRejectsEmptyNameDefaultCollision(): Promise<void> {
    const unit = definition('unit', 'unit_a', 'file:///C:/workspace/unit_a.sv', 1, 'fp-a');
    const harness = createHarness([unit]);
    await harness.send({ type: 'addModule', definitionKey: unit.key });
    await harness.send({ type: 'addModule', definitionKey: unit.key });
    await harness.send({
        type: 'updateInstanceName',
        index: 1,
        value: '',
    });

    await harness.send({ type: 'generate', config: { name: 'tb_default_collision' } });

    assert.strictEqual(harness.generatedConfigs.length, 0);
    assert.match(latest(harness.posted, 'error').message, /instance name.*unique/i);
}

async function testGenerateResolvesEmptyInstanceNameToDefault(): Promise<void> {
    const unit = definition('unit', 'unit_a', 'file:///C:/workspace/unit_a.sv', 1, 'fp-a');
    const harness = createHarness([unit]);
    await harness.send({ type: 'addModule', definitionKey: unit.key });
    await harness.send({
        type: 'updateInstanceName',
        index: 0,
        value: '',
    });

    await harness.send({ type: 'generate', config: { name: 'tb_default_instance' } });

    assert.strictEqual(
        harness.generatedConfigs.at(-1).modules[0].instance_name,
        'u_unit_a'
    );
}

async function testGeneratePreservesDefaultsForEmptyConfigValues(): Promise<void> {
    const item = definition('item', 'item', 'file:///C:/workspace/item.sv', 1, 'fp-item');
    const harness = createHarness([item]);
    await harness.send({ type: 'addModule', definitionKey: item.key });
    await harness.send({
        type: 'generate',
        config: {
            name: 'tb_defaults',
            time_unit: '',
            time_precision: '',
            reset_duration: '',
            wave_file: '',
            timeout: '',
        },
    });

    const generated = harness.generatedConfigs.at(-1);
    assert.strictEqual(generated.time_unit, '1ns');
    assert.strictEqual(generated.time_precision, '1ps');
    assert.strictEqual(generated.reset_duration, '100');
    assert.strictEqual(generated.wave_file, 'tb_defaults.vcd');
    assert.strictEqual(generated.timeout, '1000000');
}

async function testMalformedWebviewMessagesHaveNoSideEffects(): Promise<void> {
    const item = definition('item', 'item', 'file:///C:/workspace/item.sv', 1, 'fp-item');
    const harness = createHarness([item]);
    await harness.send({ type: 'addModule', definitionKey: item.key });
    await harness.send({ type: 'removeModule', index: '0' });
    harness.provider.refreshModules();
    assert.strictEqual(latest(harness.posted, 'syncEntries').entries.length, 1);

    const generatedBefore = harness.generatedConfigs.length;
    await harness.send({ type: 'generate', config: null });
    assert.strictEqual(harness.generatedConfigs.length, generatedBefore);
    assert.match(latest(harness.posted, 'error').message, /invalid testbench request/i);
    await harness.send(null);
    assert.strictEqual(harness.generatedConfigs.length, generatedBefore);
}

async function main(): Promise<void> {
    await testExactChoicesAndResolvedAdd();
    await testLiveResolutionAndFingerprintRejection();
    await testDisposedPanelIgnoresOldMessages();
    await testReresolvedViewHydratesEntriesBeforeEditing();
    await testPanelOverridesArePrototypeSafe();
    await testDefaultInstanceNamesStayUnique();
    await testGenerateRejectsDuplicateInstanceNames();
    await testGenerateResolvesEmptyInstanceNameToDefault();
    await testGenerateRejectsEmptyNameDefaultCollision();
    await testGeneratePreservesDefaultsForEmptyConfigValues();
    await testMalformedWebviewMessagesHaveNoSideEffects();
    console.log('testbench panel tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
