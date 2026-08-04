import { SourceSpan } from './model';

export class PositionMap {
    private readonly utf16ToByteOffsets: number[];
    private readonly byteBoundaryToUtf16 = new Map<number, number>();

    constructor(private readonly text: string) {
        this.utf16ToByteOffsets = new Array(text.length + 1);
        let byteOffset = 0;

        for (let offset = 0; offset < text.length;) {
            this.utf16ToByteOffsets[offset] = byteOffset;
            this.byteBoundaryToUtf16.set(byteOffset, offset);

            const codePoint = text.codePointAt(offset)!;
            const char = String.fromCodePoint(codePoint);
            const units = char.length;
            for (let i = 1; i < units; i++) {
                this.utf16ToByteOffsets[offset + i] = byteOffset;
            }

            byteOffset += Buffer.byteLength(char, 'utf8');
            offset += units;
        }

        this.utf16ToByteOffsets[text.length] = byteOffset;
        this.byteBoundaryToUtf16.set(byteOffset, text.length);
    }

    utf16ToByte(offset: number): number {
        if (offset < 0 || offset > this.text.length) {
            throw new RangeError('UTF-16 offset out of range');
        }
        return this.utf16ToByteOffsets[offset];
    }

    byteToUtf16(byteOffset: number): number {
        const offset = this.byteBoundaryToUtf16.get(byteOffset);
        if (offset === undefined) {
            throw new RangeError('byte offset is not a UTF-8 boundary');
        }
        return offset;
    }

    byteRangeToSourceRange(start: number, end: number): SourceSpan {
        return { start: this.byteToUtf16(start), end: this.byteToUtf16(end) };
    }
}
