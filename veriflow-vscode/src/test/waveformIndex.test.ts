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
} from '../core/vcdIndexFormat';
import {
    VcdIndexCancelled,
    VcdIndexReader,
    buildVcdIndex,
} from '../core/vcdIndex';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
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

const tests: Array<[string, () => void | Promise<void>]> = [
    ['waveform logic value codec', testLogicValueRoundTrip],
    ['waveform record codecs', testRecordRoundTrips],
    ['waveform manifest validation', testTimestampAndManifestValidation],
    ['waveform index build and query', testBuildAndQueryIndex],
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
