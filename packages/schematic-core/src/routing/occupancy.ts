import { assertGridCoordinate } from './geometry';

type IntervalReservation = {
    networkId: string;
    start: number;
    end: number;
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

function openIntervalsOverlap(
    firstStart: number,
    firstEnd: number,
    secondStart: number,
    secondEnd: number
): boolean {
    return Math.max(firstStart, secondStart) < Math.min(firstEnd, secondEnd);
}

function firstEndingAtOrAfter(
    reservations: readonly IntervalReservation[],
    coordinate: number
): number {
    let low = 0;
    let high = reservations.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (reservations[middle].end < coordinate) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

class IntervalReservationIndex {
    private readonly byLane = new Map<
        string,
        Map<number, IntervalReservation[]>
    >();

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
        const reservations = this.get(laneId, track);
        for (let index = firstEndingAtOrAfter(reservations, start);
            index < reservations.length && reservations[index].start < end;
            index += 1) {
            const reservation = reservations[index];
            if (reservation.networkId !== networkId
                && openIntervalsOverlap(
                    start,
                    end,
                    reservation.start,
                    reservation.end
                )) {
                return true;
            }
        }
        return false;
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

        const reservations = this.get(laneId, track);
        const mergedIndexes: number[] = [];
        for (let index = firstEndingAtOrAfter(reservations, start);
            index < reservations.length && reservations[index].start <= end;
            index += 1) {
            const reservation = reservations[index];
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
            if (reservation.end < start || reservation.start > end) continue;
            mergedIndexes.push(index);
            start = Math.min(start, reservation.start);
            end = Math.max(end, reservation.end);
        }

        if (mergedIndexes.length === 1) {
            const existing = reservations[mergedIndexes[0]];
            if (existing.start === start && existing.end === end) return true;
        }

        const mergedIndexSet = new Set(mergedIndexes);
        const merged: IntervalReservation = { networkId, start, end };
        const next: IntervalReservation[] = [];
        let inserted = false;
        for (let index = 0; index < reservations.length; index += 1) {
            if (mergedIndexSet.has(index)) continue;
            const reservation = reservations[index];
            if (!inserted && (start < reservation.start
                || (start === reservation.start
                    && (end < reservation.end
                        || (end === reservation.end
                            && networkId < reservation.networkId))))) {
                next.push(merged);
                inserted = true;
            }
            next.push(reservation);
        }
        if (!inserted) next.push(merged);
        this.set(laneId, track, next);
        return true;
    }

    reservations(
        laneId: string,
        track: number
    ): readonly Readonly<IntervalReservation>[] {
        this.validateTrack(track);
        return this.get(laneId, track).map(reservation => ({ ...reservation }));
    }

    private get(
        laneId: string,
        track: number
    ): readonly IntervalReservation[] {
        return this.byLane.get(laneId)?.get(track) ?? [];
    }

    private set(
        laneId: string,
        track: number,
        reservations: IntervalReservation[]
    ): void {
        let byTrack = this.byLane.get(laneId);
        if (!byTrack) {
            byTrack = new Map();
            this.byLane.set(laneId, byTrack);
        }
        byTrack.set(track, reservations);
    }

    private validateTrack(track: number): void {
        assertGridCoordinate(track, 'reservation track');
        if (track < 0) {
            throw new RangeError('reservation track must be non-negative');
        }
    }
}

export class VerticalReservationIndex {
    private readonly index = new IntervalReservationIndex();

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
