import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Module = require('module');

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';

function withModuleStubs<T>(stubs: Record<string, unknown>, load: () => T): T {
    const moduleLoader = Module as typeof Module & {
        _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function loadWithStubs(
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
        moduleLoader._load = originalLoad;
    }
}

type FakeIndex = {
    getAllDefinitions(kind: 'module'): HdlDefinitionSummary[];
    getDefinition(key: string): HdlDefinitionSummary | undefined;
};

type InstantiationCommand = {
    showModuleInstantiationPicker(
        getIndex: () => FakeIndex | undefined,
        isCurrent?: () => boolean,
        workspaceRoot?: string
    ): Promise<void>;
};

function moduleDefinition(
    root: string,
    relativePath: string,
    name: string,
    declarationStart: number,
    parameters: HdlDefinitionSummary['parameters'] = [],
    ports: HdlDefinitionSummary['ports'] = []
): HdlDefinitionSummary {
    const uri = pathToFileURL(path.join(root, relativePath)).toString();
    return {
        key: `module:${uri}:${declarationStart}`,
        kind: 'module',
        name,
        uri,
        declarationStart,
        declarationLine: 1,
        parameters,
        ports,
        dependencies: [],
        modelFingerprint: `sha256:${relativePath}`,
    };
}

function fakeIndex(definitions: HdlDefinitionSummary[]): FakeIndex {
    const byKey = new Map(definitions.map(definition => [definition.key, definition]));
    return {
        getAllDefinitions(kind: 'module'): HdlDefinitionSummary[] {
            assert.strictEqual(kind, 'module');
            return [...definitions];
        },
        getDefinition(key: string): HdlDefinitionSummary | undefined {
            return byKey.get(key);
        },
    };
}

function loadCommand(vscodeStub: unknown, adapterDefinitions: HdlDefinitionSummary[]): InstantiationCommand {
    const choices = require('../core/moduleInstantiationChoices') as typeof import('../core/moduleInstantiationChoices');
    const formatter = require('../core/moduleInstantiationFormatter') as typeof import('../core/moduleInstantiationFormatter');
    const adapter = require('../core/hdl/legacyModelAdapter') as typeof import('../core/hdl/legacyModelAdapter');
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
    return withModuleStubs(
        {
            vscode: vscodeStub,
            './core': {
                buildModuleInstantiationChoices: choices.buildModuleInstantiationChoices,
                formatModuleInstantiation: formatter.formatModuleInstantiation,
                toModuleInfo(definition: HdlDefinitionSummary) {
                    adapterDefinitions.push(definition);
                    return adapter.toModuleInfo(definition);
                },
            },
        },
        () => require('../moduleInstantiationCommand') as InstantiationCommand
    );
}

async function testExactIndexedDefinitionCopiesGoldenText(): Promise<void> {
    const root = path.join(process.cwd(), 'workspace');
    const workspaceAlu = moduleDefinition(root, 'rtl/alu.sv', 'alu', 0, [
        { name: 'WIDTH', defaultExpression: '8' },
    ], [
        { name: 'clk', direction: 'input', width: { kind: 'known', bits: 1 } },
    ]);
    const vendorAlu = moduleDefinition(root, 'vendor/alu.v', 'alu', 12, [
        { name: 'VENDOR_WIDTH', defaultExpression: '4' },
    ], [
        {
            name: 'vendor_data',
            direction: 'input',
            packedRange: '[VENDOR_WIDTH-1:0]',
            width: { kind: 'symbolic', expression: 'VENDOR_WIDTH' },
        },
    ]);
    const index = fakeIndex([vendorAlu, workspaceAlu]);
    let copiedText = '';
    let informationMessages = 0;
    let quickPickCalls = 0;
    const adapterDefinitions: HdlDefinitionSummary[] = [];
    const vscodeStub = {
        window: {
            async showQuickPick(items: Array<{ definitionKey?: string }>): Promise<unknown> {
                quickPickCalls++;
                return quickPickCalls === 1
                    ? items.find(item => item.definitionKey === vendorAlu.key)
                    : { label: 'Copy', action: 'copy' };
            },
            showWarningMessage(): void {},
            showErrorMessage(): void {},
            showInformationMessage(): void { informationMessages++; },
            activeTextEditor: undefined,
        },
        env: {
            clipboard: {
                async writeText(value: string): Promise<void> { copiedText = value; },
            },
        },
    };
    const command = loadCommand(vscodeStub, adapterDefinitions);

    await command.showModuleInstantiationPicker(() => index, () => true, root);

    assert.deepStrictEqual(adapterDefinitions, [vendorAlu]);
    assert.strictEqual(copiedText, [
        'alu #(',
        '    .VENDOR_WIDTH ( 4 ))',
        'u_alu (',
        '    .vendor_data ( vendor_data ));',
    ].join('\n'));
    assert.strictEqual(informationMessages, 1);
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
}

async function testDeferredModulePickerRejectsReplacementAndDeactivation(): Promise<void> {
    for (const invalidation of ['replacement', 'deactivation'] as const) {
        const root = path.join(process.cwd(), 'workspace');
        const definition = moduleDefinition(root, 'rtl/child.sv', 'child', 0);
        const initialIndex = fakeIndex([definition]);
        const replacementIndex = fakeIndex([definition]);
        let currentIndex: FakeIndex | undefined = initialIndex;
        let lifecycleCurrent = true;
        let releasePicker!: () => void;
        let pickerStarted!: () => void;
        const started = new Promise<void>(resolve => { pickerStarted = resolve; });
        const release = new Promise<void>(resolve => { releasePicker = resolve; });
        let quickPickCalls = 0;
        let clipboardWrites = 0;
        const adapterDefinitions: HdlDefinitionSummary[] = [];
        const vscodeStub = {
            window: {
                async showQuickPick(items: unknown[]): Promise<unknown> {
                    quickPickCalls++;
                    pickerStarted();
                    await release;
                    return items[0];
                },
                showWarningMessage(): void {},
                showErrorMessage(): void {},
                showInformationMessage(): void {},
                activeTextEditor: undefined,
            },
            env: {
                clipboard: {
                    async writeText(): Promise<void> { clipboardWrites++; },
                },
            },
        };
        const command = loadCommand(vscodeStub, adapterDefinitions);

        const invocation = command.showModuleInstantiationPicker(
            () => currentIndex,
            () => lifecycleCurrent,
            root
        );
        await started;
        if (invalidation === 'replacement') {
            currentIndex = replacementIndex;
        } else {
            lifecycleCurrent = false;
            currentIndex = undefined;
        }
        releasePicker();
        await invocation;

        assert.strictEqual(quickPickCalls, 1, invalidation);
        assert.deepStrictEqual(adapterDefinitions, [], invalidation);
        assert.strictEqual(clipboardWrites, 0, invalidation);
        delete require.cache[require.resolve('../moduleInstantiationCommand')];
    }
}

async function testDeferredActionPickerRequiresLiveDefinition(): Promise<void> {
    const root = path.join(process.cwd(), 'workspace');
    const definition = moduleDefinition(root, 'rtl/child.sv', 'child', 0);
    let definitionAvailable = true;
    const index: FakeIndex = {
        getAllDefinitions: () => [definition],
        getDefinition: () => definitionAvailable ? definition : undefined,
    };
    let releaseAction!: () => void;
    let actionStarted!: () => void;
    const started = new Promise<void>(resolve => { actionStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseAction = resolve; });
    let quickPickCalls = 0;
    let clipboardWrites = 0;
    const adapterDefinitions: HdlDefinitionSummary[] = [];
    const vscodeStub = {
        window: {
            async showQuickPick(items: unknown[]): Promise<unknown> {
                quickPickCalls++;
                if (quickPickCalls === 1) { return items[0]; }
                actionStarted();
                await release;
                return { label: 'Copy', action: 'copy' };
            },
            showWarningMessage(): void {},
            showErrorMessage(): void {},
            showInformationMessage(): void {},
            activeTextEditor: undefined,
        },
        env: { clipboard: { async writeText(): Promise<void> { clipboardWrites++; } } },
    };
    const command = loadCommand(vscodeStub, adapterDefinitions);

    const invocation = command.showModuleInstantiationPicker(() => index, () => true, root);
    await started;
    definitionAvailable = false;
    releaseAction();
    await invocation;

    assert.strictEqual(quickPickCalls, 2);
    assert.deepStrictEqual(adapterDefinitions, []);
    assert.strictEqual(clipboardWrites, 0);
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
}

async function testInsertUsesCurrentSelectionInOriginalHdlEditor(): Promise<void> {
    const root = path.join(process.cwd(), 'workspace');
    const definition = moduleDefinition(root, 'rtl/child.sv', 'child', 0, [], [
        { name: 'a', direction: 'input', width: { kind: 'known', bits: 1 } },
    ]);
    const index = fakeIndex([definition]);
    const invocationRange = { start: { line: 0, character: 0 } };
    const currentRange = { start: { line: 1, character: 0 } };
    let replacedRange: unknown;
    let insertedText = '';
    const editor = {
        selection: invocationRange,
        document: {
            languageId: 'systemverilog',
            lineAt(): { text: string } { return { text: '' }; },
        },
        async edit(callback: (builder: { replace(range: unknown, text: string): void }) => void) {
            callback({
                replace(range: unknown, text: string): void {
                    replacedRange = range;
                    insertedText = text;
                },
            });
            return true;
        },
    };
    let quickPickCalls = 0;
    const adapterDefinitions: HdlDefinitionSummary[] = [];
    const vscodeStub = {
        window: {
            async showQuickPick(items: unknown[]): Promise<unknown> {
                quickPickCalls++;
                if (quickPickCalls === 1) { return items[0]; }
                editor.selection = currentRange;
                return { label: 'Insert', action: 'insert' };
            },
            showWarningMessage(): void {},
            showErrorMessage(): void {},
            showInformationMessage(): void {},
            activeTextEditor: editor,
        },
        env: { clipboard: { async writeText(): Promise<void> {} } },
    };
    const command = loadCommand(vscodeStub, adapterDefinitions);

    await command.showModuleInstantiationPicker(() => index, () => true, root);

    assert.strictEqual(replacedRange, currentRange);
    assert.strictEqual(insertedText, [
        'child u_child (',
        '    .a ( a ));',
    ].join('\n'));
    assert.deepStrictEqual(adapterDefinitions, [definition]);
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
}

async function testInsertRejectsChangedOrNonHdlEditor(): Promise<void> {
    for (const invalidContext of ['different editor', 'non-HDL editor'] as const) {
        const root = path.join(process.cwd(), 'workspace');
        const definition = moduleDefinition(root, 'rtl/child.sv', 'child', 0);
        const index = fakeIndex([definition]);
        let editCalls = 0;
        const originalEditor = {
            selection: { start: { line: 0, character: 0 } },
            document: { languageId: 'verilog', lineAt: () => ({ text: '' }) },
            async edit(): Promise<boolean> { editCalls++; return true; },
        };
        const otherHdlEditor = {
            ...originalEditor,
            document: { languageId: 'systemverilog', lineAt: () => ({ text: '' }) },
        };
        let quickPickCalls = 0;
        const vscodeStub = {
            window: {
                async showQuickPick(items: unknown[]): Promise<unknown> {
                    quickPickCalls++;
                    if (quickPickCalls === 1) { return items[0]; }
                    if (invalidContext === 'different editor') {
                        this.activeTextEditor = otherHdlEditor;
                    } else {
                        originalEditor.document.languageId = 'plaintext';
                    }
                    return { label: 'Insert', action: 'insert' };
                },
                showWarningMessage(): void {},
                showErrorMessage(): void {},
                showInformationMessage(): void {},
                activeTextEditor: originalEditor,
            },
            env: { clipboard: { async writeText(): Promise<void> {} } },
        };
        const command = loadCommand(vscodeStub, []);

        await command.showModuleInstantiationPicker(() => index, () => true, root);

        assert.strictEqual(editCalls, 0, invalidContext);
        delete require.cache[require.resolve('../moduleInstantiationCommand')];
    }
}

async function testCancellingEitherPickerHasNoSideEffects(): Promise<void> {
    for (const cancelledPicker of ['module', 'action'] as const) {
        const root = path.join(process.cwd(), 'workspace');
        const definition = moduleDefinition(root, 'rtl/child.sv', 'child', 0);
        const index = fakeIndex([definition]);
        let quickPickCalls = 0;
        let clipboardWrites = 0;
        let editCalls = 0;
        const adapterDefinitions: HdlDefinitionSummary[] = [];
        const editor = {
            selection: { start: { line: 0, character: 0 } },
            document: { languageId: 'verilog', lineAt: () => ({ text: '' }) },
            async edit(): Promise<boolean> { editCalls++; return true; },
        };
        const vscodeStub = {
            window: {
                async showQuickPick(items: unknown[]): Promise<unknown> {
                    quickPickCalls++;
                    if (cancelledPicker === 'module' || quickPickCalls === 2) {
                        return undefined;
                    }
                    return items[0];
                },
                showWarningMessage(): void {},
                showErrorMessage(): void {},
                showInformationMessage(): void {},
                activeTextEditor: editor,
            },
            env: {
                clipboard: {
                    async writeText(): Promise<void> { clipboardWrites++; },
                },
            },
        };
        const command = loadCommand(vscodeStub, adapterDefinitions);

        await command.showModuleInstantiationPicker(() => index, () => true, root);

        assert.strictEqual(quickPickCalls, cancelledPicker === 'module' ? 1 : 2);
        assert.deepStrictEqual(adapterDefinitions, [], cancelledPicker);
        assert.strictEqual(clipboardWrites, 0, cancelledPicker);
        assert.strictEqual(editCalls, 0, cancelledPicker);
        delete require.cache[require.resolve('../moduleInstantiationCommand')];
    }
}

async function main(): Promise<void> {
    await testExactIndexedDefinitionCopiesGoldenText();
    await testDeferredModulePickerRejectsReplacementAndDeactivation();
    await testDeferredActionPickerRequiresLiveDefinition();
    await testInsertUsesCurrentSelectionInOriginalHdlEditor();
    await testInsertRejectsChangedOrNonHdlEditor();
    await testCancellingEitherPickerHasNoSideEffects();
    console.log('module instantiation lifecycle tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
