import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/main';

test('builtin CLI simulates Verilog-2005 and writes VCD without native Icarus in PATH', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-builtin-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const homeDir = path.join(caseRoot, 'home');
    const emptyPath = path.join(caseRoot, 'empty-path');
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(emptyPath, { recursive: true });

    writeFileSync(path.join(rootDir, 'counter.v'), `
module counter(input clk, input reset, output reg [3:0] value);
    always @(posedge clk) begin
        if (reset) value <= 0;
        else value <= value + 1;
    end
endmodule
`, 'utf8');
    writeFileSync(path.join(rootDir, 'counter_tb.v'), `
\`timescale 1ns/1ps
module counter_tb;
    reg clk = 0;
    reg reset = 1;
    wire [3:0] value;
    counter dut(.clk(clk), .reset(reset), .value(value));
    always #5 clk = ~clk;
    initial begin
        $dumpfile("counter.vcd");
        $dumpvars(0, counter_tb);
        #12 reset = 0;
        #40;
        if (value === 4) $display("PASS");
        else $display("FAIL value=%0d", value);
        $finish;
    end
endmodule
`, 'utf8');
    writeFileSync(path.join(cwd, 'project.json'), JSON.stringify({
        project_name: 'builtin-smoke',
        project_root: 'rtl',
        top_module: 'counter_tb',
        simulator: 'builtin',
        wave_file_template: 'counter.vcd',
    }, null, 2), 'utf8');

    let stdout = '';
    let stderr = '';
    const originalPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
        const exitCode = await runCli(['sim', '--project', 'project.json'], {
            cwd,
            homeDir,
            stdout: text => { stdout += text; },
            stderr: text => { stderr += text; },
            commandExecutor: {
                execute(): never {
                    throw new Error('native command execution was attempted');
                },
            },
        });

        assert.equal(exitCode, 0, stderr || stdout);
        assert.match(stdout, /PASS/);
        assert.doesNotMatch(stdout, /\[CMD\]/);
        assert.equal(stderr, '');
        assert.equal(existsSync(path.join(rootDir, 'counter.vcd')), true);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(caseRoot, { recursive: true, force: true });
    }
});
