import { assertGridCoordinate } from './geometry';

type IntervalReservation = Readonly<{
    networkId: string;
    start: number;
    end: number;
}>;

type AvlNode = Readonly<{
    reservation: IntervalReservation;
    left?: AvlNode;
    right?: AvlNode;
    height: number;
    size: number;
    maxEnd: number;
}>;

type VisitCounter = {
    nodeVisits: number;
};

export type VerticalReservation = Readonly<{
    networkId: string;
    y1: number;
    y2: number;
}>;

export type HorizontalReservation = Readonly<{
    networkId: string;
    x1: number;
    x2: number;
}>;

export type ReservationIndexDiagnostics = Readonly<{
    nodeCount: number;
    height: number;
    nodeVisits: number;
}>;

function nodeHeight(node: AvlNode | undefined): number {
    return node?.height ?? 0;
}

function nodeSize(node: AvlNode | undefined): number {
    return node?.size ?? 0;
}

function makeNode(
    reservation: IntervalReservation,
    left?: AvlNode,
    right?: AvlNode
): AvlNode {
    return {
        reservation,
        left,
        right,
        height: Math.max(nodeHeight(left), nodeHeight(right)) + 1,
        size: nodeSize(left) + nodeSize(right) + 1,
        maxEnd: Math.max(
            reservation.end,
            left?.maxEnd ?? Number.NEGATIVE_INFINITY,
            right?.maxEnd ?? Number.NEGATIVE_INFINITY
        ),
    };
}

function compareReservations(
    first: IntervalReservation,
    second: IntervalReservation
): number {
    if (first.start !== second.start) return first.start - second.start;
    if (first.end !== second.end) return first.end - second.end;
    if (first.networkId < second.networkId) return -1;
    if (first.networkId > second.networkId) return 1;
    return 0;
}

function rotateLeft(node: AvlNode): AvlNode {
    const pivot = node.right;
    if (!pivot) return node;
    return makeNode(
        pivot.reservation,
        makeNode(node.reservation, node.left, pivot.left),
        pivot.right
    );
}

function rotateRight(node: AvlNode): AvlNode {
    const pivot = node.left;
    if (!pivot) return node;
    return makeNode(
        pivot.reservation,
        pivot.left,
        makeNode(node.reservation, pivot.right, node.right)
    );
}

function rebalance(node: AvlNode): AvlNode {
    const balance = nodeHeight(node.left) - nodeHeight(node.right);
    if (balance > 1) {
        const left = node.left;
        if (!left) return node;
        if (nodeHeight(left.left) < nodeHeight(left.right)) {
            return rotateRight(makeNode(
                node.reservation,
                rotateLeft(left),
                node.right
            ));
        }
        return rotateRight(node);
    }
    if (balance < -1) {
        const right = node.right;
        if (!right) return node;
        if (nodeHeight(right.right) < nodeHeight(right.left)) {
            return rotateLeft(makeNode(
                node.reservation,
                node.left,
                rotateRight(right)
            ));
        }
        return rotateLeft(node);
    }
    return node;
}

function insert(
    node: AvlNode | undefined,
    reservation: IntervalReservation,
    counter: VisitCounter
): AvlNode {
    if (!node) return makeNode(reservation);
    counter.nodeVisits += 1;
    const order = compareReservations(reservation, node.reservation);
    if (order === 0) return node;
    if (order < 0) {
        return rebalance(makeNode(
            node.reservation,
            insert(node.left, reservation, counter),
            node.right
        ));
    }
    return rebalance(makeNode(
        node.reservation,
        node.left,
        insert(node.right, reservation, counter)
    ));
}

function joinWithPivot(
    left: AvlNode | undefined,
    reservation: IntervalReservation,
    right: AvlNode | undefined,
    counter: VisitCounter
): AvlNode {
    if (left && nodeHeight(left) > nodeHeight(right) + 1) {
        counter.nodeVisits += 1;
        return rebalance(makeNode(
            left.reservation,
            left.left,
            joinWithPivot(left.right, reservation, right, counter)
        ));
    }
    if (right && nodeHeight(right) > nodeHeight(left) + 1) {
        counter.nodeVisits += 1;
        return rebalance(makeNode(
            right.reservation,
            joinWithPivot(left, reservation, right.left, counter),
            right.right
        ));
    }
    return makeNode(reservation, left, right);
}

function removeMinimum(
    node: AvlNode,
    counter: VisitCounter
): readonly [IntervalReservation, AvlNode | undefined] {
    counter.nodeVisits += 1;
    if (!node.left) return [node.reservation, node.right];
    const [minimum, nextLeft] = removeMinimum(node.left, counter);
    return [
        minimum,
        joinWithPivot(nextLeft, node.reservation, node.right, counter),
    ];
}

function join(
    left: AvlNode | undefined,
    right: AvlNode | undefined,
    counter: VisitCounter
): AvlNode | undefined {
    if (!left) return right;
    if (!right) return left;
    const [pivot, nextRight] = removeMinimum(right, counter);
    return joinWithPivot(left, pivot, nextRight, counter);
}

function removeStartRange(
    node: AvlNode | undefined,
    minimumStart: number,
    maximumStart: number,
    counter: VisitCounter
): AvlNode | undefined {
    if (!node) return undefined;
    counter.nodeVisits += 1;
    if (node.reservation.start < minimumStart) {
        return joinWithPivot(
            node.left,
            node.reservation,
            removeStartRange(
                node.right,
                minimumStart,
                maximumStart,
                counter
            ),
            counter
        );
    }
    if (node.reservation.start > maximumStart) {
        return joinWithPivot(
            removeStartRange(
                node.left,
                minimumStart,
                maximumStart,
                counter
            ),
            node.reservation,
            node.right,
            counter
        );
    }
    return join(
        removeStartRange(node.left, minimumStart, maximumStart, counter),
        removeStartRange(node.right, minimumStart, maximumStart, counter),
        counter
    );
}

function collectTouching(
    node: AvlNode | undefined,
    start: number,
    end: number,
    result: IntervalReservation[],
    counter: VisitCounter
): void {
    if (!node || node.maxEnd < start) return;
    counter.nodeVisits += 1;
    collectTouching(node.left, start, end, result, counter);
    if (node.reservation.start > end) return;
    if (node.reservation.end >= start) result.push(node.reservation);
    collectTouching(node.right, start, end, result, counter);
}

function collectReservations(
    node: AvlNode | undefined,
    result: IntervalReservation[]
): void {
    if (!node) return;
    collectReservations(node.left, result);
    result.push({ ...node.reservation });
    collectReservations(node.right, result);
}

function openIntervalsOverlap(
    firstStart: number,
    firstEnd: number,
    secondStart: number,
    secondEnd: number
): boolean {
    return Math.max(firstStart, secondStart) < Math.min(firstEnd, secondEnd);
}

class IntervalReservationIndex {
    private readonly byLane = new Map<string, Map<number, AvlNode>>();
    private readonly counter: VisitCounter = { nodeVisits: 0 };

    hasConflict(
        laneId: string,
        track: number,
        networkId: string,
        first: number,
        second: number
    ): boolean {
        this.validateTrack(track);
        assertGridCoordinate(first, 'reservation interval start');
        assertGridCoordinate(second, 'reservation interval end');
        const start = Math.min(first, second);
        const end = Math.max(first, second);
        if (start === end) return false;
        const touching: IntervalReservation[] = [];
        collectTouching(
            this.getRoot(laneId, track),
            start,
            end,
            touching,
            this.counter
        );
        return touching.some(reservation =>
            reservation.networkId !== networkId
            && openIntervalsOverlap(
                start,
                end,
                reservation.start,
                reservation.end
            )
        );
    }

    reserve(
        laneId: string,
        track: number,
        networkId: string,
        first: number,
        second: number
    ): boolean {
        this.validateTrack(track);
        assertGridCoordinate(first, 'reservation interval start');
        assertGridCoordinate(second, 'reservation interval end');
        let start = Math.min(first, second);
        let end = Math.max(first, second);
        if (start === end) return true;

        const root = this.getRoot(laneId, track);
        const touching: IntervalReservation[] = [];
        collectTouching(root, start, end, touching, this.counter);
        const merged: IntervalReservation[] = [];
        for (const reservation of touching) {
            if (reservation.networkId !== networkId) {
                if (openIntervalsOverlap(
                    start,
                    end,
                    reservation.start,
                    reservation.end
                )) {
                    return false;
                }
                continue;
            }
            merged.push(reservation);
            start = Math.min(start, reservation.start);
            end = Math.max(end, reservation.end);
        }

        if (merged.length === 1
            && merged[0].start === start
            && merged[0].end === end) {
            return true;
        }

        let nextRoot = root;
        if (merged.length > 0) {
            // A successful candidate cannot overlap another network between
            // the first and last same-network reservations being replaced.
            nextRoot = removeStartRange(
                nextRoot,
                merged[0].start,
                merged[merged.length - 1].start,
                this.counter
            );
        }
        nextRoot = insert(
            nextRoot,
            { networkId, start, end },
            this.counter
        );
        this.setRoot(laneId, track, nextRoot);
        return true;
    }

    reservations(
        laneId: string,
        track: number
    ): readonly Readonly<IntervalReservation>[] {
        this.validateTrack(track);
        const result: IntervalReservation[] = [];
        collectReservations(this.getRoot(laneId, track), result);
        return result;
    }

    diagnostics(): ReservationIndexDiagnostics {
        let nodeCount = 0;
        let height = 0;
        for (const byTrack of this.byLane.values()) {
            for (const root of byTrack.values()) {
                nodeCount += root.size;
                height = Math.max(height, root.height);
            }
        }
        return {
            nodeCount,
            height,
            nodeVisits: this.counter.nodeVisits,
        };
    }

    private getRoot(laneId: string, track: number): AvlNode | undefined {
        return this.byLane.get(laneId)?.get(track);
    }

    private setRoot(laneId: string, track: number, root: AvlNode): void {
        let byTrack = this.byLane.get(laneId);
        if (!byTrack) {
            byTrack = new Map();
            this.byLane.set(laneId, byTrack);
        }
        byTrack.set(track, root);
    }

    private validateTrack(track: number): void {
        assertGridCoordinate(track, 'reservation track');
        if (track < 0) {
            throw new RangeError('reservation track must be non-negative');
        }
    }
}

const indexes = new WeakMap<object, IntervalReservationIndex>();

export class VerticalReservationIndex {
    private readonly index = new IntervalReservationIndex();

    constructor() {
        indexes.set(this, this.index);
    }

    hasConflict(
        channelId: string,
        track: number,
        networkId: string,
        y1: number,
        y2: number
    ): boolean {
        return this.index.hasConflict(channelId, track, networkId, y1, y2);
    }

    reserve(
        channelId: string,
        track: number,
        networkId: string,
        y1: number,
        y2: number
    ): boolean {
        return this.index.reserve(channelId, track, networkId, y1, y2);
    }

    reservations(
        channelId: string,
        track: number
    ): readonly VerticalReservation[] {
        return this.index.reservations(channelId, track).map(reservation => ({
            networkId: reservation.networkId,
            y1: reservation.start,
            y2: reservation.end,
        }));
    }
}

export class HorizontalReservationIndex {
    private readonly index = new IntervalReservationIndex();

    constructor() {
        indexes.set(this, this.index);
    }

    hasConflict(
        corridorId: string,
        track: number,
        networkId: string,
        x1: number,
        x2: number
    ): boolean {
        return this.index.hasConflict(corridorId, track, networkId, x1, x2);
    }

    reserve(
        corridorId: string,
        track: number,
        networkId: string,
        x1: number,
        x2: number
    ): boolean {
        return this.index.reserve(corridorId, track, networkId, x1, x2);
    }

    reservations(
        corridorId: string,
        track: number
    ): readonly HorizontalReservation[] {
        return this.index.reservations(corridorId, track).map(reservation => ({
            networkId: reservation.networkId,
            x1: reservation.start,
            x2: reservation.end,
        }));
    }
}

export function reservationIndexDiagnostics(
    index: VerticalReservationIndex | HorizontalReservationIndex
): ReservationIndexDiagnostics {
    const internal = indexes.get(index);
    if (!internal) {
        return { nodeCount: 0, height: 0, nodeVisits: 0 };
    }
    return internal.diagnostics();
}
