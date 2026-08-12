import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmInvocation } from './lib/npm-command.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishable = [
    {
        name: '@veriflow/flow-core',
        workspace: 'packages/flow-core',
        requiredFiles: ['dist/index.js'],
    },
    {
        name: '@veriflow/hdl-core',
        workspace: 'packages/hdl-core',
        requiredFiles: ['dist/index.js'],
    },
    {
        name: '@veriflow/schematic-core',
        workspace: 'packages/schematic-core',
        requiredFiles: [
            'dist/index.js',
            'dist/model.js',
            'dist/interfaces/builtins/axi4.json',
            'dist/interfaces/builtins/axis.json',
            'dist/interfaces/builtins/apb.json',
            'dist/interfaces/builtins/ahb-lite.json',
        ],
    },
    {
        name: '@veriflow/hdl-runtime',
        workspace: 'packages/hdl-runtime',
        requiredFiles: ['dist/index.js', 'dist/parserWorker.js'],
    },
    {
        name: '@veriflow/waveform-runtime',
        workspace: 'packages/waveform-runtime',
        requiredFiles: ['dist/index.js', 'dist/waveformWorker.js'],
    },
    {
        name: '@veriflow/waveform-desktop',
        workspace: 'packages/waveform-desktop',
        requiredFiles: [
            'assets/waveform/index.html',
            'assets/waveform/index.js',
            'dist/launcher.js',
            'dist/main.js',
            'dist/preload.js',
            'dist/router.js',
            'scripts/install-electron.cjs',
        ],
    },
    {
        name: '@veriflow/cli',
        workspace: 'packages/cli',
        requiredFiles: ['dist/main.js'],
    },
];

const packScript = readFileSync(path.join(repositoryRoot, 'scripts', 'pack-node-release.mjs'), 'utf8');
const packedWorkspaces = [...packScript.matchAll(/^\s{4}'(@veriflow\/[^']+)',$/gm)]
    .map(match => match[1]);
assert.deepEqual(
    packedWorkspaces,
    publishable.map(entry => entry.name),
    'pack-node-release workspaces must match release smoke packages'
);

function run(command, args, cwd = repositoryRoot, env = process.env) {
    try {
        return execFileSync(command, args, {
            cwd,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stdout = error.stdout?.toString() ?? '';
        const stderr = error.stderr?.toString() ?? '';
        throw new Error(`${command} ${args.join(' ')} failed\n${stdout}${stderr}`);
    }
}

function readJson(filepath) {
    return JSON.parse(readFileSync(filepath, 'utf8'));
}

function runNpm(args, cwd = repositoryRoot, environment = process.env) {
    const invocation = resolveNpmInvocation(args, {
        npmExecutable: environment.npm_execpath,
    });
    return run(invocation.executable, invocation.args, cwd, environment);
}

function invokeCli(args, cwd, environment) {
    const invocation = resolveNpmInvocation(
        ['exec', '--', 'veriflow', ...args],
        { npmExecutable: environment.npm_execpath }
    );
    return spawnSync(invocation.executable, invocation.args, {
        cwd,
        env: environment,
        encoding: 'utf8',
        shell: false,
    });
}

const rootVersion = readJson(path.join(repositoryRoot, 'package.json')).version;
const publishedNames = new Set(publishable.map(entry => entry.name));
for (const entry of publishable) {
    const manifest = readJson(path.join(repositoryRoot, entry.workspace, 'package.json'));
    assert.notEqual(manifest.private, true, `${entry.name} must not be private`);
    assert.equal(manifest.version, rootVersion, `${entry.name} version`);
    assert.equal(manifest.publishConfig?.access, 'public', `${entry.name} public access`);
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (publishedNames.has(dependency)) {
            assert.equal(version, rootVersion, `${entry.name} dependency ${dependency}`);
        }
    }
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-node-release-'));
const packRoot = path.join(temporaryRoot, 'packs');
const installRoot = path.join(temporaryRoot, 'install');
mkdirSync(packRoot, { recursive: true });
mkdirSync(installRoot, { recursive: true });

try {
    runNpm(['run', 'build:cli']);
    const tarballs = [];
    for (const entry of publishable) {
        const before = new Set(readdirSync(packRoot));
        const output = runNpm([
            '--silent',
            'pack',
            '--workspace',
            entry.name,
            '--pack-destination',
            packRoot,
            '--json',
        ]);
        const packed = JSON.parse(output)[0];
        const files = new Set(packed.files.map(file => file.path));
        for (const required of entry.requiredFiles) {
            assert.equal(files.has(required), true, `${entry.name} missing ${required}`);
        }
        const created = readdirSync(packRoot).filter(filename => !before.has(filename));
        assert.equal(created.length, 1, `${entry.name} tarball count`);
        tarballs.push(path.join(packRoot, created[0]));
    }

    writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({
        name: 'veriflow-release-smoke',
        version: '0.0.0',
        private: true,
    }, null, 2));
    const homeDir = path.join(temporaryRoot, 'home');
    mkdirSync(homeDir, { recursive: true });
    const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== 'npm_config_allow_scripts'
    ));
    const environment = {
        ...inheritedEnvironment,
        HOME: homeDir,
        USERPROFILE: homeDir,
        VERIFLOW_SKIP_ELECTRON_DOWNLOAD: '1',
    };
    runNpm([
        'install',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        ...tarballs,
    ], installRoot, environment);

    const installedPackage = realpathSync(path.join(
        installRoot,
        'node_modules',
        '@veriflow',
        'cli'
    ));
    assert.equal(installedPackage.startsWith(realpathSync(installRoot)), true);
    const installedCliManifest = readJson(path.join(installedPackage, 'package.json'));
    assert.equal(
        installedCliManifest.dependencies?.['@veriflow/schematic-core'],
        rootVersion,
        'installed CLI must depend on the published schematic-core version'
    );
    const help = invokeCli(['--help'], installRoot, environment);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /VeriFlow - Lightweight Verilog Simulation Manager/);
    const version = invokeCli(['--version'], installRoot, environment);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `VeriFlow ${rootVersion}\n`);

    const projectRoot = path.join(installRoot, 'smoke-project');
    const rtlRoot = path.join(projectRoot, 'rtl');
    mkdirSync(rtlRoot, { recursive: true });
    writeFileSync(path.join(rtlRoot, 'child.sv'), 'module child; endmodule\n', 'utf8');
    writeFileSync(
        path.join(rtlRoot, 'top.sv'),
        'module top; child child_instance(); endmodule\n',
        'utf8'
    );
    writeFileSync(path.join(projectRoot, 'project.json'), JSON.stringify({
        project_name: 'release-smoke',
        project_root: 'rtl',
        top_module: 'top',
    }, null, 2), 'utf8');
    writeFileSync(path.join(projectRoot, 'soc.ad'), `${JSON.stringify({
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'soc',
        ports: [],
        instances: [{ name: 'u_child', module: 'child' }],
        connections: [],
        interfaceConnections: [],
        defaults: {},
        export: {},
        presentation: {},
    }, null, 2)}\n`, 'utf8');
    const analyze = invokeCli(
        ['analyze', '--project', 'project.json'],
        projectRoot,
        environment
    );
    assert.equal(analyze.status, 0, analyze.stderr);
    assert.match(analyze.stdout, /child\.sv/);
    assert.match(analyze.stdout, /top\.sv/);
    const validateAd = invokeCli(['ad', 'validate', 'soc.ad'], projectRoot, environment);
    assert.equal(validateAd.status, 0, validateAd.stderr);
    const exportAd = invokeCli(['ad', 'export', 'soc.ad'], projectRoot, environment);
    assert.equal(exportAd.status, 0, exportAd.stderr);
    assert.match(
        readFileSync(path.join(projectRoot, 'soc.v'), 'utf8'),
        /^\/\/ vik-veriflow:generated arch-design /
    );
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Node release artifact smoke passed');
