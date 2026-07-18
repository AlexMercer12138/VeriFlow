import * as fs from 'fs';

export type StableFileSnapshot = {
    size: number;
    mtimeNs: string;
};

export type StableFileReloaderOptions = {
    delayMs?: number;
    confirmationMs?: number;
    onChanging?: () => void;
    onStable: (snapshot: StableFileSnapshot) => void;
    onUnavailable?: (error: Error) => void;
};

export class StableFileReloader {
    private debounceTimer: NodeJS.Timeout | undefined;
    private confirmationTimer: NodeJS.Timeout | undefined;
    private sequence = 0;
    private disposed = false;
    private readonly delayMs: number;
    private readonly confirmationMs: number;

    constructor(
        private readonly source: string,
        private readonly options: StableFileReloaderOptions
    ) {
        this.delayMs = options.delayMs ?? 750;
        this.confirmationMs = options.confirmationMs ?? 100;
    }

    private async snapshot(): Promise<StableFileSnapshot> {
        const stat = await fs.promises.stat(this.source, { bigint: true });
        return { size: Number(stat.size), mtimeNs: stat.mtimeNs.toString() };
    }

    notify(): void {
        if (this.disposed) return;
        this.sequence += 1;
        const sequence = this.sequence;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
        this.options.onChanging?.();
        this.debounceTimer = setTimeout(() => void this.observe(sequence), this.delayMs);
    }

    private async observe(sequence: number): Promise<void> {
        if (this.disposed || sequence !== this.sequence) return;
        let first: StableFileSnapshot;
        try {
            first = await this.snapshot();
        } catch (error) {
            this.options.onUnavailable?.(error as Error);
            return;
        }
        this.confirmationTimer = setTimeout(
            () => void this.confirm(sequence, first),
            this.confirmationMs
        );
    }

    private async confirm(sequence: number, first: StableFileSnapshot): Promise<void> {
        if (this.disposed || sequence !== this.sequence) return;
        try {
            const second = await this.snapshot();
            if (second.size === first.size && second.mtimeNs === first.mtimeNs) {
                this.options.onStable(second);
            } else {
                this.notify();
            }
        } catch (error) {
            this.options.onUnavailable?.(error as Error);
        }
    }

    dispose(): void {
        this.disposed = true;
        this.sequence += 1;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
    }
}
