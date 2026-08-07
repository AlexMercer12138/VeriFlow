import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import TreeSitter = require('web-tree-sitter');
import { handleProbeRequest, runProbeJsonLines } from './probe';

const { Parser } = TreeSitter;
const maximumJsonLineBytes = 8 * 1024 * 1024;

function probeAssets(): { runtimeWasmPath: string; languageWasmPath: string } {
    const runtimeWasmPath = process.env.VERIFLOW_WEB_TREE_SITTER_WASM
        ?? require.resolve('web-tree-sitter/web-tree-sitter.wasm');
    const languageWasmPath = process.env.VERIFLOW_SYSTEMVERILOG_WASM
        ?? require.resolve('tree-sitter-systemverilog/tree-sitter-systemverilog.wasm');
    return { runtimeWasmPath, languageWasmPath };
}

async function captureJsonLines(
    input: AsyncIterable<Buffer | string>
): Promise<ReturnType<JSON['parse']>[]> {
    const output: string[] = [];
    await runProbeJsonLines(input, {
        write(line: string): boolean {
            output.push(line);
            return true;
        },
    }, probeAssets());
    return output.map(line => JSON.parse(line));
}

function sizedInvalidRequest(requestId: string, byteLength = maximumJsonLineBytes): Buffer {
    const prefix = Buffer.from(
        `{"protocolVersion":1,"requestId":"${requestId}","type":"parse",`
        + '"payload":{"source":""},"padding":"'
    );
    const suffix = Buffer.from('"}');
    return Buffer.concat([
        prefix,
        Buffer.alloc(byteLength - prefix.length - suffix.length, 0x61),
        suffix,
    ], byteLength);
}

async function assertExactLimitAccepted(input: Readable, requestId: string): Promise<void> {
    const responses = await captureJsonLines(input);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].requestId, requestId);
    assert.equal(responses[0].error.code, 'INVALID_REQUEST');
}

async function assertLineTooLarge(input: Readable): Promise<void> {
    const responses = await captureJsonLines(input);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].requestId, '');
    assert.equal(responses[0].error.code, 'LINE_TOO_LARGE');
}

test('parses a SystemVerilog module with the pinned WASM language', async () => {
    const response = await handleProbeRequest({
        protocolVersion: 1,
        requestId: 'probe-1',
        type: 'probe',
        payload: {
            source: 'module top(input logic clk); endmodule',
        },
    }, probeAssets());

    assert.equal(response.ok, true);
    assert.equal(response.payload.rootType, 'source_file');
    assert.equal(response.payload.containsModule, true);
    assert.equal(response.payload.languageAbi, 15);
});

test('parses the canonical packaged feasibility module', async () => {
    const response = await handleProbeRequest({
        protocolVersion: 1,
        requestId: 'packaged-feasibility',
        type: 'probe',
        payload: {
            source: 'module packaged; endmodule',
        },
    }, probeAssets());

    assert.equal(response.ok, true);
    assert.equal(response.payload.rootType, 'source_file');
    assert.equal(response.payload.containsModule, true);
    assert.equal(response.payload.languageAbi, 15);
});

test('deletes the parser when setLanguage throws', { concurrency: false }, async () => {
    const originalSetLanguage = Parser.prototype.setLanguage;
    const originalDelete = Parser.prototype.delete;
    let deleteCalls = 0;
    Parser.prototype.setLanguage = function setLanguageFailure(
        this: TreeSitter.Parser,
        _language: TreeSitter.Language | null
    ): TreeSitter.Parser {
        throw new Error('setLanguage test failure');
    };
    Parser.prototype.delete = function trackedDelete(this: TreeSitter.Parser): void {
        deleteCalls += 1;
        originalDelete.call(this);
    };

    try {
        const response = await handleProbeRequest({
            protocolVersion: 1,
            requestId: 'set-language-failure',
            type: 'probe',
            payload: { source: 'module top; endmodule' },
        }, probeAssets());

        assert.equal(response.ok, false);
        if (response.ok) assert.fail('expected a structured error');
        assert.equal(response.error.code, 'PROBE_FAILED');
        assert.match(response.error.message, /setLanguage test failure/);
        assert.equal(deleteCalls, 1);
    } finally {
        Parser.prototype.setLanguage = originalSetLanguage;
        Parser.prototype.delete = originalDelete;
    }
});

test('rejects non-probe requests with a structured error', async () => {
    const response = await handleProbeRequest({
        protocolVersion: 1,
        requestId: 'invalid-1',
        type: 'parse',
        payload: { source: 'module top; endmodule' },
    }, probeAssets());

    assert.equal(response.ok, false);
    if (response.ok) assert.fail('expected a structured error');
    assert.equal(response.error.code, 'INVALID_REQUEST');
});

test('rejects overlong UTF-8 request IDs without echoing them', async () => {
    const requestId = '\u{1F600}'.repeat(65);
    const response = await handleProbeRequest({
        protocolVersion: 1,
        requestId,
        type: 'probe',
        payload: { source: 'module top; endmodule' },
    }, probeAssets());

    assert.equal(response.ok, false);
    if (response.ok) assert.fail('expected a structured error');
    assert.equal(response.error.code, 'INVALID_REQUEST');
    assert.equal(response.requestId, '');
    assert.equal(JSON.stringify(response).includes(requestId), false);
});

test('discards an overlong raw JSONL line and handles the next request', async () => {
    async function* input(): AsyncGenerator<Buffer> {
        yield Buffer.from('{"padding":"');
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        for (let index = 0; index < 129; index += 1) yield chunk;
        yield Buffer.from('"}\r\n');
        yield Buffer.from(`${JSON.stringify({
            protocolVersion: 1,
            requestId: 'after-overflow',
            type: 'probe',
            payload: { source: 'module recovered; endmodule' },
        })}\r\n`);
    }

    const responses = await captureJsonLines(input());

    assert.equal(responses.length, 2);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].requestId, '');
    assert.equal(responses[0].error.code, 'LINE_TOO_LARGE');
    assert.equal(responses[1].ok, true);
    assert.equal(responses[1].requestId, 'after-overflow');
    assert.equal(responses[1].payload.containsModule, true);
});

test('accepts an exact-limit JSONL line with LF', async () => {
    const requestId = 'exact-lf';
    await assertExactLimitAccepted(Readable.from([
        sizedInvalidRequest(requestId),
        Buffer.from('\n'),
    ]), requestId);
});

test('accepts an exact-limit JSONL line with CRLF in one chunk', async () => {
    const requestId = 'exact-crlf';
    await assertExactLimitAccepted(Readable.from([Buffer.concat([
        sizedInvalidRequest(requestId),
        Buffer.from('\r\n'),
    ])]), requestId);
});

test('accepts an exact-limit JSONL line with CR and LF split across chunks', async () => {
    const requestId = 'exact-split-crlf';
    await assertExactLimitAccepted(Readable.from([
        sizedInvalidRequest(requestId),
        Buffer.from('\r'),
        Buffer.from('\n'),
    ]), requestId);
});

test('rejects a JSONL line with one ordinary byte over the limit', async () => {
    await assertLineTooLarge(Readable.from([
        sizedInvalidRequest('ordinary-overflow'),
        Buffer.from('x\n'),
    ]));
});

test('counts a split CR as content when the next byte is not LF', async () => {
    await assertLineTooLarge(Readable.from([
        sizedInvalidRequest('ordinary-cr', maximumJsonLineBytes - 1),
        Buffer.from('\r'),
        Buffer.from('x\n'),
    ]));
});

test('copies a retained tail before requesting the next input chunk', async () => {
    const request = Buffer.from(JSON.stringify({
        protocolVersion: 1,
        requestId: 'retained-tail',
        type: 'probe',
        payload: { source: 'module retained; endmodule' },
    }));
    const parent = Buffer.alloc(32 * 1024 * 1024, 0x20);
    const tailOffset = parent.length - request.length;
    request.copy(parent, tailOffset);

    async function* input(): AsyncGenerator<Buffer> {
        yield parent.subarray(tailOffset);
        parent.fill(0x20, tailOffset);
        yield Buffer.from('\n');
    }

    const responses = await captureJsonLines(input());

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].requestId, 'retained-tail');
    assert.equal(responses[0].payload.containsModule, true);
});

test('copies an incomplete tail before writing an earlier response', async () => {
    const firstLine = Buffer.from('{}\n');
    const secondLine = Buffer.from(JSON.stringify({
        protocolVersion: 1,
        requestId: 'tail-after-response',
        type: 'probe',
        payload: { source: 'module after_response; endmodule' },
    }));
    const parent = Buffer.alloc(32 * 1024 * 1024, 0x20);
    const sliceOffset = parent.length - firstLine.length - secondLine.length;
    const secondLineOffset = sliceOffset + firstLine.length;
    firstLine.copy(parent, sliceOffset);
    secondLine.copy(parent, secondLineOffset);
    const output: string[] = [];

    await runProbeJsonLines(Readable.from([
        parent.subarray(sliceOffset),
        Buffer.from('\n'),
    ]), {
        write(line: string): boolean {
            output.push(line);
            if (output.length === 1) parent.fill(0x20, secondLineOffset);
            return true;
        },
    }, probeAssets());

    const responses = output.map(line => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].error.code, 'INVALID_REQUEST');
    assert.equal(responses[1].ok, true);
    assert.equal(responses[1].requestId, 'tail-after-response');
    assert.equal(responses[1].payload.containsModule, true);
});

test('keeps blank JSONL lines as invalid JSON requests', async () => {
    const responses = await captureJsonLines(Readable.from([Buffer.from('\r\n')]));

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].requestId, 'unknown');
    assert.equal(responses[0].error.code, 'INVALID_JSON');
});

test('rejects source whose UTF-8 encoding is larger than one MiB', async () => {
    const response = await handleProbeRequest({
        protocolVersion: 1,
        requestId: 'large-1',
        type: 'probe',
        payload: { source: '\u{1F600}'.repeat(1024 * 1024 / 4 + 1) },
    }, probeAssets());

    assert.equal(response.ok, false);
    if (response.ok) assert.fail('expected a structured error');
    assert.equal(response.error.code, 'SOURCE_TOO_LARGE');
});
