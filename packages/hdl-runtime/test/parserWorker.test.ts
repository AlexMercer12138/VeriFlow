import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import type { HdlDocument } from '@veriflow/hdl-core/model';
import type {
    ParserWorkerRequest,
    ParserWorkerResponse,
} from '@veriflow/hdl-runtime/protocol';

const packageRoot = path.resolve(__dirname, '..', '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const workerPath = path.join(packageRoot, 'dist', 'parserWorker.js');
const workerData = {
    runtimeWasmPath: path.join(
        workspaceRoot,
        'veriflow-vscode',
        'media',
        'parsers',
        'web-tree-sitter.wasm'
    ),
    languageWasmPath: path.join(
        workspaceRoot,
        'veriflow-vscode',
        'media',
        'parsers',
        'tree-sitter-systemverilog.wasm'
    ),
};

function post(worker: Worker, request: ParserWorkerRequest): void {
    worker.postMessage(request);
}

async function parseDocument(
    text = 'module top(input logic clk); endmodule'
): Promise<HdlDocument> {
    const worker = new Worker(workerPath, { workerData });
    try {
        const response = await new Promise<ParserWorkerResponse>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('HDL runtime worker parse timed out')),
                15_000
            );
            const finish = (callback: () => void): void => {
                clearTimeout(timeout);
                callback();
            };
            worker.once('message', message => finish(() => resolve(message)));
            worker.once('error', error => finish(() => reject(error)));
            post(worker, {
                type: 'parse',
                requestId: 'package-parse',
                uri: 'memory:/top.sv',
                version: 7,
                text,
                priority: 'interactive',
                options: { defines: {} },
            });
        });
        if (response.type === 'failed') {
            throw new Error(response.message);
        }
        return response.document;
    } finally {
        await worker.terminate();
    }
}

test('runtime worker parses with the real WASM grammar', async () => {
    const document = await parseDocument();

    assert.equal(document.uri, 'memory:/top.sv');
    assert.equal(document.version, 7);
    assert.deepEqual(document.modules.map(module => module.name), ['top']);
    assert.match(document.textHash, /^[0-9a-f]{64}$/);
});

test('runtime worker adapts initialized non-ANSI variable output ports', async () => {
    const document = await parseDocument([
        'module vio_digit(probe_out0);',
        "output reg [4 : 0] probe_out0 = 'h00;",
        'endmodule',
    ].join('\n'));

    assert.deepEqual(document.modules[0].ports.map(port => ({
        name: port.name,
        direction: port.direction,
        typeText: port.typeText,
        packedRange: port.packedRange,
        width: port.width,
    })), [{
        name: 'probe_out0',
        direction: 'output',
        typeText: 'reg',
        packedRange: '[4 : 0]',
        width: { kind: 'known', bits: 5 },
    }]);
});

test('runtime worker disposes without sending a response', async () => {
    const worker = new Worker(workerPath, { workerData });

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('HDL runtime worker dispose timed out')),
            15_000
        );
        worker.once('message', message => {
            clearTimeout(timeout);
            reject(new Error(`unexpected worker response: ${JSON.stringify(message)}`));
        });
        worker.once('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        worker.once('exit', code => {
            clearTimeout(timeout);
            code === 0 ? resolve() : reject(new Error(`worker exited with code ${code}`));
        });
        post(worker, { type: 'dispose' });
    });
});
