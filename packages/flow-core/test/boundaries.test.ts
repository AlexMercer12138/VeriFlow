import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const sharedPackages = [
    '@veriflow/flow-core',
    '@veriflow/hdl-core',
    '@veriflow/schematic-core',
    '@veriflow/hdl-runtime',
    '@veriflow/waveform-runtime',
] as const;
const vscodeProductName = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'veriflow-vscode', 'package.json'),
    'utf8'
)).name as string;
const productPackageNames = [
    vscodeProductName,
    '@veriflow/cli',
    '@veriflow/waveform-desktop',
] as const;

function packageDirectory(packageName: string): string {
    return path.join(repositoryRoot, 'packages', packageName.slice('@veriflow/'.length));
}

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    });
}

test('shared package public imports compile for a host consumer', () => {
    const artifactRoot = path.join(repositoryRoot, '.artifacts');
    mkdirSync(artifactRoot, { recursive: true });
    const consumerRoot = mkdtempSync(path.join(artifactRoot, 'shared-consumer-'));
    try {
        for (const packageName of sharedPackages) {
            const packageRoot = packageDirectory(packageName);
            const manifest = JSON.parse(readFileSync(
                path.join(packageRoot, 'package.json'),
                'utf8'
            ));
            assert.equal(manifest.name, packageName);
            assert.equal(manifest.exports['.'].types, './dist/index.d.ts');
        }
        writeFileSync(path.join(consumerRoot, 'consumer.ts'), [
            ...sharedPackages.map(packageName => `import '${packageName}';`),
            'export {};',
            '',
        ].join('\n'));
        writeFileSync(path.join(consumerRoot, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                strict: true,
                target: 'ES2020',
                module: 'Node16',
                moduleResolution: 'Node16',
                outDir: 'dist',
            },
            files: ['consumer.ts'],
        }, null, 2));
        const result = spawnSync(process.execPath, [
            require.resolve('typescript/bin/tsc'),
            '-p',
            path.join(consumerRoot, 'tsconfig.json'),
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const runtime = spawnSync(process.execPath, [
            path.join(consumerRoot, 'dist', 'consumer.js'),
        ], { encoding: 'utf8' });
        assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
    } finally {
        rmSync(consumerRoot, { recursive: true, force: true });
    }
});

function forbiddenSharedImport(specifier: string): boolean {
    return specifier === 'vscode'
        || specifier.startsWith('vscode/')
        || specifier === 'electron'
        || specifier.startsWith('electron/')
        || productPackageNames.some(packageName =>
            specifier === packageName || specifier.startsWith(`${packageName}/`)
        )
        || specifier.includes('veriflow-vscode')
        || /(?:^|[/\\])(?:src[/\\])?presentation(?:[/\\]|$)/.test(specifier)
        || /(?:PySide|QtWidgets|\.py$)/.test(specifier);
}

function sharedDependencySpecifiers(contents: string): string[] {
    const preprocessed = ts.preProcessFile(contents, true, true);
    return [
        ...preprocessed.importedFiles,
        ...preprocessed.referencedFiles,
        ...preprocessed.typeReferenceDirectives,
    ].map(dependency => dependency.fileName);
}

test('shared import policy recognizes host and product subpaths', () => {
    for (const specifier of [
        'vscode/languages',
        'electron/main',
        '@veriflow/cli/internal',
        '@veriflow/waveform-desktop/preload',
        'veriflow',
        'veriflow/internal',
        'veriflow-vscode/src/config',
        '../../../src/presentation/cli.py',
        'PySide6',
    ]) {
        assert.equal(forbiddenSharedImport(specifier), true, specifier);
    }
    assert.equal(forbiddenSharedImport('node:path'), false);
    assert.equal(forbiddenSharedImport('@veriflow/hdl-core'), false);
});

test('shared dependency discovery includes TypeScript reference directives', () => {
    const contents = [
        '/// <reference types="veriflow" />',
        '/// <reference path="veriflow-vscode/src/config.d.ts" />',
        '',
    ].join('\n');
    assert.deepEqual(sharedDependencySpecifiers(contents).sort(), [
        'veriflow',
        'veriflow-vscode/src/config.d.ts',
    ]);
});

test('shared package sources do not depend on product hosts', () => {
    for (const packageName of sharedPackages) {
        const sourceRoot = path.join(packageDirectory(packageName), 'src');
        for (const file of sourceFiles(sourceRoot)) {
            const contents = readFileSync(file, 'utf8');
            for (const imported of sharedDependencySpecifiers(contents)) {
                assert.equal(
                    forbiddenSharedImport(imported),
                    false,
                    `${path.relative(repositoryRoot, file)} imports ${imported}`
                );
            }
        }
    }
});

test('shared package build outputs stay outside source control', () => {
    const outputs = [
        'packages/flow-core/dist/index.js',
        'packages/flow-core/dist-test/test/boundaries.test.js',
    ];
    const result = spawnSync('git', ['check-ignore', ...outputs], {
        cwd: repositoryRoot,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), outputs.sort());
});
