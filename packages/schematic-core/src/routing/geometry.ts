export type Point = {
    x: number;
    y: number;
};

export type Rectangle = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type HorizontalSegment = {
    orientation: 'horizontal';
    networkId: string;
    y: number;
    x1: number;
    x2: number;
};

export type VerticalSegment = {
    orientation: 'vertical';
    networkId: string;
    x: number;
    y1: number;
    y2: number;
};

export type RouteSegment = HorizontalSegment | VerticalSegment;

export function assertGridCoordinate(value: number, name: string): void {
    if (!Number.isSafeInteger(value)) {
        throw new RangeError(`${name} must be a finite integer grid coordinate`);
    }
}

export function horizontal(
    networkId: string,
    x1: number,
    x2: number,
    y: number
): HorizontalSegment {
    assertGridCoordinate(x1, 'x1');
    assertGridCoordinate(x2, 'x2');
    assertGridCoordinate(y, 'y');
    return {
        orientation: 'horizontal',
        networkId,
        y,
        x1: Math.min(x1, x2),
        x2: Math.max(x1, x2),
    };
}

export function vertical(
    networkId: string,
    x: number,
    y1: number,
    y2: number
): VerticalSegment {
    assertGridCoordinate(x, 'x');
    assertGridCoordinate(y1, 'y1');
    assertGridCoordinate(y2, 'y2');
    return {
        orientation: 'vertical',
        networkId,
        x,
        y1: Math.min(y1, y2),
        y2: Math.max(y1, y2),
    };
}

function compareSegments(left: RouteSegment, right: RouteSegment): number {
    const networkOrder = left.networkId < right.networkId
        ? -1
        : left.networkId > right.networkId ? 1 : 0;
    if (networkOrder !== 0) return networkOrder;
    if (left.orientation !== right.orientation) {
        return left.orientation === 'horizontal' ? -1 : 1;
    }
    if (left.orientation === 'horizontal' && right.orientation === 'horizontal') {
        return left.y - right.y || left.x1 - right.x1 || left.x2 - right.x2;
    }
    if (left.orientation === 'vertical' && right.orientation === 'vertical') {
        return left.x - right.x || left.y1 - right.y1 || left.y2 - right.y2;
    }
    return 0;
}

function haveOpenIntervalOverlap(
    firstStart: number,
    firstEnd: number,
    secondStart: number,
    secondEnd: number
): boolean {
    return Math.max(firstStart, secondStart) < Math.min(firstEnd, secondEnd);
}

type LaneInterval = {
    networkId: string;
    start: number;
    end: number;
};

function compareLaneIntervals(left: LaneInterval, right: LaneInterval): number {
    return left.start - right.start
        || left.end - right.end
        || (left.networkId < right.networkId
            ? -1
            : left.networkId > right.networkId ? 1 : 0);
}

function simplifyLane(intervals: readonly LaneInterval[]): LaneInterval[] {
    const byNetwork = new Map<string, LaneInterval[]>();
    for (const interval of intervals) {
        const networkIntervals = byNetwork.get(interval.networkId) ?? [];
        networkIntervals.push(interval);
        byNetwork.set(interval.networkId, networkIntervals);
    }

    const merged: LaneInterval[] = [];
    for (const networkIntervals of byNetwork.values()) {
        networkIntervals.sort(compareLaneIntervals);
        for (const interval of networkIntervals) {
            const previous = merged[merged.length - 1];
            if (previous?.networkId === interval.networkId
                && interval.start <= previous.end) {
                previous.end = Math.max(previous.end, interval.end);
            } else {
                merged.push({ ...interval });
            }
        }
    }

    const byStart = merged.slice().sort(compareLaneIntervals);
    for (let index = 1; index < byStart.length; index += 1) {
        if (byStart[index].start < byStart[index - 1].end) {
            throw new RangeError(
                'different networks cannot share a collinear open interval'
            );
        }
    }
    return merged;
}

export function segmentIntersectsRectangleInterior(
    segment: RouteSegment,
    rectangle: Rectangle
): boolean {
    assertGridCoordinate(rectangle.x, 'rectangle.x');
    assertGridCoordinate(rectangle.y, 'rectangle.y');
    assertGridCoordinate(rectangle.width, 'rectangle.width');
    assertGridCoordinate(rectangle.height, 'rectangle.height');
    if (rectangle.width < 0 || rectangle.height < 0) {
        throw new RangeError('rectangle dimensions must be non-negative');
    }
    const right = rectangle.x + rectangle.width;
    const bottom = rectangle.y + rectangle.height;
    assertGridCoordinate(right, 'rectangle right edge');
    assertGridCoordinate(bottom, 'rectangle bottom edge');

    if (segment.orientation === 'horizontal') {
        const normalized = horizontal(
            segment.networkId,
            segment.x1,
            segment.x2,
            segment.y
        );
        return normalized.x1 !== normalized.x2
            && normalized.y > rectangle.y
            && normalized.y < bottom
            && haveOpenIntervalOverlap(
                normalized.x1,
                normalized.x2,
                rectangle.x,
                right
            );
    }
    const normalized = vertical(
        segment.networkId,
        segment.x,
        segment.y1,
        segment.y2
    );
    return normalized.y1 !== normalized.y2
        && normalized.x > rectangle.x
        && normalized.x < right
        && haveOpenIntervalOverlap(
            normalized.y1,
            normalized.y2,
            rectangle.y,
            bottom
        );
}

export function simplifySegments(
    segments: readonly RouteSegment[]
): RouteSegment[] {
    const horizontalLanes = new Map<number, LaneInterval[]>();
    const verticalLanes = new Map<number, LaneInterval[]>();
    for (const segment of segments) {
        if (segment.orientation === 'horizontal') {
            const normalized = horizontal(
                segment.networkId,
                segment.x1,
                segment.x2,
                segment.y
            );
            if (normalized.x1 === normalized.x2) continue;
            const lane = horizontalLanes.get(normalized.y) ?? [];
            lane.push({
                networkId: normalized.networkId,
                start: normalized.x1,
                end: normalized.x2,
            });
            horizontalLanes.set(normalized.y, lane);
        } else {
            const normalized = vertical(
                segment.networkId,
                segment.x,
                segment.y1,
                segment.y2
            );
            if (normalized.y1 === normalized.y2) continue;
            const lane = verticalLanes.get(normalized.x) ?? [];
            lane.push({
                networkId: normalized.networkId,
                start: normalized.y1,
                end: normalized.y2,
            });
            verticalLanes.set(normalized.x, lane);
        }
    }

    const result: RouteSegment[] = [];
    for (const [y, lane] of horizontalLanes) {
        for (const interval of simplifyLane(lane)) {
            result.push(horizontal(
                interval.networkId,
                interval.start,
                interval.end,
                y
            ));
        }
    }
    for (const [x, lane] of verticalLanes) {
        for (const interval of simplifyLane(lane)) {
            result.push(vertical(
                interval.networkId,
                x,
                interval.start,
                interval.end
            ));
        }
    }
    result.sort(compareSegments);
    return result;
}
