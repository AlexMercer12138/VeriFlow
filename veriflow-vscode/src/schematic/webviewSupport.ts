import type { SourceSpan } from '../core/hdl/model';
import type { SchematicLayout } from './layoutStore';
import type { WebviewCommand } from './protocol';

export type TimerAdapter<Handle> = {
    set(callback: () => void, delayMs: number): Handle;
    clear(handle: Handle): void;
};

type DefaultTimerHandle = ReturnType<typeof setTimeout>;

const defaultTimers: TimerAdapter<DefaultTimerHandle> = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: handle => clearTimeout(handle),
};

export function navigationCommandForCell(
    target: { sourceSpan?: SourceSpan; definitionKey?: string },
    openDefinition: boolean
): WebviewCommand | undefined {
    if (openDefinition) {
        return typeof target.definitionKey === 'string'
            && target.definitionKey.length > 0
            ? { type: 'openDefinition', definitionKey: target.definitionKey }
            : undefined;
    }
    return target.sourceSpan
        ? { type: 'revealSource', span: target.sourceSpan }
        : undefined;
}

export function cloneSchematicLayout(layout: SchematicLayout): SchematicLayout {
    return {
        nodes: Object.fromEntries(Object.entries(layout.nodes).map(([id, node]) => [
            id,
            { ...node },
        ])),
        viewport: { ...layout.viewport },
        minimap: layout.minimap,
        ...(layout.selectedObjectId === undefined
            ? {}
            : { selectedObjectId: layout.selectedObjectId }),
    };
}

export class DebouncedLayoutSaveScheduler<Handle = DefaultTimerHandle> {
    private readonly pending = new Map<string, { handle?: Handle }>();

    constructor(
        private readonly delayMs: number,
        private readonly save: (moduleKey: string, layout: SchematicLayout) => void,
        private readonly timers: TimerAdapter<Handle> = defaultTimers as unknown as
            TimerAdapter<Handle>
    ) {}

    schedule(moduleKey: string, layout: SchematicLayout): void {
        const previous = this.pending.get(moduleKey);
        if (previous?.handle !== undefined) this.timers.clear(previous.handle);

        const snapshot = cloneSchematicLayout(layout);
        const pending: { handle?: Handle } = {};
        this.pending.set(moduleKey, pending);
        pending.handle = this.timers.set(() => {
            if (this.pending.get(moduleKey) !== pending) return;
            this.pending.delete(moduleKey);
            this.save(moduleKey, snapshot);
        }, this.delayMs);
    }

    dispose(): void {
        for (const pending of this.pending.values()) {
            if (pending.handle !== undefined) this.timers.clear(pending.handle);
        }
        this.pending.clear();
    }
}
