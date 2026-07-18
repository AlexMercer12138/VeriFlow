import * as assert from 'assert';

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

const tests: Array<[string, () => void]> = [
    ['waveform logic value codec', testLogicValueRoundTrip],
    ['waveform record codecs', testRecordRoundTrips],
    ['waveform manifest validation', testTimestampAndManifestValidation],
];

for (const [name, test] of tests) {
    test();
    console.log(`ok - ${name}`);
}
