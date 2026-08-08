import type {
    WaveformWorkerClient,
    WaveformWorkerMessage,
} from '@veriflow/waveform-runtime/waveformWorkerClient';

type RendererRequest = {
    generation?: number;
    requestId: string;
};

export type WaveformSearchTarget = {
    reference: string;
    bitIndex?: number | null;
    waveIndex?: number;
    name?: string;
    order?: number;
};

export type WaveformRendererMessage =
    | { type: 'ready' }
    | { type: 'cancelRequest'; generation?: number; requestId: string }
    | { type: 'cancelLoad'; generation?: number }
    | { type: 'retryLoad'; generation?: number }
    | (RendererRequest & {
        type: 'windowRequest';
        references: string[];
        start: number;
        end: number;
        pixelWidth: number;
        prefetch?: number;
    })
    | (RendererRequest & {
        type: 'valueRequest';
        references: string[];
        time: number;
    })
    | (RendererRequest & {
        type: 'searchRequest';
        reference?: string;
        targets?: WaveformSearchTarget[];
        cursorTime: number;
        direction: number;
        mode: string;
        query?: string;
        bitIndex?: number;
    });

export interface WaveformRouterTransport {
    send(message: WaveformWorkerMessage): void;
    onMessage(listener: (message: unknown) => void): () => void;
}

export interface WaveformRouterOptions {
    source: string;
    transport: WaveformRouterTransport;
    worker: WaveformWorkerClient;
}

const SEARCH_MODES = new Set(['change', 'rising', 'falling', 'value', 'xz']);
const MAX_REQUEST_ITEMS = 256;
const MAX_STRING_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedString(value: unknown, allowEmpty = false): value is string {
    return typeof value === 'string'
        && value.length <= MAX_STRING_LENGTH
        && (allowEmpty || value.length > 0);
}

function isOptionalGeneration(value: unknown): boolean {
    return value === undefined
        || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isRequestId(value: unknown): value is string {
    return isBoundedString(value) && value.length <= 256;
}

function isReferenceList(value: unknown): value is string[] {
    return Array.isArray(value)
        && value.length > 0
        && value.length <= MAX_REQUEST_ITEMS
        && value.every(reference => isBoundedString(reference));
}

function isOptionalInteger(value: unknown, allowNull = false): boolean {
    return value === undefined
        || (allowNull && value === null)
        || Number.isSafeInteger(value);
}

function isSearchTarget(value: unknown): value is WaveformSearchTarget {
    if (!isRecord(value) || !isBoundedString(value.reference)) return false;
    return isOptionalInteger(value.bitIndex, true)
        && isOptionalInteger(value.waveIndex)
        && isOptionalInteger(value.order)
        && (value.name === undefined || isBoundedString(value.name, true));
}

function isSearchTargetList(value: unknown): value is WaveformSearchTarget[] {
    return Array.isArray(value)
        && value.length > 0
        && value.length <= MAX_REQUEST_ITEMS
        && value.every(isSearchTarget);
}

function rendererMessageError(message: Record<string, unknown>): string | undefined {
    if (!isOptionalGeneration(message.generation)) {
        return `invalid ${String(message.type)} payload`;
    }
    if (message.type === 'ready' || message.type === 'cancelLoad' || message.type === 'retryLoad') {
        return undefined;
    }
    if (message.type === 'cancelRequest') {
        return isRequestId(message.requestId) ? undefined : 'invalid cancelRequest payload';
    }
    if (message.type === 'windowRequest') {
        const valid = isRequestId(message.requestId)
            && isReferenceList(message.references)
            && isFiniteNumber(message.start)
            && isFiniteNumber(message.end)
            && isFiniteNumber(message.pixelWidth)
            && message.pixelWidth > 0
            && (message.prefetch === undefined || isFiniteNumber(message.prefetch));
        return valid ? undefined : 'invalid windowRequest payload';
    }
    if (message.type === 'valueRequest') {
        const valid = isRequestId(message.requestId)
            && isReferenceList(message.references)
            && isFiniteNumber(message.time);
        return valid ? undefined : 'invalid valueRequest payload';
    }
    if (message.type === 'searchRequest') {
        const validTarget = isBoundedString(message.reference)
            || isSearchTargetList(message.targets);
        const valid = isRequestId(message.requestId)
            && validTarget
            && isFiniteNumber(message.cursorTime)
            && (message.direction === -1 || message.direction === 1)
            && typeof message.mode === 'string'
            && SEARCH_MODES.has(message.mode)
            && (message.query === undefined || isBoundedString(message.query, true))
            && isOptionalInteger(message.bitIndex, true)
            && (message.targets === undefined || isSearchTargetList(message.targets));
        return valid ? undefined : 'invalid searchRequest payload';
    }
    return 'unsupported waveform bridge message';
}

export class WaveformRouter {
    private readonly stopRendererMessages: () => void;
    private readonly stopWorkerMessages: () => void;
    private disposed = false;

    constructor(private readonly options: WaveformRouterOptions) {
        this.stopRendererMessages = options.transport.onMessage(message => {
            this.handleRendererMessage(message);
        });
        this.stopWorkerMessages = options.worker.onMessage(message => {
            options.transport.send(message);
        });
    }

    private bridgeError(message: string): void {
        this.options.transport.send({
            type: 'bridgeError',
            generation: this.options.worker.currentGeneration,
            message,
        });
    }

    private handleRendererMessage(message: unknown): void {
        if (!isRecord(message)) {
            this.bridgeError('waveform bridge message must be an object');
            return;
        }
        const error = rendererMessageError(message);
        if (error) {
            this.bridgeError(error);
            return;
        }
        const request = message as WaveformRendererMessage;
        if (request.type === 'ready' || request.type === 'retryLoad') {
            this.options.worker.open(this.options.source);
        } else if (request.type === 'cancelRequest') {
            this.options.worker.cancelRequest(request.requestId);
        } else if (request.type === 'cancelLoad') {
            this.options.worker.cancelLoad();
        } else if (request.type === 'windowRequest') {
            this.options.worker.forward({
                type: request.type,
                requestId: request.requestId,
                references: [...request.references],
                start: request.start,
                end: request.end,
                pixelWidth: request.pixelWidth,
                ...(request.prefetch === undefined ? {} : { prefetch: request.prefetch }),
            });
        } else if (request.type === 'valueRequest') {
            this.options.worker.forward({
                type: request.type,
                requestId: request.requestId,
                references: [...request.references],
                time: request.time,
            });
        } else if (request.type === 'searchRequest') {
            this.options.worker.forward({
                type: request.type,
                requestId: request.requestId,
                cursorTime: request.cursorTime,
                direction: request.direction,
                mode: request.mode,
                ...(request.reference === undefined ? {} : { reference: request.reference }),
                ...(request.query === undefined ? {} : { query: request.query }),
                ...(request.bitIndex === undefined ? {} : { bitIndex: request.bitIndex }),
                ...(request.targets === undefined ? {} : {
                    targets: request.targets.map(target => ({ ...target })),
                }),
            });
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.stopRendererMessages();
        this.stopWorkerMessages();
        await this.options.worker.dispose();
    }
}
