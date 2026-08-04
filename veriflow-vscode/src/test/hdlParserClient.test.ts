import * as assert from 'assert';
import * as path from 'path';
import { Worker } from 'worker_threads';

import type { HdlDocument } from '../core/hdl/model';
import {
    HdlParserCancelledError,
    HdlParserClient,
    HdlParserDisposedError,
    WorkerLike,
} from '../core/hdl/parserClient';
import type {
    HdlParseOptions,
    ParserWorkerRequest,
    ParserWorkerResponse,
} from '../core/hdl/protocol';
import { computeTreeEdit } from '../core/hdl/treeEdit';

type WorkerEvent = 'message' | 'error' | 'exit';
type WorkerListener = (...values: any[]) => void;

class FakeWorker implements WorkerLike {
    readonly messages: ParserWorkerRequest[] = [];
    readonly attemptedMessages: ParserWorkerRequest[] = [];
    terminateCalls = 0;
    throwOnCancel = false;
    throwOnDispose = false;
    failParseAt: number | undefined;
    terminateFailure: 'none' | 'sync' | 'async' = 'none';
    private parseAttempts = 0;
    private readonly listeners = new Map<WorkerEvent, Set<WorkerListener>>();

    postMessage(message: ParserWorkerRequest): void {
        this.attemptedMessages.push(message);
        if (message.type === 'cancel' && this.throwOnCancel) {
            throw new Error('worker channel closed');
        }
        if (message.type === 'dispose' && this.throwOnDispose) {
            throw new Error('dispose send failed');
        }
        if (message.type === 'parse') {
            this.parseAttempts++;
            if (this.parseAttempts === this.failParseAt) {
                throw new Error('send failed');
            }
        }
        this.messages.push(message);
    }

    on(event: WorkerEvent, listener: WorkerListener): this {
        const listeners = this.listeners.get(event) ?? new Set<WorkerListener>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    off(event: WorkerEvent, listener: WorkerListener): this {
        this.listeners.get(event)?.delete(listener);
        return this;
    }

    terminate(): Promise<number> {
        this.terminateCalls++;
        if (this.terminateFailure === 'sync') {
            throw new Error('terminate threw');
        }
        if (this.terminateFailure === 'async') {
            return Promise.reject(new Error('terminate rejected'));
        }
        return Promise.resolve(0);
    }

    emit(event: WorkerEvent, ...values: any[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(...values);
        }
    }

    respond(response: ParserWorkerResponse): void {
        this.emit('message', response);
    }
}

function fakeDocument(uri: string, version: number, marker = ''): HdlDocument {
    return {
        uri,
        languageId: uri.endsWith('.v') ? 'verilog' : 'systemverilog',
        version,
        textHash: marker,
        lineEnding: '\n',
        preprocessingFingerprint: marker,
        modules: [],
        interfaces: [],
        packages: [],
        directives: [],
        includes: [],
        diagnostics: [],
    };
}

function parseMessages(worker: FakeWorker): Extract<ParserWorkerRequest, { type: 'parse' }>[] {
    return worker.messages.filter(
        (message): message is Extract<ParserWorkerRequest, { type: 'parse' }> =>
            message.type === 'parse'
    );
}

function requestIdAt(worker: FakeWorker, index: number): string {
    return parseMessages(worker)[index].requestId;
}

function resolveParse(
    worker: FakeWorker,
    index: number,
    uri: string,
    version: number,
    marker = ''
): void {
    worker.respond({
        type: 'parsed',
        requestId: requestIdAt(worker, index),
        document: fakeDocument(uri, version, marker),
    });
}

async function assertCancelled(promise: Promise<unknown>): Promise<void> {
    await assert.rejects(promise, error =>
        error instanceof HdlParserCancelledError
        && error.name === 'HdlParserCancelledError'
        && error.message === 'HDL parse cancelled'
    );
}

async function assertDisposed(promise: Promise<unknown>): Promise<void> {
    await assert.rejects(promise, error =>
        error instanceof HdlParserDisposedError
        && error.name === 'HdlParserDisposedError'
        && error.message === 'HDL parser client is disposed'
    );
}

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`${label} timed out`)),
                    15_000
                );
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

function makeClient(
    workers: FakeWorker[],
    configureWorker?: (worker: FakeWorker, index: number) => void
): HdlParserClient {
    return new HdlParserClient({
        workerPath: 'fake-worker.js',
        runtimeWasmPath: 'runtime.wasm',
        languageWasmPath: 'language.wasm',
        createWorker: () => {
            const worker = new FakeWorker();
            configureWorker?.(worker, workers.length);
            workers.push(worker);
            return worker;
        },
    });
}

async function testCacheIdentityCancellationAndPriorities(): Promise<void> {
    const workers: FakeWorker[] = [];
    const client = makeClient(workers);
    const uri = 'file:///workspace/top.sv';
    const baseOptions: HdlParseOptions = { defines: { WIDTH: '8' } };

    const first = client.parse(uri, 1, 'module top; endmodule', baseOptions);
    const duplicate = client.parse(uri, 1, 'module top; endmodule', baseOptions);
    assert.strictEqual(first, duplicate);
    assert.strictEqual(workers.length, 1);
    assert.strictEqual(parseMessages(workers[0]).length, 1);
    assert.strictEqual(parseMessages(workers[0])[0].priority, 'interactive');

    const changed = client.parse(uri, 1, 'module changed; endmodule', baseOptions);
    await assertCancelled(first);
    assert.deepStrictEqual(workers[0].messages.slice(1, 3).map(message => message.type), [
        'cancel',
        'parse',
    ]);
    const changedRequest = parseMessages(workers[0])[1];
    assert.ok(!Object.prototype.hasOwnProperty.call(changedRequest, 'edit'));
    assert.ok(!Object.prototype.hasOwnProperty.call(changedRequest, 'treeEdit'));

    const newer = client.parse(uri, 2, 'module newest; endmodule', baseOptions);
    await assertCancelled(changed);
    assert.strictEqual(workers[0].messages.at(-2)?.type, 'cancel');
    assert.strictEqual(workers[0].messages.at(-1)?.type, 'parse');
    const newerRequest = parseMessages(workers[0])[2];
    assert.strictEqual(newerRequest.priority, 'interactive');
    resolveParse(workers[0], 2, uri, 2, 'newest');
    assert.strictEqual((await newer).version, 2);

    const background = client.parse(
        'file:///workspace/background.sv',
        1,
        'module background; endmodule',
        { defines: {} },
        'background'
    );
    assert.strictEqual(parseMessages(workers[0]).at(-1)?.priority, 'background');
    resolveParse(workers[0], 3, 'file:///workspace/background.sv', 1);
    await background;
    await client.dispose();
}

async function testFingerprintCanonicalizationAndEphemeralIsolation(): Promise<void> {
    const workers: FakeWorker[] = [];
    const client = makeClient(workers);
    const uri = 'file:///workspace/top.sv';
    const text = 'module top; endmodule';
    const includeA = {
        fromUri: 'FILE://EXAMPLE.COM/work/./top.sv',
        rawPath: 'defs.svh',
        resolvedUri: 'file://example.com/work/include/../include/defs.svh',
        text: '`define FLAG 1\n',
    };
    const includeB = {
        fromUri: 'file://example.com/work/top.sv',
        rawPath: 'ports.svh',
        resolvedUri: 'FILE://EXAMPLE.COM/work/include/ports.svh',
        text: 'input logic clk',
    };
    const firstOptions: HdlParseOptions = {
        defines: { WIDTH: '8', FLAG: true },
        resolvedIncludes: [includeA, includeB],
    };
    const reorderedOptions: HdlParseOptions = {
        resolvedIncludes: [includeB, includeA],
        defines: { FLAG: true, WIDTH: '8' },
        maxIncludeDepth: 32,
    };

    const first = client.parse(uri, 1, text, firstOptions);
    assert.strictEqual(client.parse(uri, 1, text, reorderedOptions), first);
    assert.strictEqual(parseMessages(workers[0]).length, 1);
    resolveParse(workers[0], 0, uri, 1);
    await first;

    const defineChanged = client.parse(uri, 1, text, {
        ...reorderedOptions,
        defines: { FLAG: true, WIDTH: '16' },
    });
    assert.strictEqual(parseMessages(workers[0]).length, 2);
    resolveParse(workers[0], 1, uri, 1);
    await defineChanged;

    const includeChanged = client.parse(uri, 1, text, {
        ...reorderedOptions,
        resolvedIncludes: [{ ...includeA, text: '`define FLAG 0\n' }, includeB],
    });
    assert.strictEqual(parseMessages(workers[0]).length, 3);
    resolveParse(workers[0], 2, uri, 1);
    await includeChanged;

    const documentCached = client.parse(uri, 1, text, reorderedOptions);
    resolveParse(workers[0], 3, uri, 1, 'document');
    await documentCached;
    const ephemeralA = client.parse(uri, 1, text, {
        ...reorderedOptions,
        cacheMode: 'ephemeral',
    });
    const ephemeralB = client.parse(uri, 1, text, {
        ...reorderedOptions,
        cacheMode: 'ephemeral',
    });
    assert.notStrictEqual(ephemeralA, ephemeralB);
    assert.strictEqual(parseMessages(workers[0]).length, 6);
    resolveParse(workers[0], 4, uri, 1, 'ephemeral-a');
    resolveParse(workers[0], 5, uri, 1, 'ephemeral-b');
    assert.strictEqual((await ephemeralA).textHash, 'ephemeral-a');
    assert.strictEqual((await ephemeralB).textHash, 'ephemeral-b');
    assert.strictEqual(client.parse(uri, 1, text, reorderedOptions), documentCached);
    await client.dispose();
}

async function testStaleResponsesFailuresAndWorkerReplacement(): Promise<void> {
    const workers: FakeWorker[] = [];
    const client = makeClient(workers);
    const uri = 'file:///workspace/stale.sv';
    const old = client.parse(uri, 1, 'module old; endmodule', { defines: {} });
    const newer = client.parse(uri, 2, 'module newer; endmodule', { defines: {} });
    await assertCancelled(old);
    workers[0].respond({
        type: 'parsed',
        requestId: requestIdAt(workers[0], 0),
        document: fakeDocument(uri, 1, 'stale'),
    });
    workers[0].respond({
        type: 'parsed',
        requestId: 'unknown-request',
        document: fakeDocument(uri, 99, 'unknown'),
    });
    resolveParse(workers[0], 1, uri, 2, 'fresh');
    assert.strictEqual((await newer).textHash, 'fresh');
    assert.strictEqual(client.parse(uri, 2, 'module newer; endmodule', { defines: {} }), newer);

    const failed = client.parse('file:///workspace/failed.sv', 1, 'bad', { defines: {} });
    const survivor = client.parse('file:///workspace/good.sv', 1, 'module good; endmodule', {
        defines: {},
    });
    const failedId = requestIdAt(workers[0], 2);
    workers[0].respond({ type: 'failed', requestId: failedId, message: 'parse failed' });
    await assert.rejects(failed, /parse failed/);
    resolveParse(workers[0], 3, 'file:///workspace/good.sv', 1);
    await survivor;

    const pendingA = client.parse('file:///workspace/a.sv', 1, 'module a; endmodule', {
        defines: {},
    });
    const pendingB = client.parse('file:///workspace/b.sv', 1, 'module b; endmodule', {
        defines: {},
    });
    workers[0].emit('error', new Error('worker crashed'));
    await assert.rejects(pendingA, /worker crashed/);
    await assert.rejects(pendingB, /worker crashed/);

    const replacement = client.parse('file:///workspace/replacement.sv', 1, 'module r; endmodule', {
        defines: {},
    });
    assert.strictEqual(workers.length, 2);
    const replacementId = requestIdAt(workers[1], 0);
    assert.ok(Number(replacementId.split('-').at(-1)) > Number(requestIdAt(workers[0], 5).split('-').at(-1)));
    workers[0].emit('exit', 1);
    resolveParse(workers[1], 0, 'file:///workspace/replacement.sv', 1);
    await replacement;
    await client.dispose();
}

async function testInvalidationClearAndDispose(): Promise<void> {
    const workers: FakeWorker[] = [];
    const client = makeClient(workers);
    client.clearCache();
    client.invalidate('file:///workspace/not-created.sv');
    assert.strictEqual(workers.length, 0);

    const a = client.parse('file:///workspace/a.sv', 1, 'module a; endmodule', { defines: {} });
    const b = client.parse('file:///workspace/b.sv', 1, 'module b; endmodule', { defines: {} });
    client.invalidate('file:///workspace/a.sv');
    await assertCancelled(a);
    assert.strictEqual(workers[0].messages.at(-1)?.type, 'cancel');
    resolveParse(workers[0], 1, 'file:///workspace/b.sv', 1);
    await b;

    const pending = client.parse('file:///workspace/pending.sv', 1, 'module p; endmodule', {
        defines: {},
    });
    client.clearCache();
    await assertCancelled(pending);
    const afterClear = client.parse('file:///workspace/after-clear.sv', 1, 'module c; endmodule', {
        defines: {},
    });
    const beforeDisposeMessages = workers[0].messages.length;
    const disposeA = client.dispose();
    const disposeB = client.dispose();
    assert.strictEqual(disposeA, disposeB);
    await assertDisposed(afterClear);
    await disposeA;
    assert.strictEqual(workers[0].messages[beforeDisposeMessages].type, 'dispose');
    assert.strictEqual(workers[0].terminateCalls, 1);

    await assert.rejects(
        client.parse('file:///workspace/after-dispose.sv', 1, 'module no; endmodule', {
            defines: {},
        }),
        /disposed/
    );
    assert.strictEqual(workers.length, 1);
}

async function testParseTransportFailureRejectsGenerationAndRetries(): Promise<void> {
    const workers: FakeWorker[] = [];
    const client = makeClient(workers, (worker, index) => {
        if (index === 0) {
            worker.failParseAt = 1;
        }
    });
    let failed!: Promise<HdlDocument>;
    assert.doesNotThrow(() => {
        failed = client.parse(
            'file:///workspace/send-failed.sv',
            1,
            'module send_failed; endmodule',
            { defines: {} }
        );
    });
    await assert.rejects(failed, /send failed/);
    assert.strictEqual(workers[0].terminateCalls, 1);

    const retry = client.parse(
        'file:///workspace/send-failed.sv',
        1,
        'module send_failed; endmodule',
        { defines: {} }
    );
    assert.strictEqual(workers.length, 2);
    const staleParse = workers[0].attemptedMessages.find(
        (message): message is Extract<ParserWorkerRequest, { type: 'parse' }> =>
            message.type === 'parse'
    )!;
    workers[0].respond({
        type: 'parsed',
        requestId: staleParse.requestId,
        document: fakeDocument('file:///workspace/send-failed.sv', 1, 'stale'),
    });
    resolveParse(workers[1], 0, 'file:///workspace/send-failed.sv', 1, 'retry');
    assert.strictEqual((await retry).textHash, 'retry');
    await client.dispose();

    const generationWorkers: FakeWorker[] = [];
    const generationClient = makeClient(generationWorkers, worker => {
        worker.failParseAt = 2;
    });
    const firstPending = generationClient.parse(
        'file:///workspace/generation-a.sv',
        1,
        'module generation_a; endmodule',
        { defines: {} }
    );
    const firstRejected = assert.rejects(firstPending, /send failed/);
    let secondPending!: Promise<HdlDocument>;
    assert.doesNotThrow(() => {
        secondPending = generationClient.parse(
            'file:///workspace/generation-b.sv',
            1,
            'module generation_b; endmodule',
            { defines: {} }
        );
    });
    await Promise.all([
        firstRejected,
        assert.rejects(secondPending, /send failed/),
    ]);
    assert.strictEqual(generationWorkers[0].terminateCalls, 1);
    await generationClient.dispose();
}

async function testDisposeIgnoresTransportAndTerminationFailures(): Promise<void> {
    const cases: Array<{
        label: string;
        configure: (worker: FakeWorker) => void;
    }> = [
        {
            label: 'dispose post failure',
            configure: worker => { worker.throwOnDispose = true; },
        },
        {
            label: 'synchronous terminate failure',
            configure: worker => { worker.terminateFailure = 'sync'; },
        },
        {
            label: 'asynchronous terminate failure',
            configure: worker => { worker.terminateFailure = 'async'; },
        },
    ];
    for (const testCase of cases) {
        const workers: FakeWorker[] = [];
        const client = makeClient(workers, worker => testCase.configure(worker));
        const pending = client.parse(
            `file:///workspace/${testCase.label.replace(/ /g, '-')}.sv`,
            1,
            'module pending_dispose; endmodule',
            { defines: {} }
        );
        const pendingRejected = assertDisposed(pending);
        const firstDispose = client.dispose();
        assert.strictEqual(client.dispose(), firstDispose);
        await Promise.all([pendingRejected, firstDispose]);
        assert.strictEqual(workers[0].terminateCalls, 1);
        await assertDisposed(client.parse(
            'file:///workspace/after-best-effort-dispose.sv',
            1,
            'module after_dispose; endmodule',
            { defines: {} }
        ));
    }
}

async function testCancelTransportFailureStillRejectsAndRestarts(): Promise<void> {
    const workers: FakeWorker[] = [];
    const client = makeClient(workers);
    const old = client.parse('file:///workspace/transport.sv', 1, 'module old; endmodule', {
        defines: {},
    });
    workers[0].throwOnCancel = true;
    const replacement = client.parse(
        'file:///workspace/transport.sv',
        2,
        'module replacement; endmodule',
        { defines: {} }
    );
    await assertCancelled(old);
    assert.strictEqual(workers.length, 2);
    resolveParse(workers[1], 0, 'file:///workspace/transport.sv', 2);
    await replacement;
    await client.dispose();
}

function expectedEdit(oldText: string, newText: string, start: number, oldEnd: number, newEnd: number) {
    const point = (text: string, offset: number): { row: number; column: number } => {
        const prefix = text.slice(0, offset);
        const lines = prefix.split('\n');
        return {
            row: lines.length - 1,
            column: Buffer.byteLength(lines.at(-1) ?? '', 'utf8'),
        };
    };
    return {
        startIndex: Buffer.byteLength(oldText.slice(0, start), 'utf8'),
        oldEndIndex: Buffer.byteLength(oldText.slice(0, oldEnd), 'utf8'),
        newEndIndex: Buffer.byteLength(newText.slice(0, newEnd), 'utf8'),
        startPosition: point(oldText, start),
        oldEndPosition: point(oldText, oldEnd),
        newEndPosition: point(newText, newEnd),
    };
}

function testComputeTreeEdit(): void {
    assert.strictEqual(computeTreeEdit('same', 'same'), undefined);
    const cases: Array<[string, string, number, number, number]> = [
        ['abc', 'Xabc', 0, 0, 1],
        ['abc', 'aXbc', 1, 1, 2],
        ['abc', 'abcX', 3, 3, 4],
        ['Xabc', 'abc', 0, 1, 0],
        ['aXbc', 'abc', 1, 2, 1],
        ['abcX', 'abc', 3, 4, 3],
        ['abc', 'aXYc', 1, 2, 3],
        ['\u4fe1\u53f7abc', '\u4fe1\u53f7aXc', 3, 4, 4],
        ['e\u0301x', 'e\u0301yx', 2, 2, 3],
        ['a\rb', 'a\r\u4e2db', 2, 2, 3],
        ['a\nb', 'a\n\ud83d\ude00b', 2, 2, 4],
    ];
    for (const [oldText, newText, start, oldEnd, newEnd] of cases) {
        assert.deepStrictEqual(
            computeTreeEdit(oldText, newText),
            expectedEdit(oldText, newText, start, oldEnd, newEnd)
        );
    }

    const oldCrlf = 'head\r\n\ud83d\ude00 value\r\nlast';
    const newCrlf = 'head\r\n\ud83d\ude00 changed\r\nlast';
    assert.deepStrictEqual(
        computeTreeEdit(oldCrlf, newCrlf),
        expectedEdit(
            oldCrlf,
            newCrlf,
            oldCrlf.indexOf('value'),
            oldCrlf.indexOf('value') + 'value'.length,
            newCrlf.indexOf('changed') + 'changed'.length
        )
    );

    const emojiOld = 'prefix \ud83d\ude00 suffix';
    const emojiNew = 'prefix \ud83d\ude03 suffix';
    assert.deepStrictEqual(
        computeTreeEdit(emojiOld, emojiNew),
        expectedEdit(emojiOld, emojiNew, 7, 9, 9)
    );

    const loneOld = 'a\ud83db';
    const loneNew = 'a\ud83dc';
    assert.deepStrictEqual(
        computeTreeEdit(loneOld, loneNew),
        expectedEdit(loneOld, loneNew, 2, 3, 3)
    );
}

function comparableDocument(document: HdlDocument): unknown {
    return {
        modules: document.modules,
        ports: document.modules.map(module => module.ports),
        instances: document.modules.map(module => module.instances),
        diagnostics: document.diagnostics,
        interfaces: document.interfaces,
        packages: document.packages,
        directives: document.directives,
        includes: document.includes,
    };
}

function realClient(): HdlParserClient {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    return new HdlParserClient({
        workerPath: path.join(extensionRoot, 'dist', 'workers', 'hdlParserWorker.js'),
        runtimeWasmPath: path.join(extensionRoot, 'media', 'parsers', 'web-tree-sitter.wasm'),
        languageWasmPath: path.join(
            extensionRoot,
            'media',
            'parsers',
            'tree-sitter-systemverilog.wasm'
        ),
    });
}

async function assertIncrementalEqualsFull(
    client: HdlParserClient,
    uri: string,
    version1Text: string,
    version1Options: HdlParseOptions,
    version2Text: string,
    version2Options: HdlParseOptions
): Promise<HdlDocument> {
    await withTimeout(
        `${uri} version 1 document parse`,
        client.parse(uri, 1, version1Text, version1Options)
    );
    const incremental = await withTimeout(
        `${uri} version 2 incremental parse`,
        client.parse(uri, 2, version2Text, version2Options)
    );
    const full = await withTimeout(`${uri} version 2 full parse`, client.parse(uri, 2, version2Text, {
        ...version2Options,
        cacheMode: 'ephemeral',
    }));
    assert.deepStrictEqual(comparableDocument(incremental), comparableDocument(full));
    return incremental;
}

async function testRealWorkerIncrementalEquivalenceAndLru(): Promise<void> {
    const client = realClient();
    try {
        const localUri = 'file:///workspace/local-define.sv';
        const localV1 = [
            '`define SELECT_A 1',
            '`ifdef SELECT_A',
            'module selected(input logic a); child_a u_child(.a(a)); endmodule',
            '`else',
            'module fallback(input logic b); child_b u_child(.b(b)); endmodule',
            '`endif',
        ].join('\n');
        const localV2 = localV1.replace('`define SELECT_A 1', '`define OTHER 1');
        const local = await assertIncrementalEqualsFull(
            client, localUri, localV1, { defines: {} }, localV2, { defines: {} }
        );
        assert.deepStrictEqual(local.modules.map(module => module.name), ['fallback']);

        const unicodeUri = 'file:///workspace/inactive-unicode.sv';
        const unicodeV1 = [
            '`ifdef OFF',
            '// 信号 \ud83d\ude00 inactive',
            'module hidden; endmodule',
            '`else',
            'module visible(input logic clk); endmodule',
            '`endif',
        ].join('\r\n');
        const unicodeV2 = unicodeV1.replace('// 信号 \ud83d\ude00', '// X信号 \ud83d\ude03');
        const unicode = await assertIncrementalEqualsFull(
            client, unicodeUri, unicodeV1, { defines: {} }, unicodeV2, { defines: {} }
        );
        assert.deepStrictEqual(unicode.modules.map(module => module.name), ['visible']);

        const runtimeUnitsUri = 'file:///workspace/runtime-edit-units.sv';
        const emojiPrefix = '\ud83d\ude00'.repeat(20);
        const runtimeUnitsV1 = [
            `module runtime_units; // ${emojiPrefix}`,
            'wire old_net;',
            'endmodule',
        ].join('\n');
        const runtimeUnitsV2 = runtimeUnitsV1.replace('wire old_net;', 'child u_child();');
        const runtimeUnits = await assertIncrementalEqualsFull(
            client,
            runtimeUnitsUri,
            runtimeUnitsV1,
            { defines: {} },
            runtimeUnitsV2,
            { defines: {} }
        );
        assert.deepStrictEqual(
            runtimeUnits.modules[0].instances.map(instance => instance.instanceName),
            ['u_child']
        );

        const includeDefineUri = 'file:///workspace/include-define.sv';
        const defsUri = 'file:///workspace/defs.svh';
        const parentSource = [
            '`include "defs.svh"',
            '`ifdef USE_FAST',
            'module fast(input logic fast_in); endmodule',
            '`else',
            'module slow(input logic slow_in); endmodule',
            '`endif',
        ].join('\n');
        const defineOptions = (text: string): HdlParseOptions => ({
            defines: {},
            resolvedIncludes: [{
                fromUri: includeDefineUri,
                rawPath: 'defs.svh',
                resolvedUri: defsUri,
                text,
            }],
        });
        const includedDefine = await assertIncrementalEqualsFull(
            client,
            includeDefineUri,
            parentSource,
            defineOptions('`define USE_FAST 1\n'),
            parentSource,
            defineOptions('`define USE_SLOW 1\n')
        );
        assert.deepStrictEqual(includedDefine.modules.map(module => module.name), ['slow']);

        const fragmentsUri = 'file:///workspace/fragments.sv';
        const portsUri = 'file:///workspace/ports.svh';
        const bodyUri = 'file:///workspace/body.svh';
        const fragmentsParent = [
            'module fragments (',
            '`include "ports.svh"',
            ');',
            '`include "body.svh"',
            'endmodule',
        ].join('\n');
        const fragmentOptions = (ports: string, body: string): HdlParseOptions => ({
            defines: {},
            resolvedIncludes: [
                {
                    fromUri: fragmentsUri,
                    rawPath: 'ports.svh',
                    resolvedUri: portsUri,
                    text: ports,
                },
                {
                    fromUri: fragmentsUri,
                    rawPath: 'body.svh',
                    resolvedUri: bodyUri,
                    text: body,
                },
            ],
        });
        const fragments = await assertIncrementalEqualsFull(
            client,
            fragmentsUri,
            fragmentsParent,
            fragmentOptions('input logic clk', 'child u_old(.clk(clk));'),
            fragmentsParent,
            fragmentOptions(
                'input logic clk, output logic done',
                'child u_new(.clk(clk), .done(done));'
            )
        );
        assert.deepStrictEqual(fragments.modules[0].ports.map(port => port.name), ['clk', 'done']);
        assert.deepStrictEqual(
            fragments.modules[0].instances.map(instance => instance.instanceName),
            ['u_new']
        );

        for (let index = 0; index < 9; index++) {
            const uri = `file:///workspace/lru-${index}.sv`;
            const document = await withTimeout(`LRU document ${index}`, client.parse(
                uri,
                1,
                `module lru_${index}(input logic p${index}); endmodule`,
                { defines: {} },
                'background'
            ));
            assert.strictEqual(document.modules[0].name, `lru_${index}`);
        }
        const reparsed = await withTimeout('LRU evicted document reparse', client.parse(
            'file:///workspace/lru-0.sv',
            2,
            'module lru_zero(output logic done); endmodule',
            { defines: {} }
        ));
        assert.strictEqual(reparsed.modules[0].name, 'lru_zero');
        assert.deepStrictEqual(reparsed.modules[0].ports.map(port => port.name), ['done']);
    } finally {
        await client.dispose();
    }
}

async function testRealWorkerDisposeExitsNaturally(): Promise<void> {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const worker = new Worker(
        path.join(extensionRoot, 'dist', 'workers', 'hdlParserWorker.js'),
        {
            workerData: {
                runtimeWasmPath: path.join(
                    extensionRoot,
                    'media',
                    'parsers',
                    'web-tree-sitter.wasm'
                ),
                languageWasmPath: path.join(
                    extensionRoot,
                    'media',
                    'parsers',
                    'tree-sitter-systemverilog.wasm'
                ),
            },
        }
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
        await withTimeout('dispose fixture first worker response', new Promise<void>((resolve, reject) => {
            worker.once('message', (response: ParserWorkerResponse) => {
                if (response.type === 'failed') {
                    reject(new Error(response.message));
                    return;
                }
                worker.postMessage({ type: 'dispose' } satisfies ParserWorkerRequest);
                resolve();
            });
            worker.once('error', reject);
            worker.postMessage({
                type: 'parse',
                requestId: 'dispose-fixture',
                uri: 'file:///workspace/dispose.sv',
                version: 1,
                text: 'module dispose_fixture; endmodule',
                priority: 'interactive',
                options: { defines: {} },
            } satisfies ParserWorkerRequest);
        }));
        const exitCode = await new Promise<number>((resolve, reject) => {
            timeout = setTimeout(
                () => reject(new Error('HDL parser worker did not exit after dispose')),
                15_000
            );
            worker.once('error', reject);
            worker.once('exit', resolve);
        });
        assert.strictEqual(exitCode, 0);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        await worker.terminate();
    }
}

async function main(): Promise<void> {
    testComputeTreeEdit();
    await testCacheIdentityCancellationAndPriorities();
    await testFingerprintCanonicalizationAndEphemeralIsolation();
    await testStaleResponsesFailuresAndWorkerReplacement();
    await testInvalidationClearAndDispose();
    await testParseTransportFailureRejectsGenerationAndRetries();
    await testDisposeIgnoresTransportAndTerminationFailures();
    await testCancelTransportFailureStillRejectsAndRestarts();
    await testRealWorkerIncrementalEquivalenceAndLru();
    await testRealWorkerDisposeExitsNaturally();
    console.log('HDL parser client tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
