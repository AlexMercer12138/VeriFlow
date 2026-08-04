import * as assert from 'assert';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';

import { ParserRequestQueue } from '../core/hdl/parserQueue';
import type { HdlDocument, SourceSpan } from '../core/hdl/model';
import type { ParserWorkerResponse } from '../core/hdl/protocol';

const extensionRoot = path.resolve(__dirname, '..', '..');
const workerPath = path.join(extensionRoot, 'dist', 'workers', 'hdlParserWorker.js');
const workerData = {
    runtimeWasmPath: path.join(extensionRoot, 'media', 'parsers', 'web-tree-sitter.wasm'),
    languageWasmPath: path.join(
        extensionRoot,
        'media',
        'parsers',
        'tree-sitter-systemverilog.wasm'
    ),
};

async function parseInWorker(
    requestId: string,
    uri: string,
    version: number,
    text: string
): Promise<ParserWorkerResponse> {
    const worker = new Worker(workerPath, { workerData });
    let timeout: NodeJS.Timeout | undefined;

    try {
        const response = new Promise<ParserWorkerResponse>((resolve, reject) => {
            timeout = setTimeout(
                () => reject(new Error(`HDL worker timed out for request ${requestId}`)),
                15_000
            );
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => {
                if (code !== 0) {
                    reject(new Error(`HDL worker exited with code ${code}`));
                }
            });
        });

        worker.postMessage({
            type: 'parse',
            requestId,
            uri,
            version,
            text,
            priority: 'interactive',
        });
        return await response;
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        await worker.terminate();
    }
}

async function expectNoWorkerMessages(
    label: string,
    send: (worker: Worker) => void,
    waitMilliseconds: number
): Promise<void> {
    const worker = new Worker(workerPath, { workerData });
    let timeout: NodeJS.Timeout | undefined;

    try {
        await new Promise<void>((resolve, reject) => {
            timeout = setTimeout(resolve, waitMilliseconds);
            worker.once('message', message => {
                reject(new Error(`${label} unexpectedly received ${JSON.stringify(message)}`));
            });
            worker.once('error', reject);
            worker.once('exit', code => {
                reject(new Error(`${label} worker exited unexpectedly with code ${code}`));
            });
            send(worker);
        });
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        await worker.terminate();
    }
}

function sliceSpan(text: string, span: SourceSpan): string {
    return text.slice(span.start, span.end);
}

function parsedDocument(response: ParserWorkerResponse): HdlDocument {
    if (response.type === 'failed') {
        assert.fail(response.message);
    }
    return response.document;
}

function testQueueScheduling(): void {
    type QueuedRequest = {
        requestId: string;
        priority: 'interactive' | 'background';
    };
    const queue = new ParserRequestQueue<QueuedRequest>();
    const backgroundOne: QueuedRequest = { requestId: 'b1', priority: 'background' };
    const backgroundTwo: QueuedRequest = { requestId: 'b2', priority: 'background' };
    const interactiveOne: QueuedRequest = { requestId: 'i1', priority: 'interactive' };

    queue.enqueue(backgroundOne);
    queue.enqueue(backgroundTwo);
    queue.enqueue(interactiveOne);
    assert.strictEqual(queue.size, 3);
    assert.strictEqual(queue.cancel('b2'), true);
    assert.strictEqual(queue.cancel('missing'), false);
    assert.strictEqual(queue.size, 2);
    assert.strictEqual(queue.takeNext(), interactiveOne);
    assert.strictEqual(queue.takeNext(), backgroundOne);
    assert.strictEqual(queue.takeNext(), undefined);
    assert.strictEqual(queue.size, 0);

    const interactiveTwo: QueuedRequest = { requestId: 'i2', priority: 'interactive' };
    const interactiveThree: QueuedRequest = { requestId: 'i3', priority: 'interactive' };
    const backgroundThree: QueuedRequest = { requestId: 'b3', priority: 'background' };
    queue.enqueue(interactiveTwo);
    queue.enqueue(interactiveThree);
    queue.enqueue(backgroundThree);
    assert.deepStrictEqual(queue.clear(), [interactiveTwo, interactiveThree, backgroundThree]);
    assert.strictEqual(queue.size, 0);

    const remainingQueue = new ParserRequestQueue<QueuedRequest>();
    const backgroundFour: QueuedRequest = { requestId: 'b4', priority: 'background' };
    const backgroundFive: QueuedRequest = { requestId: 'b5', priority: 'background' };
    const backgroundSix: QueuedRequest = { requestId: 'b6', priority: 'background' };
    const interactiveFour: QueuedRequest = { requestId: 'i4', priority: 'interactive' };
    remainingQueue.enqueue(backgroundFour);
    remainingQueue.enqueue(backgroundFive);
    remainingQueue.enqueue(backgroundSix);
    assert.strictEqual(remainingQueue.takeNext(), backgroundFour);
    assert.strictEqual(remainingQueue.cancel('b5'), true);
    remainingQueue.enqueue(interactiveFour);
    assert.deepStrictEqual(remainingQueue.clear(), [interactiveFour, backgroundSix]);
    assert.strictEqual(remainingQueue.size, 0);
}

function testQueueLargeDrain(): void {
    const requestCount = 100_000;
    const queue = new ParserRequestQueue<{
        requestId: string;
        priority: 'background';
    }>();
    for (let index = 0; index < requestCount; index++) {
        queue.enqueue({ requestId: String(index), priority: 'background' });
    }

    const started = performance.now();
    for (let index = 0; index < requestCount; index++) {
        assert.strictEqual(queue.takeNext()?.requestId, String(index));
    }
    const elapsed = performance.now() - started;

    assert.strictEqual(queue.takeNext(), undefined);
    assert.strictEqual(queue.size, 0);
    assert.ok(elapsed < 4_000, `draining ${requestCount} requests took ${elapsed}ms`);
}

async function testRealWasmParse(): Promise<void> {
    const uri = 'memory:/top.sv';
    const source = '// \u4fe1\u53f7\ud83d\ude00\r\nmodule top(input logic clk);\r\nendmodule';
    const response = await parseInWorker('1', uri, 7, source);

    assert.strictEqual(response.requestId, '1');
    const document = parsedDocument(response);
    assert.strictEqual(document.uri, uri);
    assert.strictEqual(document.version, 7);
    assert.strictEqual(document.languageId, 'systemverilog');
    assert.strictEqual(document.lineEnding, '\r\n');
    assert.match(document.textHash, /^[0-9a-f]{64}$/);
    assert.strictEqual(document.preprocessingFingerprint, 'none');
    assert.strictEqual(document.modules.length, 1);
    assert.deepStrictEqual(document.interfaces, []);
    assert.deepStrictEqual(document.packages, []);
    assert.deepStrictEqual(document.directives, []);
    assert.deepStrictEqual(document.includes, []);
    assert.deepStrictEqual(document.diagnostics, []);

    const module = document.modules[0];
    assert.strictEqual(module.name, 'top');
    assert.strictEqual(module.declarationStyle, 'ansi');
    assert.ok(module.id);
    for (const span of [
        module.nameSpan,
        module.declarationSpan,
        module.headerSpan,
        module.bodySpan,
        module.declarationRegionSpan,
        module.endmoduleSpan,
    ]) {
        assert.strictEqual(span.uri, uri);
        assert.ok(span.start <= span.end);
    }
    assert.strictEqual(sliceSpan(source, module.nameSpan), 'top');
    assert.strictEqual(
        sliceSpan(source, module.declarationSpan),
        'module top(input logic clk);\r\nendmodule'
    );
    assert.strictEqual(sliceSpan(source, module.headerSpan), 'module top(input logic clk);');
    assert.strictEqual(sliceSpan(source, module.bodySpan), '\r\n');
    assert.strictEqual(sliceSpan(source, module.declarationRegionSpan), '\r\n');
    assert.strictEqual(sliceSpan(source, module.endmoduleSpan), 'endmodule');
    assert.deepStrictEqual(module.parameters, []);
    assert.deepStrictEqual(module.localParameters, []);
    assert.deepStrictEqual(module.ports, []);
    assert.deepStrictEqual(module.portDeclarationGroups, []);
    assert.deepStrictEqual(module.instances, []);
    assert.deepStrictEqual(module.instanceDeclarationGroups, []);
}

async function testErrorDiagnosticUsesUtf16Span(): Promise<void> {
    const uri = 'memory:/broken.v';
    const source = '// \u4fe1\u53f7\ud83d\ude00\nmodule broken; @@@ endmodule';
    const response = await parseInWorker('invalid', uri, 2, source);

    const document = parsedDocument(response);
    assert.strictEqual(document.languageId, 'verilog');
    const diagnostic = document.diagnostics.find(
        item => item.code === 'systemverilog.syntax-error'
    );
    assert.ok(diagnostic, 'expected an ERROR-node diagnostic');
    assert.strictEqual(document.diagnostics.length, 1);
    assert.strictEqual(diagnostic.severity, 'error');
    assert.ok(diagnostic.span);
    assert.strictEqual(diagnostic.span.uri, uri);
    assert.ok(diagnostic.span.start >= source.indexOf('@'));
    assert.ok(sliceSpan(source, diagnostic.span).includes('@'));
}

async function testMissingSyntaxDiagnostics(): Promise<void> {
    const cases = [
        {
            requestId: 'missing-name',
            source: '// \u4fe1\u53f7\ud83d\ude00\nmodule ; endmodule',
            missingType: 'simple_identifier',
            moduleNames: [],
            expectedOffset: '// \u4fe1\u53f7\ud83d\ude00\nmodule'.length,
        },
        {
            requestId: 'missing-semicolon',
            source: 'module missing_semicolon(input logic clk) endmodule',
            missingType: ';',
            moduleNames: ['missing_semicolon'],
            expectedOffset: 'module missing_semicolon(input logic clk)'.length,
        },
    ];

    for (const fixture of cases) {
        const uri = `memory:/${fixture.requestId}.sv`;
        const document = parsedDocument(
            await parseInWorker(fixture.requestId, uri, 1, fixture.source)
        );
        const missing = document.diagnostics.filter(
            diagnostic => diagnostic.code === 'systemverilog.missing-syntax'
        );

        assert.strictEqual(missing.length, 1);
        assert.strictEqual(document.diagnostics.length, 1);
        assert.strictEqual(
            missing[0].message,
            `Missing SystemVerilog syntax: ${fixture.missingType}`
        );
        assert.ok(missing[0].span);
        assert.strictEqual(missing[0].span.start, missing[0].span.end);
        assert.strictEqual(missing[0].span.start, fixture.expectedOffset);
        assert.strictEqual(missing[0].span.uri, uri);
        assert.deepStrictEqual(
            document.modules.map(module => module.name),
            fixture.moduleNames
        );
        assert.ok(document.modules.every(module => module.name.length > 0));
    }
}

async function testEndLabelSkipsComments(): Promise<void> {
    const source = 'module top; endmodule /* comment */ : labeled';
    const document = parsedDocument(
        await parseInWorker('end-label', 'memory:/end-label.sv', 1, source)
    );

    assert.strictEqual(document.modules.length, 1);
    assert.strictEqual(document.modules[0].endLabel, 'labeled');
}

async function testDisposeSuppressesResponses(): Promise<void> {
    await expectNoWorkerMessages('dispose during initialization', worker => {
        worker.postMessage({
            type: 'parse',
            requestId: 'dispose-running',
            uri: 'memory:/dispose-running.sv',
            version: 1,
            text: 'module dispose_running; endmodule',
            priority: 'interactive',
        });
        worker.postMessage({ type: 'dispose' });
    }, 1_200);

    await expectNoWorkerMessages('parse after dispose', worker => {
        worker.postMessage({ type: 'dispose' });
        worker.postMessage({
            type: 'parse',
            requestId: 'after-dispose',
            uri: 'memory:/after-dispose.sv',
            version: 1,
            text: 'module after_dispose; endmodule',
            priority: 'interactive',
        });
    }, 300);
}

async function main(): Promise<void> {
    testQueueScheduling();
    testQueueLargeDrain();
    await testRealWasmParse();
    await testErrorDiagnosticUsesUtf16Span();
    await testMissingSyntaxDiagnostics();
    await testEndLabelSkipsComments();
    await testDisposeSuppressesResponses();
    console.log('HDL worker tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
