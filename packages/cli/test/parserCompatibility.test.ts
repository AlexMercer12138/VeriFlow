import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CliEnvironment, runCli } from '../src/main';

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

async function invoke(argv: string[], cwd: string): Promise<RunResult> {
    let stdout = '';
    let stderr = '';
    const environment: CliEnvironment = {
        cwd,
        homeDir: path.join(cwd, 'home'),
        stdout: text => { stdout += text; },
        stderr: text => { stderr += text; },
    };
    return {
        exitCode: await runCli(argv, environment),
        stdout,
        stderr,
    };
}

async function withTemporaryDirectory(
    run: (directory: string) => Promise<void>
): Promise<void> {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-parser-'));
    try {
        await run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('accepts a long option value joined with equals', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '--name=equals'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'Project created: equals.json\n');
        assert.equal(result.stderr, '');
        assert.equal(existsSync(path.join(cwd, 'equals.json')), true);
    });
});

test('accepts a value attached to a short option', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '-nattached'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'Project created: attached.json\n');
        assert.equal(result.stderr, '');
        assert.equal(existsSync(path.join(cwd, 'attached.json')), true);
    });
});

test('accepts an unambiguous long option abbreviation', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '--nam', 'abbreviated'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'Project created: abbreviated.json\n');
        assert.equal(result.stderr, '');
        assert.equal(existsSync(path.join(cwd, 'abbreviated.json')), true);
    });
});

test('rejects an option-like separated value', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '-n', '-dash'], cwd);

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow project new [-h] -n NAME [-r ROOT] [-t TOP] [-L LIB] [-s SIM]
                            [-w WAVE] [--output OUTPUT]
veriflow project new: error: argument -n/--name: expected one argument
`);
        assert.equal(existsSync(path.join(cwd, '-dash.json')), false);
    });
});
