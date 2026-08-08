import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NativeSimulatorBackend } from '@veriflow/flow-core/nativeSimulatorBackend';
import type { SimulationRequest } from '@veriflow/flow-core/simulation';

type Capture = {
    action: string;
    args: string[];
    cwd: string;
};

function quote(value: string): string {
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function request(
    root: string,
    capturePath: string,
    compileAction = 'compile'
): SimulationRequest {
    const fixture = path.resolve(
        __dirname,
        '..',
        '..',
        'test',
        'fixtures',
        'fakeSimulator.mjs'
    );
    const prefix = `${quote(process.execPath)} ${quote(fixture)} ${quote(capturePath)}`;
    return {
        files: [path.join(root, 'child.v'), path.join(root, 'top.v')],
        output: path.join(root, 'top.out'),
        simulator: {
            name: 'fake',
            compileCmd: `${prefix} ${compileAction} "{output}" {files}`,
            runCmd: `${prefix} run "{output}"`,
        },
        cwd: root,
        topModule: 'top',
    };
}

function captures(filepath: string): Capture[] {
    return readFileSync(filepath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('native simulator backend runs rendered commands in the requested cwd', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-sim-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const result = await new NativeSimulatorBackend().compileAndRun(
            request(root, capturePath)
        );

        assert.equal(result.success, true);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'RUN OK\n');
        assert.equal(result.stderr, '');
        assert.ok(result.elapsedTime >= 0);
        assert.match(result.compileCommand, / compile "top\.out" "child\.v" "top\.v"$/);
        assert.match(result.runCommand, / run "top\.out"$/);
        assert.deepEqual(captures(capturePath), [
            { action: 'compile', args: ['top.out', 'child.v', 'top.v'], cwd: root },
            { action: 'run', args: ['top.out'], cwd: root },
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('native simulator backend stops after a compile error and parses diagnostics', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-sim-fail-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const result = await new NativeSimulatorBackend().compileAndRun(
            request(root, capturePath, 'compile-fail')
        );

        assert.equal(result.success, false);
        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, 'COMPILE OUTPUT\n');
        assert.equal(result.stderr, 'top.v:3: error: compile failed\n');
        assert.equal(result.runCommand, '');
        assert.deepEqual(result.logEntries.filter(entry => entry.level === 'ERROR'), [{
            level: 'ERROR',
            message: 'compile failed',
            fileRef: 'top.v',
            lineNo: 3,
        }]);
        assert.deepEqual(captures(capturePath).map(call => call.action), ['compile-fail']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
