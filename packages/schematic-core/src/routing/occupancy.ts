import { assertGridCoordinate } from './geometry';

type IntervalReservation = {
    networkId: string;
    start: number;
    end: number;
};

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
        const reservations = this.byLane.get(laneId)?.get(track) ?? [];
        return reservations.some(reservation =>
            reservation.networkId !== networkId
            && Math.max(start, reservation.start) < Math.min(end, reservation.end)
        );
    }

    reserve(
        laneId: string,
        track: number,
        networkId: string,
        first: number,
        second: number
    ): boolean {
        if (this.hasConflict(laneId, track, networkId, first, second)) {
            return false;
        }
        const start = Math.min(first, second);
        const end = Math.max(first, second);
        let byTrack = this.byLane.get(laneId);
        if (!byTrack) {
            byTrack = new Map();
            this.byLane.set(laneId, byTrack);
        }
        const reservations = byTrack.get(track) ?? [];
        reservations.push({ networkId, start, end });
        byTrack.set(track, reservations);
        return true;
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
}
