import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIverilogSource } from './lib/iverilog-source.mjs';
import { resolveNpmInvocation } from './lib/npm-command.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(repositoryRoot, 'dist', 'npm');
const workspaces = [
    '@veriflow/flow-core',
    '@veriflow/hdl-core',
    '@veriflow/schematic-core',
    '@veriflow/hdl-runtime',
    '@veriflow/waveform-runtime',
    '@veriflow/waveform-desktop',
    '@veriflow/simulator-iverilog-wasm',
    '@veriflow/cli',
];
const upstreamPackageRoot = path.join(
    repositoryRoot,
    'node_modules',
    '@veriflow',
    'iverilog-wasm'
);

function npm(args) {
    const invocation = resolveNpmInvocation(args);
    execFileSync(invocation.executable, invocation.args, {
        cwd: repositoryRoot,
        stdio: 'inherit',
    });
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
readIverilogSource({
    packageRoot: upstreamPackageRoot,
    expectedName: '@veriflow/iverilog-wasm',
    expectedVersion: '0.1.4',
});
npm(['run', 'build:cli']);
for (const workspace of workspaces) {
    npm(['pack', '--workspace', workspace, '--pack-destination', destination]);
}
