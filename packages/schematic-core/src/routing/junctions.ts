import {
    horizontal,
    simplifySegments,
    vertical,
    type HorizontalSegment,
    type Point,
    type RouteSegment,
    type VerticalSegment,
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

type IndexedHorizontal = {
    index: number;
    segment: HorizontalSegment;
};

type IndexedVertical = {
    index: number;
    segment: VerticalSegment;
};

type NetworkSegments = {
    horizontals: IndexedHorizontal[];
    verticals: IndexedVertical[];
};

type SweepEvent = {
    x: number;
    kind: 0 | 1 | 2;
    segmentIndex: number;
};

class ActiveCoordinateIndex {
    private readonly tree: Int32Array;
    private readonly segmentByCoordinate: number[];

    constructor(size: number) {
        this.tree = new Int32Array(size + 1);
        this.segmentByCoordinate = new Array<number>(size).fill(-1);
    }

    activate(coordinateIndex: number, segmentIndex: number): void {
        this.segmentByCoordinate[coordinateIndex] = segmentIndex;
        this.update(coordinateIndex, 1);
    }

    deactivate(coordinateIndex: number): void {
        this.segmentByCoordinate[coordinateIndex] = -1;
        this.update(coordinateIndex, -1);
    }

    forEachActive(
        startIndex: number,
        endIndex: number,
        visit: (segmentIndex: number) => void
    ): void {
        let order = this.prefixSum(startIndex) + 1;
        const finalOrder = this.prefixSum(endIndex);
        while (order <= finalOrder) {
            const coordinateIndex = this.findByOrder(order);
            visit(this.segmentByCoordinate[coordinateIndex]);
            order += 1;
        }
    }

    private update(coordinateIndex: number, delta: number): void {
        for (let index = coordinateIndex + 1;
            index < this.tree.length;
            index += index & -index) {
            this.tree[index] += delta;
        }
    }

    private prefixSum(endIndex: number): number {
        let sum = 0;
        for (let index = endIndex; index > 0; index -= index & -index) {
            sum += this.tree[index];
        }
        return sum;
    }

    private findByOrder(order: number): number {
        let index = 0;
        let step = 1;
        while (step * 2 < this.tree.length) step *= 2;
        for (; step > 0; step = Math.floor(step / 2)) {
            const next = index + step;
            if (next < this.tree.length && this.tree[next] < order) {
                index = next;
                order -= this.tree[next];
            }
        }
        return index;
    }
}

function lowerBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle] < target) low = middle + 1;
        else high = middle;
    }
    return low;
}

function upperBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle] <= target) low = middle + 1;
        else high = middle;
    }
    return low;
}

function splitAtOrthogonalIntersections(
    network: NetworkSegments,
    segments: readonly RouteSegment[],
    splitCoordinates: readonly Set<number>[]
): void {
    if (network.horizontals.length === 0 || network.verticals.length === 0) {
        return;
    }

    const horizontalYs = network.horizontals.map(({ segment }) => segment.y);
    horizontalYs.sort((left, right) => left - right);
    const uniqueYs: number[] = [];
    for (const y of horizontalYs) {
        if (uniqueYs[uniqueYs.length - 1] !== y) uniqueYs.push(y);
    }
    const yIndex = new Map<number, number>();
    uniqueYs.forEach((y, index) => yIndex.set(y, index));

    const events: SweepEvent[] = [];
    for (const horizontalSegment of network.horizontals) {
        events.push({
            x: horizontalSegment.segment.x1,
            kind: 0,
            segmentIndex: horizontalSegment.index,
        });
        events.push({
            x: horizontalSegment.segment.x2,
            kind: 2,
            segmentIndex: horizontalSegment.index,
        });
    }
    for (const verticalSegment of network.verticals) {
        events.push({
            x: verticalSegment.segment.x,
            kind: 1,
            segmentIndex: verticalSegment.index,
        });
    }
    events.sort((left, right) =>
        left.x - right.x
        || left.kind - right.kind
        || left.segmentIndex - right.segmentIndex
    );

    const active = new ActiveCoordinateIndex(uniqueYs.length);
    for (const event of events) {
        const segment = segments[event.segmentIndex];
        if (segment.orientation === 'horizontal') {
            const coordinateIndex = yIndex.get(segment.y)!;
            if (event.kind === 0) {
                active.activate(coordinateIndex, event.segmentIndex);
            } else {
                active.deactivate(coordinateIndex);
            }
            continue;
        }

        const firstY = lowerBound(uniqueYs, segment.y1);
        const afterLastY = upperBound(uniqueYs, segment.y2);
        active.forEachActive(firstY, afterLastY, horizontalIndex => {
            const horizontalSegment = segments[horizontalIndex];
            if (horizontalSegment.orientation !== 'horizontal') return;
            splitCoordinates[horizontalIndex].add(segment.x);
            splitCoordinates[event.segmentIndex].add(horizontalSegment.y);
        });
    }
}

export function splitSegmentsAtBranchPoints(
    segments: readonly RouteSegment[]
): RouteSegment[] {
    const simplified = simplifySegments(segments);
    const splitCoordinates = simplified.map(segment =>
        segment.orientation === 'horizontal'
            ? new Set([segment.x1, segment.x2])
            : new Set([segment.y1, segment.y2])
    );

    const byNetwork = new Map<string, NetworkSegments>();
    simplified.forEach((segment, index) => {
        let network = byNetwork.get(segment.networkId);
        if (!network) {
            network = { horizontals: [], verticals: [] };
            byNetwork.set(segment.networkId, network);
        }
        if (segment.orientation === 'horizontal') {
            network.horizontals.push({ index, segment });
        } else {
            network.verticals.push({ index, segment });
        }
    });
    for (const network of byNetwork.values()) {
        splitAtOrthogonalIntersections(network, simplified, splitCoordinates);
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
