import assert from 'node:assert/strict';
import test from 'node:test';

import type { HdlDocument } from '@veriflow/hdl-core/model';
import {
    HdlParserCancelledError,
    HdlParserClient,
    HdlParserDisposedError,
    type WorkerLike,
} from '@veriflow/hdl-runtime/parserClient';
import { ParserRequestQueue } from '@veriflow/hdl-runtime/parserQueue';
import type {
    ParserWorkerRequest,
    ParserWorkerResponse,
} from '@veriflow/hdl-runtime/protocol';

type WorkerEvent = 'message' | 'error' | 'exit';
type WorkerListener = (...values: any[]) => void;

class FakeWorker implements WorkerLike {
    readonly messages: ParserWorkerRequest[] = [];
    terminateCalls = 0;
    private readonly listeners = new Map<WorkerEvent, Set<WorkerListener>>();

    postMessage(message: ParserWorkerRequest): void {
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
        return Promise.resolve(0);
    }

    respond(response: ParserWorkerResponse): void {
        for (const listener of this.listeners.get('message') ?? []) {
            listener(response);
        }
    }
}

function document(uri: string, version: number): HdlDocument {
    return {
        uri,
        version,
        languageId: 'systemverilog',
        textHash: 'hash',
        lineEnding: '\n',
        preprocessingFingerprint: 'fingerprint',
        modules: [],
        interfaces: [],
        packages: [],
        directives: [],
        includes: [],
        diagnostics: [],
    };
}

test('queue prioritizes interactive work and supports cancellation', () => {
    type Request = { requestId: string; priority: 'interactive' | 'background' };
    const queue = new ParserRequestQueue<Request>();
    const background: Request = { requestId: 'background', priority: 'background' };
    const cancelled: Request = { requestId: 'cancelled', priority: 'background' };
    const interactive: Request = { requestId: 'interactive', priority: 'interactive' };

    queue.enqueue(background);
    queue.enqueue(cancelled);
    queue.enqueue(interactive);

    assert.equal(queue.cancel(cancelled.requestId), true);
    assert.equal(queue.cancel('missing'), false);
    assert.equal(queue.size, 2);
    assert.equal(queue.takeNext(), interactive);
    assert.deepEqual(queue.clear(), [background]);
    assert.equal(queue.size, 0);
});

test('parser client shares document parses and disposes its worker', async () => {
    const workers: FakeWorker[] = [];
    const client = new HdlParserClient({
        workerPath: 'parser-worker.js',
        runtimeWasmPath: 'runtime.wasm',
        languageWasmPath: 'language.wasm',
        createWorker: () => {
            const worker = new FakeWorker();
            workers.push(worker);
            return worker;
        },
    });
    const uri = 'file:///workspace/top.sv';
    const first = client.parse(uri, 1, 'module top; endmodule', { defines: {} });
    const duplicate = client.parse(uri, 1, 'module top; endmodule', { defines: {} });

    assert.equal(first, duplicate);
    assert.equal(workers.length, 1);
    const request = workers[0].messages[0];
    assert.equal(request.type, 'parse');
    if (request.type !== 'parse') {
        assert.fail('expected parse request');
    }
    workers[0].respond({
        type: 'parsed',
        requestId: request.requestId,
        document: document(uri, 1),
    });

    assert.equal((await first).uri, uri);
    await client.dispose();
    assert.equal(workers[0].messages[workers[0].messages.length - 1]?.type, 'dispose');
    assert.equal(workers[0].terminateCalls, 1);
    await assert.rejects(
        client.parse(uri, 2, 'module newer; endmodule', { defines: {} }),
        HdlParserDisposedError
    );
});

test('parser client cancellation rejects and notifies the worker', async () => {
    const worker = new FakeWorker();
    const client = new HdlParserClient({
        workerPath: 'parser-worker.js',
        runtimeWasmPath: 'runtime.wasm',
        languageWasmPath: 'language.wasm',
        createWorker: () => worker,
    });
    const controller = new AbortController();
    const pending = client.parse(
        'file:///workspace/live.sv',
        1,
        'module live; endmodule',
        { defines: {} },
        'interactive',
        controller.signal
    );

    controller.abort();

    await assert.rejects(pending, HdlParserCancelledError);
    assert.deepEqual(worker.messages.slice(-1), [{
        type: 'cancel',
        requestId: 'hdl-1',
    }]);
    await client.dispose();
});
