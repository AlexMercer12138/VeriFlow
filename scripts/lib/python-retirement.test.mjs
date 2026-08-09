import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);

const ignoredDirectories = new Set([
    '.git',
    '.worktrees',
    'build',
    'dist',
    'node_modules',
]);

function walkFiles(directory, relativeDirectory = '') {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relativePath = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            if (!ignoredDirectories.has(entry.name)) {
                files.push(...walkFiles(path.join(directory, entry.name), relativePath));
            }
            continue;
        }
        if (entry.isFile()) {
            files.push(relativePath);
        }
    }
    return files;
}

test('repository contains no Python implementation or packaging files', () => {
    const forbiddenNames = new Set([
        'ParserProbe.spec',
        'VeriFlow-cli.spec',
        'VeriFlow.spec',
        'pyproject.toml',
        'requirements.txt',
        'run_cli.py',
        'run_gui.py',
    ]);
    const offenders = walkFiles(repositoryRoot)
        .filter(relativePath => (
            relativePath.endsWith('.py')
            || relativePath.endsWith('.spec')
            || forbiddenNames.has(relativePath)
            || relativePath.startsWith('python-packages/')
        ))
        .sort();

    assert.deepEqual(
        offenders,
        [],
        `remove Python implementation and packaging files:\n${offenders.join('\n')}`
    );
});

test('active automation contains no Python product or build paths', () => {
    const activeFiles = [
        'package.json',
        'veriflow-vscode/package.json',
        ...readdirSync(path.join(repositoryRoot, '.github', 'workflows'))
            .filter(filename => filename.endsWith('.yml') || filename.endsWith('.yaml'))
            .map(filename => path.posix.join('.github/workflows', filename)),
    ];
    const forbidden = /(?:^|[\s"'/:])python(?:3)?(?:\s|:|$)|setup-python|pytest|pyinstaller|worker[-_ ]?wheel|python-deprecation|VeriFlow(?:-cli)?\.exe|run_release\.py/i;
    const offenders = [];

    for (const relativePath of activeFiles) {
        const lines = readFileSync(path.join(repositoryRoot, relativePath), 'utf8').split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
            if (forbidden.test(line)) {
                offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
            }
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `remove Python references from active automation:\n${offenders.join('\n')}`
    );
});

test('release automation uses the Node entry point', () => {
    assert.equal(
        existsSync(path.join(repositoryRoot, 'scripts', 'run-release.mjs')),
        true,
        'scripts/run-release.mjs must exist'
    );
    assert.equal(
        existsSync(path.join(repositoryRoot, 'scripts', 'run_release.py')),
        false,
        'scripts/run_release.py must be removed'
    );
});
