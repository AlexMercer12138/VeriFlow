export type RoutingTrackOrientation = 'horizontal' | 'vertical';

export type RoutingTrackPool = Readonly<{
    id: string;
    orientation: RoutingTrackOrientation;
    readonly trackCount: number;
}>;

export type RoutingTrackPoolController = Readonly<{
    pool: RoutingTrackPool;
    request(track?: number): number;
    seal(): void;
}>;

export const MAX_ROUTING_TRACKS = 100_000;

function assertTrackIndex(track: number): void {
    if (!Number.isSafeInteger(track) || track < 0
        || track >= MAX_ROUTING_TRACKS) {
        throw new RangeError(
            `routing track must be a non-negative safe integer below ${MAX_ROUTING_TRACKS}`
        );
    }
}

export function createRoutingTrackPool(
    id: string,
    orientation: RoutingTrackOrientation
): RoutingTrackPoolController {
    let trackCount = 0;
    let sealed = false;
    const pool = Object.freeze({
        id,
        orientation,
        get trackCount(): number {
            return trackCount;
        },
    });

    return Object.freeze({
        pool,
        request(track?: number): number {
            if (sealed) {
                throw new Error(`routing track pool ${id} is already realized`);
            }
            const selected = track ?? trackCount;
            assertTrackIndex(selected);
            trackCount = Math.max(trackCount, selected + 1);
            return selected;
        },
        seal(): void {
            sealed = true;
        },
    });
}
