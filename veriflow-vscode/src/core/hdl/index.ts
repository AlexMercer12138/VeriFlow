import * as path from 'path';

import { HdlParserClient } from './parserClient';

export * from './model';
export {
    HdlParserCancelledError,
    HdlParserClient,
    HdlParserDisposedError,
} from './parserClient';
export type { HdlParserClientOptions, WorkerLike } from './parserClient';
export type { HdlParseOptions, ParsePriority } from './protocol';
export { computeTreeEdit } from './treeEdit';
export type { ParserTreeEdit } from './treeEdit';

export type HdlParserExtensionContext = {
    extensionPath: string;
};

export function createHdlParserClient(
    context: HdlParserExtensionContext
): HdlParserClient {
    return new HdlParserClient({
        workerPath: path.join(
            context.extensionPath,
            'dist',
            'workers',
            'hdlParserWorker.js'
        ),
        runtimeWasmPath: path.join(
            context.extensionPath,
            'media',
            'parsers',
            'web-tree-sitter.wasm'
        ),
        languageWasmPath: path.join(
            context.extensionPath,
            'media',
            'parsers',
            'tree-sitter-systemverilog.wasm'
        ),
    });
}
