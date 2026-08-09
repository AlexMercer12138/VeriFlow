import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    ReleaseError,
    ensureChangelogHasVersion,
    ensureVersionsMatch,
    nextPatchVersion,
    parseArguments,
    parseVersion,
    resolveReleaseNpmInvocation,
    runRelease,
    updateVersionFiles,
} from './release.mjs';

function writeJson(filepath, value) {
    mkdirSync(path.dirname(filepath), { recursive: true });
    writeFileSync(filepath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filepath) {
    return JSON.parse(readFileSync(filepath, 'utf8'));
}

function createRepository() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-release-test-'));
    writeJson(path.join(root, 'package.json'), {
        name: 'fixture',
        version: '1.4.0',
        dependencies: { '@veriflow/flow-core': '1.4.0', external: '^2.0.0' },
    });
    writeJson(path.join(root, 'packages/flow-core/package.json'), {
        name: '@veriflow/flow-core',
        version: '1.4.0',
    });
    writeJson(path.join(root, 'packages/cli/package.json'), {
        name: '@veriflow/cli',
        version: '1.4.0',
        dependencies: { '@veriflow/flow-core': '1.4.0' },
        devDependencies: { '@veriflow/test-helper': '1.4.0' },
    });
    writeJson(path.join(root, 'veriflow-vscode/package.json'), {
        name: 'veriflow',
        version: '1.4.0',
        dependencies: { '@veriflow/flow-core': '1.4.0' },
    });
    mkdirSync(path.join(root, 'veriflow-vscode'), { recursive: true });
    writeFileSync(
        path.join(root, 'veriflow-vscode/CHANGELOG.md'),
        '# Changelog\n\n## [1.4.0] - 2026-08-09\n',
        'utf8'
    );
    writeJson(path.join(root, 'tests/cli_contract/cases.json'), {
        cases: [
            { id: 'version', expected: { stdout: 'VeriFlow 1.4.0\n', stderr: '', exit_code: 0 } },
            { id: 'version_short', expected: { stdout: 'VeriFlow 1.4.0\n', stderr: '', exit_code: 0 } },
            { id: 'root_help', expected: { stdout: 'unchanged\n', stderr: '', exit_code: 0 } },
        ],
    });
    return root;
}

test('semantic versions are strict and patch increments are deterministic', () => {
    assert.deepEqual(parseVersion('12.3.9'), [12, 3, 9]);
    assert.equal(nextPatchVersion('12.3.9'), '12.3.10');
    for (const invalid of ['1.2', 'v1.2.3', '1.2.3-beta', '1.02.3', ' 1.2.3 ']) {
        assert.throws(() => parseVersion(invalid), ReleaseError);
    }
});

test('version and changelog checks cover every workspace manifest', () => {
    const root = createRepository();
    try {
        assert.equal(ensureVersionsMatch(root), '1.4.0');
        ensureChangelogHasVersion(root, '1.4.0');

        const cliPath = path.join(root, 'packages/cli/package.json');
        const cli = readJson(cliPath);
        cli.version = '1.4.1';
        writeJson(cliPath, cli);
        assert.throws(() => ensureVersionsMatch(root), /version mismatch/);
        assert.throws(() => ensureChangelogHasVersion(root, '1.4.1'), /missing changelog heading/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('version update synchronizes manifests, internal dependencies, and CLI contract', () => {
    const root = createRepository();
    try {
        assert.deepEqual(updateVersionFiles(root, '2.0.0'), {
            currentVersion: '1.4.0',
            newVersion: '2.0.0',
        });

        for (const relativePath of [
            'package.json',
            'packages/flow-core/package.json',
            'packages/cli/package.json',
            'veriflow-vscode/package.json',
        ]) {
            assert.equal(readJson(path.join(root, relativePath)).version, '2.0.0');
        }
        const rootPackage = readJson(path.join(root, 'package.json'));
        assert.equal(rootPackage.dependencies['@veriflow/flow-core'], '2.0.0');
        assert.equal(rootPackage.dependencies.external, '^2.0.0');
        const cli = readJson(path.join(root, 'packages/cli/package.json'));
        assert.equal(cli.dependencies['@veriflow/flow-core'], '2.0.0');
        assert.equal(cli.devDependencies['@veriflow/test-helper'], '2.0.0');

        const contract = readJson(path.join(root, 'tests/cli_contract/cases.json'));
        assert.equal(contract.cases[0].expected.stdout, 'VeriFlow 2.0.0\n');
        assert.equal(contract.cases[1].expected.stdout, 'VeriFlow 2.0.0\n');
        assert.equal(contract.cases[2].expected.stdout, 'unchanged\n');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('version update validates the complete contract before writing manifests', () => {
    const root = createRepository();
    try {
        const contractPath = path.join(root, 'tests/cli_contract/cases.json');
        const contract = readJson(contractPath);
        contract.cases[1].expected.stdout = 'unexpected\n';
        writeJson(contractPath, contract);

        assert.throws(() => updateVersionFiles(root, '1.4.1'), /version_short/);
        assert.equal(readJson(path.join(root, 'package.json')).version, '1.4.0');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('release arguments preserve long and short action forms', () => {
    assert.deepEqual(parseArguments(['--check', '-p']), {
        actions: ['check', 'package'],
        targetVersion: undefined,
        showHelp: false,
    });
    assert.deepEqual(parseArguments(['-u', '2.1.0']), {
        actions: ['update'],
        targetVersion: '2.1.0',
        showHelp: false,
    });
    assert.deepEqual(parseArguments(['--update']), {
        actions: ['update'],
        targetVersion: undefined,
        showHelp: false,
    });
    assert.deepEqual(parseArguments(['--all=3.0.0']), {
        actions: ['update', 'check', 'package'],
        targetVersion: '3.0.0',
        showHelp: false,
    });
    assert.deepEqual(parseArguments(['--help']), {
        actions: [],
        targetVersion: undefined,
        showHelp: true,
    });
    assert.throws(() => parseArguments(['--unknown']), /unknown argument/);
});

test('direct Windows release commands resolve npm through node.exe', () => {
    const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    assert.deepEqual(resolveReleaseNpmInvocation(['run', 'build'], {
        nodeExecutable,
        npmExecutable: '',
        platform: 'win32',
        fileExists: candidate => candidate === npmCli,
    }), {
        executable: nodeExecutable,
        args: [npmCli, 'run', 'build'],
    });
});

test('release check executes only the Node product gates', () => {
    const root = createRepository();
    const commands = [];
    try {
        const status = runRelease(['--check'], {
            root,
            log: () => {},
            runCommand(command, args, cwd) {
                commands.push({ command, args, cwd });
            },
        });
        assert.equal(status, 0);
        assert.deepEqual(commands.map(({ command, args }) => [command, ...args]), [
            ['npm', 'run', 'typecheck:shared'],
            ['npm', 'run', 'test:shared'],
            ['npm', 'test', '--workspace', '@veriflow/cli'],
            ['npm', 'test', '--workspace', '@veriflow/waveform-desktop'],
            ['npm', 'test', '--workspace', 'veriflow-vscode'],
            ['npm', 'run', 'test:release'],
            ['npm', 'run', 'verify:generated'],
            ['git', '--no-pager', 'diff', '--check'],
            ['git', '--no-pager', 'status', '--short', '--branch'],
        ]);
        assert.equal(commands.every(command => command.cwd === root), true);
        assert.doesNotMatch(JSON.stringify(commands), /python|pytest|pyinstaller/i);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('release update and package actions preserve ordering', () => {
    const root = createRepository();
    const commands = [];
    try {
        const status = runRelease(['--update', '1.4.1', '--package'], {
            root,
            log: () => {},
            runCommand(command, args) {
                commands.push([command, ...args]);
            },
        });
        assert.equal(status, 0);
        assert.equal(readJson(path.join(root, 'package.json')).version, '1.4.1');
        assert.deepEqual(commands, [
            ['npm', 'install', '--package-lock-only', '--ignore-scripts'],
            ['npm', 'run', 'pack:node'],
            ['npm', 'run', 'package', '--workspace', 'veriflow-vscode'],
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
