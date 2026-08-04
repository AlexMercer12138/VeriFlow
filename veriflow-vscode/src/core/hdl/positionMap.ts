import { SourceSpan } from './model';

type PositionCheckpoint = {
    utf16Start: number;
    utf16End: number;
    byteStart: number;
    byteEnd: number;
};

export class PositionMap {
    private readonly checkpoints: PositionCheckpoint[] = [];
    private readonly totalBytes: number;

    constructor(private readonly text: string) {
        let byteOffset = 0;

        for (let offset = 0; offset < text.length;) {
            const codePoint = text.codePointAt(offset)!;
            const char = String.fromCodePoint(codePoint);
            const units = char.length;
            const bytes = Buffer.byteLength(char, 'utf8');

            if (bytes !== units) {
                this.checkpoints.push({
                    utf16Start: offset,
                    utf16End: offset + units,
                    byteStart: byteOffset,
                    byteEnd: byteOffset + bytes,
                });
            }

            byteOffset += bytes;
            offset += units;
        }

        this.totalBytes = byteOffset;
    }

    utf16ToByte(offset: number): number {
        if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length) {
            throw new RangeError('UTF-16 offset out of range');
        }

        const checkpoint = this.findCheckpoint(offset, 'utf16Start');
        if (!checkpoint) {
            return offset;
        }
        if (offset < checkpoint.utf16End) {
            return checkpoint.byteStart;
        }
        return checkpoint.byteEnd + offset - checkpoint.utf16End;
    }

    byteToUtf16(byteOffset: number): number {
        if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > this.totalBytes) {
            throw new RangeError('byte offset is not a UTF-8 boundary');
        }

        const checkpoint = this.findCheckpoint(byteOffset, 'byteStart');
        if (!checkpoint) {
            return byteOffset;
        }
        if (byteOffset < checkpoint.byteEnd) {
            if (byteOffset === checkpoint.byteStart) {
                return checkpoint.utf16Start;
            }
            throw new RangeError('byte offset is not a UTF-8 boundary');
        }
        return checkpoint.utf16End + byteOffset - checkpoint.byteEnd;
    }

    byteRangeToSourceRange(start: number, end: number): SourceSpan {
        return { start: this.byteToUtf16(start), end: this.byteToUtf16(end) };
    }

    private findCheckpoint(
        offset: number,
        startKey: 'utf16Start' | 'byteStart'
    ): PositionCheckpoint | undefined {
        let low = 0;
        let high = this.checkpoints.length - 1;
        let result: PositionCheckpoint | undefined;

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const checkpoint = this.checkpoints[middle];
            if (checkpoint[startKey] <= offset) {
                result = checkpoint;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        return result;
    }
}
