import { parentPort, workerData } from 'worker_threads';
// The ESM export relies on import.meta.url, which is unavailable in this CJS worker bundle.
import TreeSitter = require('web-tree-sitter');

import { ParserRequestQueue } from './parserQueue';
import {
    ParseRequest,
    ParserWorkerRequest,
    ParserWorkerResponse,
} from './protocol';
import { adaptTree } from './treeSitterAdapter';

if (!parentPort) {
    throw new Error('HDL parser worker requires a parent port');
}
const port = parentPort;

let parserPromise: Promise<TreeSitter.Parser> | undefined;
const queue = new ParserRequestQueue<ParseRequest>();
const cancelled = new Set<string>();
let running = false;
let runningRequestId: string | undefined;
let disposed = false;

function getParser(): Promise<TreeSitter.Parser> {
    if (!parserPromise) {
        parserPromise = (async () => {
            await TreeSitter.Parser.init({
                locateFile: () => workerData.runtimeWasmPath,
            });
            const language = await TreeSitter.Language.load(workerData.languageWasmPath);
            if (language.abiVersion !== 15) {
                throw new Error(`Unexpected SystemVerilog ABI ${language.abiVersion}`);
            }
            return new TreeSitter.Parser().setLanguage(language);
        })();
    }
    return parserPromise;
}

function post(response: ParserWorkerResponse): void {
    port.postMessage(response);
}

async function pump(): Promise<void> {
    if (disposed || running) {
        return;
    }

    const request = queue.takeNext();
    if (!request) {
        return;
    }

    running = true;
    runningRequestId = request.requestId;
    try {
        const parser = await getParser();
        const tree = parser.parse(request.text);
        if (!tree) {
            throw new Error('SystemVerilog parser returned no tree');
        }

        try {
            const document = adaptTree(tree, request);
            if (!cancelled.has(request.requestId)) {
                post({
                    type: 'parsed',
                    requestId: request.requestId,
                    document,
                });
            }
        } finally {
            tree.delete();
        }
    } catch (error) {
        if (!cancelled.has(request.requestId)) {
            post({
                type: 'failed',
                requestId: request.requestId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    } finally {
        cancelled.delete(request.requestId);
        running = false;
        runningRequestId = undefined;
        void pump();
    }
}

port.on('message', (request: ParserWorkerRequest) => {
    switch (request.type) {
        case 'cancel':
            if (queue.cancel(request.requestId)) {
                return;
            }
            if (runningRequestId === request.requestId) {
                cancelled.add(request.requestId);
            }
            return;
        case 'dispose':
            disposed = true;
            queue.clear();
            return;
        case 'parse':
            if (!disposed) {
                queue.enqueue(request);
                void pump();
            }
            return;
    }
});
