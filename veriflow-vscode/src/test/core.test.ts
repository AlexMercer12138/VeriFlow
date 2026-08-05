import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { DependencyAnalyzer } from '../core/dependencyAnalyzer';
import { formatModuleInstantiation } from '../core/moduleInstantiationFormatter';
import { buildModuleInstantiationChoices } from '../core/moduleInstantiationChoices';
import { PortParser } from '../core/portParser';
import { TestbenchGenerator, TbConfig } from '../core/testbenchGenerator';
import { LogParser } from '../core/logParser';
import { SimulationRunner } from '../core/simulationRunner';
import { VcdParser } from '../core/vcdParser';
import { WaveformLayoutStore } from '../core/waveformLayoutStore';
import {
    createWorkspaceIndexHarness,
    WorkspaceIndexHarness,
} from './helpers/workspaceIndexFixture';

type WaveCore = {
    WindowCache: new (capacity?: number) => {
        get(key: string): any;
        set(key: string, value: any): void;
        has(key: string): boolean;
        clear(): void;
        readonly size: number;
    };
    RequestTracker: new () => {
        generation: number;
        setGeneration(generation: number): void;
        next(kind: string): string;
        cancel(requestId: string): void;
        accepts(message: any): boolean;
    };
    WaveWindowCache: new (capacity?: number) => {
        readonly size: number;
        set(entry: any): void;
        find(query: any): any | undefined;
        clear(): void;
    };
    BoundedRequestRetry: new (maxRetries?: number) => {
        canStart(kind: string, key: string): boolean;
        recordFailure(kind: string, key: string, retryCount: number): boolean;
        recordSuccess(kind: string, key: string): void;
        clear(): void;
    };
    effectiveWindowTicksPerPixel(descriptor: any, responsePixelWidth: unknown): number;
    matchPendingRequest(requestId: unknown, pending: Record<string, any>): any | null;
    FrameScheduler: new (requestFrame: (callback: () => void) => unknown) => {
        schedule(callback: () => void): void;
        cancel(): void;
    };
    windowNeedsRefresh(entry: any, viewport: any, threshold?: number, bounds?: any): boolean;
    decodeWindowPayload(payload: any): any;
    prefetchRange(start: number, end: number, minimum: number, maximum: number): {
        start: number;
        end: number;
    };
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
    calculateVirtualWindow(
        totalRows: number,
        viewportHeight: number,
        scrollTop: number,
        rowHeight: number,
        overscan: number
    ): {
        firstRow: number;
        renderedCount: number;
        totalHeight: number;
        overflow: boolean;
    };
    signalMatchesSelectedScope(signalScope: string, selectedScope: string): boolean;
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

async function createDependencyHarness(
    projectDir: string,
    sources: Record<string, string>
): Promise<WorkspaceIndexHarness> {
    const harness = createWorkspaceIndexHarness(Object.fromEntries(
        Object.entries(sources).map(([relativePath, text]) => [
            pathToFileURL(path.join(projectDir, relativePath)).toString(),
            text,
        ])
    ));
    await harness.index.scan([pathToFileURL(projectDir).toString()]);
    return harness;
}

async function testDependencyAnalyzer(): Promise<void> {
    const projectDir = copyFixture();
    const sources = Object.fromEntries(
        ['uart_rx.v', 'uart_tx.v', 'uart_tb.v'].map(name => [
            name,
            fs.readFileSync(path.join(projectDir, name), 'utf8'),
        ])
    );
    const harness = await createDependencyHarness(projectDir, sources);
    try {
        const topKey = harness.index.findDefinitions(golden.top_module, 'module')[0].key;
        const result = new DependencyAnalyzer(harness.index).resolve(topKey);

        assert.strictEqual(result.topModule, golden.top_module);
        assert.strictEqual(result.topDefinitionKey, topKey);
        assert.deepStrictEqual(result.missingModules, []);
        assert.deepStrictEqual(result.ambiguousModules, {});
        assert.deepStrictEqual(result.depGraph, golden.dependency_graph);
        assert.deepStrictEqual(basenames(result.files), golden.compile_order);
        assert.deepStrictEqual(Object.keys(result.moduleMap).sort(), golden.modules);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerIndexedTopologicalOrder(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-index-'));
    const harness = await createDependencyHarness(projectDir, {
        'top.v': 'module top; child u_child(); endmodule\n',
        'child.v': 'module child; leaf u_leaf(); endmodule\n',
        'leaf.v': 'module leaf; endmodule\n',
    });
    try {
        const topKey = harness.index.findDefinitions('top', 'module')[0].key;
        const result = new DependencyAnalyzer(harness.index).resolve(topKey);

        assert.strictEqual(result.topModule, 'top');
        assert.strictEqual(result.topDefinitionKey, topKey);
        assert.deepStrictEqual(
            result.files.map(filePath => path.basename(filePath)),
            ['leaf.v', 'child.v', 'top.v']
        );
        assert.deepStrictEqual(result.depGraph.top, ['child']);
        assert.deepStrictEqual(result.missingModules, []);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerConditionalCompilation(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-cond-'));
    const sources: Record<string, string> = {};
    for (const moduleName of ['active_child', 'inactive_child', 'fallback_child']) {
        sources[`${moduleName}.v`] = `module ${moduleName}; endmodule\n`;
    }
    sources['top.v'] = [
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
    ].join('\n');
    const harness = await createDependencyHarness(projectDir, sources);
    try {
        const result = new DependencyAnalyzer(harness.index).resolve('top');

        assert.deepStrictEqual(result.missingModules, []);
        assert.deepStrictEqual(result.depGraph.top, ['active_child', 'fallback_child']);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerGenerateForIf(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-generate-'));
    const sources: Record<string, string> = {};
    for (const moduleName of ['for_child', 'if_false_child', 'if_true_child', 'foo_generate_child']) {
        sources[`${moduleName}.v`] = `module ${moduleName}; endmodule\n`;
    }
    sources['top.v'] = [
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
    ].join('\n');
    const harness = await createDependencyHarness(projectDir, sources);
    try {
        const result = new DependencyAnalyzer(harness.index).resolve('top');

        assert.deepStrictEqual(result.missingModules, []);
        assert.deepStrictEqual(
            result.depGraph.top,
            ['foo_generate_child', 'for_child', 'if_false_child', 'if_true_child']
        );
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerProceduralStatements(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-proc-'));
    const sources: Record<string, string> = {};
    for (const moduleName of ['child_after', 'child_before']) {
        sources[`${moduleName}.v`] = `module ${moduleName}; endmodule\n`;
    }
    sources['top.v'] = [
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
    ].join('\n');
    const harness = await createDependencyHarness(projectDir, sources);
    try {
        const result = new DependencyAnalyzer(harness.index).resolve('top');

        assert.deepStrictEqual(result.missingModules, []);
        assert.deepStrictEqual(result.depGraph.top, ['child_after', 'child_before']);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerMissingAndAmbiguousModules(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-ambiguous-'));
    const harness = await createDependencyHarness(projectDir, {
        'top.v': [
            'module top;',
            '  child u_child();',
            '  z_missing u_z();',
            '  a_missing u_a();',
            'endmodule',
        ].join('\n'),
        'lib-a/child.v': 'module child; endmodule\n',
        'lib-b/child.v': 'module child; endmodule\n',
    });
    try {
        const analyzer = new DependencyAnalyzer(harness.index);
        const topKey = harness.index.findDefinitions('top', 'module')[0].key;
        const candidates = harness.index.findDefinitions('child', 'module');
        const candidateKeys = candidates.map(definition => definition.key).sort();

        const unresolved = analyzer.resolve(topKey);
        assert.deepStrictEqual(unresolved.missingModules, ['a_missing', 'z_missing']);
        assert.deepStrictEqual(unresolved.ambiguousModules, { child: candidateKeys });
        assert.deepStrictEqual(
            unresolved.files.map(filePath => path.basename(filePath)),
            ['top.v']
        );
        assert.strictEqual(unresolved.moduleMap.child, undefined);

        const selected = candidates[1];
        const resolved = analyzer.resolve(topKey, { child: selected.key });
        assert.deepStrictEqual(resolved.ambiguousModules, {});
        assert.strictEqual(resolved.moduleMap.child, fileURLToPath(selected.uri));
        assert.deepStrictEqual(resolved.files, [fileURLToPath(selected.uri), fileURLToPath(
            harness.index.findDefinitions('top', 'module')[0].uri
        )]);

        const invalid = analyzer.resolve(topKey, { child: 'module:file:///not-a-candidate.v:0' });
        assert.deepStrictEqual(invalid.ambiguousModules, { child: candidateKeys });
        assert.strictEqual(invalid.moduleMap.child, undefined);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerTopIdentity(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-top-'));
    const harness = await createDependencyHarness(projectDir, {
        'a/top.sv': 'module top; endmodule\n',
        'b/top.sv': 'module top; endmodule\n',
    });
    try {
        const analyzer = new DependencyAnalyzer(harness.index);
        const definitions = harness.index.findDefinitions('top', 'module');
        const exact = analyzer.resolve(definitions[1].key);
        assert.strictEqual(exact.topModule, 'top');
        assert.strictEqual(exact.topDefinitionKey, definitions[1].key);
        assert.deepStrictEqual(exact.files, [fileURLToPath(definitions[1].uri)]);

        const duplicateName = analyzer.resolve('top');
        assert.strictEqual(duplicateName.topModule, 'top');
        assert.strictEqual(duplicateName.topDefinitionKey, '');
        assert.deepStrictEqual(duplicateName.files, []);
        assert.deepStrictEqual(duplicateName.ambiguousModules, {
            top: definitions.map(definition => definition.key).sort(),
        });

        const missing = analyzer.resolve('absent_top');
        assert.strictEqual(missing.topModule, 'absent_top');
        assert.strictEqual(missing.topDefinitionKey, '');
        assert.deepStrictEqual(missing.missingModules, ['absent_top']);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerRejectsReachableNameCollision(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-name-collision-'));
    const harness = await createDependencyHarness(projectDir, {
        'a/dup.sv': 'module dup; dup u_other(); endmodule\n',
        'b/dup.sv': 'module dup; endmodule\n',
    });
    try {
        const definitions = harness.index.findDefinitions('dup', 'module');
        const top = definitions[0];
        const boundDependency = definitions[1];
        const result = new DependencyAnalyzer(harness.index).resolve(top.key, {
            dup: boundDependency.key,
        });

        assert.deepStrictEqual(result.ambiguousModules, {
            dup: definitions.map(definition => definition.key).sort(),
        });
        assert.strictEqual(result.moduleMap.dup, fileURLToPath(top.uri));
        assert.deepStrictEqual(result.depGraph.dup, ['dup']);
        assert.deepStrictEqual(result.files, [fileURLToPath(top.uri)]);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerPreservesProtoNamedModule(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-proto-name-'));
    const harness = await createDependencyHarness(projectDir, {
        '__proto__.sv': 'module __proto__; endmodule\n',
    });
    try {
        const definition = harness.index.findDefinitions('__proto__', 'module')[0];
        const result = new DependencyAnalyzer(harness.index).resolve(definition.key);

        assert.deepStrictEqual(Object.keys(result.moduleMap), ['__proto__']);
        assert.deepStrictEqual(Object.keys(result.depGraph), ['__proto__']);
        assert.strictEqual(
            result.moduleMap.__proto__,
            fileURLToPath(definition.uri)
        );
        assert.deepStrictEqual(result.depGraph.__proto__, []);
        assert.strictEqual(Object.getPrototypeOf(result.moduleMap), Object.prototype);
        assert.strictEqual(Object.getPrototypeOf(result.depGraph), Object.prototype);
        assert.strictEqual(Object.prototype.hasOwnProperty.call({}, '__proto__'), false);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerIncludeOrderAndCycles(): Promise<void> {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-dep-order-'));
    const harness = await createDependencyHarness(projectDir, {
        'top.v': '`include "top_defs.svh"\nmodule top; child u_child(); endmodule\n',
        'top_defs.svh': '`define TOP_WIDTH 8\n',
        'child.v': '`include "child_defs.svh"\nmodule child; top u_top(); endmodule\n',
        'child_defs.svh': '`define CHILD_WIDTH 4\n',
    });
    try {
        const topKey = harness.index.findDefinitions('top', 'module')[0].key;
        const result = new DependencyAnalyzer(harness.index).resolve(topKey);

        assert.deepStrictEqual(result.files.map(filePath => path.basename(filePath)), [
            'child_defs.svh',
            'child.v',
            'top_defs.svh',
            'top.v',
        ]);
        assert.deepStrictEqual(result.depGraph, {
            top: ['child'],
            child: ['top'],
        });
        assert.deepStrictEqual(result.missingModules, []);
    } finally {
        await harness.dispose();
    }
}

async function testDependencyAnalyzerNonFileUriFallback(): Promise<void> {
    const harness = createWorkspaceIndexHarness({
        'memory:///workspace/top.sv': 'module top; endmodule\n',
    });
    try {
        await harness.index.scan(['memory:///workspace']);
        const result = new DependencyAnalyzer(harness.index).resolve('top');
        assert.deepStrictEqual(result.files, ['memory:///workspace/top.sv']);
        assert.strictEqual(result.moduleMap.top, 'memory:///workspace/top.sv');
    } finally {
        await harness.dispose();
    }
}

function testDependencyAnalyzerProductionWiring(): void {
    const analyzerSource = fs.readFileSync(
        path.join(repoRoot, 'veriflow-vscode', 'src', 'core', 'dependencyAnalyzer.ts'),
        'utf8'
    );
    const extensionSource = fs.readFileSync(
        path.join(repoRoot, 'veriflow-vscode', 'src', 'extension.ts'),
        'utf8'
    );

    assert.match(analyzerSource, /constructor\(private readonly index: WorkspaceHdlIndex\)/);
    assert.doesNotMatch(analyzerSource, /MODULE_DECL_RE|INST_RE|INCLUDE_RE|readText|listVerilogFiles/);
    assert.match(extensionSource, /new DependencyAnalyzer\(index\)/);
    assert.doesNotMatch(extensionSource, /depAnalyzer\.resolve\([^\n]+,\s*searchDirs\)/);
    assert.match(extensionSource, /entry\[1\] !== false/);
    assert.match(extensionSource, /await index\.load\(\)|hdlIndexLoad = index\.load\(\)/);
    assert.match(extensionSource, /await index\.scan\(rootUris, signal\)/);
    assert.ok(
        extensionSource.indexOf('index?.dispose();')
        < extensionSource.indexOf('await parser?.dispose();')
    );
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

function testPortParserSelectsNamedModule(): void {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-multi-module-'));
    const filepath = path.join(projectDir, 'combined.sv');
    fs.writeFileSync(filepath, [
        'module first(input logic wrong_port);',
        'endmodule',
        '',
        'module selected #(',
        '    parameter WIDTH = 16',
        ') (',
        '    input logic clk,',
        '    output logic [WIDTH-1:0] data_o',
        ');',
        'endmodule',
        '',
    ].join('\n'), 'utf-8');

    const info = new PortParser().parseFile(filepath, 'selected');

    assert.strictEqual(info.name, 'selected');
    assert.deepStrictEqual(info.parameters.map(parameter => parameter.name), ['WIDTH']);
    assert.deepStrictEqual(info.ports.map(port => port.name), ['clk', 'data_o']);
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
    assert.ok(content.includes(`module ${tbSpec.name};`));
    assert.ok(content.includes(`$dumpfile("${tbSpec.wave_file}");`));
    assert.ok(content.includes([
        '    uart_tx #(',
        '        .SYS_CLK_FREQ ( 1_000_000 ),',
        '        .BAUD_RATE    ( 115200    ),',
        '        .STOP_BIT_CNT ( 1         ),',
        '        .PARITY_TYPE  ( "none"    ))',
        '    u_tx0 (',
        '        .clk      ( clk        ),',
        '        .rst_n    ( rst_n      ),',
        '        .tx_valid ( tx_valid   ),',
        '        .tx_ready ( tx_ready   ),',
        '        .tx_data  ( tx_payload ),',
        '        .uart_tx  ( uart_tx    ));',
    ].join('\n')));
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
        { key: 'a-0', fullName: 'top.a', reference: 'a', width: 1 },
        { key: 'a-1', fullName: 'top.a', reference: 'a', width: 1 },
        { key: 'data-0', fullName: 'top.data', reference: 'data', width: 8 },
    ];
    assert.deepStrictEqual(waveCore.describeSignal({ ...signals[1] }, signals), {
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

function testWaveLibraryWindowing(): void {
    assert.deepStrictEqual(
        waveCore.calculateVirtualWindow(100, 320, 2880, 32, 4),
        { firstRow: 86, renderedCount: 14, totalHeight: 3200, overflow: true }
    );
    assert.deepStrictEqual(
        waveCore.calculateVirtualWindow(5, 320, 0, 32, 4),
        { firstRow: 0, renderedCount: 5, totalHeight: 160, overflow: false }
    );
    assert.deepStrictEqual(
        waveCore.calculateVirtualWindow(100, 320, 33, 32, 0),
        { firstRow: 1, renderedCount: 11, totalHeight: 3200, overflow: true }
    );
    assert.deepStrictEqual(
        waveCore.calculateVirtualWindow(100, 320, 33, 32, -1),
        { firstRow: 1, renderedCount: 11, totalHeight: 3200, overflow: true }
    );
    assert.deepStrictEqual(
        waveCore.calculateVirtualWindow(100, 320, 33, 32, NaN),
        { firstRow: 1, renderedCount: 11, totalHeight: 3200, overflow: true }
    );
    assert.deepStrictEqual(
        waveCore.calculateVirtualWindow(100, 0, 33, 32, 0),
        { firstRow: 1, renderedCount: 0, totalHeight: 3200, overflow: true }
    );
    assert.deepStrictEqual(
        waveCore.calculateVirtualWindow(100, 0, 3200, 32, 0),
        { firstRow: 100, renderedCount: 0, totalHeight: 3200, overflow: true }
    );
    assert.strictEqual(waveCore.signalMatchesSelectedScope('top', ''), true);
    assert.strictEqual(waveCore.signalMatchesSelectedScope('top', 'top'), true);
    assert.strictEqual(waveCore.signalMatchesSelectedScope('top.child', 'top'), false);
    assert.strictEqual(waveCore.signalMatchesSelectedScope('top', false as any), false);
    assert.strictEqual(waveCore.signalMatchesSelectedScope('top', 0 as any), false);
    assert.strictEqual(waveCore.signalMatchesSelectedScope(1 as any, '1' as any), false);
}

function testIndexedWaveCore(): void {
    const raw = waveCore.decodeWindowPayload({
        kind: 'raw',
        width: 4,
        times: [0, 12],
        values: Buffer.from([0x00, 0x4b]).toString('base64'),
        valueStride: 1,
    });
    assert.deepStrictEqual(raw, {
        kind: 'raw',
        width: 4,
        changes: [
            { time: 0, value: '0000' },
            { time: 12, value: '10xz' },
        ],
    });
    const summary = waveCore.decodeWindowPayload({
        kind: 'summary',
        width: 4,
        firstTimes: [0],
        lastTimes: [12],
        firstValues: Buffer.from([0x00]).toString('base64'),
        lastValues: Buffer.from([0x4b]).toString('base64'),
        valueStride: 1,
        flags: [7],
    });
    assert.deepStrictEqual(summary.records, [{
        firstTime: 0,
        lastTime: 12,
        firstValue: '0000',
        lastValue: '10xz',
        flags: 7,
    }]);

    const cache = new waveCore.WindowCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.strictEqual(cache.get('a'), 1);
    cache.set('c', 3);
    assert.strictEqual(cache.has('a'), true);
    assert.strictEqual(cache.has('b'), false);
    assert.strictEqual(cache.size, 2);

    const requests = new waveCore.RequestTracker();
    requests.setGeneration(4);
    const requestId = requests.next('window');
    assert.strictEqual(requests.accepts({ generation: 4, requestId }), true);
    requests.cancel(requestId);
    assert.strictEqual(requests.accepts({ generation: 4, requestId }), false);
    requests.setGeneration(5);
    assert.strictEqual(requests.accepts({ generation: 4, requestId }), false);
    assert.deepStrictEqual(waveCore.prefetchRange(10, 20, 0, 100), { start: 5, end: 25 });
}

function testWaveWindowReuseAndFrameScheduling(): void {
    const cache = new waveCore.WaveWindowCache(2);
    const raw = {
        generation: 2,
        reference: 'clk',
        start: 0,
        end: 200,
        ticksPerPixel: 1,
        series: { kind: 'raw' },
    };
    const summary = {
        generation: 2,
        reference: 'data',
        start: 0,
        end: 200,
        ticksPerPixel: 2,
        series: { kind: 'summary' },
    };
    cache.set(raw);
    cache.set(summary);

    assert.deepStrictEqual(cache.find({
        generation: 2,
        reference: 'clk',
        start: 50,
        end: 150,
        ticksPerPixel: 0.25,
    }), raw);
    assert.deepStrictEqual(cache.find({
        generation: 3,
        reference: 'clk',
        start: 50,
        end: 150,
        ticksPerPixel: 0.25,
    }), undefined);
    assert.strictEqual(cache.find({
        generation: 2,
        reference: 'data',
        start: 50,
        end: 150,
        ticksPerPixel: 1,
    }), undefined);
    assert.deepStrictEqual(cache.find({
        generation: 2,
        reference: 'data',
        start: 50,
        end: 150,
        ticksPerPixel: 2,
    }), summary);
    assert.strictEqual(cache.size, 2);
    assert.strictEqual(waveCore.windowNeedsRefresh(raw, { start: 50, end: 150 }), false);
    assert.strictEqual(waveCore.windowNeedsRefresh(raw, { start: 95, end: 195 }), true);
    assert.strictEqual(waveCore.windowNeedsRefresh(null, { start: 50, end: 150 }), true);
    cache.clear();
    assert.strictEqual(cache.size, 0);

    const lru = new waveCore.WaveWindowCache(2);
    lru.set(raw);
    lru.set(summary);
    lru.find({ generation: 2, reference: 'clk', start: 50, end: 150, ticksPerPixel: 1 });
    lru.set({ ...raw, reference: 'reset' });
    assert.ok(lru.find({ generation: 2, reference: 'clk', start: 50, end: 150, ticksPerPixel: 1 }));
    assert.strictEqual(lru.find({ generation: 2, reference: 'data', start: 50, end: 150, ticksPerPixel: 2 }), undefined);

    const prefetchedRange = waveCore.prefetchRange(0, 100, 0, 1000);
    assert.deepStrictEqual(prefetchedRange, { start: 0, end: 150 });
    const prefetched = { ...prefetchedRange, pixelWidth: 100, ticksPerPixel: 1 };
    const effectiveTicksPerPixel = waveCore.effectiveWindowTicksPerPixel(prefetched, 50);
    assert.strictEqual(effectiveTicksPerPixel, 3);
    const cappedSummary = {
        generation: 2,
        reference: 'capped-summary',
        start: prefetched.start,
        end: prefetched.end,
        ticksPerPixel: effectiveTicksPerPixel,
        series: { kind: 'summary' },
    };
    const cappedRaw = {
        ...cappedSummary,
        reference: 'capped-raw',
        series: { kind: 'raw' },
    };
    const cappedCache = new waveCore.WaveWindowCache(2);
    cappedCache.set(cappedSummary);
    cappedCache.set(cappedRaw);
    assert.strictEqual(cappedCache.find({
        generation: 2,
        reference: 'capped-summary',
        start: 25,
        end: 125,
        ticksPerPixel: 1,
    }), undefined);
    assert.deepStrictEqual(cappedCache.find({
        generation: 2,
        reference: 'capped-raw',
        start: 25,
        end: 125,
        ticksPerPixel: 1,
    }), cappedRaw);
    assert.strictEqual(waveCore.effectiveWindowTicksPerPixel(prefetched, undefined), 1.5);
    assert.strictEqual(waveCore.effectiveWindowTicksPerPixel(prefetched, Infinity), 1.5);
    assert.strictEqual(waveCore.effectiveWindowTicksPerPixel(prefetched, 50.5), 1.5);
    assert.strictEqual(waveCore.effectiveWindowTicksPerPixel(prefetched, 101), 1.5);

    const legacySummary = {
        ...cappedSummary,
        reference: 'legacy-summary',
        ticksPerPixel: waveCore.effectiveWindowTicksPerPixel(prefetched, undefined),
    };
    const legacyRaw = {
        ...legacySummary,
        reference: 'legacy-raw',
        series: { kind: 'raw' },
    };
    const legacyCache = new waveCore.WaveWindowCache(2);
    legacyCache.set(legacySummary);
    legacyCache.set(legacyRaw);
    assert.strictEqual(legacyCache.find({
        generation: 2,
        reference: 'legacy-summary',
        start: 25,
        end: 125,
        ticksPerPixel: 1.25,
    }), undefined);
    assert.deepStrictEqual(legacyCache.find({
        generation: 2,
        reference: 'legacy-raw',
        start: 25,
        end: 125,
        ticksPerPixel: 1.25,
    }), legacyRaw);

    const frames: Array<() => void> = [];
    const paints: number[] = [];
    const scheduler = new waveCore.FrameScheduler(callback => {
        frames.push(callback);
        return frames.length;
    });
    scheduler.schedule(() => paints.push(1));
    scheduler.schedule(() => paints.push(2));
    assert.strictEqual(frames.length, 1);
    frames[0]();
    assert.deepStrictEqual(paints, [2]);
    scheduler.schedule(() => paints.push(3));
    scheduler.cancel();
    frames[1]();
    assert.deepStrictEqual(paints, [2]);
}

function testRecoverableWaveformRequestErrors(): void {
    const retries = new waveCore.BoundedRequestRetry(1);
    const requests = new waveCore.RequestTracker();
    requests.setGeneration(7);
    const sent: Array<{ kind: string; key: string; requestId: string; retryCount: number }> = [];
    const send = (kind: string, key: string, retryCount = 0) => {
        assert.strictEqual(retries.canStart(kind, key), true);
        const requestId = requests.next(kind);
        const pending = { kind, key, requestId, retryCount };
        sent.push(pending);
        return pending;
    };

    let pendingWindow = send('window', '0:150:50');
    let pendingValue = send('value', '7:5:clk');
    const pendingSearch = send('search', 'rising:5:clk');
    assert.strictEqual(waveCore.matchPendingRequest('stale-window', {
        window: pendingWindow,
        value: pendingValue,
        search: pendingSearch,
    }), null);

    const failedWindow = waveCore.matchPendingRequest(pendingWindow.requestId, {
        window: pendingWindow,
        value: pendingValue,
        search: pendingSearch,
    });
    assert.strictEqual(failedWindow.kind, 'window');
    assert.strictEqual(retries.recordFailure('window', pendingWindow.key, pendingWindow.retryCount), true);
    pendingWindow = send('window', pendingWindow.key, pendingWindow.retryCount + 1);
    assert.notStrictEqual(pendingWindow.requestId, failedWindow.pending.requestId);
    retries.recordSuccess('window', pendingWindow.key);

    const failedValue = waveCore.matchPendingRequest(pendingValue.requestId, {
        window: pendingWindow,
        value: pendingValue,
        search: pendingSearch,
    });
    assert.strictEqual(failedValue.kind, 'value');
    assert.strictEqual(retries.recordFailure('value', pendingValue.key, pendingValue.retryCount), true);
    pendingValue = send('value', pendingValue.key, pendingValue.retryCount + 1);
    assert.notStrictEqual(pendingValue.requestId, failedValue.pending.requestId);
    retries.recordSuccess('value', pendingValue.key);

    const persistent = send('window', '150:300:50');
    assert.strictEqual(retries.recordFailure('window', persistent.key, persistent.retryCount), true);
    const persistentRetry = send('window', persistent.key, persistent.retryCount + 1);
    assert.strictEqual(retries.recordFailure('window', persistentRetry.key, persistentRetry.retryCount), false);
    assert.strictEqual(retries.canStart('window', persistent.key), false);
    assert.strictEqual(retries.canStart('window', '300:450:50'), true);
    assert.strictEqual(sent.filter(item => item.key === persistent.key).length, 2);
}

function testWaveWindowHardening(): void {
    const raw = {
        generation: 2,
        reference: 'clk',
        start: 0,
        end: 200,
        ticksPerPixel: 1,
        series: { kind: 'raw' },
    };
    const cache = new waveCore.WaveWindowCache(2);
    const unrelated = { ...raw, reference: 'reset' };
    const replacement = { ...raw, series: { kind: 'raw', replacement: true } };
    cache.set(unrelated);
    cache.set(raw);
    cache.set(replacement);
    assert.strictEqual(cache.size, 2);
    assert.deepStrictEqual(cache.find({ generation: 2, reference: 'reset', start: 0, end: 200, ticksPerPixel: 1 }), unrelated);
    assert.deepStrictEqual(cache.find({ generation: 2, reference: 'clk', start: 0, end: 200, ticksPerPixel: 1 }), replacement);

    assert.throws(() => cache.set({ ...raw, start: NaN }), TypeError);
    assert.throws(() => cache.set({ ...raw, generation: Infinity }), TypeError);
    assert.throws(() => cache.set({ ...raw, end: Infinity }), TypeError);
    assert.throws(() => cache.set({ ...raw, start: 201, end: 200 }), TypeError);
    assert.throws(() => cache.set({ ...raw, ticksPerPixel: 0 }), TypeError);
    assert.throws(() => cache.set({ ...raw, ticksPerPixel: Infinity }), TypeError);
    assert.strictEqual(cache.find({ ...raw, generation: NaN }), undefined);
    assert.strictEqual(cache.find({ ...raw, start: Infinity }), undefined);
    assert.strictEqual(cache.find({ ...raw, start: 201, end: 200 }), undefined);
    assert.strictEqual(cache.find({ ...raw, ticksPerPixel: 0 }), undefined);
    assert.strictEqual(cache.find({ ...raw, ticksPerPixel: Infinity }), undefined);

    assert.strictEqual(waveCore.windowNeedsRefresh(
        { start: 0, end: 125 }, { start: 0, end: 100 }, 0.25, { start: 0, end: 1000 }
    ), false);
    assert.strictEqual(waveCore.windowNeedsRefresh(
        { start: 875, end: 1000 }, { start: 900, end: 1000 }, 0.25, { start: 0, end: 1000 }
    ), false);
    assert.strictEqual(waveCore.windowNeedsRefresh({ start: 75, end: 225 }, { start: 100, end: 200 }), false);
    assert.strictEqual(waveCore.windowNeedsRefresh({ start: 100, end: 200 }, { start: 100, end: 200 }, Infinity), true);
    assert.strictEqual(waveCore.windowNeedsRefresh({ start: 100, end: 200 }, { start: 100, end: 200 }, -1), false);
    assert.strictEqual(waveCore.windowNeedsRefresh({ start: 0, end: Infinity }, { start: 0, end: 100 }), true);
    assert.strictEqual(waveCore.windowNeedsRefresh({ start: 100, end: 0 }, { start: 0, end: 100 }), true);
    assert.strictEqual(waveCore.windowNeedsRefresh({ start: 0, end: 100 }, { start: NaN, end: 100 }), true);
    assert.strictEqual(waveCore.windowNeedsRefresh(
        { start: 0, end: 100 }, { start: 0, end: 100 }, 0.25, { start: 100, end: 0 }
    ), true);

    const frames: Array<() => void> = [];
    const paints: string[] = [];
    const scheduler = new waveCore.FrameScheduler(callback => {
        frames.push(callback);
        return frames.length;
    });
    scheduler.schedule(() => paints.push('A'));
    scheduler.cancel();
    scheduler.schedule(() => paints.push('B'));
    assert.strictEqual(frames.length, 2);
    frames[0]();
    assert.deepStrictEqual([...paints], []);
    frames[1]();
    assert.deepStrictEqual([...paints], ['B']);

    const retryFrames: Array<() => void> = [];
    let throws = true;
    const retryScheduler = new waveCore.FrameScheduler(callback => {
        if (throws) {
            throws = false;
            throw new Error('request frame failed');
        }
        retryFrames.push(callback);
        return retryFrames.length;
    });
    assert.throws(() => retryScheduler.schedule(() => paints.push('failed')), /request frame failed/);
    retryScheduler.schedule(() => paints.push('retry'));
    assert.strictEqual(retryFrames.length, 1);
    retryFrames[0]();
    assert.deepStrictEqual([...paints], ['B', 'retry']);
}

function testWaveformTransportAdapters(): void {
    const transportModule = require(path.join(
        __dirname,
        '..',
        '..',
        'media',
        'waveform',
        'viewer-transport.js'
    ));
    const vscodeSent: any[] = [];
    let state: any = null;
    const vscodeTransport = transportModule.createWaveformTransport({
        acquireVsCodeApi: () => ({
            postMessage: (message: any) => vscodeSent.push(message),
            getState: () => state,
            setState: (value: any) => { state = value; },
        }),
        addEventListener: () => undefined,
    });
    vscodeTransport.send({ type: 'ready' });
    vscodeTransport.setState({ layout: 1 });
    assert.strictEqual(vscodeTransport.kind, 'vscode');
    assert.deepStrictEqual(vscodeSent, [{ type: 'ready' }]);
    assert.deepStrictEqual(vscodeTransport.getState(), { layout: 1 });

    const memorySent: any[] = [];
    let memoryIncoming: ((message: any) => void) | undefined;
    const memoryTransport = transportModule.createWaveformTransport({
        __waveformMemoryTransport: {
            send: (message: any) => memorySent.push(message),
            onMessage: (listener: (message: any) => void) => {
                memoryIncoming = listener;
                return () => undefined;
            },
        },
    });
    const received: any[] = [];
    memoryTransport.onMessage((message: any) => received.push(message));
    memoryTransport.send({ type: 'windowRequest' });
    memoryIncoming?.({ type: 'windowData' });
    assert.strictEqual(memoryTransport.kind, 'memory');
    assert.strictEqual(memorySent.length, 1);
    assert.deepStrictEqual(received, [{ type: 'windowData' }]);

    let bridgeIncoming: ((payload: string) => void) | undefined;
    const bridgeSent: string[] = [];
    const qtTransport = transportModule.createWaveformTransport({
        qt: { webChannelTransport: {} },
        QWebChannel: class {
            constructor(_transport: unknown, ready: (channel: any) => void) {
                ready({
                    objects: {
                        waveformBridge: {
                            send: (payload: string) => bridgeSent.push(payload),
                            message: { connect: (listener: (payload: string) => void) => { bridgeIncoming = listener; } },
                        },
                    },
                });
            }
        },
    });
    const qtReceived: any[] = [];
    qtTransport.onMessage((message: any) => qtReceived.push(message));
    qtTransport.send({ type: 'valueRequest' });
    bridgeIncoming?.(JSON.stringify({ type: 'cursorValues' }));
    assert.strictEqual(qtTransport.kind, 'qt');
    assert.strictEqual(JSON.parse(bridgeSent[0]).type, 'valueRequest');
    assert.deepStrictEqual(qtReceived, [{ type: 'cursorValues' }]);
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

function testModuleInstantiationFormatterAlignment(): void {
    const actual = formatModuleInstantiation({
        moduleName: 'module_name',
        instanceName: 'u_module_name',
        parameters: [
            { name: 'DEPTH', value: '8' },
            { name: 'DATA_WIDTH', value: 'DATA_WIDTH' },
        ],
        ports: [
            { name: 'clk', value: 'clk_i' },
            { name: 'reset_n', value: 'reset_signal' },
        ],
    });

    assert.strictEqual(actual, [
        'module_name #(',
        '    .DEPTH      ( 8          ),',
        '    .DATA_WIDTH ( DATA_WIDTH ))',
        'u_module_name (',
        '    .clk     ( clk_i        ),',
        '    .reset_n ( reset_signal ));',
    ].join('\n'));
}

function testModuleInstantiationFormatterWithoutParameters(): void {
    const actual = formatModuleInstantiation({
        moduleName: 'child',
        instanceName: 'u_child',
        parameters: [],
        ports: [{ name: 'a', value: 'a' }],
        baseIndent: '    ',
    });

    assert.strictEqual(actual, [
        '    child u_child (',
        '        .a ( a ));',
    ].join('\n'));
}

function testModuleInstantiationFormatterWithoutPorts(): void {
    assert.strictEqual(formatModuleInstantiation({
        moduleName: 'leaf',
        instanceName: 'u_leaf',
        parameters: [],
        ports: [],
    }), 'leaf u_leaf ();');

    assert.strictEqual(formatModuleInstantiation({
        moduleName: 'configured_leaf',
        instanceName: 'u_configured_leaf',
        parameters: [{ name: 'WIDTH', value: 'WIDTH' }],
        ports: [],
    }), [
        'configured_leaf #(',
        '    .WIDTH ( WIDTH ))',
        'u_configured_leaf ();',
    ].join('\n'));
}

function testModuleInstantiationChoices(): void {
    const root = path.join(os.tmpdir(), 'veriflow-choice-root');
    const workspaceAlu = path.join(root, 'rtl', 'alu.sv');
    const libraryAlu = path.join(os.tmpdir(), 'veriflow-lib', 'alu.sv');
    const fifo = path.join(root, 'rtl', 'fifo.sv');

    const choices = buildModuleInstantiationChoices({
        root,
        libDirs: [path.dirname(libraryAlu)],
        totalModules: 2,
        modules: ['alu', 'fifo'],
        workspaceModules: ['alu', 'fifo'],
        definitions: [
            {
                key: `module:file://${workspaceAlu}:0`,
                name: 'alu',
                uri: `file://${workspaceAlu}`,
                filepath: workspaceAlu,
                line: 1,
                workspace: true,
            },
            {
                key: `module:file://${libraryAlu}:0`,
                name: 'alu',
                uri: `file://${libraryAlu}`,
                filepath: libraryAlu,
                line: 5,
                workspace: false,
            },
            {
                key: `module:file://${fifo}:0`,
                name: 'fifo',
                uri: `file://${fifo}`,
                filepath: fifo,
                line: 1,
                workspace: true,
            },
        ],
        modulesByDir: {},
        moduleFiles: { alu: workspaceAlu, fifo },
        duplicates: { alu: [workspaceAlu, libraryAlu] },
        duplicatesWithLines: {
            alu: [
                { file: workspaceAlu, line: 1 },
                { file: libraryAlu, line: 5 },
            ],
        },
    });

    assert.deepStrictEqual(choices, [
        {
            label: 'alu',
            description: path.join('rtl', 'alu.sv'),
            moduleName: 'alu',
            filepath: workspaceAlu,
        },
        {
            label: 'alu',
            description: libraryAlu,
            moduleName: 'alu',
            filepath: libraryAlu,
        },
        {
            label: 'fifo',
            description: path.join('rtl', 'fifo.sv'),
            moduleName: 'fifo',
            filepath: fifo,
        },
    ]);
}

function testModuleInstantiationManifestContribution(): void {
    const manifest = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'veriflow-vscode', 'package.json'),
        'utf-8'
    ));
    const command = manifest.contributes.commands.find(
        (entry: any) => entry.command === 'veriflow.instantiateModule'
    );
    const editorMenu = (manifest.contributes.menus['editor/context'] || []).find(
        (entry: any) => entry.command === 'veriflow.instantiateModule'
    );

    assert.deepStrictEqual(command, {
        command: 'veriflow.instantiateModule',
        title: 'Instantiate Module',
        category: 'VeriFlow',
        icon: '$(symbol-method)',
    });
    assert.deepStrictEqual(editorMenu, {
        command: 'veriflow.instantiateModule',
        when: 'editorLangId == verilog || editorLangId == systemverilog',
        group: 'navigation@10',
    });
}

const tests: Array<[string, () => void | Promise<void>]> = [
    ['dependency analyzer', testDependencyAnalyzer],
    ['dependency analyzer indexed topological order', testDependencyAnalyzerIndexedTopologicalOrder],
    ['dependency analyzer conditional compilation', testDependencyAnalyzerConditionalCompilation],
    ['dependency analyzer generate for/if', testDependencyAnalyzerGenerateForIf],
    ['dependency analyzer procedural statements', testDependencyAnalyzerProceduralStatements],
    ['dependency analyzer missing and ambiguous modules', testDependencyAnalyzerMissingAndAmbiguousModules],
    ['dependency analyzer top identity', testDependencyAnalyzerTopIdentity],
    ['dependency analyzer rejects reachable name collision', testDependencyAnalyzerRejectsReachableNameCollision],
    ['dependency analyzer preserves __proto__ named module', testDependencyAnalyzerPreservesProtoNamedModule],
    ['dependency analyzer include order and cycles', testDependencyAnalyzerIncludeOrderAndCycles],
    ['dependency analyzer non-file URI fallback', testDependencyAnalyzerNonFileUriFallback],
    ['dependency analyzer production wiring', testDependencyAnalyzerProductionWiring],
    ['port parser', testPortParser],
    ['port parser selects named module', testPortParserSelectsNamedModule],
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
    ['wave library windowing', testWaveLibraryWindowing],
    ['indexed waveform core', testIndexedWaveCore],
    ['wave window reuse and frame scheduling', testWaveWindowReuseAndFrameScheduling],
    ['wave window hardening', testWaveWindowHardening],
    ['recoverable waveform request errors', testRecoverableWaveformRequestErrors],
    ['waveform transport adapters', testWaveformTransportAdapters],
    ['waveform layout store', testWaveformLayoutStore],
    ['module instantiation formatter alignment', testModuleInstantiationFormatterAlignment],
    ['module instantiation formatter without parameters', testModuleInstantiationFormatterWithoutParameters],
    ['module instantiation formatter without ports', testModuleInstantiationFormatterWithoutPorts],
    ['module instantiation choices', testModuleInstantiationChoices],
    ['module instantiation manifest contribution', testModuleInstantiationManifestContribution],
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
