import { createHash } from 'crypto';
import { Worker } from 'worker_threads';

import type { HdlDocument } from './model';
import { preprocessingFingerprint } from './preprocessor';
import type {
    HdlParseOptions,
    ParsePriority,
    ParserWorkerRequest,
    ParserWorkerResponse,
} from './protocol';

type MessageListener = (message: ParserWorkerResponse) => void;
type ErrorListener = (error: Error) => void;
type ExitListener = (code: number) => void;

export interface WorkerLike {
    postMessage(message: ParserWorkerRequest): void;
    on(event: 'message', listener: MessageListener): this;
    on(event: 'error', listener: ErrorListener): this;
    on(event: 'exit', listener: ExitListener): this;
    off?(event: 'message', listener: MessageListener): this;
    off?(event: 'error', listener: ErrorListener): this;
    off?(event: 'exit', listener: ExitListener): this;
    removeListener?(event: 'message', listener: MessageListener): this;
    removeListener?(event: 'error', listener: ErrorListener): this;
    removeListener?(event: 'exit', listener: ExitListener): this;
    terminate(): number | Promise<number>;
}

export type HdlParserClientOptions = {
    workerPath: string;
    runtimeWasmPath: string;
    languageWasmPath: string;
    createWorker?: (path: string, workerData: Record<string, string>) => WorkerLike;
};

type PendingRequest = {
    requestId: string;
    uri: string;
    resolve: (document: HdlDocument) => void;
    reject: (error: Error) => void;
};

type CacheEntry = {
    version: number;
    preprocessingFingerprint: string;
    textHash: string;
    cacheMode: 'document';
    text: string;
    promise: Promise<HdlDocument>;
    requestId: string;
};

type WorkerListeners = {
    message: MessageListener;
    error: ErrorListener;
    exit: ExitListener;
};

export class HdlParserCancelledError extends Error {
    constructor() {
        super('HDL parse cancelled');
        this.name = 'HdlParserCancelledError';
    }
}

export class HdlParserDisposedError extends Error {
    constructor() {
        super('HDL parser client is disposed');
        this.name = 'HdlParserDisposedError';
    }
}

export class HdlParserClient {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly pending = new Map<string, PendingRequest>();
    private worker: WorkerLike | undefined;
    private workerListeners: WorkerListeners | undefined;
    private workerGeneration = 0;
    private nextRequestNumber = 1;
    private disposed = false;
    private disposePromise: Promise<void> | undefined;

    constructor(private readonly options: HdlParserClientOptions) {}

    parse(
        uri: string,
        version: number,
        text: string,
        options: HdlParseOptions,
        priority: ParsePriority = 'interactive'
    ): Promise<HdlDocument> {
        if (this.disposed) {
            return Promise.reject(new HdlParserDisposedError());
        }

        const cacheMode = options.cacheMode ?? 'document';
        const fingerprint = preprocessingFingerprint(options);
        const textHash = createHash('sha256').update(text).digest('hex');
        if (cacheMode === 'document') {
            const cached = this.cache.get(uri);
            if (
                cached
                && cached.version === version
                && cached.preprocessingFingerprint === fingerprint
                && cached.textHash === textHash
                && cached.cacheMode === cacheMode
                && cached.text === text
            ) {
                return cached.promise;
            }
            if (cached) {
                this.cancelRequest(cached.requestId);
                this.cache.delete(uri);
            }
        }

        const worker = this.ensureWorker();
        const requestId = `hdl-${this.nextRequestNumber++}`;
        let resolvePromise!: (document: HdlDocument) => void;
        let rejectPromise!: (error: Error) => void;
        const promise = new Promise<HdlDocument>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        this.pending.set(requestId, {
            requestId,
            uri,
            resolve: resolvePromise,
            reject: rejectPromise,
        });
        if (cacheMode === 'document') {
            this.cache.set(uri, {
                version,
                preprocessingFingerprint: fingerprint,
                textHash,
                cacheMode,
                text,
                promise,
                requestId,
            });
        }

        try {
            worker.postMessage({
                type: 'parse',
                requestId,
                uri,
                version,
                text,
                priority,
                options: { ...options, cacheMode },
            });
        } catch (error) {
            this.handleWorkerFailure(
                worker,
                error instanceof Error ? error : new Error(String(error))
            );
        }
        return promise;
    }

    invalidate(uri: string): void {
        this.cache.delete(uri);
        for (const pending of [...this.pending.values()]) {
            if (pending.uri === uri) {
                this.cancelRequest(pending.requestId);
            }
        }
    }

    clearCache(): void {
        this.cache.clear();
        for (const requestId of [...this.pending.keys()]) {
            this.cancelRequest(requestId);
        }
    }

    dispose(): Promise<void> {
        if (!this.disposePromise) {
            this.disposed = true;
            this.disposePromise = this.disposeWorkerAndState();
        }
        return this.disposePromise;
    }

    private ensureWorker(): WorkerLike {
        if (this.worker) {
            return this.worker;
        }
        const createWorker = this.options.createWorker
            ?? ((workerPath: string, workerData: Record<string, string>) =>
                new Worker(workerPath, { workerData }));
        const worker = createWorker(this.options.workerPath, {
            runtimeWasmPath: this.options.runtimeWasmPath,
            languageWasmPath: this.options.languageWasmPath,
        });
        const generation = ++this.workerGeneration;
        const listeners: WorkerListeners = {
            message: message => {
                if (this.worker === worker && this.workerGeneration === generation) {
                    this.handleMessage(message);
                }
            },
            error: error => {
                if (this.worker === worker && this.workerGeneration === generation) {
                    this.handleWorkerFailure(worker, error);
                }
            },
            exit: code => {
                if (
                    !this.disposed
                    && this.worker === worker
                    && this.workerGeneration === generation
                ) {
                    this.handleWorkerFailure(
                        worker,
                        new Error(`HDL parser worker exited with code ${code}`)
                    );
                }
            },
        };
        worker.on('message', listeners.message);
        worker.on('error', listeners.error);
        worker.on('exit', listeners.exit);
        this.worker = worker;
        this.workerListeners = listeners;
        return worker;
    }

    private handleMessage(response: ParserWorkerResponse): void {
        const pending = this.pending.get(response.requestId);
        if (!pending) {
            return;
        }
        this.pending.delete(response.requestId);
        if (response.type === 'parsed') {
            pending.resolve(response.document);
            return;
        }
        this.dropCacheRequest(response.requestId);
        pending.reject(new Error(response.message));
    }

    private cancelRequest(requestId: string): void {
        const pending = this.pending.get(requestId);
        if (!pending) {
            return;
        }
        this.pending.delete(requestId);
        this.dropCacheRequest(requestId);
        pending.reject(new HdlParserCancelledError());
        const worker = this.worker;
        if (worker) {
            try {
                worker.postMessage({ type: 'cancel', requestId });
            } catch (error) {
                this.handleWorkerFailure(
                    worker,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    }

    private dropCacheRequest(requestId: string): void {
        for (const [uri, entry] of this.cache) {
            if (entry.requestId === requestId) {
                this.cache.delete(uri);
            }
        }
    }

    private handleWorkerFailure(worker: WorkerLike, error: Error): void {
        if (this.worker !== worker) {
            return;
        }
        this.detachWorker(worker);
        this.worker = undefined;
        this.workerListeners = undefined;
        this.cache.clear();
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
        try {
            void Promise.resolve(worker.terminate()).catch(() => undefined);
        } catch {
            // The worker has already failed; termination is a best-effort cleanup.
        }
    }

    private detachWorker(worker: WorkerLike): void {
        const listeners = this.workerListeners;
        if (!listeners) {
            return;
        }
        const remove = worker.off?.bind(worker) ?? worker.removeListener?.bind(worker);
        remove?.('message', listeners.message);
        remove?.('error', listeners.error);
        remove?.('exit', listeners.exit);
    }

    private async disposeWorkerAndState(): Promise<void> {
        this.cache.clear();
        for (const pending of this.pending.values()) {
            pending.reject(new HdlParserDisposedError());
        }
        this.pending.clear();
        const worker = this.worker;
        if (!worker) {
            return;
        }
        try {
            worker.postMessage({ type: 'dispose' });
        } catch {
            // Disposal is best-effort after local state has become terminal.
        }
        try {
            this.detachWorker(worker);
        } catch {
            // A broken transport may also reject listener cleanup.
        } finally {
            this.worker = undefined;
            this.workerListeners = undefined;
        }
        try {
            await Promise.resolve(worker.terminate());
        } catch {
            // The client remains disposed even when worker termination fails.
        }
    }
}
