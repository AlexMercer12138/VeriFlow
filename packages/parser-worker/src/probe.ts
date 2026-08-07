import path from 'node:path';
import TreeSitter = require('web-tree-sitter');

const { Language, Parser } = TreeSitter;

const protocolVersion = 1 as const;
const probeType = 'probe' as const;
const expectedLanguageAbi = 15;
const maximumRequestIdBytes = 256;
const maximumSourceBytes = 1024 * 1024;
const maximumJsonLineBytes = 8 * 1024 * 1024;

export type ProbeRequest = {
    protocolVersion: 1;
    requestId: string;
    type: 'probe';
    payload: {
        source: string;
    };
};

export type ProbeResponse = {
    protocolVersion: 1;
    requestId: string;
    type: 'probe';
    ok: true;
    payload: {
        rootType: string;
        containsModule: boolean;
        languageAbi: number;
    };
} | {
    protocolVersion: 1;
    requestId: string;
    type: 'probe';
    ok: false;
    error: {
        code: string;
        message: string;
    };
};

export type ProbeAssets = {
    runtimeWasmPath: string;
    languageWasmPath: string;
};

type BoundedJsonLine = {
    tooLarge: false;
    value: string;
} | {
    tooLarge: true;
};

type ProbeOutput = {
    write(chunk: string): unknown;
};

let runtimeKey: string | undefined;
let runtimePromise: Promise<TreeSitter.Language> | undefined;

function requestIdOf(value: unknown): string {
    if (typeof value !== 'object' || value === null) return 'unknown';
    const requestId = (value as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) return 'unknown';
    return Buffer.byteLength(requestId, 'utf8') <= maximumRequestIdBytes ? requestId : '';
}

function failure(requestId: string, code: string, message: string): ProbeResponse {
    return {
        protocolVersion,
        requestId,
        type: probeType,
        ok: false,
        error: { code, message },
    };
}

function isProbeRequest(value: unknown): value is ProbeRequest {
    if (typeof value !== 'object' || value === null) return false;
    const request = value as Record<string, unknown>;
    if (request.protocolVersion !== protocolVersion
        || request.type !== probeType
        || typeof request.requestId !== 'string'
        || request.requestId.length === 0
        || Buffer.byteLength(request.requestId, 'utf8') > maximumRequestIdBytes
        || typeof request.payload !== 'object'
        || request.payload === null) {
        return false;
    }
    return typeof (request.payload as Record<string, unknown>).source === 'string';
}

async function loadLanguage(assets: ProbeAssets): Promise<TreeSitter.Language> {
    const key = `${path.resolve(assets.runtimeWasmPath)}\0${path.resolve(assets.languageWasmPath)}`;
    if (runtimePromise) {
        if (runtimeKey !== key) {
            throw new Error('Tree-sitter probe runtime is already initialized with different assets');
        }
        return runtimePromise;
    }

    runtimeKey = key;
    runtimePromise = (async () => {
        const runtimeWasmPath = path.resolve(assets.runtimeWasmPath);
        await Parser.init({
            locateFile: (file: string) => file.endsWith('.wasm') ? runtimeWasmPath : file,
        });
        const language = await Language.load(path.resolve(assets.languageWasmPath));
        if (language.abiVersion !== expectedLanguageAbi) {
            throw new Error(
                `Unsupported SystemVerilog language ABI ${language.abiVersion}; expected ${expectedLanguageAbi}`
            );
        }
        return language;
    })();
    return runtimePromise;
}

export async function handleProbeRequest(
    value: unknown,
    assets: ProbeAssets
): Promise<ProbeResponse> {
    const requestId = requestIdOf(value);
    if (!isProbeRequest(value)) {
        return failure(requestId, 'INVALID_REQUEST', 'Expected a protocol version 1 probe request');
    }
    if (Buffer.byteLength(value.payload.source, 'utf8') > maximumSourceBytes) {
        return failure(requestId, 'SOURCE_TOO_LARGE', 'Probe source exceeds the 1 MiB limit');
    }

    try {
        const language = await loadLanguage(assets);
        const parser = new Parser();
        try {
            parser.setLanguage(language);
            const tree = parser.parse(value.payload.source);
            if (!tree) throw new Error('Tree-sitter returned no syntax tree');
            try {
                return {
                    protocolVersion,
                    requestId,
                    type: probeType,
                    ok: true,
                    payload: {
                        rootType: tree.rootNode.type,
                        containsModule: tree.rootNode
                            .descendantsOfType('module_declaration').length > 0,
                        languageAbi: language.abiVersion,
                    },
                };
            } finally {
                tree.delete();
            }
        } finally {
            parser.delete();
        }
    } catch (error) {
        return failure(
            requestId,
            'PROBE_FAILED',
            error instanceof Error ? error.message : String(error)
        );
    }
}

async function* readBoundedJsonLines(
    input: AsyncIterable<Buffer | string>
): AsyncGenerator<BoundedJsonLine> {
    const retained = Buffer.allocUnsafe(maximumJsonLineBytes);
    let retainedBytes = 0;
    let discarding = false;
    let pendingCarriageReturn = false;

    function acceptedLine(): BoundedJsonLine {
        return {
            tooLarge: false,
            value: retained.toString('utf8', 0, retainedBytes),
        };
    }

    function retain(segment: Buffer): void {
        if (discarding || segment.length === 0) return;
        if (segment.length > maximumJsonLineBytes - retainedBytes) {
            retainedBytes = 0;
            discarding = true;
            pendingCarriageReturn = false;
            return;
        }
        segment.copy(retained, retainedBytes);
        retainedBytes += segment.length;
    }

    function retainCarriageReturn(): void {
        if (discarding) return;
        if (retainedBytes === maximumJsonLineBytes) {
            retainedBytes = 0;
            discarding = true;
            return;
        }
        retained[retainedBytes] = 0x0d;
        retainedBytes += 1;
    }

    for await (const inputChunk of input) {
        const chunk = Buffer.isBuffer(inputChunk)
            ? inputChunk
            : Buffer.from(inputChunk, 'utf8');
        const completed: BoundedJsonLine[] = [];
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(0x0a, start);
            const end = newline === -1 ? chunk.length : newline;

            if (pendingCarriageReturn) {
                pendingCarriageReturn = false;
                if (newline !== start) retainCarriageReturn();
            }

            if (!discarding) {
                const hasTrailingCarriageReturn = end > start && chunk[end - 1] === 0x0d;
                retain(chunk.subarray(start, hasTrailingCarriageReturn ? end - 1 : end));
                if (!discarding && newline === -1 && hasTrailingCarriageReturn) {
                    pendingCarriageReturn = true;
                }
            }

            if (newline === -1) break;
            completed.push(discarding ? { tooLarge: true } : acceptedLine());
            retainedBytes = 0;
            discarding = false;
            pendingCarriageReturn = false;
            start = newline + 1;
        }
        for (const line of completed) yield line;
    }

    if (pendingCarriageReturn) retainCarriageReturn();
    if (discarding) {
        yield { tooLarge: true };
    } else if (retainedBytes > 0) {
        yield acceptedLine();
    }
}

export async function runProbeJsonLines(
    input: AsyncIterable<Buffer | string>,
    output: ProbeOutput,
    assets: ProbeAssets
): Promise<void> {
    for await (const line of readBoundedJsonLines(input)) {
        let response: ProbeResponse;
        if (line.tooLarge) {
            response = failure('', 'LINE_TOO_LARGE', 'JSONL line exceeds the 8 MiB limit');
        } else {
            try {
                response = await handleProbeRequest(JSON.parse(line.value), assets);
            } catch (error) {
                response = failure(
                    'unknown',
                    'INVALID_JSON',
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
        output.write(`${JSON.stringify(response)}\n`);
    }
}

async function runJsonLines(): Promise<void> {
    const executableRoot = path.dirname(process.execPath);
    const assets = {
        runtimeWasmPath: path.join(executableRoot, 'web-tree-sitter.wasm'),
        languageWasmPath: path.join(executableRoot, 'tree-sitter-systemverilog.wasm'),
    };
    await runProbeJsonLines(process.stdin, process.stdout, assets);
}

if (require.main === module) {
    void runJsonLines().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
