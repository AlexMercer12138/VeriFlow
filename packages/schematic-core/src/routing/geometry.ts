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

function haveDifferentNetworkCollinearOverlap(
    left: RouteSegment,
    right: RouteSegment
): boolean {
    if (left.networkId === right.networkId
        || left.orientation !== right.orientation) {
        return false;
    }
    if (left.orientation === 'horizontal' && right.orientation === 'horizontal') {
        return left.y === right.y
            && haveOpenIntervalOverlap(left.x1, left.x2, right.x1, right.x2);
    }
    if (left.orientation === 'vertical' && right.orientation === 'vertical') {
        return left.x === right.x
            && haveOpenIntervalOverlap(left.y1, left.y2, right.y1, right.y2);
    }
    return false;
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
    const normalized = segments.map(segment => segment.orientation === 'horizontal'
        ? horizontal(segment.networkId, segment.x1, segment.x2, segment.y)
        : vertical(segment.networkId, segment.x, segment.y1, segment.y2)
    ).filter(segment => segment.orientation === 'horizontal'
        ? segment.x1 !== segment.x2
        : segment.y1 !== segment.y2
    ).sort(compareSegments);
    for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1;
            rightIndex < normalized.length;
            rightIndex += 1) {
            if (haveDifferentNetworkCollinearOverlap(
                normalized[leftIndex],
                normalized[rightIndex]
            )) {
                throw new RangeError(
                    'different networks cannot share a collinear open interval'
                );
            }
        }
    }
    const merged: RouteSegment[] = [];
    for (const segment of normalized) {
        const previous = merged[merged.length - 1];
        if (previous?.orientation === 'horizontal'
            && segment.orientation === 'horizontal'
            && previous.networkId === segment.networkId
            && previous.y === segment.y
            && segment.x1 <= previous.x2) {
            previous.x2 = Math.max(previous.x2, segment.x2);
        } else if (previous?.orientation === 'vertical'
            && segment.orientation === 'vertical'
            && previous.networkId === segment.networkId
            && previous.x === segment.x
            && segment.y1 <= previous.y2) {
            previous.y2 = Math.max(previous.y2, segment.y2);
        } else {
            merged.push(segment);
        }
    }
    return merged;
}
