import {
    horizontal,
    simplifySegments,
    vertical,
    type Point,
    type RouteSegment,
} from './geometry';

export type Direction = 'north' | 'east' | 'south' | 'west';

export type Junction = {
    networkId: string;
    point: Point;
    directions: ReadonlySet<Direction>;
};

const DIRECTION_ORDER: readonly Direction[] = [
    'north',
    'east',
    'south',
    'west',
];

export function splitSegmentsAtBranchPoints(
    segments: readonly RouteSegment[]
): RouteSegment[] {
    const simplified = simplifySegments(segments);
    const splitCoordinates = simplified.map(segment =>
        segment.orientation === 'horizontal'
            ? new Set([segment.x1, segment.x2])
            : new Set([segment.y1, segment.y2])
    );

    for (let leftIndex = 0; leftIndex < simplified.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1;
            rightIndex < simplified.length;
            rightIndex += 1) {
            const left = simplified[leftIndex];
            const right = simplified[rightIndex];
            if (left.networkId !== right.networkId
                || left.orientation === right.orientation) {
                continue;
            }
            const horizontalSegment = left.orientation === 'horizontal'
                ? left
                : right.orientation === 'horizontal' ? right : undefined;
            const verticalSegment = left.orientation === 'vertical'
                ? left
                : right.orientation === 'vertical' ? right : undefined;
            if (!horizontalSegment || !verticalSegment
                || verticalSegment.x < horizontalSegment.x1
                || verticalSegment.x > horizontalSegment.x2
                || horizontalSegment.y < verticalSegment.y1
                || horizontalSegment.y > verticalSegment.y2) {
                continue;
            }
            splitCoordinates[leftIndex].add(left.orientation === 'horizontal'
                ? verticalSegment.x
                : horizontalSegment.y
            );
            splitCoordinates[rightIndex].add(right.orientation === 'horizontal'
                ? verticalSegment.x
                : horizontalSegment.y
            );
        }
    }

    return simplified.flatMap((segment, index) => {
        const coordinates = [...splitCoordinates[index]].sort(
            (left, right) => left - right
        );
        const result: RouteSegment[] = [];
        for (let coordinateIndex = 1;
            coordinateIndex < coordinates.length;
            coordinateIndex += 1) {
            const start = coordinates[coordinateIndex - 1];
            const end = coordinates[coordinateIndex];
            result.push(segment.orientation === 'horizontal'
                ? horizontal(segment.networkId, start, end, segment.y)
                : vertical(segment.networkId, segment.x, start, end)
            );
        }
        return result;
    });
}

export function deriveJunctions(
    segments: readonly RouteSegment[]
): Junction[] {
    const directionsByNetwork = new Map<
        string,
        Map<number, Map<number, Set<Direction>>>
    >();
    const addDirection = (
        networkId: string,
        point: Point,
        direction: Direction
    ): void => {
        let byX = directionsByNetwork.get(networkId);
        if (!byX) {
            byX = new Map();
            directionsByNetwork.set(networkId, byX);
        }
        let byY = byX.get(point.x);
        if (!byY) {
            byY = new Map();
            byX.set(point.x, byY);
        }
        let directions = byY.get(point.y);
        if (!directions) {
            directions = new Set();
            byY.set(point.y, directions);
        }
        directions.add(direction);
    };

    for (const segment of splitSegmentsAtBranchPoints(segments)) {
        if (segment.orientation === 'horizontal') {
            addDirection(
                segment.networkId,
                { x: segment.x1, y: segment.y },
                'east'
            );
            addDirection(
                segment.networkId,
                { x: segment.x2, y: segment.y },
                'west'
            );
        } else {
            addDirection(
                segment.networkId,
                { x: segment.x, y: segment.y1 },
                'south'
            );
            addDirection(
                segment.networkId,
                { x: segment.x, y: segment.y2 },
                'north'
            );
        }
    }

    const junctions: Junction[] = [];
    for (const [networkId, byX] of directionsByNetwork) {
        for (const [x, byY] of byX) {
            for (const [y, directions] of byY) {
                if (directions.size < 3) continue;
                junctions.push({
                    networkId,
                    point: { x, y },
                    directions: new Set(DIRECTION_ORDER.filter(direction =>
                        directions.has(direction)
                    )),
                });
            }
        }
    }
    junctions.sort((left, right) =>
        (left.networkId < right.networkId
            ? -1
            : left.networkId > right.networkId ? 1 : 0)
        || left.point.x - right.point.x
        || left.point.y - right.point.y
    );
    return junctions;
}
