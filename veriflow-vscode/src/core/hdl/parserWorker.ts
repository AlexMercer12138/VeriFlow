import { createHash } from 'crypto';
import { parentPort, workerData } from 'worker_threads';
// The ESM export relies on import.meta.url, which is unavailable in this CJS worker bundle.
import TreeSitter = require('web-tree-sitter');

import { ParserRequestQueue } from './parserQueue';
import { preprocessForParsing } from './preprocessor';
import {
    HdlParseOptions,
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

function canRespond(requestId: string): boolean {
    return !disposed && !cancelled.has(requestId);
}

function canonicalizeUri(uri: string): string {
    try {
        const parsed = new URL(uri);
        const protocol = parsed.protocol.toLowerCase();
        const host = parsed.host.toLowerCase();
        const pathname = protocol === 'file:'
            ? parsed.pathname.toLowerCase()
            : parsed.pathname;
        return `${protocol}//${host}${pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return uri.split('\\').join('/');
    }
}

function preprocessingFingerprint(options: HdlParseOptions): string {
    const defines = Object.entries(options.defines)
        .sort(([left], [right]) => left.localeCompare(right));
    const includes = (options.resolvedIncludes ?? []).map(include => ({
        fromUri: canonicalizeUri(include.fromUri),
        rawPath: include.rawPath,
        resolvedUri: canonicalizeUri(include.resolvedUri),
        contentHash: createHash('sha256').update(include.text).digest('hex'),
    })).sort((left, right) =>
        left.fromUri.localeCompare(right.fromUri)
        || left.rawPath.localeCompare(right.rawPath)
        || left.resolvedUri.localeCompare(right.resolvedUri)
        || left.contentHash.localeCompare(right.contentHash)
    );
    return createHash('sha256').update(JSON.stringify({
        defines,
        includes,
        maxIncludeDepth: options.maxIncludeDepth ?? 32,
    })).digest('hex');
}

function compareDiagnostics(
    left: ReturnType<typeof preprocessForParsing>['diagnostics'][number],
    right: ReturnType<typeof preprocessForParsing>['diagnostics'][number]
): number {
    return (left.span?.uri ?? '').localeCompare(right.span?.uri ?? '')
        || (left.span?.start ?? Number.MAX_SAFE_INTEGER)
            - (right.span?.start ?? Number.MAX_SAFE_INTEGER)
        || (left.span?.end ?? Number.MAX_SAFE_INTEGER)
            - (right.span?.end ?? Number.MAX_SAFE_INTEGER)
        || left.code.localeCompare(right.code)
        || left.message.localeCompare(right.message);
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
        if (disposed) {
            return;
        }
        const options = request.options ?? { defines: {} };
        const preprocessed = preprocessForParsing(request.uri, request.text, options);
        const tree = parser.parse(preprocessed.text);
        if (!tree) {
            throw new Error('SystemVerilog parser returned no tree');
        }

        let document: ReturnType<typeof adaptTree>;
        try {
            document = adaptTree(tree, request, {
                text: preprocessed.text,
                sourceMap: preprocessed.sourceMap,
                sourceTexts: preprocessed.sourceTexts,
            });
        } finally {
            tree.delete();
        }
        document.preprocessingFingerprint = preprocessingFingerprint(options);
        document.diagnostics = [
            ...document.diagnostics,
            ...preprocessed.diagnostics,
        ].sort(compareDiagnostics);
        if (canRespond(request.requestId)) {
            post({
                type: 'parsed',
                requestId: request.requestId,
                document,
            });
        }
    } catch (error) {
        if (canRespond(request.requestId)) {
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
