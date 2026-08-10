import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
    assertRepositoryPathsUnchanged,
    createIsolatedRepository,
    snapshotRepositoryPaths,
} from './helpers/isolatedRepository';

function assertHostNeutralSchematicCore(root: string): void {
    const sourceRoot = path.join(root, 'packages', 'schematic-core', 'src');
    const forbidden = /(?:from\s+|import\s*(?:\(\s*)?|require\s*\()\s*['"](?:vscode|electron|@antv\/x6|@veriflow\/schematic-webview)(?:['"/])/;
    const pending = [sourceRoot];
    while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const candidate = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                pending.push(candidate);
            } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                assert.doesNotMatch(
                    fs.readFileSync(candidate, 'utf8'),
                    forbidden,
                    `${path.relative(root, candidate)} imports a host or renderer dependency`
                );
            }
        }
    }
}

function assertStandaloneWebBuildFromCleanCore(root: string): void {
    const npmExecPath = process.env.npm_execpath;
    assert.ok(npmExecPath && path.isAbsolute(npmExecPath));
    const protectedTargets = [
        path.join(root, 'packages', 'hdl-core', 'dist'),
        path.join(root, 'packages', 'schematic-core', 'dist'),
        path.join(root, 'web-dist'),
    ];
    const protectedSnapshots = snapshotRepositoryPaths(protectedTargets);
    let isolated: ReturnType<typeof createIsolatedRepository> | undefined;
    try {
        isolated = createIsolatedRepository(root, 'veriflow-web-build');
        const fixtureRoot = isolated.repositoryRoot;
        const hdlCoreDist = path.join(fixtureRoot, 'packages', 'hdl-core', 'dist');
        const schematicCoreDist = path.join(fixtureRoot, 'packages', 'schematic-core', 'dist');
        const webDist = path.join(fixtureRoot, 'web-dist');
        assert.strictEqual(fs.existsSync(hdlCoreDist), false);
        assert.strictEqual(fs.existsSync(schematicCoreDist), false);
        assert.strictEqual(fs.existsSync(webDist), false);
        const result = spawnSync(process.execPath, [npmExecPath, 'run', 'build:web'], {
            cwd: fixtureRoot,
            encoding: 'utf8',
            timeout: 120_000,
        });
        assert.strictEqual(result.status, 0, [
            'standalone build:web must build HDL and schematic dependencies from a clean state',
            `stdout:\n${String(result.stdout ?? '')}`,
            `stderr:\n${String(result.stderr ?? '')}`,
        ].join('\n'));
        assert.ok(fs.existsSync(path.join(hdlCoreDist, 'index.js')));
        assert.ok(fs.existsSync(path.join(schematicCoreDist, 'index.js')));
        assert.ok(fs.existsSync(path.join(webDist, 'schematic', 'index.js')));
        const rootBundle = fs.readFileSync(path.join(webDist, 'schematic', 'index.js'));
        const extensionCwdResult = spawnSync(process.execPath, [
            path.join(fixtureRoot, 'scripts', 'build-web.mjs'),
        ], {
            cwd: path.join(fixtureRoot, 'veriflow-vscode'),
            encoding: 'utf8',
            timeout: 120_000,
        });
        assert.strictEqual(extensionCwdResult.status, 0, [
            'build-web.mjs must run from the extension working directory',
            `stdout:\n${String(extensionCwdResult.stdout ?? '')}`,
            `stderr:\n${String(extensionCwdResult.stderr ?? '')}`,
        ].join('\n'));
        const extensionCwdBundle = fs.readFileSync(
            path.join(webDist, 'schematic', 'index.js')
        );
        assert.ok(
            rootBundle.equals(extensionCwdBundle),
            'schematic web bundle must not depend on the invoking working directory'
        );
    } finally {
        try {
            isolated?.dispose();
        } finally {
            assertRepositoryPathsUnchanged(protectedSnapshots);
        }
    }
}

async function run(): Promise<void> {
    const root = path.resolve(__dirname, '../../..');
    const config = await import(path.join(root, 'scripts/lib/build-config.mjs'));
    assert.deepStrictEqual(config.browserBuildOptions(), {
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: false,
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8',
    });
    const extensionManifest = JSON.parse(fs.readFileSync(
        path.join(root, 'veriflow-vscode', 'package.json'),
        'utf8'
    )) as { scripts: Record<string, string> };
    assert.strictEqual(
        extensionManifest.scripts['vscode:prepublish'],
        'node ../scripts/build-vscode.mjs'
    );
    assert.strictEqual(
        extensionManifest.scripts.test,
        'npm run vscode:prepublish && node ./scripts/run-tests.mjs'
    );
    const rootManifest = JSON.parse(fs.readFileSync(
        path.join(root, 'package.json'),
        'utf8'
    )) as { scripts: Record<string, string> };
    assert.match(
        rootManifest.scripts['build:shared'],
        /@veriflow\/hdl-core.*@veriflow\/schematic-core/,
        'build:shared must build schematic core after HDL core'
    );
    assert.strictEqual(
        rootManifest.scripts['build:vscode'],
        'node scripts/build-vscode.mjs'
    );
    assert.strictEqual(
        rootManifest.scripts.build,
        'npm run build:parser && npm run build:vscode'
    );
    assertHostNeutralSchematicCore(root);
    assertStandaloneWebBuildFromCleanCore(root);
}

run().then(() => console.log('root build tests passed'));
