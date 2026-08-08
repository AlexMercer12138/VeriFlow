import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NodeWaveViewerLauncher } from '../src/runtime/nodeWaveViewerLauncher';

const fakeViewer = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'fakeWaveViewer.mjs');

test('CLI help does not load Electron', () => {
    const mainPath = require.resolve('../src/main');
    const result = spawnSync(process.execPath, [
        '-e',
        `const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request) {
    if (request === 'electron') throw new Error('electron module was loaded');
    return Reflect.apply(originalLoad, this, arguments);
};
const { runCli } = require(process.argv[1]);
runCli(['--help'], {
    cwd: process.cwd(),
    homeDir: process.cwd(),
    stdout() {},
    stderr() {},
}).then(exitCode => {
    if (exitCode !== 0) process.exitCode = exitCode;
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});`,
        mainPath,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
});

async function waitForFile(filepath: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (existsSync(filepath)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${filepath}`);
}

test('external wave viewer launches through the native shell in the requested cwd', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-wave-launcher-'));
    const capturePath = path.join(root, 'viewer.json');
    try {
        const command = [process.execPath, fakeViewer, capturePath, 'hello world']
            .map(value => JSON.stringify(value))
            .join(' ');
        await new NodeWaveViewerLauncher().openExternal(command, root);
        await waitForFile(capturePath);

        assert.deepEqual(JSON.parse(readFileSync(capturePath, 'utf8')), {
            cwd: root,
            args: ['hello world'],
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
