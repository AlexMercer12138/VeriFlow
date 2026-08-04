import * as assert from 'assert';
import { spawnSync } from 'child_process';

import { PositionMap } from '../core/hdl/positionMap';

const text = 'module top; // chinese: \u4fe1\u53f7\nendmodule\n';
const map = new PositionMap(text);
const endmoduleUtf16 = text.indexOf('endmodule');
const endmoduleByte = Buffer.byteLength(text.slice(0, endmoduleUtf16), 'utf8');

assert.strictEqual(map.byteToUtf16(endmoduleByte), endmoduleUtf16);
assert.strictEqual(map.utf16ToByte(endmoduleUtf16), endmoduleByte);
assert.deepStrictEqual(map.byteRangeToSourceRange(endmoduleByte, endmoduleByte + 9), {
    start: endmoduleUtf16,
    end: endmoduleUtf16 + 9,
});

const emojiText = 'a\ud83d\ude00b';
const emojiMap = new PositionMap(emojiText);
assert.strictEqual(emojiMap.byteToUtf16(1), 1);
assert.strictEqual(emojiMap.byteToUtf16(5), 3);
assert.strictEqual(emojiMap.utf16ToByte(2), 1);
assert.throws(() => emojiMap.byteToUtf16(2), /UTF-8 boundary/);

const emptyMap = new PositionMap('');
assert.strictEqual(emptyMap.byteToUtf16(0), 0);
assert.strictEqual(emptyMap.utf16ToByte(0), 0);
assert.deepStrictEqual(emptyMap.byteRangeToSourceRange(0, 0), { start: 0, end: 0 });

const bmpMap = new PositionMap('\u4fe1');
assert.strictEqual(bmpMap.utf16ToByte(0), 0);
assert.strictEqual(bmpMap.utf16ToByte(1), 3);
assert.strictEqual(bmpMap.byteToUtf16(3), 1);
assert.throws(() => bmpMap.byteToUtf16(1), /UTF-8 boundary/);

assert.throws(() => map.utf16ToByte(-1), /UTF-16 offset out of range/);
assert.throws(() => map.utf16ToByte(text.length + 1), /UTF-16 offset out of range/);
assert.throws(() => map.utf16ToByte(Number.NaN), /UTF-16 offset out of range/);
assert.throws(() => map.utf16ToByte(Number.POSITIVE_INFINITY), /UTF-16 offset out of range/);
assert.throws(() => map.utf16ToByte(0.5), /UTF-16 offset out of range/);
assert.throws(() => map.byteToUtf16(-1), /UTF-8 boundary/);
assert.throws(() => map.byteToUtf16(Buffer.byteLength(text, 'utf8') + 1), /UTF-8 boundary/);
assert.throws(() => map.byteToUtf16(Number.NaN), /UTF-8 boundary/);
assert.throws(() => map.byteToUtf16(Number.POSITIVE_INFINITY), /UTF-8 boundary/);
assert.throws(() => map.byteToUtf16(0.5), /UTF-8 boundary/);
const chineseUtf16 = text.indexOf('\u4fe1');
const chineseByte = Buffer.byteLength(text.slice(0, chineseUtf16), 'utf8');
assert.throws(() => map.byteRangeToSourceRange(chineseByte + 1, endmoduleByte), /UTF-8 boundary/);

const mixedText = [
    'a'.repeat(10_000),
    '\u4fe1',
    'b'.repeat(12_000),
    '\ud83d\ude00',
    'c'.repeat(8_000),
    '\ud800',
    'd'.repeat(7_000),
    '\udc00',
    'e'.repeat(9_000),
    '\u00e9',
].join('');
const expectedUtf16ToByte = new Array<number>(mixedText.length + 1);
const expectedByteToUtf16 = new Map<number, number>();
let expectedByteLength = 0;

for (let offset = 0; offset < mixedText.length;) {
    expectedUtf16ToByte[offset] = expectedByteLength;
    expectedByteToUtf16.set(expectedByteLength, offset);

    const char = String.fromCodePoint(mixedText.codePointAt(offset)!);
    for (let unit = 1; unit < char.length; unit++) {
        expectedUtf16ToByte[offset + unit] = expectedByteLength;
    }

    expectedByteLength += Buffer.byteLength(char, 'utf8');
    offset += char.length;
}
expectedUtf16ToByte[mixedText.length] = expectedByteLength;
expectedByteToUtf16.set(expectedByteLength, mixedText.length);

const mixedMap = new PositionMap(mixedText);
for (let offset = 0; offset <= mixedText.length; offset++) {
    assert.strictEqual(mixedMap.utf16ToByte(offset), expectedUtf16ToByte[offset]);
}
for (let byteOffset = 0; byteOffset <= expectedByteLength; byteOffset++) {
    const expectedOffset = expectedByteToUtf16.get(byteOffset);
    if (expectedOffset === undefined) {
        assert.throws(() => mixedMap.byteToUtf16(byteOffset), /UTF-8 boundary/);
    } else {
        assert.strictEqual(mixedMap.byteToUtf16(byteOffset), expectedOffset);
    }
}

const memoryProbe = `
const { PositionMap } = require(process.env.POSITION_MAP_MODULE);
const length = 5_000_000;
const map = new PositionMap('a'.repeat(length));
if (map.utf16ToByte(length) !== length || map.byteToUtf16(length) !== length) {
    throw new Error('ASCII endpoint mapping failed');
}
`;
const memoryResult = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '-e', memoryProbe],
    {
        encoding: 'utf8',
        env: {
            ...process.env,
            POSITION_MAP_MODULE: require.resolve('../core/hdl/positionMap'),
        },
        timeout: 30_000,
    }
);
assert.strictEqual(
    memoryResult.status,
    0,
    `ASCII memory probe failed: ${memoryResult.error?.message ?? memoryResult.stderr}`
);

console.log('HDL position map tests passed');
