import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdapterSourceContext } from '@veriflow/hdl-core/treeSitterAdapter';
import type { HdlDocument } from '@veriflow/hdl-core/model';
import { PositionMap } from '@veriflow/hdl-core/positionMap';
import {
    canonicalizeSourceUri,
    preprocessForParsing,
} from '@veriflow/hdl-core/preprocessor';
import { computeTreeEdit } from '@veriflow/hdl-core/treeEdit';

test('public model and adapter context types compile for product hosts', () => {
    const document: Pick<HdlDocument, 'uri' | 'version'> = {
        uri: 'memory:/top.sv',
        version: 1,
    };
    const context: Pick<AdapterSourceContext, 'text'> = { text: 'module top; endmodule' };

    assert.equal(document.uri, 'memory:/top.sv');
    assert.equal(context.text, 'module top; endmodule');
});

test('position map preserves UTF-16 and UTF-8 offsets', () => {
    const text = 'module top; // signal \u4fe1\u53f7 \ud83d\ude00\nendmodule\n';
    const map = new PositionMap(text);
    const utf16Offset = text.indexOf('endmodule');
    const byteOffset = Buffer.byteLength(text.slice(0, utf16Offset), 'utf8');
    const chineseUtf16 = text.indexOf('\u4fe1');
    const chineseByte = Buffer.byteLength(text.slice(0, chineseUtf16), 'utf8');

    assert.equal(map.byteToUtf16(byteOffset), utf16Offset);
    assert.equal(map.utf16ToByte(utf16Offset), byteOffset);
    assert.throws(() => map.byteToUtf16(chineseByte + 1), /UTF-8 boundary/);
});

test('preprocessor preserves active branches and textual include source maps', () => {
    const topUri = 'file:///workspace/top.sv';
    const includeUri = 'file:///workspace/ports.svh';
    const source = [
        '`define ENABLED',
        '`ifdef ENABLED',
        'module top(',
        '`include "ports.svh"',
        '); endmodule',
        '`else',
        'module inactive; endmodule',
        '`endif',
    ].join('\n');
    const result = preprocessForParsing(topUri, source, {
        defines: {},
        resolvedIncludes: [{
            fromUri: topUri,
            rawPath: 'ports.svh',
            resolvedUri: includeUri,
            text: 'input logic clk',
        }],
    });

    assert.match(result.text, /module top/);
    assert.doesNotMatch(result.text, /module inactive/);
    const includedOffset = result.text.indexOf('clk');
    assert.deepEqual(result.sourceMap.mapSpan(includedOffset, includedOffset + 3), {
        uri: includeUri,
        start: 12,
        end: 15,
    });
    assert.equal(
        canonicalizeSourceUri('file:///workspace/A.sv', 'win32'),
        canonicalizeSourceUri('file:///workspace/a.sv', 'win32')
    );
});

test('tree edit reports byte offsets for Unicode-safe incremental parsing', () => {
    const oldText = 'module top; // \u4fe1\u53f7\nendmodule\n';
    const newText = 'module renamed; // \u4fe1\u53f7\nendmodule\n';
    const edit = computeTreeEdit(oldText, newText);

    assert.ok(edit);
    assert.equal(edit.startIndex, Buffer.byteLength('module ', 'utf8'));
    assert.equal(edit.oldEndIndex, Buffer.byteLength('module top', 'utf8'));
    assert.equal(edit.newEndIndex, Buffer.byteLength('module renamed', 'utf8'));
});
