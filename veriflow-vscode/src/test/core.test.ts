import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DependencyAnalyzer } from '../core/dependencyAnalyzer';
import { PortParser } from '../core/portParser';
import { TestbenchGenerator, TbConfig } from '../core/testbenchGenerator';
import { LogParser } from '../core/logParser';
import { SimulationRunner } from '../core/simulationRunner';

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

const tests: Array<[string, () => void]> = [
    ['dependency analyzer', testDependencyAnalyzer],
    ['dependency analyzer conditional compilation', testDependencyAnalyzerConditionalCompilation],
    ['port parser', testPortParser],
    ['port parser conditional compilation', testPortParserConditionalCompilation],
    ['port parser SystemVerilog and non-ANSI', testPortParserSystemVerilogAndNonAnsi],
    ['testbench generator', testTestbenchGenerator],
    ['log parser', testLogParser],
    ['simulation runner paths', testSimulationRunnerPathResolution],
    ['simulation runner command logging', testSimulationRunnerCommandLogging],
];

for (const [name, fn] of tests) {
    fn();
    console.log(`ok - ${name}`);
}
