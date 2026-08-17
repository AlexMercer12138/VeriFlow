import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

type SimulationResult = {
    success: boolean;
    stdout: string;
    stderr: string;
    artifacts: Map<string, Uint8Array>;
};

type IverilogApi = {
    simulate(request: {
        files: Array<{ path: string; data: string }>;
        sources: string[];
        top: string;
        generation: '2005';
        artifacts: string[];
    }): Promise<SimulationResult>;
};

const extensionRoot = path.resolve(__dirname, '..', '..');
const packagedRoot = process.env.VERIFLOW_BUILTIN_ASSETS_ROOT
    ? path.resolve(process.env.VERIFLOW_BUILTIN_ASSETS_ROOT)
    : path.join(extensionRoot, 'dist', 'vendor', 'iverilog-wasm');
const packagedEntry = path.join(packagedRoot, 'dist', 'index.js');
const importEsm = new Function(
    'specifier',
    'return import(specifier);'
) as (specifier: string) => Promise<IverilogApi>;

async function run(): Promise<void> {
    assert.ok(fs.statSync(packagedEntry).isFile(), `missing packaged entry ${packagedEntry}`);
    const api = await importEsm(pathToFileURL(packagedEntry).href);
    const result = await api.simulate({
        files: [
            {
                path: 'counter.v',
                data: [
                    'module counter(input clk, input reset, output reg [3:0] value);',
                    '  always @(posedge clk) begin',
                    '    if (reset) value <= 0;',
                    '    else value <= value + 1;',
                    '  end',
                    'endmodule',
                    '',
                ].join('\n'),
            },
            {
                path: 'counter_tb.v',
                data: [
                    '`timescale 1ns/1ps',
                    'module counter_tb;',
                    '  reg clk = 0;',
                    '  reg reset = 1;',
                    '  wire [3:0] value;',
                    '  counter dut(.clk(clk), .reset(reset), .value(value));',
                    '  always #5 clk = ~clk;',
                    '  initial begin',
                    '    $dumpfile("counter.vcd");',
                    '    $dumpvars(0, counter_tb);',
                    '    #12 reset = 0;',
                    '    #40;',
                    '    if (value === 4) $display("PASS");',
                    '    else $display("FAIL value=%0d", value);',
                    '    $finish;',
                    '  end',
                    'endmodule',
                    '',
                ].join('\n'),
            },
        ],
        sources: ['counter.v', 'counter_tb.v'],
        top: 'counter_tb',
        generation: '2005',
        artifacts: ['counter.vcd'],
    });

    assert.strictEqual(result.success, true, result.stderr || result.stdout);
    assert.match(result.stdout, /(^|\n)PASS\n/);
    assert.doesNotMatch(result.stdout, /FAIL/);
    assert.ok(
        (result.artifacts.get('counter.vcd')?.byteLength ?? 0) > 0,
        'packaged simulator returned a blank VCD'
    );
}

run()
    .then(() => console.log('builtin simulator packaged asset tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
