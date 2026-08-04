import * as path from 'path';
import { Worker } from 'worker_threads';

import type { HdlDocument } from '../../core/hdl/model';
import type { HdlParseOptions, ParserWorkerResponse } from '../../core/hdl/protocol';

export async function parseWithRealWorker(
    uri: string,
    text: string,
    options: HdlParseOptions = { defines: {} }
): Promise<HdlDocument> {
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
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
        const response = await new Promise<ParserWorkerResponse>((resolve, reject) => {
            let settled = false;
            const finish = (callback: () => void): void => {
                if (!settled) {
                    settled = true;
                    callback();
                }
            };

            timeout = setTimeout(
                () => finish(() => reject(new Error(`HDL fixture worker timed out for ${uri}`))),
                15_000
            );
            worker.once('message', message => finish(() => resolve(message)));
            worker.once('error', error => finish(() => reject(error)));
            worker.once('exit', code => {
                finish(() => reject(new Error(
                    `HDL fixture worker exited before responding with code ${code}`
                )));
            });

            worker.postMessage({
                type: 'parse',
                requestId: 'fixture',
                uri,
                version: 1,
                text,
                priority: 'interactive',
                options,
            });
        });

        if (response.type === 'failed') {
            throw new Error(response.message);
        }
        return response.document;
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        await worker.terminate();
    }
}
