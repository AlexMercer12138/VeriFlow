import {
    copyFile,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildBundles,
    collectBundledPackageLicenses,
    formatThirdPartyNotices,
    runWatch,
    verifyAndCopyParserAssets,
} from './build-support.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(extensionRoot, 'dist');
const workerRoot = path.join(distRoot, 'workers');
const parserRoot = path.join(extensionRoot, 'media', 'parsers');
const schematicSourceRoot = path.join(extensionRoot, 'webview', 'schematic');
const schematicRoot = path.join(extensionRoot, 'media', 'schematic');

const parserAssets = [
    {
        name: 'tree-sitter-systemverilog',
        version: '0.4.0',
        source: path.join(
            extensionRoot,
            'node_modules',
            'tree-sitter-systemverilog',
            'tree-sitter-systemverilog.wasm'
        ),
        destination: path.join(parserRoot, 'tree-sitter-systemverilog.wasm'),
        licenseDeclaration: 'MIT',
        licensePath: path.join(extensionRoot, 'node_modules', 'tree-sitter-systemverilog', 'LICENSE'),
        sha256: 'e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d',
    },
    {
        name: 'web-tree-sitter',
        version: '0.26.11',
        source: path.join(
            extensionRoot,
            'node_modules',
            'web-tree-sitter',
            'web-tree-sitter.wasm'
        ),
        destination: path.join(parserRoot, 'web-tree-sitter.wasm'),
        licenseDeclaration: 'MIT',
        licensePath: path.join(extensionRoot, 'node_modules', 'web-tree-sitter', 'LICENSE'),
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
        entryPoints: [path.join(extensionRoot, 'src', 'core', 'hdl', 'parserWorker.ts')],
        outfile: path.join(workerRoot, 'hdlParserWorker.js'),
    },
    {
        ...commonBuildOptions,
        entryPoints: [path.join(extensionRoot, 'src', 'core', 'waveformWorker.ts')],
        outfile: path.join(workerRoot, 'waveformWorker.js'),
    },
];

async function writeThirdPartyNotices(frontendPackages = []) {
    const parserPackages = await Promise.all(parserAssets.map(async asset => ({
        name: asset.name,
        version: asset.version,
        license: asset.licenseDeclaration,
        licenseText: await readFile(asset.licensePath, 'utf8'),
    })));
    await writeFile(
        path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'),
        formatThirdPartyNotices(parserPackages, frontendPackages),
        'utf8'
    );
}

async function prepareParserAssets() {
    await verifyAndCopyParserAssets(parserAssets);
}

async function prepareSchematicAssets() {
    await rm(schematicRoot, { recursive: true, force: true });
    await mkdir(schematicRoot, { recursive: true });
    await Promise.all(['index.html', 'styles.css'].map(fileName => copyFile(
        path.join(schematicSourceRoot, fileName),
        path.join(schematicRoot, fileName)
    )));
}

async function writeSchematicNotices(metafile) {
    if (!metafile) {
        throw new Error('The schematic browser bundle did not produce an esbuild metafile');
    }
    await writeThirdPartyNotices(
        await collectBundledPackageLicenses(metafile, extensionRoot)
    );
}

function schematicBundleOptions(watchMode) {
    const options = {
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: true,
        metafile: true,
        sourcemap: false,
        legalComments: 'none',
        entryPoints: [path.join(schematicSourceRoot, 'index.ts')],
        outfile: path.join(schematicRoot, 'index.js'),
    };
    if (!watchMode) return options;
    return {
        ...options,
        plugins: [{
            name: 'veriflow-schematic-notices',
            setup(build) {
                build.onEnd(async result => {
                    if (result.errors.length === 0) {
                        await writeSchematicNotices(result.metafile);
                    }
                });
            },
        }],
    };
}

async function prepareDist() {
    await rm(distRoot, { recursive: true, force: true });
    await mkdir(workerRoot, { recursive: true });
}

async function runBuild() {
    await prepareParserAssets();
    await prepareDist();
    await prepareSchematicAssets();
    const results = await buildBundles([
        ...nodeBundleOptions,
        schematicBundleOptions(false),
    ]);
    await writeSchematicNotices(results.at(-1)?.metafile);
}

async function runWatchMode() {
    await prepareParserAssets();
    await prepareDist();
    // Watch startup recreates static assets so stale media cannot survive.
    await prepareSchematicAssets();
    await writeThirdPartyNotices();
    process.exitCode = await runWatch({
        bundleOptions: [
            ...nodeBundleOptions,
            schematicBundleOptions(true),
        ],
        cwd: extensionRoot,
        typecheck: {
            command: process.execPath,
            args: [
                path.join(extensionRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
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
