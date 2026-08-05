import type { SourceSpan } from '../core/hdl/model';
import type { SchematicLayout } from './layoutStore';
import type { WebviewCommand } from './protocol';

export type TimerAdapter<Handle> = {
    set(callback: () => void, delayMs: number): Handle;
    clear(handle: Handle): void;
};

export type SchematicSelectionItem = {
    objectId: string;
    description: string;
};

export type SchematicSelectionSummary = {
    selectedObjectId?: string;
    statusText: string;
};

export type SchematicPoint = { x: number; y: number };
export type SchematicRect = SchematicPoint & { width: number; height: number };
export type SchematicNetworkLabelPlacement = {
    position: {
        distance: number;
        offset: SchematicPoint;
    };
    bounds: SchematicRect;
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

export function summarizeSchematicSelection(
    items: readonly SchematicSelectionItem[]
): SchematicSelectionSummary {
    const last = items.at(-1);
    if (!last) return { statusText: 'No selection' };
    return {
        selectedObjectId: last.objectId,
        statusText: items.length === 1
            ? last.description
            : `${items.length} objects selected`,
    };
}

export function placeSchematicNetworkLabel(
    route: readonly SchematicPoint[],
    nodeBounds: readonly SchematicRect[],
    label: string
): SchematicNetworkLabelPlacement {
    const labelWidth = Math.max(24, label.length * 10 + 8);
    const labelHeight = 16;
    const clearance = 4;
    let cumulativeLength = 0;
    const segments: Array<{
        index: number;
        start: SchematicPoint;
        end: SchematicPoint;
        length: number;
        startLength: number;
    }> = [];
    for (let index = 0; index + 1 < route.length; index += 1) {
        const start = route[index];
        const end = route[index + 1];
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        if (length > 0) {
            segments.push({ index, start, end, length, startLength: cumulativeLength });
            cumulativeLength += length;
        }
    }
    if (segments.length === 0) {
        segments.push({
            index: 0,
            start: route[0] ?? { x: 0, y: 0 },
            end: route[0] ?? { x: 0, y: 0 },
            length: 0,
            startLength: 0,
        });
    }

    const candidates = segments
        .map(segment => {
            const x = (segment.start.x + segment.end.x) / 2;
            const y = (segment.start.y + segment.end.y) / 2;
            return {
                segment,
                center: { x, y },
                distance: cumulativeLength > 0
                    ? (segment.startLength + segment.length / 2) / cumulativeLength
                    : 0,
            };
        })
        .sort((left, right) => right.segment.length - left.segment.length
            || left.segment.index - right.segment.index);
    const overlapsNode = (bounds: SchematicRect): boolean => nodeBounds.some(node =>
        bounds.x < node.x + node.width + clearance
        && bounds.x + bounds.width > node.x - clearance
        && bounds.y < node.y + node.height + clearance
        && bounds.y + bounds.height > node.y - clearance
    );
    const placement = (
        candidate: typeof candidates[number],
        offsetY: number
    ): SchematicNetworkLabelPlacement => ({
        position: {
            distance: candidate.distance,
            offset: { x: 0, y: offsetY },
        },
        bounds: {
            x: candidate.center.x - labelWidth / 2,
            y: candidate.center.y + offsetY - labelHeight / 2,
            width: labelWidth,
            height: labelHeight,
        },
    });

    for (const candidate of candidates) {
        const centered = placement(candidate, 0);
        if (!overlapsNode(centered.bounds)) return centered;
    }

    const shifted: Array<{
        rank: number;
        offsetY: number;
        placement: SchematicNetworkLabelPlacement;
    }> = [];
    candidates.forEach((candidate, rank) => {
        const left = candidate.center.x - labelWidth / 2;
        const right = candidate.center.x + labelWidth / 2;
        const offsets = new Set<number>();
        for (const node of nodeBounds) {
            if (left >= node.x + node.width + clearance
                || right <= node.x - clearance) {
                continue;
            }
            offsets.add(node.y - clearance - labelHeight / 2 - candidate.center.y);
            offsets.add(
                node.y + node.height + clearance + labelHeight / 2
                - candidate.center.y
            );
        }
        for (const offsetY of offsets) {
            const shiftedPlacement = placement(candidate, offsetY);
            if (!overlapsNode(shiftedPlacement.bounds)) {
                shifted.push({ rank, offsetY, placement: shiftedPlacement });
            }
        }
    });
    shifted.sort((left, right) => Math.abs(left.offsetY) - Math.abs(right.offsetY)
        || left.rank - right.rank
        || left.offsetY - right.offsetY);
    return shifted[0]?.placement ?? placement(candidates[0], 0);
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
