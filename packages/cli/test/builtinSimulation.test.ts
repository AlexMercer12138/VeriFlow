import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
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

test('builtin CLI resolves includes from the project root', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-include-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const homeDir = path.join(caseRoot, 'home');
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    writeFileSync(path.join(rootDir, 'defs.vh'), '`define EXPECTED 7\n', 'utf8');
    writeFileSync(path.join(rootDir, 'top.v'), `
\`include "defs.vh"
module top;
    initial begin
        if (\`EXPECTED == 7) $display("PASS");
        else $display("FAIL");
        $finish;
    end
endmodule
`, 'utf8');
    writeFileSync(path.join(cwd, 'project.json'), JSON.stringify({
        project_name: 'builtin-include',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
    }, null, 2), 'utf8');

    let stdout = '';
    let stderr = '';
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
        assert.doesNotMatch(stdout, /Include file defs\.vh not found|FAIL/);
        assert.equal(stderr, '');
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('builtin CLI stages simulation_files for readmemh relative to the run cwd', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-readmemh-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const vectorsDir = path.join(cwd, 'vectors');
    const wavesDir = path.join(rootDir, 'waves');
    const homeDir = path.join(caseRoot, 'home');
    mkdirSync(vectorsDir, { recursive: true });
    mkdirSync(wavesDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    writeFileSync(path.join(vectorsDir, 'input.hex'), '2a\n', 'utf8');
    writeFileSync(path.join(rootDir, 'top.v'), `
module top;
    reg [7:0] memory [0:0];
    initial begin
        $readmemh("../vectors/input.hex", memory);
        $dumpfile("waves/top.vcd");
        $dumpvars(0, top);
        #1;
        if (memory[0] === 8'h2a) $display("PASS");
        else $display("FAIL %h", memory[0]);
        $finish;
    end
endmodule
`, 'utf8');
    writeFileSync(path.join(cwd, 'project.json'), JSON.stringify({
        project_name: 'builtin-readmemh',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
        simulation_files: ['vectors/input.hex'],
        wave_file_template: 'waves/top.vcd',
    }, null, 2), 'utf8');

    let stdout = '';
    let stderr = '';
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
        assert.doesNotMatch(stdout, /Unable to open|FAIL/);
        assert.equal(stderr, '');
        assert.equal(existsSync(path.join(wavesDir, 'top.vcd')), true);
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('builtin CLI preserves runtime paths through a symlink project root', async t => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-link-cwd-'));
    const cwd = path.join(caseRoot, 'workspace');
    const physicalProject = path.join(caseRoot, 'physical', 'demo');
    const physicalRoot = path.join(physicalProject, 'rtl');
    const rootDir = path.join(cwd, 'rtl-link');
    const vectorsDir = path.join(physicalProject, 'vectors');
    const homeDir = path.join(caseRoot, 'home');
    const emptyPath = path.join(caseRoot, 'empty-path');
    mkdirSync(physicalRoot, { recursive: true });
    mkdirSync(vectorsDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(emptyPath, { recursive: true });

    try {
        try {
            symlinkSync(physicalRoot, rootDir, 'dir');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                t.skip(`directory links are unavailable: ${code}`);
                return;
            }
            throw error;
        }
        writeFileSync(path.join(vectorsDir, 'input.hex'), '2a\n', 'utf8');
        writeFileSync(path.join(physicalRoot, 'top.v'), `
module top;
    reg [7:0] memory [0:0];
    initial begin
        $readmemh("../vectors/input.hex", memory);
        #1;
        if (memory[0] === 8'h2a) $display("PASS");
        else $display("FAIL %h", memory[0]);
        $finish;
    end
endmodule
`, 'utf8');
        writeFileSync(path.join(cwd, 'project.json'), JSON.stringify({
            project_name: 'builtin-link-cwd',
            project_root: 'rtl-link',
            top_module: 'top',
            simulator: 'builtin',
            simulation_files: ['../physical/demo/vectors/input.hex'],
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
            assert.doesNotMatch(stdout, /Unable to open|FAIL/);
            assert.equal(stderr, '');
        } finally {
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
        }
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('builtin CLI writes an absolute external wave through a safe virtual path', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-external-wave-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const externalDir = path.join(caseRoot, 'external');
    const waveFile = path.join(externalDir, 'top.vcd');
    const homeDir = path.join(caseRoot, 'home');
    const emptyPath = path.join(caseRoot, 'empty-path');
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(emptyPath, { recursive: true });

    writeFileSync(path.join(rootDir, 'top.v'), `
module top;
    initial begin
        $dumpfile("../../external/top.vcd");
        $dumpvars(0, top);
        $display("PASS");
        #1 $finish;
    end
endmodule
`, 'utf8');
    writeFileSync(path.join(cwd, 'project.json'), JSON.stringify({
        project_name: 'builtin-external-wave',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
        wave_file_template: waveFile,
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
        assert.doesNotMatch(stdout, /Unable to open|FAIL/);
        assert.equal(stderr, '');
        assert.equal(existsSync(waveFile), true);
        assert.equal(
            existsSync(path.join(externalDir, '.veriflow-artifact-dir')),
            false,
        );
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('builtin CLI stages nested VCD directories in the WASM workspace', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-nested-vcd-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const wavesDir = path.join(rootDir, 'waves');
    const homeDir = path.join(caseRoot, 'home');
    mkdirSync(wavesDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    writeFileSync(path.join(rootDir, 'top.v'), `
module top;
    initial begin
        $dumpfile("waves/top.vcd");
        $dumpvars(0, top);
        $display("PASS");
        #1 $finish;
    end
endmodule
`, 'utf8');
    writeFileSync(path.join(cwd, 'project.json'), JSON.stringify({
        project_name: 'builtin-nested-vcd',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
        wave_file_template: 'waves/top.vcd',
    }, null, 2), 'utf8');

    let stdout = '';
    let stderr = '';
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
        assert.doesNotMatch(stdout, /Unable to open waves\/top\.vcd|FAIL/);
        assert.equal(stderr, '');
        assert.equal(existsSync(path.join(wavesDir, 'top.vcd')), true);
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});
