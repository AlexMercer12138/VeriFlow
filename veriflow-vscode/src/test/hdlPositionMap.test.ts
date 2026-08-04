import * as assert from 'assert';

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
assert.throws(() => map.byteToUtf16(-1), /UTF-8 boundary/);
assert.throws(() => map.byteToUtf16(Buffer.byteLength(text, 'utf8') + 1), /UTF-8 boundary/);
const chineseUtf16 = text.indexOf('\u4fe1');
const chineseByte = Buffer.byteLength(text.slice(0, chineseUtf16), 'utf8');
assert.throws(() => map.byteRangeToSourceRange(chineseByte + 1, endmoduleByte), /UTF-8 boundary/);

console.log('HDL position map tests passed');
