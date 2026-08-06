import { parentPort, workerData } from 'worker_threads';

import { VcdIndexCancelled, VcdIndexReader } from './vcdIndex';
import { WaveformCache } from './waveformCache';

type WorkerRequestBase = {
    generation: number;
    requestId?: string;
};

type SearchTarget = {
    reference: string;
    bitIndex?: number;
    order?: number;
};

type WorkerRequest =
    | (WorkerRequestBase & { type: 'openFile'; source: string })
    | (WorkerRequestBase & {
        type: 'windowRequest';
        references: string[];
        start: number;
        end: number;
        pixelWidth: number;
    })
    | (WorkerRequestBase & { type: 'valueRequest'; references: string[]; time: number })
    | (WorkerRequestBase & {
        type: 'searchRequest';
        reference: string;
        bitIndex?: number;
        cursorTime: number;
        direction: number;
        mode: string;
        query?: string;
        targets?: SearchTarget[];
    })
    | (WorkerRequestBase & { type: 'cancelRequest' })
    | (WorkerRequestBase & { type: 'cancelLoad' })
    | (WorkerRequestBase & { type: 'dispose' });

type OpenFileRequest = Extract<WorkerRequest, { type: 'openFile' }>;
type WindowRequest = Extract<WorkerRequest, { type: 'windowRequest' }>;
type ValueRequest = Extract<WorkerRequest, { type: 'valueRequest' }>;
type SearchRequest = Extract<WorkerRequest, { type: 'searchRequest' }>;

if (!parentPort) throw new Error('waveform worker requires a parent port');

const port = parentPort;
const cache = new WaveformCache({ root: workerData?.cacheRoot });
const cancelledLoads = new Set<number>();
const cancelledRequests = new Set<string>();
let activeGeneration = 0;
let reader: VcdIndexReader | undefined;
let readerGeneration = 0;
let indexDir: string | undefined;

function requestKey(generation: number, requestId: unknown): string {
    return `${generation}:${String(requestId)}`;
}

function post(type: string, generation: number, payload: Record<string, unknown> = {}): void {
    port.postMessage({ type, generation, ...payload });
}

function loadCancelled(generation: number): boolean {
    return cancelledLoads.has(generation) || generation !== activeGeneration;
}

function requestCancelled(message: WorkerRequestBase): boolean {
    return message.generation !== readerGeneration ||
        cancelledRequests.has(requestKey(message.generation, message.requestId));
}

async function openFile(message: OpenFileRequest): Promise<void> {
    const generation = message.generation;
    if (activeGeneration && activeGeneration !== generation) cancelledLoads.add(activeGeneration);
    activeGeneration = generation;
    cancelledLoads.delete(generation);
    cancelledRequests.clear();
    let metadataSent = false;
    try {
        const nextIndexDir = await cache.getOrBuild(message.source, {
            onMetadata: metadata => {
                if (loadCancelled(generation)) return;
                metadataSent = true;
                post('waveformMetadata', generation, {
                    fileName: message.source,
                    data: metadata,
                });
            },
            onProgress: progress => {
                if (!loadCancelled(generation)) post('indexProgress', generation, { progress });
            },
            cancelled: () => loadCancelled(generation),
        });
        if (loadCancelled(generation)) {
            cache.release(nextIndexDir);
            return;
        }
        const nextReader = new VcdIndexReader(nextIndexDir);
        if (!metadataSent) {
            post('waveformMetadata', generation, {
                fileName: message.source,
                data: nextReader.metadata,
            });
        }
        reader?.close();
        if (indexDir) cache.release(indexDir);
        reader = nextReader;
        readerGeneration = generation;
        indexDir = nextIndexDir;
        post('indexReady', generation, {
            fileName: message.source,
            data: nextReader.metadata,
        });
    } catch (error) {
        if (error instanceof VcdIndexCancelled || loadCancelled(generation)) {
            post('indexCancelled', generation);
        } else {
            post('reloadFailed', generation, { message: (error as Error).message });
        }
    }
}

function requireReader(message: WorkerRequestBase): VcdIndexReader {
    if (requestCancelled(message)) throw new VcdIndexCancelled();
    if (!reader || readerGeneration !== message.generation) {
        throw new Error('waveform index is not ready');
    }
    return reader;
}

function windowRequest(message: WindowRequest): void {
    const current = requireReader(message);
    const references = Array.isArray(message.references) ? message.references.slice(0, 256) : [];
    let pixelWidth = Math.max(1, Math.min(8192, Math.trunc(message.pixelWidth ?? 1)));
    if (references.length) {
        pixelWidth = Math.min(pixelWidth, Math.max(1, Math.floor(32768 / (2 * references.length))));
    }
    const series = references.map((reference: string) => ({
        reference,
        ...current.queryWindowForReference(
            reference,
            message.start ?? 0,
            message.end ?? 0,
            pixelWidth,
            () => requestCancelled(message)
        ),
    }));
    if (!requestCancelled(message)) {
        post('windowData', message.generation, {
            requestId: message.requestId,
            pixelWidth,
            series,
        });
    }
}

function valueRequest(message: ValueRequest): void {
    const current = requireReader(message);
    const references = Array.isArray(message.references) ? message.references : [];
    const values = current.valuesAt(references, message.time ?? 0);
    if (!requestCancelled(message)) {
        post('cursorValues', message.generation, { requestId: message.requestId, values });
    }
}

function searchRequest(message: SearchRequest): void {
    const current = requireReader(message);
    const targets = Array.isArray(message.targets) && message.targets.length
        ? message.targets
        : [{ reference: message.reference, bitIndex: message.bitIndex, order: 0 }];
    const matches = targets.flatMap((target: SearchTarget) => {
        if (requestCancelled(message)) return [];
        const result = current.search(
            target.reference,
            message.cursorTime ?? 0,
            message.direction ?? 1,
            message.mode ?? 'change',
            message.query ?? '',
            target.bitIndex,
            () => requestCancelled(message)
        );
        return result ? [{ ...result, target }] : [];
    });
    const direction = message.direction ?? 1;
    matches.sort((left, right) => {
        const timeOrder = direction >= 0 ? left.time - right.time : right.time - left.time;
        return timeOrder || Number(left.target.order ?? 0) - Number(right.target.order ?? 0);
    });
    const result = matches[0] ?? null;
    if (!requestCancelled(message)) {
        post('searchResult', message.generation, { requestId: message.requestId, result });
    }
}

async function disposeWorker(): Promise<void> {
    cancelledLoads.add(activeGeneration);
    reader?.close();
    reader = undefined;
    readerGeneration = 0;
    if (indexDir) cache.release(indexDir);
    indexDir = undefined;
    post('disposed', activeGeneration);
    port.close();
}

async function handleMessage(message: WorkerRequest): Promise<void> {
    try {
        if (message.type === 'openFile') await openFile(message);
        else if (message.type === 'windowRequest') windowRequest(message);
        else if (message.type === 'valueRequest') valueRequest(message);
        else if (message.type === 'searchRequest') searchRequest(message);
        else if (message.type === 'cancelRequest') {
            cancelledRequests.add(requestKey(message.generation, message.requestId));
        } else if (message.type === 'cancelLoad') {
            cancelledLoads.add(message.generation);
        } else if (message.type === 'dispose') {
            await disposeWorker();
        }
    } catch (error) {
        if (error instanceof VcdIndexCancelled || requestCancelled(message)) return;
        post('requestError', message.generation, {
            requestId: message.requestId,
            message: (error as Error).message,
        });
    }
}

port.on('message', (message: WorkerRequest) => void handleMessage(message));
