import { execFileSync } from 'node:child_process';
import { copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { nodeCjsBuildOptions } from './lib/build-config.mjs';
import { recreate, sha256, writeJson } from './lib/files.mjs';

const expectedNodeVersion = 'v24.14.1';
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, '.artifacts', 'parser-worker');
const packageRoot = path.join(root, 'packages', 'parser-worker');
const nodeModulesRoot = path.join(root, 'node_modules');

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}

async function packageVersion(packageName, expectedVersion) {
    const metadata = await readJson(path.join(nodeModulesRoot, packageName, 'package.json'));
    if (metadata.version !== expectedVersion) {
        throw new Error(
            `${packageName} version mismatch: expected ${expectedVersion}, received ${metadata.version}`
        );
    }
    return metadata.version;
}

async function wasmMetadata(file) {
    const details = await stat(file);
    return {
        file: path.basename(file),
        size: details.size,
        sha256: await sha256(file),
    };
}

export async function buildParserProbe() {
    if (process.version !== expectedNodeVersion) {
        throw new Error(
            `Parser SEA requires Node ${expectedNodeVersion}; running ${process.version}`
        );
    }

    const workspaceMetadata = await readJson(path.join(root, 'package.json'));
    const parserMetadata = await readJson(path.join(packageRoot, 'package.json'));
    if (workspaceMetadata.engines?.node !== `>=${expectedNodeVersion.slice(1)}`) {
        throw new Error(`Workspace Node minimum must be ${expectedNodeVersion.slice(1)}`);
    }
    if (parserMetadata.version !== workspaceMetadata.version) {
        throw new Error(
            `Parser worker version ${parserMetadata.version} does not match workspace ${workspaceMetadata.version}`
        );
    }

    const pinnedPackages = workspaceMetadata.devDependencies;
    const packageVersions = {
        parserWorker: parserMetadata.version,
        esbuild: await packageVersion('esbuild', pinnedPackages.esbuild),
        postject: await packageVersion('postject', pinnedPackages.postject),
        treeSitterSystemVerilog: await packageVersion(
            'tree-sitter-systemverilog',
            pinnedPackages['tree-sitter-systemverilog']
        ),
        webTreeSitter: await packageVersion('web-tree-sitter', pinnedPackages['web-tree-sitter']),
    };

    await recreate(artifactRoot);

    const bundle = path.join(artifactRoot, 'probe.cjs');
    await build({
        ...nodeCjsBuildOptions(),
        entryPoints: [path.join(packageRoot, 'src', 'probe.ts')],
        outfile: bundle,
    });

    const runtimeWasm = path.join(artifactRoot, 'web-tree-sitter.wasm');
    const languageWasm = path.join(artifactRoot, 'tree-sitter-systemverilog.wasm');
    await copyFile(
        path.join(nodeModulesRoot, 'web-tree-sitter', 'web-tree-sitter.wasm'),
        runtimeWasm
    );
    await copyFile(
        path.join(nodeModulesRoot, 'tree-sitter-systemverilog', 'tree-sitter-systemverilog.wasm'),
        languageWasm
    );

    execFileSync(process.execPath, [
        '--experimental-sea-config',
        path.join(packageRoot, 'sea-config.json'),
    ], {
        cwd: root,
        stdio: 'inherit',
    });

    const executable = path.join(artifactRoot, 'parser-worker.exe');
    await copyFile(process.execPath, executable);
    execFileSync(process.execPath, [
        path.join(nodeModulesRoot, 'postject', 'dist', 'cli.js'),
        executable,
        'NODE_SEA_BLOB',
        path.join(artifactRoot, 'sea-prep.blob'),
        '--sentinel-fuse',
        seaFuse,
    ], {
        cwd: root,
        stdio: 'inherit',
    });

    await writeJson(path.join(artifactRoot, 'manifest.json'), {
        protocolVersion: 1,
        nodeVersion: process.version,
        packages: packageVersions,
        wasm: {
            webTreeSitter: await wasmMetadata(runtimeWasm),
            systemVerilog: await wasmMetadata(languageWasm),
        },
    });
}

await buildParserProbe();
