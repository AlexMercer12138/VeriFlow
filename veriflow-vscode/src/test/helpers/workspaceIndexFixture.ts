import * as path from 'path';

import { HdlParserClient } from '../../core/hdl/parserClient';
import type { HdlParseOptions, ParsePriority } from '../../core/hdl/protocol';
import { canonicalizeSourceUri } from '../../core/hdl/preprocessor';
import { WorkspaceHdlIndex } from '../../core/hdl/workspaceHdlIndex';
import { WorkspaceIndexStore } from '../../core/hdl/workspaceIndexStore';

type ParserCall = {
    uri: string;
    priority: 'interactive' | 'background';
};

type ParserHooks = {
    afterParse?: (call: ParserCall) => void | Promise<void>;
};

class MemoryMemento {
    readonly writes: unknown[] = [];
    private readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        const clone = value === undefined
            ? undefined
            : JSON.parse(JSON.stringify(value)) as unknown;
        this.writes.push(clone);
        if (clone === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, clone);
        }
    }
}

class InstrumentedParser extends HdlParserClient {
    constructor(
        extensionRoot: string,
        private readonly calls: ParserCall[],
        private readonly parseOptions: HdlParseOptions[],
        private readonly hooks: ParserHooks
    ) {
        super({
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

    override async parse(
        uri: string,
        version: number,
        text: string,
        options: HdlParseOptions,
        priority: ParsePriority = 'interactive'
    ) {
        const call = { uri, priority };
        this.calls.push(call);
        this.parseOptions.push(options);
        const document = await super.parse(uri, version, text, options, priority);
        await this.hooks.afterParse?.(call);
        return document;
    }
}

export type WorkspaceIndexHarness = {
    index: WorkspaceHdlIndex;
    files: Map<string, string>;
    parserCalls: Array<{ uri: string; priority: 'interactive' | 'background' }>;
    parserOptions: HdlParseOptions[];
    persistedWrites: unknown[];
    hooks: ParserHooks;
    createIndex(defines?: Record<string, string | true>): WorkspaceHdlIndex;
    dispose(): Promise<void>;
};

export function createWorkspaceIndexHarness(
    initial: Record<string, string>
): WorkspaceIndexHarness {
    const files = new Map<string, string>(Object.entries(initial).map(([uri, text]) => [
        canonicalizeSourceUri(uri),
        text,
    ]));
    const parserCalls: ParserCall[] = [];
    const parserOptions: HdlParseOptions[] = [];
    const hooks: ParserHooks = {};
    const memento = new MemoryMemento();
    const store = new WorkspaceIndexStore(memento);
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const parser = new InstrumentedParser(
        extensionRoot,
        parserCalls,
        parserOptions,
        hooks
    );
    const createIndex = (
        defines: Record<string, string | true> = {}
    ): WorkspaceHdlIndex => new WorkspaceHdlIndex({
        parser,
        store,
        parserFingerprint: 'fixture-parser-v1',
        defines,
        async findFiles(roots: string[]): Promise<string[]> {
            const canonicalRoots = roots.map(root => canonicalizeSourceUri(root));
            return [...files.keys()].filter(uri => canonicalRoots.some(root =>
                uri === root || uri.startsWith(root.endsWith('/') ? root : `${root}/`)
            ));
        },
        async readFile(uri: string) {
            const text = files.get(canonicalizeSourceUri(uri));
            if (text === undefined) {
                throw new Error(`fixture file not found: ${uri}`);
            }
            return {
                text,
                version: 1,
                mtimeMs: 1,
                size: Buffer.byteLength(text),
            };
        },
        async resolveInclude(fromUri: string, includePath: string) {
            let resolved: string;
            try {
                resolved = canonicalizeSourceUri(new URL(includePath, fromUri).toString());
            } catch {
                return undefined;
            }
            return files.has(resolved) ? resolved : undefined;
        },
    });
    const harness: WorkspaceIndexHarness = {
        index: undefined as unknown as WorkspaceHdlIndex,
        files,
        parserCalls,
        parserOptions,
        persistedWrites: memento.writes,
        hooks,
        createIndex,
        dispose: () => parser.dispose(),
    };
    harness.index = createIndex();
    return harness;
}
