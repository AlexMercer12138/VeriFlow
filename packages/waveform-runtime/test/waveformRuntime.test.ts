import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    INDEX_VERSION,
    MAX_WEB_TIMESTAMP,
    RawRecordCodec,
    SummaryRecordCodec,
    VcdIndexError,
    packLogicValue,
    unpackLogicValue,
    validateManifest,
} from '@veriflow/waveform-runtime/vcdIndexFormat';
import {
    VcdIndexCancelled,
    VcdIndexReader,
    buildVcdIndex,
} from '@veriflow/waveform-runtime/vcdIndex';
import {
    WaveformCache,
    WaveformCacheLock,
    sourceFingerprint,
} from '@veriflow/waveform-runtime/waveformCache';
import { WaveformWorkerClient } from '@veriflow/waveform-runtime/waveformWorkerClient';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const waveformFixture = path.join(repoRoot, 'tests', 'fixtures', 'waveform_debug.vcd');
const expectedIndex = JSON.parse(
    fs.readFileSync(
        path.join(repoRoot, 'tests', 'fixtures', 'waveform_index_expected.json'),
        'utf-8'
    )
);

function testLogicValueRoundTrip(): void {
    const samples: Array<[string, number, number[]]> = [
        ['1', 1, [0x40]],
        ['10xz', 4, [0x4b]],
        ['101010101', 9, [0x44, 0x44, 0x40]],
        ['x', 9, [0xaa, 0xaa, 0x80]],
    ];
    for (const [value, width, expected] of samples) {
        const packed = packLogicValue(value, width);
        assert.deepStrictEqual(Array.from(packed), expected);
        let normalized = value.toLowerCase();
        if (normalized.length === 1 && width > 1 && 'xz'.includes(normalized)) {
            normalized = normalized.repeat(width);
        } else {
            normalized = normalized.padStart(width, '0').slice(-width);
        }
        assert.strictEqual(unpackLogicValue(packed, width), normalized);
    }
}

function testRecordRoundTrips(): void {
    const raw = new RawRecordCodec(4);
    assert.strictEqual(raw.recordSize, 9);
    assert.deepStrictEqual(raw.decode(raw.encode(2 ** 40 + 7, '10xz')), {
        timestamp: 2 ** 40 + 7,
        value: '10xz',
    });

    const summary = new SummaryRecordCodec(4);
    assert.strictEqual(summary.recordSize, 19);
    assert.deepStrictEqual(
        summary.decode(summary.encode(5, 12, '1010', '10xz', 0b1111)),
        {
            firstTime: 5,
            lastTime: 12,
            firstValue: '1010',
            lastValue: '10xz',
            flags: 0b1111,
        }
    );
}

function testTimestampAndManifestValidation(): void {
    const raw = new RawRecordCodec(1);
    assert.throws(() => raw.encode(MAX_WEB_TIMESTAMP + 1, '0'), VcdIndexError);

    assert.strictEqual(
        validateManifest({
            formatVersion: INDEX_VERSION,
            dataFile: 'waveform.vfi',
            streams: [],
            signals: [],
        }).formatVersion,
        INDEX_VERSION
    );
    assert.throws(
        () => validateManifest({ formatVersion: INDEX_VERSION + 1 }),
        /version/
    );
}

async function testBuildAndQueryIndex(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-vfi-'));
    const indexDir = path.join(root, 'index');
    const metadataEvents: any[] = [];
    const progressEvents: any[] = [];
    try {
        const manifest = await buildVcdIndex(waveformFixture, indexDir, {
            onMetadata: (event: any) => metadataEvents.push(event),
            onProgress: (event: any) => progressEvents.push(event),
        });
        assert.strictEqual(metadataEvents.length, 1);
        assert.strictEqual(metadataEvents[0].timescale, '10ns');
        assert.strictEqual(metadataEvents[0].signals.length, 6);
        assert.strictEqual(manifest.endTime, 20);
        assert.strictEqual(progressEvents[0].phase, 'scan');
        assert.strictEqual(progressEvents[progressEvents.length - 1].phase, 'complete');

        const reader = new VcdIndexReader(indexDir);
        assert.strictEqual(reader.metadata.timescale, expectedIndex.timescale);
        assert.strictEqual(reader.metadata.endTime, expectedIndex.endTime);
        assert.deepStrictEqual(reader.rawChangesForReference('clk'), expectedIndex.clk);
        assert.deepStrictEqual(
            reader.rawChangesForReference('data [3:0]'),
            expectedIndex.data
        );

        const raw = reader.queryWindowForReference('clk', 7, 12, 32);
        assert.strictEqual(raw.kind, 'raw');
        assert.deepStrictEqual(raw.times, [5, 10]);

        const summary = reader.queryWindowForReference('data [3:0]', 0, 20, 1);
        assert.strictEqual(summary.kind, 'summary');
        assert.ok(summary.flags[0] & 1);
        assert.ok(summary.flags[0] & 2);
        assert.ok(summary.flags[0] & 4);

        assert.deepStrictEqual(
            reader.valuesAt(['clk', 'data [3:0]', 'ready'], 11),
            { clk: '0', 'data [3:0]': '1010', ready: '0' }
        );
        assert.strictEqual(reader.search('clk', 0, 1, 'rising')?.time, 5);
        assert.strictEqual(reader.search('clk', 12, -1, 'falling')?.time, 10);
        assert.strictEqual(
            reader.search('data [3:0]', 0, 1, 'value', '0xA')?.time,
            6
        );
        assert.strictEqual(reader.search('data [3:0]', 6, 1, 'xz')?.time, 12);
        assert.strictEqual(
            reader.search('data [3:0]', 0, 1, 'rising', '', 1)?.time,
            6
        );
        assert.strictEqual(reader.search('clk', 20, 1, 'change'), null);
        assert.throws(
            () => reader.queryWindowForReference('clk', 0, 20, 32, () => true),
            VcdIndexCancelled
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function testWaveformCache(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-cache-'));
    const cacheRoot = path.join(root, 'cache');
    const sourceOne = path.join(root, 'one.vcd');
    const sourceTwo = path.join(root, 'two.vcd');
    const sampled = path.join(root, 'sampled.vcd');
    try {
        const fixedTime = new Date('2023-11-14T22:13:20.123Z');
        fs.writeFileSync(
            sampled,
            Buffer.concat([
                Buffer.alloc(64 * 1024, 'a'),
                Buffer.from('middle'),
                Buffer.alloc(64 * 1024, 'z'),
            ])
        );
        fs.utimesSync(sampled, fixedTime, fixedTime);
        const before = await sourceFingerprint(sampled);
        const changed = fs.readFileSync(sampled);
        changed[0] = 'b'.charCodeAt(0);
        changed[changed.length - 1] = 'y'.charCodeAt(0);
        fs.writeFileSync(sampled, changed);
        fs.utimesSync(sampled, fixedTime, fixedTime);
        const after = await sourceFingerprint(sampled);
        assert.strictEqual(before.size, after.size);
        assert.strictEqual(before.mtimeNs, after.mtimeNs);
        assert.notStrictEqual(before.headSha256, after.headSha256);
        assert.notStrictEqual(before.tailSha256, after.tailSha256);
        assert.notStrictEqual(before.key, after.key);
        if (process.platform === 'win32') {
            assert.strictEqual(before.normalizedPath, before.normalizedPath.toLowerCase().replace(/\\/g, '/'));
        }

        fs.copyFileSync(waveformFixture, sourceOne);
        fs.copyFileSync(waveformFixture, sourceTwo);
        fs.appendFileSync(sourceTwo, '#21\n1#\n');
        const cache = new WaveformCache({ root: cacheRoot });
        const first = await cache.getOrBuild(sourceOne);
        const dataMtimeMs = fs.statSync(path.join(first, 'waveform.vfi')).mtimeMs;
        assert.strictEqual(await cache.getOrBuild(sourceOne), first);
        assert.strictEqual(fs.statSync(path.join(first, 'waveform.vfi')).mtimeMs, dataMtimeMs);
        cache.release(first);
        fs.writeFileSync(path.join(first, 'waveform.vfi'), 'BAD!');
        assert.strictEqual(await cache.getOrBuild(sourceOne), first);
        assert.strictEqual(
            fs.readFileSync(path.join(first, 'waveform.vfi')).subarray(0, 4).toString('ascii'),
            'VFI1'
        );
        cache.release(first);

        const secondFingerprint = await sourceFingerprint(sourceTwo);
        fs.mkdirSync(cacheRoot, { recursive: true });
        fs.writeFileSync(
            path.join(cacheRoot, `${secondFingerprint.key}.lock`),
            JSON.stringify({ pid: 999999999, heartbeatMs: 0, token: 'stale' })
        );
        const second = await cache.getOrBuild(sourceTwo);
        assert.strictEqual(path.basename(second), secondFingerprint.key);
        assert.ok(!fs.existsSync(path.join(cacheRoot, `${secondFingerprint.key}.lock`)));
        cache.release(second);

        const cancelledSource = path.join(root, 'cancelled.vcd');
        fs.copyFileSync(waveformFixture, cancelledSource);
        await assert.rejects(
            cache.getOrBuild(cancelledSource, { cancelled: () => true }),
            VcdIndexCancelled
        );
        assert.ok(
            fs.readdirSync(cacheRoot).every(name => !name.includes('.tmp.') && !name.endsWith('.lock'))
        );

        const firstManifestPath = path.join(first, 'manifest.json');
        const secondManifestPath = path.join(second, 'manifest.json');
        const firstManifest = JSON.parse(fs.readFileSync(firstManifestPath, 'utf8'));
        const secondManifest = JSON.parse(fs.readFileSync(secondManifestPath, 'utf8'));
        firstManifest.lastAccessNs = '1';
        secondManifest.lastAccessNs = '2';
        fs.writeFileSync(firstManifestPath, JSON.stringify(firstManifest));
        fs.writeFileSync(secondManifestPath, JSON.stringify(secondManifest));
        const directorySize = (directory: string): number => fs.readdirSync(directory)
            .reduce((total, name) => total + fs.statSync(path.join(directory, name)).size, 0);
        cache.maxBytes = Math.max(directorySize(first), directorySize(second));
        await cache.cleanup();
        assert.ok(!fs.existsSync(first));
        assert.ok(fs.existsSync(second));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function testMalformedStaleCacheLock(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-lock-'));
    const lockPath = path.join(root, 'broken.lock');
    try {
        fs.writeFileSync(lockPath, '{');
        fs.utimesSync(lockPath, new Date(0), new Date(0));
        const lock = new WaveformCacheLock(lockPath, 1);
        assert.strictEqual(await lock.acquire(), true);
        await lock.release();
        assert.strictEqual(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function testWaveformWorkerClient(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-worker-'));
    const client = new WaveformWorkerClient({ cacheRoot: path.join(root, 'cache') });
    const messages: any[] = [];
    const disposeListener = client.onMessage((message: any) => messages.push(message));
    const waitFor = async (predicate: (message: any) => boolean): Promise<any> => {
        const existing = messages.find(predicate);
        if (existing) return existing;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                dispose();
                reject(new Error('timed out waiting for waveform worker message'));
            }, 5000);
            const dispose = client.onMessage((message: any) => {
                if (!predicate(message)) return;
                clearTimeout(timeout);
                dispose();
                resolve(message);
            });
        });
    };
    try {
        const generation = client.open(waveformFixture);
        await waitFor(message => message.type === 'indexReady' && message.generation === generation);
        const metadataIndex = messages.findIndex(message => message.type === 'waveformMetadata');
        const readyIndex = messages.findIndex(message => message.type === 'indexReady');
        assert.ok(metadataIndex >= 0 && metadataIndex < readyIndex);

        const windowRequest = client.requestWindow({
            references: ['clk'],
            start: 0,
            end: 20,
            pixelWidth: 64,
        });
        const windowData = await waitFor(
            message => message.type === 'windowData' && message.requestId === windowRequest
        );
        assert.deepStrictEqual(windowData.series[0].times, [0, 5, 10, 15, 20]);
        assert.strictEqual(windowData.pixelWidth, 64);

        const cappedWindowRequest = client.requestWindow({
            references: ['clk', 'clk', 'clk', 'clk'],
            start: 0,
            end: 20,
            pixelWidth: 8192,
        });
        const cappedWindowData = await waitFor(
            message => message.type === 'windowData' && message.requestId === cappedWindowRequest
        );
        assert.strictEqual(cappedWindowData.pixelWidth, 4096);

        const valueRequest = client.requestValues(['clk', 'data [3:0]'], 11);
        const values = await waitFor(
            message => message.type === 'cursorValues' && message.requestId === valueRequest
        );
        assert.deepStrictEqual(values.values, { clk: '0', 'data [3:0]': '1010' });

        const searchRequest = client.requestSearch({
            reference: 'clk',
            cursorTime: 0,
            direction: 1,
            mode: 'rising',
        });
        const search = await waitFor(
            message => message.type === 'searchResult' && message.requestId === searchRequest
        );
        assert.strictEqual(search.result.time, 5);

        const cancelledRequest = client.requestWindow({
            references: ['clk'],
            start: 0,
            end: 20,
            pixelWidth: 64,
        });
        client.cancelRequest(cancelledRequest);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.ok(!messages.some(
            message => message.type === 'windowData' && message.requestId === cancelledRequest
        ));

        const reloadSource = path.join(root, 'reload.vcd');
        fs.copyFileSync(waveformFixture, reloadSource);
        const additions: string[] = [];
        for (let timestamp = 21; timestamp < 20000; timestamp++) {
            additions.push(`#${timestamp}\n${timestamp % 2}!\n`);
        }
        fs.appendFileSync(reloadSource, additions.join(''));
        const secondGeneration = client.open(reloadSource);
        const oldGenerationRequest = client.requestValues(['clk'], 11);
        const oldGenerationValues = await waitFor(
            message => message.type === 'cursorValues' && message.requestId === oldGenerationRequest
        );
        assert.strictEqual(oldGenerationValues.generation, generation);
        assert.deepStrictEqual(oldGenerationValues.values, { clk: '0' });
        await waitFor(
            message => message.type === 'indexReady' && message.generation === secondGeneration
        );
        const secondReady = messages.findIndex(
            message => message.type === 'indexReady' && message.generation === secondGeneration
        );
        assert.ok(messages.slice(secondReady).every(message => message.generation === secondGeneration));
    } finally {
        disposeListener();
        await client.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const tests: Array<[string, () => void | Promise<void>]> = [
    ['waveform logic value codec', testLogicValueRoundTrip],
    ['waveform record codecs', testRecordRoundTrips],
    ['waveform manifest validation', testTimestampAndManifestValidation],
    ['waveform index build and query', testBuildAndQueryIndex],
    ['waveform cache', testWaveformCache],
    ['malformed stale waveform cache lock', testMalformedStaleCacheLock],
    ['waveform worker client', testWaveformWorkerClient],
];

async function runTests(): Promise<void> {
    for (const [name, test] of tests) {
        await test();
        console.log(`ok - ${name}`);
    }
}

runTests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
