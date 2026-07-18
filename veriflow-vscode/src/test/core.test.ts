import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DependencyAnalyzer } from '../core/dependencyAnalyzer';
import { PortParser } from '../core/portParser';
import { TestbenchGenerator, TbConfig } from '../core/testbenchGenerator';
import { LogParser } from '../core/logParser';
import { SimulationRunner } from '../core/simulationRunner';
import { VcdParser } from '../core/vcdParser';
import { WaveformLayoutStore } from '../core/waveformLayoutStore';

type WaveCore = {
    validateLayout(value: unknown): any | null;
    describeSignal(signal: any, signals: any[]): any;
    matchSignalDescriptors(descriptors: any[], signals: any[]): Array<number | null>;
    parseTimescale(value: string): {
        multiplier: number;
        unit: string;
        secondsPerTick: number;
    } | null;
    formatTicks(ticks: number, timescale: string): string;
    measureCursors(
        cursorA: number,
        cursorB: number | null,
        timescale: string
    ): {
        deltaTicks: number | null;
        deltaText: string;
        frequencyText: string;
    };
    parseSearchValue(text: string, width: number): {
        ok: boolean;
        bits?: string;
        error?: string;
    };
    findSearchMatch(
        targets: any[],
        cursorTime: number,
        direction: number,
        mode: string,
        query: string
    ): any;
};

const waveCore = require('../../media/waveform/viewer-core.js') as WaveCore;

type Golden = {
    top_module: string;
    modules: string[];
    dependency_graph: Record<string, string[]>;
    discovery_order: string[];
    compile_order: string[];
    uart_tx: {
        parameters: [string, string][];
        ports: Array<['input' | 'output' | 'inout', string, string | null]>;
    };
    generated_testbench: {
        name: string;
        wave_file: string;
        required_snippets: string[];
    };
    log_sample: {
        text: string;
        levels: string[];
        first_file: string;
        first_line: number;
    };
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fixtureDir = path.join(repoRoot, 'tests', 'project_test');
const golden: Golden = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'tests', 'golden_uart.json'), 'utf-8')
);

function copyFixture(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-vscode-'));
    for (const name of ['uart_rx.v', 'uart_tx.v', 'uart_tb.v', 'uart_sim.json']) {
        fs.copyFileSync(path.join(fixtureDir, name), path.join(tmpDir, name));
    }
    return tmpDir;
}

function basenames(files: string[]): string[] {
    return files.map(f => path.basename(f));
}

function testDependencyAnalyzer(): void {
    const projectDir = copyFixture();
    const result = new DependencyAnalyzer().resolve(golden.top_module, [projectDir]);

    assert.deepStrictEqual(result.missingModules, []);
    assert.deepStrictEqual(result.depGraph, golden.dependency_graph);
    assert.deepStrictEqual(basenames(result.files), golden.compile_order);
    assert.deepStrictEqual(Object.keys(result.moduleMap).sort(), golden.modules);
}

function testDependencyAnalyzerConditionalCompilation(): void {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-cond-'));
    for (const moduleName of ['active_child', 'inactive_child', 'fallback_child']) {
        fs.writeFileSync(
            path.join(projectDir, `${moduleName}.v`),
            `module ${moduleName}; endmodule\n`,
            'utf-8'
        );
    }
    fs.writeFileSync(path.join(projectDir, 'top.v'), [
        'module top;',
        '`define USE_ACTIVE',
        '`ifdef USE_ACTIVE',
        '    active_child u_active();',
        '`else',
        '    inactive_child u_inactive();',
        '`endif',
        '`ifndef SKIP_FALLBACK',
        '    fallback_child u_fallback();',
        '`endif',
        'endmodule',
        '',
    ].join('\n'), 'utf-8');

    const result = new DependencyAnalyzer().resolve('top', [projectDir]);

    assert.deepStrictEqual(result.missingModules, []);
    assert.deepStrictEqual(result.depGraph.top, ['active_child', 'fallback_child']);
}

function testDependencyAnalyzerGenerateForIf(): void {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-generate-'));
    for (const moduleName of ['for_child', 'if_false_child', 'if_true_child', 'foo_generate_child']) {
        fs.writeFileSync(
            path.join(projectDir, `${moduleName}.v`),
            `module ${moduleName}; endmodule\n`,
            'utf-8'
        );
    }
    fs.writeFileSync(path.join(projectDir, 'top.v'), [
        'module top;',
        'genvar i;',
        'foo_generate_child u_name_contains_generate();',
        'generate',
        '  for (i = 0; i < 4; i = i + 1) begin : g_for',
        '    for_child #(.INDEX(i)) u_for();',
        '  end',
        '',
        '  if (USE_TRUE) begin : g_if_true',
        '    if_true_child u_true();',
        '  end else begin : g_if_false',
        '    if_false_child u_false();',
        '  end',
        'endgenerate',
        'endmodule',
        '',
    ].join('\n'), 'utf-8');

    const result = new DependencyAnalyzer().resolve('top', [projectDir]);

    assert.deepStrictEqual(result.missingModules, []);
    assert.deepStrictEqual(
        result.depGraph.top,
        ['foo_generate_child', 'for_child', 'if_false_child', 'if_true_child']
    );
}

function testDependencyAnalyzerProceduralStatements(): void {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-proc-'));
    for (const moduleName of ['child_after', 'child_before']) {
        fs.writeFileSync(
            path.join(projectDir, `${moduleName}.v`),
            `module ${moduleName}; endmodule\n`,
            'utf-8'
        );
    }
    fs.writeFileSync(path.join(projectDir, 'top.v'), [
        'module top;',
        '  reg x;',
        '  reg begin_count;',
        '  reg end2;',
        '  reg join_flag;',
        '',
        '  child_before u_before();',
        '',
        '  always @(*) x = begin_count | end2 | join_flag;',
        '  always @(*) begin',
        '    begin_count = 1\'b0;',
        '    if (x) begin',
        '      end2 = 1\'b1;',
        '    end else begin',
        '      join_flag = 1\'b1;',
        '    end',
        '  end',
        '',
        '  child_after u_after();',
        'endmodule',
        '',
    ].join('\n'), 'utf-8');

    const result = new DependencyAnalyzer().resolve('top', [projectDir]);

    assert.deepStrictEqual(result.missingModules, []);
    assert.deepStrictEqual(result.depGraph.top, ['child_after', 'child_before']);
}

function testPortParser(): void {
    const projectDir = copyFixture();
    const info = new PortParser().parseFile(path.join(projectDir, 'uart_tx.v'));

    assert.strictEqual(info.name, 'uart_tx');
    assert.deepStrictEqual(
        info.parameters.map(p => [p.name, p.value]),
        golden.uart_tx.parameters
    );
    assert.deepStrictEqual(
        info.ports.map(p => [p.direction, p.name, p.width ?? null]),
        golden.uart_tx.ports
    );
}

function testPortParserConditionalCompilation(): void {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-cond-'));
    const filepath = path.join(projectDir, 'cond_ports.v');
    fs.writeFileSync(filepath, [
        '`define USE_WIDE',
        'module cond_ports (',
        '    input clk,',
        '`ifdef USE_WIDE',
        '    input [15:0] data_i,',
        '`else',
        '    input [7:0] data_i,',
        '    input unused_else_i,',
        '`endif',
        '`ifndef DISABLE_READY',
        '    output ready_o,',
        '`endif',
        '    output done_o',
        ');',
        'endmodule',
        '',
    ].join('\n'), 'utf-8');

    const info = new PortParser().parseFile(filepath);

    assert.deepStrictEqual(
        info.ports.map(p => [p.direction, p.name, p.width ?? null]),
        [
            ['input', 'clk', null],
            ['input', 'data_i', '[15:0]'],
            ['output', 'ready_o', null],
            ['output', 'done_o', null],
        ]
    );
}

function testPortParserSystemVerilogAndNonAnsi(): void {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-sv-'));
    const svFile = path.join(projectDir, 'sv_mod.sv');
    const legacyFile = path.join(projectDir, 'legacy_mod.v');
    fs.writeFileSync(svFile, [
        'module sv_mod #(',
        '    parameter int WIDTH = $clog2(DEPTH),',
        '    parameter string MODE = "fast,still-one-value"',
        ') (',
        '    input logic signed [WIDTH-1:0] a_i, b_i,',
        '    output var logic ready_o,',
        '    inout wire pad_io',
        ');',
        'endmodule',
        '',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(legacyFile, [
        'module legacy_mod (clk, rst_n, data_o);',
        '    input wire clk;',
        '    input rst_n;',
        '    output reg [3:0] data_o;',
        'endmodule',
        '',
    ].join('\n'), 'utf-8');

    const parser = new PortParser();
    const svInfo = parser.parseFile(svFile);
    const legacyInfo = parser.parseFile(legacyFile);

    assert.deepStrictEqual(
        svInfo.parameters.map(p => [p.name, p.value]),
        [
            ['WIDTH', '$clog2(DEPTH)'],
            ['MODE', '"fast,still-one-value"'],
        ]
    );
    assert.deepStrictEqual(
        svInfo.ports.map(p => [p.direction, p.name, p.width ?? null]),
        [
            ['input', 'a_i', '[WIDTH-1:0]'],
            ['input', 'b_i', '[WIDTH-1:0]'],
            ['output', 'ready_o', null],
            ['inout', 'pad_io', null],
        ]
    );
    assert.deepStrictEqual(
        legacyInfo.ports.map(p => [p.direction, p.name, p.width ?? null]),
        [
            ['input', 'clk', null],
            ['input', 'rst_n', null],
            ['output', 'data_o', '[3:0]'],
        ]
    );
}

function testTestbenchGenerator(): void {
    const projectDir = copyFixture();
    const outputDir = path.join(projectDir, 'generated', 'tb');
    const tbSpec = golden.generated_testbench;
    const config: TbConfig = {
        name: tbSpec.name,
        time_unit: '1ns',
        time_precision: '1ps',
        clocks_mhz: ['100'],
        reset_active_high: false,
        reset_duration: '100',
        modules: [
            {
                module_name: 'uart_tx',
                instance_name: 'u_tx0',
                filepath: path.join(projectDir, 'uart_tx.v'),
                port_signals: {
                    clk: 'clk',
                    rst_n: 'rst_n',
                    tx_data: 'tx_payload',
                },
                param_values: {
                    SYS_CLK_FREQ: '1_000_000',
                    BAUD_RATE: '115200',
                },
            },
        ],
        wave_file: tbSpec.wave_file,
        timeout: '1000000',
    };

    const filepath = new TestbenchGenerator().generate(config, outputDir);
    assert.strictEqual(filepath, path.join(outputDir, `${tbSpec.name}.v`));
    const content = fs.readFileSync(filepath, 'utf-8');
    for (const snippet of tbSpec.required_snippets) {
        assert.ok(content.includes(snippet), `missing snippet: ${snippet}`);
    }
}

function testLogParser(): void {
    const entries = new LogParser().parse(golden.log_sample.text);
    assert.deepStrictEqual(entries.map(e => e.level), golden.log_sample.levels);
    assert.strictEqual(entries[0].fileRef, golden.log_sample.first_file);
    assert.strictEqual(entries[0].lineNo, golden.log_sample.first_line);
}

function testSimulationRunnerPathResolution(): void {
    const projectDir = copyFixture();
    const external = path.join(os.tmpdir(), 'veriflow-external-lib.v');
    const runner = new SimulationRunner() as any;
    const resolved = runner._resolveFilePaths([
        path.join(projectDir, 'uart_tb.v'),
        external,
    ], projectDir);

    assert.strictEqual(resolved[0], 'uart_tb.v');
    assert.strictEqual(path.resolve(resolved[1]), path.resolve(external));
}

function testSimulationRunnerCommandLogging(): void {
    const projectDir = copyFixture();
    const runner = new SimulationRunner();
    const result = runner.compileAndRun(
        [],
        path.join(projectDir, 'fake.out'),
        {
            name: 'custom',
            compileCmd: 'node -e "console.log(\'compile ok\')"',
            runCmd: 'node -e "console.log(\'run ok\')"',
        },
        projectDir,
        'uart_tb'
    );

    assert.strictEqual(result.success, true);
    assert.ok(result.stdout.includes('[CMD] Compile:'));
    assert.ok(result.stdout.includes('[CMD] Run:'));
    assert.ok(result.stdout.includes('run ok'));
}

function testVcdParser(): void {
    const parser = new VcdParser();
    const data = parser.parse(`
$date today $end
$version test $end
$comment generated by test $end
$timescale 1ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 8 " data [7:0] $end
$upscope $end
$enddefinitions $end
#0
0!
b00000000 "
#5
1!
b10101010 "
#10
x!
bzzzzzzzz "
`);

    assert.equal(data.timescale, '1ns');
    assert.equal(data.endTime, 10);
    assert.equal(data.signals.length, 2);
    assert.equal(data.warnings.length, 0);
    assert.equal(data.signals[0].reference, 'clk');
    assert.equal(data.signals[1].reference, 'data [7:0]');

    const clk = data.signals.find(signal => signal.reference === 'clk');
    const bus = data.signals.find(signal => signal.reference === 'data [7:0]');
    assert.ok(clk);
    assert.ok(bus);
    assert.equal(clk.fullName, 'top.clk');
    assert.equal(clk.changes.length, 3);
    assert.equal(clk.changes[2].value, 'x');
    assert.equal(bus.width, 8);
    assert.equal(bus.changes[1].value, '10101010');
    assert.equal(bus.changes[2].value, 'zzzzzzzz');
}

function testVcdParserMultilineMetadataAndAliases(): void {
    const parser = new VcdParser();
    const data = parser.parse(`
$date
  Tue May 19 10:01:22 2026
$end
$version
  Icarus Verilog
$end
$timescale
  1ns
$end
$scope module top $end
$var wire 1 ! a $end
$var wire 1 ! alias_a $end
$upscope $end
$enddefinitions $end
$dumpvars
0!
$end
#10
1!
`);

    assert.equal(data.date, 'Tue May 19 10:01:22 2026');
    assert.equal(data.version, 'Icarus Verilog');
    assert.equal(data.timescale, '1ns');
    assert.equal(data.signals.length, 2);
    assert.ok(data.signals.some(signal => signal.fullName === 'top.a'));
    assert.ok(data.signals.some(signal => signal.fullName === 'top.alias_a'));
    for (const signal of data.signals) {
        assert.equal(signal.changes.length, 2);
        assert.equal(signal.changes[1].value, '1');
    }
}

function testVcdParserKeepsDeclaredSignalsAndFinalTime(): void {
    const parser = new VcdParser();
    const data = parser.parse(`
$timescale 1ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 1 # idle $end
$upscope $end
$enddefinitions $end
#0
0!
#100
`);

    assert.equal(data.endTime, 100);
    assert.equal(data.signals.length, 2);
    const idle = data.signals.find(signal => signal.reference === 'idle');
    assert.ok(idle);
    assert.equal(idle.changes.length, 1);
    assert.equal(idle.changes[0].time, 0);
    assert.equal(idle.changes[0].value, 'x');
}

function testWaveLayoutValidationAndMatching(): void {
    const layout = waveCore.validateLayout({
        version: 1,
        rows: [
            {
                kind: 'signal',
                signal: {
                    fullName: 'top.a',
                    reference: 'a',
                    width: 1,
                    occurrence: 0,
                },
            },
        ],
        view: {
            startTime: 2,
            endTime: 8,
            waveScrollTop: 0,
            libraryWidth: 280,
            waveNameWidth: 160,
        },
        cursors: { a: 3, b: 7, active: 'b' },
    });
    assert.ok(layout);
    assert.strictEqual(waveCore.validateLayout({ version: 2, rows: [] }), null);
    assert.strictEqual(waveCore.validateLayout({ version: 1, rows: 'bad' }), null);

    const signals = [
        { fullName: 'top.a', reference: 'a', width: 1 },
        { fullName: 'top.a', reference: 'a', width: 1 },
        { fullName: 'top.data', reference: 'data', width: 8 },
    ];
    assert.deepStrictEqual(waveCore.describeSignal(signals[1], signals), {
        fullName: 'top.a',
        reference: 'a',
        width: 1,
        occurrence: 1,
    });
    assert.deepStrictEqual(
        waveCore.matchSignalDescriptors(
            [
                { fullName: 'top.a', reference: 'a', width: 1, occurrence: 1 },
                { fullName: 'top.missing', reference: 'missing', width: 1, occurrence: 0 },
                { fullName: 'top.a', reference: 'a', width: 1, occurrence: 0 },
            ],
            signals
        ),
        [1, null, 0]
    );
}

function testWaveCursorMeasurement(): void {
    assert.deepStrictEqual(waveCore.parseTimescale('10 ns'), {
        multiplier: 10,
        unit: 'ns',
        secondsPerTick: 1e-8,
    });
    assert.strictEqual(waveCore.formatTicks(12, '10ns'), '120 ns');
    assert.deepStrictEqual(waveCore.measureCursors(12, 17, '10ns'), {
        deltaTicks: 5,
        deltaText: '50 ns',
        frequencyText: '20 MHz',
    });
    assert.deepStrictEqual(waveCore.measureCursors(12, 12, '1ns'), {
        deltaTicks: 0,
        deltaText: '0 ns',
        frequencyText: '-',
    });
    assert.deepStrictEqual(waveCore.measureCursors(12, null, '1ns'), {
        deltaTicks: null,
        deltaText: '-',
        frequencyText: '-',
    });
    assert.strictEqual(waveCore.formatTicks(2500, '100ps'), '250 ns');
    assert.strictEqual(waveCore.measureCursors(0, 1, '1ps').frequencyText, '1 THz');
}

function testWaveConditionalSearch(): void {
    assert.deepStrictEqual(waveCore.parseSearchValue('0xA', 4), {
        ok: true,
        bits: '1010',
    });
    assert.deepStrictEqual(waveCore.parseSearchValue('0b0011', 4), {
        ok: true,
        bits: '0011',
    });
    assert.deepStrictEqual(waveCore.parseSearchValue('10', 8), {
        ok: true,
        bits: '00001010',
    });
    assert.strictEqual(waveCore.parseSearchValue('0x10', 4).ok, false);
    assert.strictEqual(waveCore.parseSearchValue('2z', 4).ok, false);

    const clk = {
        order: 0,
        name: 'top.clk',
        width: 1,
        changes: [
            { time: 0, value: '0' },
            { time: 5, value: '1' },
            { time: 10, value: '0' },
            { time: 15, value: 'x' },
            { time: 20, value: '1' },
        ],
    };
    const data = {
        order: 1,
        name: 'top.data',
        width: 4,
        changes: [
            { time: 0, value: '0000' },
            { time: 6, value: '1010' },
            { time: 12, value: '10xz' },
            { time: 18, value: '0011' },
        ],
    };
    const bit = {
        ...data,
        order: 2,
        name: 'top.data[1]',
        width: 1,
        bitIndex: 1,
        parentWidth: 4,
    };

    assert.strictEqual(waveCore.findSearchMatch([clk], 0, 1, 'rising', '').time, 5);
    assert.strictEqual(waveCore.findSearchMatch([clk], 12, -1, 'falling', '').time, 10);
    assert.strictEqual(waveCore.findSearchMatch([data], 0, 1, 'value', '0xA').time, 6);
    assert.strictEqual(waveCore.findSearchMatch([data], 6, 1, 'xz', '').time, 12);
    assert.strictEqual(waveCore.findSearchMatch([bit], 0, 1, 'rising', '').time, 6);
    assert.strictEqual(waveCore.findSearchMatch([clk, data], 0, 1, 'change', '').time, 5);
    assert.strictEqual(waveCore.findSearchMatch([clk], 20, 1, 'change', '').match, null);
    assert.strictEqual(waveCore.findSearchMatch([data], 0, 1, 'rising', '').error, 'edge-needs-scalar');
}

async function testWaveformLayoutStore(): Promise<void> {
    const values = new Map<string, unknown>();
    const memento = {
        get<T>(key: string, fallback: T): T {
            return (values.has(key) ? values.get(key) : fallback) as T;
        },
        update(key: string, value: unknown): Promise<void> {
            values.set(key, value);
            return Promise.resolve();
        },
    };
    const store = new WaveformLayoutStore(memento);
    await Promise.all([
        store.save('file:///a.vcd', {
            version: 1,
            rows: [{ kind: 'group' }],
        }),
        store.save('file:///b.vcd', {
            version: 1,
            rows: [{ kind: 'signal' }],
        }),
    ]);

    assert.strictEqual((store.load('file:///a.vcd') as any).rows[0].kind, 'group');
    assert.strictEqual((store.load('file:///b.vcd') as any).rows[0].kind, 'signal');
    assert.strictEqual(store.load('file:///missing.vcd'), null);
}

const tests: Array<[string, () => void | Promise<void>]> = [
    ['dependency analyzer', testDependencyAnalyzer],
    ['dependency analyzer conditional compilation', testDependencyAnalyzerConditionalCompilation],
    ['dependency analyzer generate for/if', testDependencyAnalyzerGenerateForIf],
    ['dependency analyzer procedural statements', testDependencyAnalyzerProceduralStatements],
    ['port parser', testPortParser],
    ['port parser conditional compilation', testPortParserConditionalCompilation],
    ['port parser SystemVerilog and non-ANSI', testPortParserSystemVerilogAndNonAnsi],
    ['testbench generator', testTestbenchGenerator],
    ['log parser', testLogParser],
    ['simulation runner paths', testSimulationRunnerPathResolution],
    ['simulation runner command logging', testSimulationRunnerCommandLogging],
    ['vcd parser', testVcdParser],
    ['vcd parser multiline metadata and aliases', testVcdParserMultilineMetadataAndAliases],
    ['vcd parser declared signals and final time', testVcdParserKeepsDeclaredSignalsAndFinalTime],
    ['wave layout validation and matching', testWaveLayoutValidationAndMatching],
    ['wave cursor measurement', testWaveCursorMeasurement],
    ['wave conditional search', testWaveConditionalSearch],
    ['waveform layout store', testWaveformLayoutStore],
];

async function runTests(): Promise<void> {
    for (const [name, fn] of tests) {
        await fn();
        console.log(`ok - ${name}`);
    }
}

runTests().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
