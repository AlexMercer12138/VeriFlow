import * as assert from 'assert';
import Module = require('module');

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

async function testQuickPickContinuationRequiresCurrentLifecycle(): Promise<void> {
    let releasePicker!: () => void;
    let pickerStarted!: () => void;
    const started = new Promise<void>(resolve => { pickerStarted = resolve; });
    const release = new Promise<void>(resolve => { releasePicker = resolve; });
    let lifecycleCurrent = true;
    let parseCalls = 0;
    let quickPickCalls = 0;
    const moduleChoice = {
        label: 'child',
        moduleName: 'child',
        filepath: '/workspace/child.sv',
    };
    const vscodeStub = {
        window: {
            async showQuickPick(): Promise<unknown> {
                quickPickCalls++;
                pickerStarted();
                await release;
                return moduleChoice;
            },
            showWarningMessage(): void {},
            showErrorMessage(): void {},
            showInformationMessage(): void {},
            activeTextEditor: undefined,
        },
        env: { clipboard: { async writeText(): Promise<void> {} } },
    };
    const coreStub = {
        buildModuleInstantiationChoices: () => [moduleChoice],
        formatModuleInstantiation: () => 'child u_child ();',
        PortParser: class {
            parseFile(): { name: string; parameters: []; ports: [] } {
                parseCalls++;
                return { name: 'child', parameters: [], ports: [] };
            }
        },
    };
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
    const command = withModuleStubs(
        { vscode: vscodeStub, './core': coreStub },
        () => require('../moduleInstantiationCommand') as {
            showModuleInstantiationPicker(
                result: unknown,
                isCurrent: () => boolean
            ): Promise<void>;
        }
    );

    const invocation = command.showModuleInstantiationPicker({ definitions: [] }, () =>
        lifecycleCurrent
    );
    await started;
    lifecycleCurrent = false;
    releasePicker();
    await invocation;

    assert.strictEqual(quickPickCalls, 1);
    assert.strictEqual(parseCalls, 0);
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
}

async function testCurrentLifecycleCopyStillCompletes(): Promise<void> {
    let quickPickCalls = 0;
    let copiedText = '';
    let informationMessages = 0;
    const moduleChoice = {
        label: 'child',
        moduleName: 'child',
        filepath: '/workspace/child.sv',
    };
    const vscodeStub = {
        window: {
            async showQuickPick(): Promise<unknown> {
                quickPickCalls++;
                return quickPickCalls === 1
                    ? moduleChoice
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
    const coreStub = {
        buildModuleInstantiationChoices: () => [moduleChoice],
        formatModuleInstantiation: () => 'child u_child ();',
        PortParser: class {
            parseFile(): { name: string; parameters: []; ports: [] } {
                return { name: 'child', parameters: [], ports: [] };
            }
        },
    };
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
    const command = withModuleStubs(
        { vscode: vscodeStub, './core': coreStub },
        () => require('../moduleInstantiationCommand') as {
            showModuleInstantiationPicker(
                result: unknown,
                isCurrent: () => boolean
            ): Promise<void>;
        }
    );

    await command.showModuleInstantiationPicker({ definitions: [] }, () => true);

    assert.strictEqual(quickPickCalls, 2);
    assert.strictEqual(copiedText, 'child u_child ();');
    assert.strictEqual(informationMessages, 1);
    delete require.cache[require.resolve('../moduleInstantiationCommand')];
}

async function main(): Promise<void> {
    await testQuickPickContinuationRequiresCurrentLifecycle();
    await testCurrentLifecycleCopyStillCompletes();
    console.log('module instantiation lifecycle tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
