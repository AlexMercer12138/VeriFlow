import * as assert from 'assert';
import {
    openSchematicDefinition,
    SchematicNavigationRegistry,
    SchematicPanelHandle,
} from '../schematic/navigationRegistry';

function panel(uri: string): SchematicPanelHandle {
    return {
        uri,
        reveal(): void {},
        selectModule(): void {},
    };
}

type Deferred = {
    started: Promise<void>;
    resolveStarted(): void;
    pending: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
};

function deferred(): Deferred {
    let resolveStarted!: () => void;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    return {
        started: new Promise(done => { resolveStarted = done; }),
        resolveStarted,
        pending: new Promise((done, fail) => {
            resolve = done;
            reject = fail;
        }),
        resolve,
        reject,
    };
}

function testMostRecentlyFocusedLivePanelWins(): void {
    const registry = new SchematicNavigationRegistry();
    const first = panel('file:///workspace/design.sv');
    const second = panel('file:///workspace/design.sv');
    const other = panel('file:///workspace/other.sv');
    const firstRegistration = registry.register(first);
    registry.register(second);
    registry.register(other);

    registry.markFocused(first);
    registry.markFocused(other);
    registry.markFocused(second);
    assert.strictEqual(registry.findPreferred(first.uri), second);
    assert.strictEqual(registry.findPreferred(other.uri), other);

    registry.markFocused(first);
    assert.strictEqual(registry.findPreferred(first.uri), first);
    firstRegistration.dispose();
    assert.strictEqual(registry.findPreferred(first.uri), second);
}

function testDisposedAndUnregisteredPanelsCannotBecomePreferred(): void {
    const registry = new SchematicNavigationRegistry();
    const registered = panel('file:///workspace/design.sv');
    const unregistered = panel('file:///workspace/design.sv');
    const registration = registry.register(registered);

    registry.markFocused(unregistered);
    assert.strictEqual(registry.findPreferred(registered.uri), undefined);

    registry.markFocused(registered);
    registration.dispose();
    registry.markFocused(registered);
    assert.strictEqual(registry.findPreferred(registered.uri), undefined);
}

function testPendingModuleKeysAreExactAndOneShot(): void {
    const registry = new SchematicNavigationRegistry();
    const uri = 'file:///workspace/design.sv';
    const key = 'module:file:///workspace/design.sv:42';
    registry.setPending(uri, key);

    const handle = panel(uri);
    registry.register(handle);
    registry.markFocused(handle);
    registry.findPreferred(uri);
    assert.strictEqual(registry.consumePending(uri), key);
    assert.strictEqual(registry.consumePending(uri), undefined);

    registry.setPending(uri, 'module:file:///workspace/design.sv:84');
    assert.strictEqual(registry.consumePending('file:///workspace/other.sv'), undefined);
    assert.strictEqual(
        registry.consumePending(uri),
        'module:file:///workspace/design.sv:84'
    );
}

function testPendingRollbackIsCompareProtected(): void {
    const registry = new SchematicNavigationRegistry();
    const uri = 'file:///workspace/design.sv';
    const first = 'module:file:///workspace/design.sv:10';
    const second = 'module:file:///workspace/design.sv:20';

    registry.setPending(uri, first);
    registry.clearPending(uri, first);
    assert.strictEqual(registry.consumePending(uri), undefined);

    registry.setPending(uri, first);
    registry.setPending(uri, second);
    registry.clearPending(uri, first);
    assert.strictEqual(registry.consumePending(uri), second);
}

async function testSameKeyRollbackKeepsNewerPendingInvocation(): Promise<void> {
    const registry = new SchematicNavigationRegistry();
    const source = panel('file:///workspace/source.sv');
    const targetUri = 'file:///workspace/target.sv';
    const definitionKey = `module:${targetUri}:0`;
    const first = deferred();
    const second = deferred();
    let invocation = 0;
    const ports = {
        getDefinition: () => ({ key: definitionKey, uri: targetUri }),
        async openSchematic(): Promise<void> {
            const gate = invocation++ === 0 ? first : second;
            gate.resolveStarted();
            await gate.pending;
        },
    };

    const firstOpen = openSchematicDefinition(source, definitionKey, registry, ports);
    await first.started;
    const secondOpen = openSchematicDefinition(source, definitionKey, registry, ports);
    await second.started;
    first.reject(new Error('older open failed'));
    await assert.rejects(firstOpen, /older open failed/);

    assert.strictEqual(registry.consumePending(targetUri), definitionKey);
    second.resolve();
    await secondOpen;
}

testMostRecentlyFocusedLivePanelWins();
testDisposedAndUnregisteredPanelsCannotBecomePreferred();
testPendingModuleKeysAreExactAndOneShot();
testPendingRollbackIsCompareProtected();
void testSameKeyRollbackKeepsNewerPendingInvocation()
    .then(() => console.log('schematic navigation registry tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
