import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserBuildOptions } from './lib/build-config.mjs';
import { copyTree, recreate } from './lib/files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDistRoot = path.join(root, 'web-dist');

export const webApplications = [
    {
        name: 'waveform',
        sourceRoot: 'packages/waveform-webview/src',
        staticFiles: ['index.html', 'index.css'],
        legacyScripts: ['viewer-transport.js', 'viewer-core.js', 'index.js'],
    },
    {
        name: 'schematic',
        sourceRoot: 'packages/schematic-webview/src',
        staticFiles: ['index.html', 'index.css'],
        entryPoint: 'index.ts',
    },
];

async function buildApplication(application) {
    const sourceRoot = path.join(root, application.sourceRoot);
    const destinationRoot = path.join(webDistRoot, application.name);

    for (const file of application.staticFiles) {
        await copyTree(path.join(sourceRoot, file), path.join(destinationRoot, file));
    }
    for (const file of application.legacyScripts ?? []) {
        await copyTree(path.join(sourceRoot, file), path.join(destinationRoot, file));
    }
    if (application.entryPoint) {
        await build({
            ...browserBuildOptions(),
            absWorkingDir: root,
            entryPoints: [path.join(sourceRoot, application.entryPoint)],
            outfile: path.join(destinationRoot, 'index.js'),
        });
    }
}

function buildWebDependencies() {
    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath
        ? process.execPath
        : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const prefix = npmExecPath ? [npmExecPath] : [];
    for (const workspace of ['@veriflow/hdl-core', '@veriflow/schematic-core']) {
        execFileSync(command, [
            ...prefix,
            'run',
            'build',
            '--workspace',
            workspace,
        ], {
            cwd: root,
            stdio: 'inherit',
        });
    }
}

export async function buildWeb(options = {}) {
    if (options.buildDependencies !== false) buildWebDependencies();
    await recreate(webDistRoot);
    for (const application of webApplications) {
        await buildApplication(application);
    }
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    await buildWeb();
}
