import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyTree, recreate } from './lib/files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(root, 'veriflow-vscode');
const applications = ['waveform', 'schematic'];

export async function syncVscodeWebAssets(repositoryRoot = root) {
    const targetExtensionRoot = path.join(repositoryRoot, 'veriflow-vscode');
    for (const application of applications) {
        const destination = path.join(targetExtensionRoot, 'media', application);
        await recreate(destination);
        await copyTree(path.join(repositoryRoot, 'web-dist', application), destination);
    }
}

export async function buildVscode() {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs')], {
        cwd: root,
        stdio: 'inherit',
    });
    execFileSync(process.execPath, [path.join(extensionRoot, 'scripts/build.mjs')], {
        cwd: extensionRoot,
        stdio: 'inherit',
    });

    await syncVscodeWebAssets();
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    await buildVscode();
}
