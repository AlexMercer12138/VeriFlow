import { createHash } from 'node:crypto';
import {
    copyFile,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(extensionRoot, 'dist');
const workerRoot = path.join(distRoot, 'workers');
const parserRoot = path.join(extensionRoot, 'media', 'parsers');

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
        license: path.join(extensionRoot, 'node_modules', 'tree-sitter-systemverilog', 'LICENSE'),
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
        license: path.join(extensionRoot, 'node_modules', 'web-tree-sitter', 'LICENSE'),
        sha256: '715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc',
    },
];

await rm(distRoot, { recursive: true, force: true });
await mkdir(workerRoot, { recursive: true });
await mkdir(parserRoot, { recursive: true });

const commonBuildOptions = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: true,
};

await Promise.all([
    build({
        ...commonBuildOptions,
        entryPoints: [path.join(extensionRoot, 'src', 'extension.ts')],
        outfile: path.join(distRoot, 'extension.js'),
        external: ['vscode'],
    }),
    build({
        ...commonBuildOptions,
        entryPoints: [path.join(extensionRoot, 'src', 'core', 'hdl', 'parserWorker.ts')],
        outfile: path.join(workerRoot, 'hdlParserWorker.js'),
    }),
    build({
        ...commonBuildOptions,
        entryPoints: [path.join(extensionRoot, 'src', 'core', 'waveformWorker.ts')],
        outfile: path.join(workerRoot, 'waveformWorker.js'),
    }),
]);

for (const asset of parserAssets) {
    await copyFile(asset.source, asset.destination);
    const digest = createHash('sha256')
        .update(await readFile(asset.destination))
        .digest('hex');
    if (digest !== asset.sha256) {
        throw new Error(
            `${asset.name} WASM SHA256 mismatch: expected ${asset.sha256}, received ${digest}`
        );
    }
}

const notices = await Promise.all(parserAssets.map(async asset => {
    const license = await readFile(asset.license, 'utf8');
    return `## ${asset.name} ${asset.version}\n\n${license.trim()}\n`;
}));

await writeFile(
    path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'),
    `# Third-Party Notices\n\n${notices.join('\n')}`,
    'utf8'
);
