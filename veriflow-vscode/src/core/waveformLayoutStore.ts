export interface MementoLike {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
}

const STORAGE_KEY = 'veriflow.waveformLayouts.v1';

export class WaveformLayoutStore {
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly memento: MementoLike) {}

    load(resourceKey: string): unknown | null {
        const layouts = this.memento.get<Record<string, unknown>>(STORAGE_KEY, {});
        return Object.prototype.hasOwnProperty.call(layouts, resourceKey)
            ? layouts[resourceKey]
            : null;
    }

    save(resourceKey: string, layout: unknown): Promise<void> {
        const write = async (): Promise<void> => {
            const current = this.memento.get<Record<string, unknown>>(STORAGE_KEY, {});
            const layouts = { ...current, [resourceKey]: layout };
            await this.memento.update(STORAGE_KEY, layouts);
        };
        this.writeQueue = this.writeQueue.then(write, write);
        return this.writeQueue;
    }
}
