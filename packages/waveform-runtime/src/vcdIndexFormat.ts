export const INDEX_VERSION = 1;
export const DATA_MAGIC = Buffer.from('VFI1', 'ascii');
export const MAX_WEB_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export const SUMMARY_CHANGED = 1 << 0;
export const SUMMARY_HAS_X = 1 << 1;
export const SUMMARY_HAS_Z = 1 << 2;
export const SUMMARY_DENSE = 1 << 3;

const symbolToBits: Record<string, number> = {
    '0': 0,
    '1': 1,
    x: 2,
    z: 3,
};
const bitsToSymbol = '01xz';

export class VcdIndexError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VcdIndexError';
    }
}

export function packedValueSize(width: number): number {
    if (!Number.isInteger(width) || width <= 0) {
        throw new VcdIndexError('signal width must be a positive integer');
    }
    return Math.ceil(width * 2 / 8);
}

export function normalizeLogicValue(value: string, width: number): string {
    packedValueSize(width);
    let normalized = String(value || '').trim().toLowerCase();
    if (normalized.startsWith('b')) normalized = normalized.slice(1);
    if (!normalized) normalized = 'x';
    if (Array.from(normalized).some(symbol => symbolToBits[symbol] === undefined)) {
        throw new VcdIndexError(`unsupported logic value: ${JSON.stringify(value)}`);
    }
    if (normalized.length === 1 && width > 1 && 'xz'.includes(normalized)) {
        normalized = normalized.repeat(width);
    } else {
        normalized = normalized.padStart(width, '0').slice(-width);
    }
    return normalized;
}

export function packLogicValue(value: string, width: number): Buffer {
    const normalized = normalizeLogicValue(value, width);
    const size = packedValueSize(width);
    const packed = Buffer.alloc(size);
    const slots = size * 4;
    for (let index = 0; index < normalized.length; index++) {
        const shift = (slots - index - 1) * 2;
        const byteIndex = Math.floor((size * 8 - shift - 2) / 8);
        const bitOffset = shift % 8;
        packed[byteIndex] |= symbolToBits[normalized[index]] << bitOffset;
    }
    return packed;
}

export function unpackLogicValue(packed: Buffer, width: number): string {
    const size = packedValueSize(width);
    if (packed.length !== size) {
        throw new VcdIndexError(
            `packed value length ${packed.length} does not match width ${width}`
        );
    }
    const slots = size * 4;
    let result = '';
    for (let index = 0; index < width; index++) {
        const shift = (slots - index - 1) * 2;
        const byteIndex = Math.floor((size * 8 - shift - 2) / 8);
        const bitOffset = shift % 8;
        result += bitsToSymbol[(packed[byteIndex] >> bitOffset) & 0b11];
    }
    return result;
}

function validateTimestamp(timestamp: number): number {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new VcdIndexError(
            `timestamp ${timestamp} exceeds the exact WebView integer range`
        );
    }
    return timestamp;
}

export type RawRecord = {
    timestamp: number;
    value: string;
};

export class RawRecordCodec {
    public readonly valueSize: number;
    public readonly recordSize: number;

    constructor(public readonly width: number) {
        this.valueSize = packedValueSize(width);
        this.recordSize = 8 + this.valueSize;
    }

    encode(timestamp: number, value: string): Buffer {
        const record = Buffer.alloc(this.recordSize);
        record.writeBigUInt64LE(BigInt(validateTimestamp(timestamp)), 0);
        packLogicValue(value, this.width).copy(record, 8);
        return record;
    }

    decode(record: Buffer): RawRecord {
        if (record.length !== this.recordSize) {
            throw new VcdIndexError('raw record has an invalid length');
        }
        const timestamp = Number(record.readBigUInt64LE(0));
        validateTimestamp(timestamp);
        return {
            timestamp,
            value: unpackLogicValue(record.subarray(8), this.width),
        };
    }
}

export type SummaryRecord = {
    firstTime: number;
    lastTime: number;
    firstValue: string;
    lastValue: string;
    flags: number;
};

export class SummaryRecordCodec {
    public readonly valueSize: number;
    public readonly recordSize: number;

    constructor(public readonly width: number) {
        this.valueSize = packedValueSize(width);
        this.recordSize = 17 + 2 * this.valueSize;
    }

    encode(
        firstTime: number,
        lastTime: number,
        firstValue: string,
        lastValue: string,
        flags: number
    ): Buffer {
        if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
            throw new VcdIndexError('summary flags must fit in one byte');
        }
        const record = Buffer.alloc(this.recordSize);
        record.writeBigUInt64LE(BigInt(validateTimestamp(firstTime)), 0);
        record.writeBigUInt64LE(BigInt(validateTimestamp(lastTime)), 8);
        packLogicValue(firstValue, this.width).copy(record, 16);
        packLogicValue(lastValue, this.width).copy(record, 16 + this.valueSize);
        record[record.length - 1] = flags;
        return record;
    }

    decode(record: Buffer): SummaryRecord {
        if (record.length !== this.recordSize) {
            throw new VcdIndexError('summary record has an invalid length');
        }
        const firstTime = Number(record.readBigUInt64LE(0));
        const lastTime = Number(record.readBigUInt64LE(8));
        validateTimestamp(firstTime);
        validateTimestamp(lastTime);
        return {
            firstTime,
            lastTime,
            firstValue: unpackLogicValue(
                record.subarray(16, 16 + this.valueSize),
                this.width
            ),
            lastValue: unpackLogicValue(
                record.subarray(16 + this.valueSize, 16 + 2 * this.valueSize),
                this.width
            ),
            flags: record[record.length - 1],
        };
    }
}

export type VcdIndexManifest = {
    formatVersion: number;
    dataFile: string;
    streams: unknown[];
    signals: unknown[];
    [key: string]: unknown;
};

export function validateManifest(value: unknown): VcdIndexManifest {
    if (!value || typeof value !== 'object') {
        throw new VcdIndexError('manifest must be an object');
    }
    const manifest = value as Record<string, unknown>;
    if (manifest.formatVersion !== INDEX_VERSION) {
        throw new VcdIndexError('unsupported waveform index version');
    }
    if (typeof manifest.dataFile !== 'string' || !manifest.dataFile) {
        throw new VcdIndexError('manifest dataFile must be a non-empty string');
    }
    if (!Array.isArray(manifest.streams)) {
        throw new VcdIndexError('manifest streams must be an array');
    }
    if (!Array.isArray(manifest.signals)) {
        throw new VcdIndexError('manifest signals must be an array');
    }
    return manifest as VcdIndexManifest;
}
