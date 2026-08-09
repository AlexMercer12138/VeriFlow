import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    '@veriflow/cli',
];

function npm(args) {
    const invocation = resolveNpmInvocation(args);
    execFileSync(invocation.executable, invocation.args, {
        cwd: repositoryRoot,
        stdio: 'inherit',
    });
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
npm(['run', 'build:cli']);
for (const workspace of workspaces) {
    npm(['pack', '--workspace', workspace, '--pack-destination', destination]);
}
