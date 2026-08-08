import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildBundles,
    runWatch,
    verifyAndCopyParserAssets,
} from './build-support.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(extensionRoot, 'dist');
const workerRoot = path.join(distRoot, 'workers');
const parserRoot = path.join(extensionRoot, 'media', 'parsers');
const workspaceRequire = createRequire(import.meta.url);
const grammarPackageRoot = path.dirname(workspaceRequire.resolve(
    'tree-sitter-systemverilog/tree-sitter-systemverilog.wasm'
));
const webTreeSitterPackageRoot = path.dirname(workspaceRequire.resolve(
    'web-tree-sitter/web-tree-sitter.wasm'
));

const parserAssets = [
    {
        name: 'tree-sitter-systemverilog',
        version: '0.4.0',
        source: path.join(grammarPackageRoot, 'tree-sitter-systemverilog.wasm'),
        destination: path.join(parserRoot, 'tree-sitter-systemverilog.wasm'),
        licenseDeclaration: 'MIT',
        licensePath: path.join(grammarPackageRoot, 'LICENSE'),
        sha256: 'e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d',
    },
    {
        name: 'web-tree-sitter',
        version: '0.26.11',
        source: path.join(webTreeSitterPackageRoot, 'web-tree-sitter.wasm'),
        destination: path.join(parserRoot, 'web-tree-sitter.wasm'),
        licenseDeclaration: 'MIT',
        licensePath: path.join(webTreeSitterPackageRoot, 'LICENSE'),
        sha256: '715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc',
    },
];

const commonBuildOptions = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
};

const nodeBundleOptions = [
    {
        ...commonBuildOptions,
        entryPoints: [path.join(extensionRoot, 'src', 'extension.ts')],
        outfile: path.join(distRoot, 'extension.js'),
        external: ['vscode'],
    },
    {
        ...commonBuildOptions,
        entryPoints: [path.join(
            extensionRoot,
            '..',
            'packages',
            'hdl-runtime',
            'src',
            'parserWorker.ts'
        )],
        outfile: path.join(workerRoot, 'hdlParserWorker.js'),
    },
    {
        ...commonBuildOptions,
        entryPoints: [path.join(
            extensionRoot,
            '..',
            'packages',
            'waveform-runtime',
            'src',
            'waveformWorker.ts'
        )],
        outfile: path.join(workerRoot, 'waveformWorker.js'),
    },
];

async function prepareParserAssets() {
    await verifyAndCopyParserAssets(parserAssets);
}

async function prepareDist() {
    await rm(distRoot, { recursive: true, force: true });
    await mkdir(workerRoot, { recursive: true });
}

async function runBuild() {
    await prepareParserAssets();
    await prepareDist();
    await buildBundles(nodeBundleOptions);
}

async function runWatchMode() {
    await prepareParserAssets();
    await prepareDist();
    process.exitCode = await runWatch({
        bundleOptions: nodeBundleOptions,
        cwd: extensionRoot,
        typecheck: {
            command: process.execPath,
            args: [
                workspaceRequire.resolve('typescript/bin/tsc'),
                '--watch', '-p', './',
            ],
            stdio: 'inherit',
        },
    });
}

if (process.argv.includes('--watch')) {
    await runWatchMode();
} else {
    await runBuild();
}
