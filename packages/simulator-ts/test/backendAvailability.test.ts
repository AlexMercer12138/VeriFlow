import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { SimulatorBackendRegistry } from '@veriflow/flow-core';

import { EXPERIMENTAL_TS_UNAVAILABLE } from '../src';

test('experimental TypeScript simulator stays private and out of release packs', async () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const repositoryRoot = path.resolve(packageRoot, '../..');
    const packageJson = JSON.parse(await readFile(
        path.join(packageRoot, 'package.json'),
        'utf8',
    ));
    const repositoryPackageJson = JSON.parse(await readFile(
        path.join(repositoryRoot, 'package.json'),
        'utf8',
    ));
    const packScript = await readFile(
        path.join(repositoryRoot, 'scripts', 'pack-node-release.mjs'),
        'utf8',
    );

    assert.equal(packageJson.name, '@veriflow/simulator-ts');
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.version, repositoryPackageJson.version);
    assert.doesNotMatch(packScript, /@veriflow\/simulator-ts/u);
});

test('experimental selection reports unavailable without resolving another provider', async () => {
    const registry = new SimulatorBackendRegistry();
    let builtinCalls = 0;
    let nativeCalls = 0;
    registry.register('builtin', () => {
        builtinCalls += 1;
        throw new Error('builtin must not be resolved');
    });
    registry.register('native-iverilog', () => {
        nativeCalls += 1;
        throw new Error('native must not be resolved');
    });
    registry.register('experimental-ts', () => {
        throw new Error(EXPERIMENTAL_TS_UNAVAILABLE);
    });

    await assert.rejects(
        registry.resolve('experimental-ts'),
        new RegExp(EXPERIMENTAL_TS_UNAVAILABLE),
    );
    assert.equal(builtinCalls, 0);
    assert.equal(nativeCalls, 0);
});
