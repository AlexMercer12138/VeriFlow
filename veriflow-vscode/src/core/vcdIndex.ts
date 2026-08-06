import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import {
    DATA_MAGIC,
    INDEX_VERSION,
    RawRecord,
    RawRecordCodec,
    SUMMARY_CHANGED,
    SUMMARY_DENSE,
    SUMMARY_HAS_X,
    SUMMARY_HAS_Z,
    SummaryRecord,
    SummaryRecordCodec,
    VcdIndexError,
    packLogicValue,
    validateManifest,
} from './vcdIndexFormat';

export type CancelCallback = () => boolean;

export type VcdIndexProgress = {
    phase: 'waiting' | 'scan' | 'write' | 'summarize' | 'complete';
    completed: number;
    total: number;
    percent: number;
};

export type VcdIndexBuildOptions = {
    onMetadata?: (metadata: VcdMetadata) => void;
    onProgress?: (progress: VcdIndexProgress) => void;
    cancelled?: CancelCallback;
};

export type VcdScope = {
    name: string;
    fullName: string;
    depth: number;
};

export type VcdSignal = {
    id: string;
    reference: string;
    fullName: string;
    scope: string;
    type: string;
    width: number;
    stream: number;
};

export type VcdWarning = {
    line: number;
    message: string;
};

export type VcdMetadata = {
    version: string;
    date: string;
    timescale: string;
    startTime: number;
    endTime: number;
    scopes: VcdScope[];
    signals: VcdSignal[];
    warnings: VcdWarning[];
};

type SummaryLevel = {
    offset: number;
    count: number;
    recordSize: number;
};

type VcdStream = {
    identifier: string;
    width: number;
    count: number;
    rawOffset: number;
    rawRecordSize: number;
    levels: SummaryLevel[];
};

export type WaveformManifest = VcdMetadata & {
    formatVersion: number;
    dataFile: string;
    streams: VcdStream[];
    signals: VcdSignal[];
    [key: string]: unknown;
};

export type RawWindow = {
    kind: 'raw';
    width: number;
    times: number[];
    values: string;
    valueStride: number;
};

export type SummaryWindow = {
    kind: 'summary';
    width: number;
    firstTimes: number[];
    lastTimes: number[];
    firstValues: string;
    lastValues: string;
    valueStride: number;
    flags: number[];
};

export type WaveformWindow = RawWindow | SummaryWindow;

export type SearchResult = {
    reference: string;
    time: number;
    value: string;
    fullValue: string;
    bitIndex: number | undefined;
};

type ScanResult = {
    metadata: VcdMetadata;
    streams: VcdStream[];
    signals: VcdSignal[];
};

type ParsedChange = {
    identifier: string;
    value: string;
};

export class VcdIndexCancelled extends VcdIndexError {
    constructor(message = 'waveform index build cancelled') {
        super(message);
        this.name = 'VcdIndexCancelled';
    }
}

function checkCancelled(cancelled?: CancelCallback): void {
    if (cancelled?.()) {
        throw new VcdIndexCancelled();
    }
}

function emit<T>(callback: ((event: T) => void) | undefined, event: T): void {
    callback?.(event);
}

function parseChange(line: string): ParsedChange | undefined {
    if (!line) return undefined;
    if ('01xXzZ'.includes(line[0])) {
        const identifier = line.slice(1).trim();
        return identifier ? { identifier, value: line[0].toLowerCase() } : undefined;
    }
    if ('bB'.includes(line[0])) {
        const parts = line.slice(1).trim().split(/\s+/, 2);
        if (parts.length === 2) {
            return { identifier: parts[1].trim(), value: parts[0].toLowerCase() };
        }
    }
    return undefined;
}

function cloneMetadata(metadata: VcdMetadata): VcdMetadata {
    return JSON.parse(JSON.stringify(metadata)) as VcdMetadata;
}

async function scanVcd(
    source: string,
    options: VcdIndexBuildOptions
): Promise<ScanResult> {
    const sourceSize = (await fs.promises.stat(source)).size;
    emit(options.onProgress, {
        phase: 'scan',
        completed: 0,
        total: sourceSize,
        percent: 0,
    });

    const scopes: VcdScope[] = [];
    const scopeStack: string[] = [];
    const signals: VcdSignal[] = [];
    const streams: VcdStream[] = [];
    const streamByIdentifier = new Map<string, number>();
    const warnings: VcdWarning[] = [];
    const metadata: VcdMetadata = {
        version: '',
        date: '',
        timescale: '',
        startTime: 0,
        endTime: 0,
        scopes,
        signals,
        warnings,
    };

    let currentTime = 0;
    let endDefinitions = false;
    let metadataEmitted = false;
    let directiveName = '';
    let directiveParts: string[] = [];
    let lineNumber = 0;
    let lastProgressAt = 0;

    const finishDirective = (): void => {
        const value = directiveParts.filter(Boolean).join(' ').trim();
        if (directiveName === 'version') metadata.version = value;
        if (directiveName === 'date') metadata.date = value;
        if (directiveName === 'timescale') metadata.timescale = value;
        directiveName = '';
        directiveParts = [];
    };

    const input = fs.createReadStream(source, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const raw of lines) {
            lineNumber += 1;
            if (lineNumber % 4096 === 0) checkCancelled(options.cancelled);
            const now = Date.now();
            if (now - lastProgressAt >= 100) {
                const completed = Math.min(sourceSize, input.bytesRead);
                emit(options.onProgress, {
                    phase: 'scan',
                    completed,
                    total: sourceSize,
                    percent: sourceSize ? Math.min(39, Math.round(39 * completed / sourceSize)) : 39,
                });
                lastProgressAt = now;
            }

            const line = raw.trim();
            if (!line) continue;

            if (directiveName) {
                const marker = line.indexOf('$end');
                directiveParts.push((marker >= 0 ? line.slice(0, marker) : line).trim());
                if (marker >= 0) finishDirective();
                continue;
            }

            if (!endDefinitions) {
                let matchedDirective = false;
                for (const name of ['date', 'version', 'timescale', 'comment']) {
                    const prefix = `$${name}`;
                    if (!line.startsWith(prefix)) continue;
                    const rest = line.slice(prefix.length).trim();
                    const marker = rest.indexOf('$end');
                    directiveName = name;
                    directiveParts = [(marker >= 0 ? rest.slice(0, marker) : rest).trim()];
                    if (marker >= 0) finishDirective();
                    matchedDirective = true;
                    break;
                }
                if (matchedDirective) continue;

                if (line.startsWith('$scope')) {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 4) {
                        const name = parts[2];
                        scopes.push({
                            name,
                            fullName: [...scopeStack, name].join('.'),
                            depth: scopeStack.length,
                        });
                        scopeStack.push(name);
                    } else {
                        warnings.push({ line: lineNumber, message: 'Malformed $scope directive' });
                    }
                    continue;
                }
                if (line.startsWith('$upscope')) {
                    if (scopeStack.length) {
                        scopeStack.pop();
                    } else {
                        warnings.push({ line: lineNumber, message: 'Unexpected $upscope' });
                    }
                    continue;
                }
                if (line.startsWith('$var')) {
                    const parts = line.split(/\s+/);
                    if (parts.length < 6) {
                        warnings.push({ line: lineNumber, message: 'Malformed $var directive' });
                        continue;
                    }
                    const width = Number(parts[2]);
                    if (!Number.isInteger(width) || width <= 0) {
                        warnings.push({ line: lineNumber, message: 'Invalid signal width' });
                        continue;
                    }
                    const identifier = parts[3];
                    const reference = parts.slice(4, -1).join(' ');
                    let streamIndex = streamByIdentifier.get(identifier);
                    if (streamIndex === undefined) {
                        streamIndex = streams.length;
                        streamByIdentifier.set(identifier, streamIndex);
                        streams.push({
                            identifier,
                            width,
                            count: 0,
                            rawOffset: 0,
                            rawRecordSize: new RawRecordCodec(width).recordSize,
                            levels: [],
                        });
                    } else if (streams[streamIndex].width !== width) {
                        throw new VcdIndexError(`alias width mismatch for identifier ${JSON.stringify(identifier)}`);
                    }
                    const scope = scopeStack.join('.');
                    signals.push({
                        id: identifier,
                        reference,
                        fullName: scope ? `${scope}.${reference}` : reference,
                        scope,
                        type: parts[1],
                        width,
                        stream: streamIndex,
                    });
                    continue;
                }
                if (line.startsWith('$enddefinitions')) {
                    endDefinitions = true;
                    metadataEmitted = true;
                    emit(options.onMetadata, cloneMetadata(metadata));
                }
                continue;
            }

            if (line.startsWith('#')) {
                const parsed = Number(line.slice(1).trim());
                if (Number.isSafeInteger(parsed) && parsed >= 0) {
                    currentTime = parsed;
                } else {
                    warnings.push({ line: lineNumber, message: 'Invalid VCD timestamp' });
                }
                metadata.endTime = Math.max(metadata.endTime, currentTime);
                continue;
            }
            const change = parseChange(line);
            if (!change) continue;
            const streamIndex = streamByIdentifier.get(change.identifier);
            if (streamIndex === undefined) {
                warnings.push({
                    line: lineNumber,
                    message: `Value change for unknown id ${JSON.stringify(change.identifier)}`,
                });
                continue;
            }
            streams[streamIndex].count += 1;
        }
    } finally {
        lines.close();
    }

    checkCancelled(options.cancelled);
    if (!metadataEmitted) throw new VcdIndexError('VCD is missing $enddefinitions');
    emit(options.onProgress, {
        phase: 'scan',
        completed: sourceSize,
        total: sourceSize,
        percent: 40,
    });
    return { metadata, streams, signals };
}

async function* iterateChanges(source: string): AsyncGenerator<[number, string, string]> {
    let currentTime = 0;
    let endDefinitions = false;
    const input = fs.createReadStream(source, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (!endDefinitions) {
                if (line.startsWith('$enddefinitions')) endDefinitions = true;
                continue;
            }
            if (line.startsWith('#')) {
                const parsed = Number(line.slice(1).trim());
                if (Number.isSafeInteger(parsed) && parsed >= 0) currentTime = parsed;
                continue;
            }
            const change = parseChange(line);
            if (change) yield [currentTime, change.identifier, change.value];
        }
    } finally {
        lines.close();
    }
}

class BufferedPositionWriter {
    private readonly positions: number[];
    private readonly buffers = new Map<number, Buffer[]>();
    private readonly bufferSizes = new Map<number, number>();
    private totalBuffered = 0;

    constructor(
        private readonly handle: fs.promises.FileHandle,
        streams: VcdStream[],
        private readonly perStreamLimit = 64 * 1024,
        private readonly totalLimit = 64 * 1024 * 1024
    ) {
        this.positions = streams.map(stream => stream.rawOffset);
    }

    async append(streamIndex: number, record: Buffer): Promise<void> {
        let records = this.buffers.get(streamIndex);
        if (!records) {
            records = [];
            this.buffers.set(streamIndex, records);
        } else {
            this.buffers.delete(streamIndex);
            this.buffers.set(streamIndex, records);
        }
        records.push(record);
        const size = (this.bufferSizes.get(streamIndex) ?? 0) + record.length;
        this.bufferSizes.set(streamIndex, size);
        this.totalBuffered += record.length;
        if (size >= this.perStreamLimit) await this.flush(streamIndex);
        while (this.totalBuffered > this.totalLimit && this.buffers.size) {
            const oldest = this.buffers.keys().next().value as number;
            await this.flush(oldest);
        }
    }

    async flush(streamIndex: number): Promise<void> {
        const records = this.buffers.get(streamIndex);
        if (!records) return;
        const data = Buffer.concat(records);
        this.buffers.delete(streamIndex);
        this.bufferSizes.delete(streamIndex);
        await this.handle.write(data, 0, data.length, this.positions[streamIndex]);
        this.positions[streamIndex] += data.length;
        this.totalBuffered -= data.length;
    }

    async flushAll(): Promise<void> {
        for (const streamIndex of Array.from(this.buffers.keys())) {
            await this.flush(streamIndex);
        }
    }
}

async function readExact(
    handle: fs.promises.FileHandle,
    length: number,
    position: number,
    errorMessage: string
): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new VcdIndexError(errorMessage);
    return buffer;
}

function logicFlags(value: string): number {
    let flags = 0;
    if (value.includes('x')) flags |= SUMMARY_HAS_X;
    if (value.includes('z')) flags |= SUMMARY_HAS_Z;
    return flags;
}

async function buildSummaryLevels(
    handle: fs.promises.FileHandle,
    streams: VcdStream[],
    options: VcdIndexBuildOptions
): Promise<void> {
    let appendOffset = (await handle.stat()).size;
    const totalStreams = Math.max(1, streams.length);

    for (let streamIndex = 0; streamIndex < streams.length; streamIndex++) {
        checkCancelled(options.cancelled);
        const stream = streams[streamIndex];
        const rawCodec = new RawRecordCodec(stream.width);
        const summaryCodec = new SummaryRecordCodec(stream.width);
        let sourceKind: 'raw' | 'summary' = 'raw';
        let sourceOffset = stream.rawOffset;
        let sourceCount = stream.count;
        let sourceRecordSize = rawCodec.recordSize;
        const levels: SummaryLevel[] = [];

        while (sourceCount > 1) {
            const levelOffset = appendOffset;
            let levelCount = 0;
            for (let groupStart = 0; groupStart < sourceCount; groupStart += 8) {
                if (groupStart % (8 * 512) === 0) checkCancelled(options.cancelled);
                const groupCount = Math.min(8, sourceCount - groupStart);
                const records: Array<RawRecord | SummaryRecord> = [];
                for (let index = 0; index < groupCount; index++) {
                    const record = await readExact(
                        handle,
                        sourceRecordSize,
                        sourceOffset + (groupStart + index) * sourceRecordSize,
                        'waveform index summary source is truncated'
                    );
                    records.push(sourceKind === 'raw' ? rawCodec.decode(record) : summaryCodec.decode(record));
                }

                let firstTime: number;
                let lastTime: number;
                let firstValue: string;
                let lastValue: string;
                let flags = 0;
                if (sourceKind === 'raw') {
                    const rawRecords = records as RawRecord[];
                    firstTime = rawRecords[0].timestamp;
                    lastTime = rawRecords[rawRecords.length - 1].timestamp;
                    firstValue = rawRecords[0].value;
                    lastValue = rawRecords[rawRecords.length - 1].value;
                    let previous = firstValue;
                    for (const item of rawRecords) {
                        flags |= logicFlags(item.value);
                        if (item.value !== previous) flags |= SUMMARY_CHANGED;
                        previous = item.value;
                    }
                } else {
                    const summaryRecords = records as SummaryRecord[];
                    firstTime = summaryRecords[0].firstTime;
                    lastTime = summaryRecords[summaryRecords.length - 1].lastTime;
                    firstValue = summaryRecords[0].firstValue;
                    lastValue = summaryRecords[summaryRecords.length - 1].lastValue;
                    let previous = firstValue;
                    for (const item of summaryRecords) {
                        flags |= item.flags;
                        if (item.firstValue !== previous) flags |= SUMMARY_CHANGED;
                        previous = item.lastValue;
                    }
                }
                if (groupCount === 8 && (flags & SUMMARY_CHANGED)) flags |= SUMMARY_DENSE;
                const encoded = summaryCodec.encode(firstTime, lastTime, firstValue, lastValue, flags);
                await handle.write(encoded, 0, encoded.length, appendOffset);
                appendOffset += encoded.length;
                levelCount += 1;
            }

            levels.push({ offset: levelOffset, count: levelCount, recordSize: summaryCodec.recordSize });
            sourceKind = 'summary';
            sourceOffset = levelOffset;
            sourceCount = levelCount;
            sourceRecordSize = summaryCodec.recordSize;
        }
        stream.levels = levels;
        emit(options.onProgress, {
            phase: 'summarize',
            completed: streamIndex + 1,
            total: totalStreams,
            percent: 85 + Math.round(14 * (streamIndex + 1) / totalStreams),
        });
    }
}

export async function buildVcdIndex(
    source: string,
    indexDir: string,
    options: VcdIndexBuildOptions = {}
): Promise<WaveformManifest> {
    source = path.resolve(source);
    indexDir = path.resolve(indexDir);
    try {
        await fs.promises.access(indexDir);
        throw new VcdIndexError(`index directory already exists: ${indexDir}`);
    } catch (error) {
        if (!(error instanceof VcdIndexError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        if (error instanceof VcdIndexError) throw error;
    }

    const scan = await scanVcd(source, options);
    let offset = DATA_MAGIC.length;
    for (const stream of scan.streams) {
        stream.rawOffset = offset;
        offset += stream.count * stream.rawRecordSize;
    }

    await fs.promises.mkdir(indexDir, { recursive: true });
    const dataPath = path.join(indexDir, 'waveform.vfi');
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(dataPath, 'w+');
        await handle.write(DATA_MAGIC, 0, DATA_MAGIC.length, 0);
        await handle.truncate(offset);
        const writer = new BufferedPositionWriter(handle, scan.streams);
        const streamByIdentifier = new Map(
            scan.streams.map((stream, index) => [stream.identifier, index])
        );
        const codecs = scan.streams.map(stream => new RawRecordCodec(stream.width));
        const totalChanges = scan.streams.reduce((total, stream) => total + stream.count, 0);
        let writtenChanges = 0;
        emit(options.onProgress, {
            phase: 'write',
            completed: 0,
            total: totalChanges,
            percent: 40,
        });
        for await (const [timestamp, identifier, value] of iterateChanges(source)) {
            if (writtenChanges % 4096 === 0) checkCancelled(options.cancelled);
            const streamIndex = streamByIdentifier.get(identifier);
            if (streamIndex === undefined) continue;
            await writer.append(streamIndex, codecs[streamIndex].encode(timestamp, value));
            writtenChanges += 1;
        }
        await writer.flushAll();
        await buildSummaryLevels(handle, scan.streams, options);
        await handle.sync();
        await handle.close();
        handle = undefined;

        const manifest: WaveformManifest = {
            formatVersion: INDEX_VERSION,
            dataFile: 'waveform.vfi',
            ...scan.metadata,
            streams: scan.streams,
            signals: scan.signals,
        };
        await fs.promises.writeFile(
            path.join(indexDir, 'manifest.json'),
            JSON.stringify(manifest),
            'utf8'
        );
        emit(options.onProgress, {
            phase: 'complete',
            completed: totalChanges,
            total: totalChanges,
            percent: 100,
        });
        return manifest;
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.promises.rm(indexDir, { recursive: true, force: true });
        throw error;
    }
}

export class VcdIndexReader {
    public readonly manifest: WaveformManifest;
    public readonly dataPath: string;
    private readonly dataHandle: number;

    constructor(public readonly indexDir: string) {
        this.manifest = validateManifest(
            JSON.parse(fs.readFileSync(path.join(indexDir, 'manifest.json'), 'utf8'))
        ) as unknown as WaveformManifest;
        this.dataPath = path.join(indexDir, this.manifest.dataFile);
        this.dataHandle = fs.openSync(this.dataPath, 'r');
        const magic = Buffer.alloc(DATA_MAGIC.length);
        const bytesRead = fs.readSync(this.dataHandle, magic, 0, magic.length, 0);
        if (bytesRead !== magic.length || !magic.equals(DATA_MAGIC)) {
            fs.closeSync(this.dataHandle);
            throw new VcdIndexError('waveform index data magic is invalid');
        }
    }

    get metadata(): VcdMetadata {
        return {
            version: this.manifest.version,
            date: this.manifest.date,
            timescale: this.manifest.timescale,
            startTime: this.manifest.startTime,
            endTime: this.manifest.endTime,
            scopes: this.manifest.scopes,
            signals: this.manifest.signals,
            warnings: this.manifest.warnings,
        };
    }

    close(): void {
        fs.closeSync(this.dataHandle);
    }

    private signalForReference(reference: string): VcdSignal {
        const signal = this.manifest.signals.find(item => item.reference === reference);
        if (!signal) throw new VcdIndexError(`unknown waveform signal reference: ${reference}`);
        return signal;
    }

    private streamForReference(reference: string): [VcdSignal, VcdStream] {
        const signal = this.signalForReference(reference);
        return [signal, this.manifest.streams[signal.stream]];
    }

    private readBuffer(position: number, length: number, errorMessage: string): Buffer {
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(this.dataHandle, buffer, 0, length, position);
        if (bytesRead !== length) throw new VcdIndexError(errorMessage);
        return buffer;
    }

    private readRaw(stream: VcdStream, codec: RawRecordCodec, index: number): RawRecord {
        return codec.decode(this.readBuffer(
            stream.rawOffset + index * codec.recordSize,
            codec.recordSize,
            'waveform index raw stream is truncated'
        ));
    }

    private lowerBoundRaw(stream: VcdStream, codec: RawRecordCodec, timestamp: number): number {
        let low = 0;
        let high = stream.count;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.readRaw(stream, codec, middle).timestamp < timestamp) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    private upperBoundRaw(stream: VcdStream, codec: RawRecordCodec, timestamp: number): number {
        let low = 0;
        let high = stream.count;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.readRaw(stream, codec, middle).timestamp <= timestamp) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    private readSummary(level: SummaryLevel, codec: SummaryRecordCodec, index: number): SummaryRecord {
        return codec.decode(this.readBuffer(
            level.offset + index * codec.recordSize,
            codec.recordSize,
            'waveform index summary stream is truncated'
        ));
    }

    private summaryRange(
        level: SummaryLevel,
        codec: SummaryRecordCodec,
        start: number,
        end: number
    ): [number, number] {
        let low = 0;
        let high = level.count;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.readSummary(level, codec, middle).lastTime < start) low = middle + 1;
            else high = middle;
        }
        const firstIndex = low;
        high = level.count;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.readSummary(level, codec, middle).firstTime <= end) low = middle + 1;
            else high = middle;
        }
        return [firstIndex, low];
    }

    rawChangesForReference(reference: string): Array<[number, string]> {
        const [, stream] = this.streamForReference(reference);
        const codec = new RawRecordCodec(stream.width);
        const result: Array<[number, string]> = [];
        for (let index = 0; index < stream.count; index++) {
            const record = this.readRaw(stream, codec, index);
            result.push([record.timestamp, record.value]);
        }
        return result;
    }

    queryWindowForReference(
        reference: string,
        start: number,
        end: number,
        pixelWidth: number,
        cancelled?: CancelCallback
    ): WaveformWindow {
        checkCancelled(cancelled);
        if (end < start) [start, end] = [end, start];
        const [, stream] = this.streamForReference(reference);
        const rawCodec = new RawRecordCodec(stream.width);
        const maxRecords = Math.max(1, Math.trunc(pixelWidth) * 2);
        const firstInRange = this.lowerBoundRaw(stream, rawCodec, start);
        const rawStart = Math.max(0, firstInRange - 1);
        let rawEnd = this.upperBoundRaw(stream, rawCodec, end);
        if (rawEnd < rawStart + 1 && stream.count) rawEnd = Math.min(stream.count, rawStart + 1);
        const rawCount = Math.max(0, rawEnd - rawStart);

        if (rawCount <= maxRecords || !stream.levels.length) {
            const times: number[] = [];
            const values: Buffer[] = [];
            for (let index = rawStart; index < rawEnd; index++) {
                if (index % 4096 === 0) checkCancelled(cancelled);
                const record = this.readRaw(stream, rawCodec, index);
                times.push(record.timestamp);
                values.push(packLogicValue(record.value, stream.width));
            }
            return {
                kind: 'raw',
                width: stream.width,
                times,
                values: Buffer.concat(values).toString('base64'),
                valueStride: rawCodec.valueSize,
            };
        }

        const summaryCodec = new SummaryRecordCodec(stream.width);
        let selectedLevel = stream.levels[stream.levels.length - 1];
        let selectedRange = this.summaryRange(selectedLevel, summaryCodec, start, end);
        for (const level of stream.levels) {
            const candidateRange = this.summaryRange(level, summaryCodec, start, end);
            if (candidateRange[1] - candidateRange[0] <= maxRecords) {
                selectedLevel = level;
                selectedRange = candidateRange;
                break;
            }
        }
        const firstTimes: number[] = [];
        const lastTimes: number[] = [];
        const firstValues: Buffer[] = [];
        const lastValues: Buffer[] = [];
        const flags: number[] = [];
        for (let index = selectedRange[0]; index < selectedRange[1]; index++) {
            checkCancelled(cancelled);
            const record = this.readSummary(selectedLevel, summaryCodec, index);
            firstTimes.push(record.firstTime);
            lastTimes.push(record.lastTime);
            firstValues.push(packLogicValue(record.firstValue, stream.width));
            lastValues.push(packLogicValue(record.lastValue, stream.width));
            flags.push(record.flags);
        }
        return {
            kind: 'summary',
            width: stream.width,
            firstTimes,
            lastTimes,
            firstValues: Buffer.concat(firstValues).toString('base64'),
            lastValues: Buffer.concat(lastValues).toString('base64'),
            valueStride: summaryCodec.valueSize,
            flags,
        };
    }

    valueAt(reference: string, timestamp: number): string {
        const [, stream] = this.streamForReference(reference);
        const codec = new RawRecordCodec(stream.width);
        if (!stream.count) return 'x'.repeat(stream.width);
        const index = this.upperBoundRaw(stream, codec, timestamp) - 1;
        return index < 0 ? 'x'.repeat(stream.width) : this.readRaw(stream, codec, index).value;
    }

    valuesAt(references: string[], timestamp: number): Record<string, string> {
        return Object.fromEntries(references.map(reference => [reference, this.valueAt(reference, timestamp)]));
    }

    private static searchValue(text: string, width: number): string {
        const cleaned = String(text || '').toLowerCase().replace(/[_\s]/g, '');
        let numeric: bigint;
        try {
            if (cleaned.startsWith('0x')) numeric = BigInt(cleaned);
            else if (cleaned.startsWith('h')) numeric = BigInt(`0x${cleaned.slice(1)}`);
            else if (cleaned.startsWith('0b')) numeric = BigInt(cleaned);
            else if (cleaned.startsWith('b')) numeric = BigInt(`0b${cleaned.slice(1)}`);
            else numeric = BigInt(cleaned);
        } catch {
            throw new VcdIndexError('invalid waveform search value');
        }
        if (numeric < 0n || numeric >= (1n << BigInt(width))) {
            throw new VcdIndexError('waveform search value exceeds signal width');
        }
        return numeric.toString(2).padStart(width, '0');
    }

    private static bitValue(value: string, bitIndex?: number): string {
        if (bitIndex === undefined) return value;
        if (!Number.isInteger(bitIndex) || bitIndex < 0 || bitIndex >= value.length) {
            throw new VcdIndexError('bus bit index is outside signal width');
        }
        return value[value.length - 1 - bitIndex];
    }

    search(
        reference: string,
        cursorTime: number,
        direction: number,
        mode: string,
        query = '',
        bitIndex?: number,
        cancelled?: CancelCallback
    ): SearchResult | null {
        checkCancelled(cancelled);
        const [, stream] = this.streamForReference(reference);
        const codec = new RawRecordCodec(stream.width);
        const targetValue = mode === 'value'
            ? VcdIndexReader.searchValue(query, bitIndex === undefined ? stream.width : 1)
            : '';
        if ((mode === 'rising' || mode === 'falling') && stream.width !== 1 && bitIndex === undefined) {
            throw new VcdIndexError('edge search requires a scalar signal or bus bit');
        }
        if (!['change', 'rising', 'falling', 'value', 'xz'].includes(mode)) {
            throw new VcdIndexError('unsupported waveform search mode');
        }

        let index = direction >= 0
            ? this.upperBoundRaw(stream, codec, cursorTime)
            : this.lowerBoundRaw(stream, codec, cursorTime) - 1;
        const step = direction >= 0 ? 1 : -1;
        let iteration = 0;
        while (index >= 0 && index < stream.count) {
            if (iteration % 4096 === 0) checkCancelled(cancelled);
            const record = this.readRaw(stream, codec, index);
            const value = VcdIndexReader.bitValue(record.value, bitIndex);
            let matches = mode === 'change';
            if (mode === 'xz') matches = value.includes('x') || value.includes('z');
            else if (mode === 'value') matches = value === targetValue;
            else if ((mode === 'rising' || mode === 'falling') && index > 0) {
                const previous = VcdIndexReader.bitValue(
                    this.readRaw(stream, codec, index - 1).value,
                    bitIndex
                );
                matches = mode === 'rising'
                    ? previous === '0' && value === '1'
                    : previous === '1' && value === '0';
            }
            if (matches) {
                return {
                    reference,
                    time: record.timestamp,
                    value,
                    fullValue: record.value,
                    bitIndex,
                };
            }
            index += step;
            iteration += 1;
        }
        return null;
    }
}
