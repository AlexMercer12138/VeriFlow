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

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
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

function installedCli(installRoot) {
    return path.join(
        installRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'veriflow.cmd' : 'veriflow'
    );
}

function invokeCli(executable, args, cwd, environment) {
    return spawnSync(executable, args, {
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
    run(npmCommand, ['run', 'build:cli']);
    const tarballs = [];
    for (const entry of publishable) {
        const before = new Set(readdirSync(packRoot));
        const output = run(npmCommand, [
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
    run(npmCommand, [
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
    const executable = installedCli(installRoot);
    const help = invokeCli(executable, ['--help'], installRoot, environment);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /VeriFlow - Lightweight Verilog Simulation Manager/);
    const version = invokeCli(executable, ['--version'], installRoot, environment);
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
    const analyze = invokeCli(
        executable,
        ['analyze', '--project', 'project.json'],
        projectRoot,
        environment
    );
    assert.equal(analyze.status, 0, analyze.stderr);
    assert.match(analyze.stdout, /child\.sv/);
    assert.match(analyze.stdout, /top\.sv/);
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Node release artifact smoke passed');
