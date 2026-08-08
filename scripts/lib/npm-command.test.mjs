import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(testRoot, 'npm-command.mjs');

test('npm commands run through Node without executing platform shims', async () => {
    assert.equal(existsSync(helperPath), true, 'npm command helper must exist');
    const { resolveNpmInvocation } = await import(pathToFileURL(helperPath).href);

    assert.deepEqual(resolveNpmInvocation(
        ['exec', '--', 'veriflow', '--help'],
        {
            nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
            npmExecutable: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        }
    ), {
        executable: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
            'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
            'exec',
            '--',
            'veriflow',
            '--help',
        ],
    });
});

test('npm command resolution rejects a missing npm_execpath', async () => {
    assert.equal(existsSync(helperPath), true, 'npm command helper must exist');
    const { resolveNpmInvocation } = await import(pathToFileURL(helperPath).href);

    assert.throws(
        () => resolveNpmInvocation(['pack'], {
            nodeExecutable: '/usr/bin/node',
            npmExecutable: '',
        }),
        /npm_execpath/
    );
});
