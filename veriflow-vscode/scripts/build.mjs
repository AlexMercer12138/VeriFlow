import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildBundles,
    collectBundledPackageLicenses,
    collectRuntimePackage,
    copyRuntimePackage,
    formatThirdPartyNotices,
    runWatch,
    verifyAndCopyParserAssets,
} from './build-support.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(extensionRoot, 'dist');
const workerRoot = path.join(distRoot, 'workers');
const vendorRoot = path.join(distRoot, 'vendor', 'iverilog-wasm');
const parserRoot = path.join(extensionRoot, 'media', 'parsers');
const workspaceRequire = createRequire(import.meta.url);
const grammarPackageRoot = path.dirname(workspaceRequire.resolve(
    'tree-sitter-systemverilog/tree-sitter-systemverilog.wasm'
));
const webTreeSitterPackageRoot = path.dirname(workspaceRequire.resolve(
    'web-tree-sitter/web-tree-sitter.wasm'
));
const iverilogEntryUrl = import.meta.resolve('@veriflow/iverilog-wasm');
const iverilogEntryPath = fileURLToPath(iverilogEntryUrl);
const iverilogPackageRoot = path.resolve(path.dirname(iverilogEntryPath), '..');
const schematicSourceRoot = path.join(
    extensionRoot,
    '..',
    'packages',
    'schematic-webview',
    'src'
);

const iverilogExpectations = {
    name: '@veriflow/iverilog-wasm',
    version: '0.1.2',
    license: 'GPL-2.0-or-later',
    nodeEngine: '>=18.15.0',
    entry: 'dist/index.js',
    declaredFiles: ['dist', 'README.md', 'LICENSE'],
    requiredFiles: [
        'package.json',
        'LICENSE',
        'README.md',
        'dist/SOURCE.md',
        'dist/index.js',
        'dist/worker.js',
        'dist/runtime/ivl.mjs',
        'dist/runtime/ivl.wasm',
        'dist/runtime/ivlpp.mjs',
        'dist/runtime/ivlpp.wasm',
        'dist/runtime/vvp.mjs',
        'dist/runtime/vvp.wasm',
    ],
    nonemptyFiles: [
        'LICENSE',
        'dist/SOURCE.md',
        'dist/index.js',
        'dist/worker.js',
        'dist/runtime/ivl.mjs',
        'dist/runtime/ivl.wasm',
        'dist/runtime/ivlpp.mjs',
        'dist/runtime/ivlpp.wasm',
        'dist/runtime/vvp.mjs',
        'dist/runtime/vvp.wasm',
    ],
    provenanceFile: 'dist/SOURCE.md',
};

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

async function prepareRuntimePackage() {
    if (path.resolve(iverilogEntryPath) !== path.join(
        iverilogPackageRoot,
        iverilogExpectations.entry
    )) {
        throw new Error(
            `@veriflow/iverilog-wasm resolved to unexpected entry: ${iverilogEntryPath}`
        );
    }
    const runtimePackage = await collectRuntimePackage(
        iverilogPackageRoot,
        iverilogExpectations
    );
    await copyRuntimePackage(runtimePackage, vendorRoot);
    return runtimePackage;
}

async function collectSchematicPackageNotices() {
    const [result] = await buildBundles([{
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: false,
        metafile: true,
        sourcemap: false,
        legalComments: 'none',
        absWorkingDir: path.resolve(extensionRoot, '..'),
        entryPoints: [path.join(schematicSourceRoot, 'index.ts')],
        write: false,
        logLevel: 'silent',
    }]);
    if (!result.metafile) {
        throw new Error('The schematic browser bundle did not produce an esbuild metafile');
    }
    return collectBundledPackageLicenses(
        result.metafile,
        path.resolve(extensionRoot, '..')
    );
}

async function writeThirdPartyNotices(runtimePackage) {
    const parserPackages = await Promise.all(parserAssets.map(async asset => ({
        name: asset.name,
        version: asset.version,
        license: asset.licenseDeclaration,
        licenseText: await readFile(asset.licensePath, 'utf8'),
    })));
    const frontendPackages = await collectSchematicPackageNotices();
    await writeFile(
        path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'),
        formatThirdPartyNotices(
            [...parserPackages, runtimePackage.notice],
            frontendPackages
        ),
        'utf8'
    );
}

async function prepareDist() {
    await rm(distRoot, { recursive: true, force: true });
    await mkdir(workerRoot, { recursive: true });
}

async function runBuild() {
    await prepareParserAssets();
    await prepareDist();
    const runtimePackage = await prepareRuntimePackage();
    await buildBundles(nodeBundleOptions);
    await writeThirdPartyNotices(runtimePackage);
}

async function runWatchMode() {
    await prepareParserAssets();
    await prepareDist();
    const runtimePackage = await prepareRuntimePackage();
    await writeThirdPartyNotices(runtimePackage);
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
