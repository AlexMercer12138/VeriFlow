import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { waveformElectronInvocation } from '../src/launcher';

test('loading the desktop launcher does not resolve Electron', () => {
    const launcherPath = require.resolve('../src/launcher');
    const result = spawnSync(process.execPath, [
        '-e',
        `const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request) {
    if (request === 'electron') throw new Error('electron module was loaded');
    return Reflect.apply(originalLoad, this, arguments);
};
require(process.argv[1]);`,
        launcherPath,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
});

test('desktop launcher resolves Electron, its app entry, and the waveform path', () => {
    const source = path.join('relative', 'wave.vcd');
    const invocation = waveformElectronInvocation(source);

    assert.equal(invocation.executable, require('electron') as unknown as string);
    assert.equal(path.basename(invocation.appEntry), 'main.js');
    assert.equal(path.dirname(invocation.appEntry), path.dirname(require.resolve('../src/launcher')));
    assert.deepEqual(invocation.args, [
        invocation.appEntry,
        '--waveform',
        path.resolve(source),
    ]);
});
