import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalizeSourceUri } from '@veriflow/hdl-core/preprocessor';
import { HdlParserClient } from '@veriflow/hdl-runtime/parserClient';
import { WorkspaceHdlIndex } from '@veriflow/hdl-runtime/workspaceHdlIndex';
import { WorkspaceIndexStore } from '@veriflow/hdl-runtime/workspaceIndexStore';

const HDL_EXTENSIONS = new Set(['.v', '.sv', '.vh', '.svh']);

class MemoryState {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, structuredClone(value));
        }
        return Promise.resolve();
    }
}

function fileUri(filepath: string): string {
    return canonicalizeSourceUri(pathToFileURL(filepath).toString());
}

async function discoverFiles(root: string): Promise<string[]> {
    let rootStat;
    try {
        rootStat = await stat(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    if (rootStat.isFile()) {
        return HDL_EXTENSIONS.has(path.extname(root).toLowerCase()) ? [fileUri(root)] : [];
    }
    if (!rootStat.isDirectory()) return [];

    const found: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const filepath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            found.push(...await discoverFiles(filepath));
        } else if (entry.isFile() && HDL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            found.push(fileUri(filepath));
        }
    }
    return found;
}

export class NodeWorkspaceHost {
    readonly index: WorkspaceHdlIndex;
    private readonly parser: HdlParserClient;
    private readonly searchDirectories: string[];
    private disposed = false;

    constructor(searchDirectories: string[], defines: Record<string, string | true> = {}) {
        this.searchDirectories = [...new Set(searchDirectories.map(directory => (
            path.resolve(directory)
        )))];
        this.parser = new HdlParserClient({
            workerPath: require.resolve('@veriflow/hdl-runtime/parserWorker'),
            runtimeWasmPath: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
            languageWasmPath: require.resolve(
                'tree-sitter-systemverilog/tree-sitter-systemverilog.wasm'
            ),
        });
        this.index = new WorkspaceHdlIndex({
            parser: this.parser,
            store: new WorkspaceIndexStore(new MemoryState()),
            parserFingerprint: 'veriflow-node-cli-tree-sitter-systemverilog-0.4.0',
            defines,
            findFiles: async roots => {
                const groups = await Promise.all(roots.map(root => discoverFiles(
                    new URL(root).protocol === 'file:' ? fileURLToPath(root) : root
                )));
                return groups.flat();
            },
            readFile: async uri => {
                const filepath = fileURLToPath(uri);
                const [text, metadata] = await Promise.all([
                    readFile(filepath, 'utf8'),
                    stat(filepath),
                ]);
                return {
                    text,
                    version: Math.trunc(metadata.mtimeMs),
                    mtimeMs: metadata.mtimeMs,
                    size: metadata.size,
                };
            },
            includeCandidates: (fromUri, includePath) => this.includeCandidates(
                fromUri,
                includePath
            ),
            resolveInclude: async (_fromUri, _includePath, candidates = []) => {
                for (const candidate of candidates) {
                    try {
                        if ((await stat(fileURLToPath(candidate))).isFile()) return candidate;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                }
                return undefined;
            },
        });
    }

    async scan(signal?: AbortSignal): Promise<void> {
        await this.index.scan(this.searchDirectories.map(fileUri), signal);
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.index.dispose();
        await this.parser.dispose();
    }

    private includeCandidates(fromUri: string, includePath: string): string[] {
        const candidates: string[] = [];
        const seen = new Set<string>();
        const add = (filepath: string): void => {
            const uri = fileUri(filepath);
            if (!seen.has(uri)) {
                seen.add(uri);
                candidates.push(uri);
            }
        };

        if (new URL(fromUri).protocol === 'file:') {
            add(path.resolve(path.dirname(fileURLToPath(fromUri)), includePath));
        }
        for (const directory of this.searchDirectories) {
            add(path.resolve(directory, includePath));
        }
        return candidates;
    }
}
