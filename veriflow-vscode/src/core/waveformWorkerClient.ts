import * as path from 'path';
import { Worker } from 'worker_threads';

export type WaveformWorkerMessage = Record<string, any> & {
    type: string;
    generation: number;
    requestId?: string;
};

export type WaveformWorkerClientOptions = {
    cacheRoot?: string;
    workerPath?: string;
};

export type WindowRequest = {
    references: string[];
    start: number;
    end: number;
    pixelWidth: number;
};

export type SearchRequest = {
    reference: string;
    cursorTime: number;
    direction: number;
    mode: string;
    query?: string;
    bitIndex?: number;
};

export class WaveformWorkerClient {
    private readonly worker: Worker;
    private readonly listeners = new Set<(message: WaveformWorkerMessage) => void>();
    private readonly cancelledRequests = new Set<string>();
    private generationCounter = 0;
    private loadingGeneration = 0;
    private readyGeneration = 0;
    private nextRequestId = 1;
    private disposed = false;

    constructor(options: WaveformWorkerClientOptions = {}) {
        const workerPath = options.workerPath ?? path.join(__dirname, 'waveformWorker.js');
        this.worker = new Worker(workerPath, { workerData: { cacheRoot: options.cacheRoot } });
        this.worker.on('message', (message: WaveformWorkerMessage) => this.handleMessage(message));
        this.worker.on('error', error => {
            this.handleMessage({
                type: 'reloadFailed',
                generation: this.loadingGeneration || this.readyGeneration,
                message: error.message,
            });
        });
    }

    get currentGeneration(): number {
        return this.readyGeneration || this.loadingGeneration;
    }

    get currentLoadingGeneration(): number {
        return this.loadingGeneration;
    }

    onMessage(listener: (message: WaveformWorkerMessage) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private handleMessage(message: WaveformWorkerMessage): void {
        if (this.disposed) return;
        const loadMessage = message.generation === this.loadingGeneration;
        const queryMessage = message.generation === this.readyGeneration;
        if (!loadMessage && !queryMessage) return;
        if (message.requestId && this.cancelledRequests.has(message.requestId)) return;
        if (message.type === 'indexReady' && loadMessage) {
            this.readyGeneration = this.loadingGeneration;
        } else if (
            (message.type === 'reloadFailed' || message.type === 'indexCancelled')
            && loadMessage
            && this.readyGeneration
        ) {
            this.loadingGeneration = this.readyGeneration;
        }
        this.listeners.forEach(listener => listener(message));
    }

    private post(message: Record<string, unknown>): void {
        if (!this.disposed) this.worker.postMessage(message);
    }

    private request(type: string, payload: Record<string, unknown>): string {
        const generation = this.readyGeneration || this.loadingGeneration;
        const requestId = `${generation}:${this.nextRequestId++}`;
        this.post({ type, generation, requestId, ...payload });
        return requestId;
    }

    open(source: string): number {
        if (this.loadingGeneration && this.loadingGeneration !== this.readyGeneration) {
            this.post({ type: 'cancelLoad', generation: this.loadingGeneration });
        }
        this.generationCounter += 1;
        this.loadingGeneration = this.generationCounter;
        this.nextRequestId = 1;
        this.post({
            type: 'openFile',
            generation: this.loadingGeneration,
            source: path.resolve(source),
        });
        return this.loadingGeneration;
    }

    requestWindow(request: WindowRequest): string {
        return this.request('windowRequest', request);
    }

    requestValues(references: string[], time: number): string {
        return this.request('valueRequest', { references, time });
    }

    requestSearch(request: SearchRequest): string {
        return this.request('searchRequest', request);
    }

    cancelRequest(requestId: string): void {
        this.cancelledRequests.add(requestId);
        this.post({
            type: 'cancelRequest',
            generation: this.readyGeneration || this.loadingGeneration,
            requestId,
        });
    }

    cancelLoad(): void {
        this.post({ type: 'cancelLoad', generation: this.loadingGeneration });
    }

    forward(message: Record<string, unknown>): void {
        this.post({
            ...message,
            generation: this.readyGeneration || this.loadingGeneration,
        });
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        const exited = new Promise<void>(resolve => this.worker.once('exit', () => resolve()));
        this.post({
            type: 'dispose',
            generation: this.loadingGeneration || this.readyGeneration,
        });
        await Promise.race([
            exited,
            new Promise<void>(resolve => setTimeout(resolve, 1000)),
        ]);
        this.disposed = true;
        await this.worker.terminate();
        this.listeners.clear();
    }
}
