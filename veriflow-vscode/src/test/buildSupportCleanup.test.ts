import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as path from 'path';
import { pathToFileURL } from 'url';

type FakeContext = {
    watch(): Promise<void>;
    dispose(): Promise<void>;
};

type BuildSupport = {
    cleanupBundleContexts(contexts: FakeContext[]): Promise<void>;
    cleanupWatchResources(
        typecheckProcess: object | undefined,
        contexts: FakeContext[],
        stopTypecheck: (typecheckProcess: object) => Promise<void>
    ): Promise<void>;
    startBundleWatchers(
        bundleOptions: string[],
        createContext: (option: string) => Promise<FakeContext>
    ): Promise<FakeContext[]>;
    runWatch(options: Record<string, unknown>): Promise<number>;
};

type AggregateErrorLike = Error & { errors: unknown[] };

const extensionRoot = path.resolve(__dirname, '..', '..');
const loadEsmModule = new Function(
    'specifier',
    'return import(specifier);'
) as (specifier: string) => Promise<BuildSupport>;

async function expectAggregate(
    action: () => Promise<unknown>,
    expectedErrors: number
): Promise<AggregateErrorLike> {
    try {
        await action();
        assert.fail('Expected AggregateError');
    } catch (error) {
        const AggregateErrorConstructor = (globalThis as any).AggregateError;
        assert.ok(error instanceof AggregateErrorConstructor, `received ${String(error)}`);
        const aggregate = error as AggregateErrorLike;
        assert.strictEqual(aggregate.errors.length, expectedErrors);
        return aggregate;
    }
}

const fakeContext = (
    label: string,
    calls: string[],
    disposeError?: Error
): FakeContext => ({
    async watch(): Promise<void> {
        calls.push(`watch:${label}`);
    },
    async dispose(): Promise<void> {
        calls.push(`dispose:${label}`);
        if (disposeError) throw disposeError;
    },
});

async function testBuildSupportCleanup(): Promise<void> {
    const support = await loadEsmModule(pathToFileURL(
        path.join(extensionRoot, 'scripts', 'build-support.mjs')
    ).href);

    const oneFailureCalls: string[] = [];
    const oneFailure = await expectAggregate(
        () => support.cleanupBundleContexts([
            fakeContext('bad', oneFailureCalls, new Error('dispose bad')),
            fakeContext('good', oneFailureCalls),
        ]),
        1
    );
    assert.deepStrictEqual(oneFailureCalls.sort(), ['dispose:bad', 'dispose:good']);
    assert.match(String(oneFailure.errors[0]), /bundle context 0.*dispose bad/);
    assert.match(String((oneFailure.errors[0] as any).cause), /dispose bad/);

    const multipleCalls: string[] = [];
    const multiple = await expectAggregate(
        () => support.cleanupBundleContexts([
            fakeContext('first', multipleCalls, new Error('dispose first')),
            fakeContext('second', multipleCalls, new Error('dispose second')),
        ]),
        2
    );
    assert.deepStrictEqual(multipleCalls.sort(), ['dispose:first', 'dispose:second']);
    assert.match(multiple.errors.map(String).join('\n'), /dispose first/);
    assert.match(multiple.errors.map(String).join('\n'), /dispose second/);

    const watchCalls: string[] = [];
    const watchCleanup = await expectAggregate(
        () => support.cleanupWatchResources(
            {},
            [fakeContext('watch', watchCalls, new Error('context stop failed'))],
            async () => {
                watchCalls.push('stop:typecheck');
                throw new Error('typecheck stop failed');
            }
        ),
        2
    );
    assert.deepStrictEqual(watchCalls.sort(), ['dispose:watch', 'stop:typecheck']);
    assert.match(watchCleanup.errors.map(String).join('\n'), /typecheck stop failed/);
    assert.match(watchCleanup.errors.map(String).join('\n'), /context stop failed/);

    const successCalls: string[] = [];
    await support.cleanupWatchResources(
        {},
        [fakeContext('success', successCalls)],
        async () => { successCalls.push('stop:typecheck'); }
    );
    assert.deepStrictEqual(successCalls.sort(), ['dispose:success', 'stop:typecheck']);

    const startupCalls: string[] = [];
    const startup = await expectAggregate(
        () => support.startBundleWatchers(
            ['first', 'second'],
            async option => {
                if (option === 'second') throw new Error('context startup failed');
                return fakeContext('created', startupCalls, new Error('startup cleanup failed'));
            }
        ),
        2
    );
    assert.deepStrictEqual(startupCalls, ['dispose:created']);
    assert.match(startup.errors.map(String).join('\n'), /context startup failed/);
    assert.match(startup.errors.map(String).join('\n'), /startup cleanup failed/);

    const runCalls: string[] = [];
    const fakeTypecheck = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        pid: 123,
    });
    const runCleanup = await expectAggregate(
        () => support.runWatch({
            bundleOptions: ['run'],
            cwd: extensionRoot,
            typecheck: { command: 'unused', args: [] },
            stopRequested: Promise.reject(new Error('watch body failed')),
            createContext: async () => fakeContext(
                'run',
                runCalls,
                new Error('run context cleanup failed')
            ),
            spawnProcess: () => {
                runCalls.push('spawn:typecheck');
                return fakeTypecheck;
            },
            stopTypecheck: async () => {
                runCalls.push('stop:typecheck');
                throw new Error('run typecheck cleanup failed');
            },
        }),
        3
    );
    assert.deepStrictEqual(runCalls.sort(), [
        'dispose:run',
        'spawn:typecheck',
        'stop:typecheck',
        'watch:run',
    ]);
    assert.match(runCleanup.errors.map(String).join('\n'), /watch body failed/);
    assert.match(runCleanup.errors.map(String).join('\n'), /run typecheck cleanup failed/);
    assert.match(runCleanup.errors.map(String).join('\n'), /run context cleanup failed/);
}

testBuildSupportCleanup()
    .then(() => console.log('build support cleanup tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
