import * as assert from 'assert';

import { createEmptyArchDesignText } from '@veriflow/schematic-core/arch-design';
import { createArchDesign } from '../archDesign/archDesignCreation';

async function testCreatesCanonicalDesignBeforeOpening(): Promise<void> {
    const writes: Array<[string, string]> = [];
    const opened: string[] = [];
    const errors: string[] = [];
    const events: string[] = [];

    const result = await createArchDesign({
        requestModule: async validate => {
            assert.strictEqual(
                validate('1bad'),
                'Enter a valid Verilog module name'
            );
            assert.strictEqual(validate('soc_top'), undefined);
            return 'soc_top';
        },
        requestTarget: async module => {
            assert.strictEqual(module, 'soc_top');
            return `workspace/${module}.ad`;
        },
        writeFile: async (target, text) => {
            events.push('write');
            writes.push([target, text]);
        },
        openEditor: async target => {
            events.push('open');
            opened.push(target);
        },
        reportError: async message => { errors.push(message); },
    });

    assert.strictEqual(result, 'workspace/soc_top.ad');
    assert.deepStrictEqual(writes, [[
        'workspace/soc_top.ad',
        createEmptyArchDesignText('soc_top'),
    ]]);
    assert.deepStrictEqual(opened, ['workspace/soc_top.ad']);
    assert.deepStrictEqual(events, ['write', 'open']);
    assert.deepStrictEqual(errors, []);
}

async function testModuleCancellationIsANoOp(): Promise<void> {
    let targetRequested = false;
    let writeRequested = false;
    let openRequested = false;

    const result = await createArchDesign<string>({
        requestModule: async () => undefined,
        requestTarget: async () => {
            targetRequested = true;
            return 'unused.ad';
        },
        writeFile: async () => { writeRequested = true; },
        openEditor: async () => { openRequested = true; },
        reportError: async () => undefined,
    });

    assert.strictEqual(result, undefined);
    assert.strictEqual(targetRequested, false);
    assert.strictEqual(writeRequested, false);
    assert.strictEqual(openRequested, false);
}

async function testTargetCancellationIsANoOp(): Promise<void> {
    let writeRequested = false;
    let openRequested = false;

    const result = await createArchDesign<string>({
        requestModule: async () => 'soc_top',
        requestTarget: async () => undefined,
        writeFile: async () => { writeRequested = true; },
        openEditor: async () => { openRequested = true; },
        reportError: async () => undefined,
    });

    assert.strictEqual(result, undefined);
    assert.strictEqual(writeRequested, false);
    assert.strictEqual(openRequested, false);
}

async function testWriteFailureIsReportedWithoutOpening(): Promise<void> {
    const errors: string[] = [];
    let opened = false;

    const result = await createArchDesign<string>({
        requestModule: async () => 'soc_top',
        requestTarget: async () => 'workspace/soc_top.ad',
        writeFile: async () => { throw new Error('write failed'); },
        openEditor: async () => { opened = true; },
        reportError: async message => { errors.push(message); },
    });

    assert.strictEqual(result, undefined);
    assert.strictEqual(opened, false);
    assert.deepStrictEqual(errors, ['write failed']);
}

async function testNonErrorFailureIsReported(): Promise<void> {
    const errors: string[] = [];

    await createArchDesign<string>({
        requestModule: async () => 'soc_top',
        requestTarget: async () => 'workspace/soc_top.ad',
        writeFile: async () => { throw 'write failed'; },
        openEditor: async () => undefined,
        reportError: async message => { errors.push(message); },
    });

    assert.deepStrictEqual(errors, ['write failed']);
}

async function main(): Promise<void> {
    await testCreatesCanonicalDesignBeforeOpening();
    await testModuleCancellationIsANoOp();
    await testTargetCancellationIsANoOp();
    await testWriteFailureIsReportedWithoutOpening();
    await testNonErrorFailureIsReported();
    console.log('Arch Design creation tests passed');
}

void main();
