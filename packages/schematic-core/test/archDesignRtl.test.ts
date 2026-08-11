import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createEmptyArchDesign,
    exportArchDesignRtl,
    parseArchDesignValue,
    parseArchDesignRtlMarker,
    type ArchDesign,
} from '../src/archDesign';

function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const parsed = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (parsed.status !== 'editable') throw new Error('expected editable design');
    return parsed.design;
}

test('exports a deterministic empty Verilog module with an owned marker', () => {
    const result = exportArchDesignRtl(createEmptyArchDesign('soc_top'), [], {
        sourcePath: 'designs/soc_top.ad',
    });

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;
    assert.equal(result.language, 'verilog');
    assert.equal(result.extension, '.v');
    assert.match(result.fingerprint, /^ad-v1-[0-9a-f]{16}$/);
    assert.equal(result.marker,
        `// vik-veriflow:generated arch-design schema=1 fingerprint=${result.fingerprint} language=verilog`);
    assert.equal(result.text, [
        result.marker,
        '// vik-veriflow:source "designs/soc_top.ad"',
        '',
        'module soc_top;',
        'endmodule',
        '',
    ].join('\n'));
    assert.deepEqual(parseArchDesignRtlMarker(result.text), {
        schemaVersion: 1,
        fingerprint: result.fingerprint,
        language: 'verilog',
    });
});

test('escapes source paths before placing them in generated comments', () => {
    const sourcePath = 'designs/top.ad\r\nendmodule\nmodule injected;';
    const result = exportArchDesignRtl(createEmptyArchDesign('safe_top'), [], { sourcePath });

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;
    assert.ok(result.text.includes(`// vik-veriflow:source ${JSON.stringify(sourcePath)}`));
    assert.equal(result.text.includes('\nmodule injected;'), false);
    assert.equal(result.text.match(/^module /gm)?.length, 1);
});

test('ignores malformed or non-leading generated markers', () => {
    assert.equal(parseArchDesignRtlMarker('module handwritten;\nendmodule\n'), undefined);
    assert.equal(parseArchDesignRtlMarker([
        '',
        '// vik-veriflow:generated arch-design schema=1 fingerprint=ad-v1-0000000000000000 language=verilog',
    ].join('\n')), undefined);
});

test('exports ordered ports, collision-safe nets, and boundary assignments', () => {
    const design = designOf({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'data', direction: 'input', width: 8 },
            { name: 'result', direction: 'output', width: 8 },
        ],
        connections: [{
            name: 'clock',
            endpoints: [{ kind: 'port', port: 'clk' }],
        }, {
            name: 'result',
            endpoints: [
                { kind: 'port', port: 'data' },
                { kind: 'port', port: 'result' },
            ],
        }],
    });

    const result = exportArchDesignRtl(design, [], { sourcePath: 'soc_top.ad' });

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;
    const body = result.text.slice(result.text.indexOf('module'));
    assert.equal(body, [
        'module soc_top (',
        '    input wire clk,',
        '    input wire [7:0] data,',
        '    output wire [7:0] result',
        ');',
        '',
        'wire __vf_net_clock;',
        'wire [7:0] __vf_net_result;',
        '',
        'assign __vf_net_clock = clk;',
        'assign __vf_net_result = data;',
        'assign result = __vf_net_result;',
        '',
        'endmodule',
        '',
    ].join('\n'));
});

test('uses an explicit language override for extension, marker, and fingerprint', () => {
    const design = createEmptyArchDesign('language_top');
    const verilog = exportArchDesignRtl(design, []);
    const systemVerilog = exportArchDesignRtl(design, [], { language: 'systemverilog' });

    assert.equal(verilog.status, 'generated');
    assert.equal(systemVerilog.status, 'generated');
    if (verilog.status !== 'generated' || systemVerilog.status !== 'generated') return;
    assert.equal(systemVerilog.language, 'systemverilog');
    assert.equal(systemVerilog.extension, '.sv');
    assert.match(systemVerilog.marker, / language=systemverilog$/);
    assert.notEqual(systemVerilog.fingerprint, verilog.fingerprint);
});
