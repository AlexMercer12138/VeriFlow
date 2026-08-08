import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(repositoryRoot, 'dist', 'npm');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const workspaces = [
    '@veriflow/flow-core',
    '@veriflow/hdl-core',
    '@veriflow/hdl-runtime',
    '@veriflow/waveform-runtime',
    '@veriflow/waveform-desktop',
    '@veriflow/cli',
];

function npm(args) {
    execFileSync(npmCommand, args, {
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
