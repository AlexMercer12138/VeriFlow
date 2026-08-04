import type { PersistedWorkspaceIndex } from './workspaceIndexTypes';

type MementoLike = {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
};

const KEY = 'veriflow.hdlWorkspaceIndex.v1';

export class WorkspaceIndexStore {
    constructor(private readonly state: MementoLike) {}

    load(parserFingerprint: string): PersistedWorkspaceIndex | undefined {
        const value = this.state.get<PersistedWorkspaceIndex>(KEY);
        return value?.schemaVersion === 1 && value.parserFingerprint === parserFingerprint
            ? value
            : undefined;
    }

    async save(value: PersistedWorkspaceIndex): Promise<void> {
        await this.state.update(KEY, value);
    }

    async clear(): Promise<void> {
        await this.state.update(KEY, undefined);
    }
}
