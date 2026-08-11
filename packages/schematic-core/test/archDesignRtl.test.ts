import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createEmptyArchDesign,
    exportArchDesignRtl,
    parseArchDesignValue,
    parseArchDesignRtlMarker,
    type ArchDesign,
    type ArchDesignModuleDefinition,
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

test('exports explicit ordered instances, parameters, and effective defaults', () => {
    const producer: ArchDesignModuleDefinition = {
        key: 'rtl/producer.v#producer',
        name: 'producer',
        parameters: [
            { name: 'MODE' },
            { name: 'WIDTH' },
            { name: 'ENABLE' },
        ],
        ports: [
            { name: 'clk', direction: 'input', width: { kind: 'known', bits: 1 } },
            { name: 'data_o', direction: 'output', width: { kind: 'known', bits: 8 } },
            { name: 'unused_o', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 'io', direction: 'inout', width: { kind: 'known', bits: 1 } },
        ],
    };
    const sink: ArchDesignModuleDefinition = {
        key: 'rtl/sink.v#sink',
        name: 'sink',
        parameters: [],
        ports: [
            { name: 'data_i', direction: 'input', width: { kind: 'known', bits: 8 } },
            { name: 'enable', direction: 'input', width: { kind: 'known', bits: 1 } },
            { name: 'spare_o', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 'io', direction: 'inout', width: { kind: 'known', bits: 1 } },
        ],
    };
    const design = designOf({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'result', direction: 'output', width: 8 },
        ],
        instances: [{
            name: 'u_prod',
            module: 'producer',
            parameters: { ENABLE: true, WIDTH: 8, MODE: "2'b10" },
        }, {
            name: 'u_sink',
            module: 'sink',
        }],
        connections: [{
            name: 'clock',
            endpoints: [
                { kind: 'port', port: 'clk' },
                { kind: 'instance', instance: 'u_prod', port: 'clk' },
            ],
        }, {
            name: 'result',
            endpoints: [
                { kind: 'instance', instance: 'u_prod', port: 'data_o' },
                { kind: 'port', port: 'result' },
            ],
        }, {
            name: 'fallback',
            endpoints: [{ kind: 'instance', instance: 'u_sink', port: 'data_i' }],
            defaults: { 'u_sink.data_i': "8'h5a" },
        }],
        defaults: {
            'u_sink.data_i': "8'h00",
            'u_sink.enable': "1'b0",
        },
    });

    const result = exportArchDesignRtl(design, [producer, sink]);

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;
    const body = result.text.slice(result.text.indexOf('module'));
    assert.equal(body, [
        'module soc_top (',
        '    input wire clk,',
        '    output wire [7:0] result',
        ');',
        '',
        'wire __vf_net_clock;',
        'wire [7:0] __vf_net_result;',
        'wire [7:0] __vf_net_fallback;',
        '',
        'assign __vf_net_clock = clk;',
        'assign result = __vf_net_result;',
        'assign __vf_net_fallback = 8\'h5a;',
        '',
        'producer #(',
        '    .MODE(2\'b10),',
        '    .WIDTH(8),',
        '    .ENABLE(1\'b1)',
        ') u_prod (',
        '    .clk(__vf_net_clock),',
        '    .data_o(__vf_net_result),',
        '    .unused_o(),',
        '    .io()',
        ');',
        '',
        'sink u_sink (',
        '    .data_i(__vf_net_fallback),',
        '    .enable(1\'b0),',
        '    .spare_o(),',
        '    .io()',
        ');',
        '',
        'endmodule',
        '',
    ].join('\n'));
});

test('exports scalar tri-state control and inout readback assignments', () => {
    const io: ArchDesignModuleDefinition = {
        key: 'rtl/io.v#io_core',
        name: 'io_core',
        parameters: [],
        ports: [
            { name: 'gpio_o', direction: 'output', width: { kind: 'known', bits: 8 } },
            { name: 'gpio_t', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 'gpio_i', direction: 'input', width: { kind: 'known', bits: 8 } },
        ],
    };
    const design = designOf({
        ports: [{ name: 'gpio', direction: 'inout', width: 8 }],
        instances: [{ name: 'u_io', module: 'io_core' }],
        connections: [{
            name: 'gpio_o',
            endpoints: [
                { kind: 'instance', instance: 'u_io', port: 'gpio_o' },
                { kind: 'port', port: 'gpio', signal: 'o' },
            ],
        }, {
            name: 'gpio_t',
            endpoints: [
                { kind: 'instance', instance: 'u_io', port: 'gpio_t' },
                { kind: 'port', port: 'gpio', signal: 't' },
            ],
        }, {
            name: 'gpio_i',
            endpoints: [
                { kind: 'port', port: 'gpio', signal: 'i' },
                { kind: 'instance', instance: 'u_io', port: 'gpio_i' },
            ],
        }],
    });

    const result = exportArchDesignRtl(design, [io]);

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;
    assert.match(result.text, /assign __vf_net_gpio_i = gpio;/);
    assert.match(
        result.text,
        /assign gpio = __vf_net_gpio_t \? \{8\{1'bz\}\} : __vf_net_gpio_o;/
    );
});

test('uses the implicit high-impedance default for an unconnected scalar inout t', () => {
    const io: ArchDesignModuleDefinition = {
        key: 'rtl/bit_io.v#bit_io',
        name: 'bit_io',
        parameters: [],
        ports: [{ name: 'pin_o', direction: 'output', width: { kind: 'known', bits: 1 } }],
    };
    const design = designOf({
        ports: [{ name: 'pin', direction: 'inout' }],
        instances: [{ name: 'u_io', module: 'bit_io' }],
        connections: [{
            name: 'pin_o',
            endpoints: [
                { kind: 'instance', instance: 'u_io', port: 'pin_o' },
                { kind: 'port', port: 'pin', signal: 'o' },
            ],
        }],
    });

    const result = exportArchDesignRtl(design, [io]);

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;
    assert.match(result.text, /assign pin = 1'b1 \? 1'bz : __vf_net_pin_o;/);
});

test('exports per-bit inout control with collision-safe Verilog generate identifiers', () => {
    const io: ArchDesignModuleDefinition = {
        key: 'rtl/vector_io.v#vector_io',
        name: 'vector_io',
        parameters: [],
        ports: [
            { name: 'gpio_o', direction: 'output', width: { kind: 'known', bits: 8 } },
            { name: 'gpio_t', direction: 'output', width: { kind: 'known', bits: 8 } },
        ],
    };
    const design = designOf({
        ports: [
            { name: '__vf_gpio_index', direction: 'input' },
            { name: '__vf_gpio_tristate', direction: 'input' },
            { name: 'gpio', direction: 'inout', width: 8 },
        ],
        instances: [{ name: 'u_io', module: 'vector_io' }],
        connections: [{
            name: 'gpio_o',
            endpoints: [
                { kind: 'instance', instance: 'u_io', port: 'gpio_o' },
                { kind: 'port', port: 'gpio', signal: 'o' },
            ],
        }, {
            name: 'gpio_t',
            endpoints: [
                { kind: 'instance', instance: 'u_io', port: 'gpio_t' },
                { kind: 'port', port: 'gpio', signal: 't' },
            ],
        }],
    });

    const result = exportArchDesignRtl(design, [io]);

    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') return;
    assert.match(result.text, /genvar __vf_gpio_index_2;/);
    assert.ok(result.text.includes([
        'generate',
        '    for (__vf_gpio_index_2 = 0; __vf_gpio_index_2 < 8; __vf_gpio_index_2 = __vf_gpio_index_2 + 1) begin : __vf_gpio_tristate_2',
        "        assign gpio[__vf_gpio_index_2] = __vf_net_gpio_t[__vf_gpio_index_2] ? 1'bz : __vf_net_gpio_o[__vf_gpio_index_2];",
        '    end',
        'endgenerate',
    ].join('\n')));
});
