import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const sharedPackages = [
    '@veriflow/flow-core',
    '@veriflow/hdl-core',
    '@veriflow/hdl-runtime',
    '@veriflow/waveform-runtime',
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
    const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-shared-consumer-'));
    try {
        const paths: Record<string, string[]> = {};
        for (const packageName of sharedPackages) {
            const packageRoot = packageDirectory(packageName);
            const manifest = JSON.parse(readFileSync(
                path.join(packageRoot, 'package.json'),
                'utf8'
            ));
            assert.equal(manifest.name, packageName);
            assert.equal(manifest.exports['.'].types, './dist/index.d.ts');
            paths[packageName] = [path.join(packageRoot, 'src', 'index.ts')];
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
                module: 'commonjs',
                moduleResolution: 'node',
                noEmit: true,
                baseUrl: '.',
                paths,
            },
            files: ['consumer.ts'],
        }, null, 2));
        const result = spawnSync(process.execPath, [
            require.resolve('typescript/bin/tsc'),
            '-p',
            path.join(consumerRoot, 'tsconfig.json'),
        ], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
        rmSync(consumerRoot, { recursive: true, force: true });
    }
});

test('shared package sources do not depend on product hosts', () => {
    const forbidden = [
        /(?:from\s+|import\s*\(|require\s*\()\s*['"]vscode['"]/,
        /(?:from\s+|import\s*\(|require\s*\()\s*['"]electron['"]/,
        /@veriflow\/(?:cli|waveform-desktop)/,
        /veriflow-vscode/,
        /src[\\/]presentation/,
        /PySide|QtWidgets|\.py['"]/,
    ];
    for (const packageName of sharedPackages) {
        const sourceRoot = path.join(packageDirectory(packageName), 'src');
        for (const file of sourceFiles(sourceRoot)) {
            const contents = readFileSync(file, 'utf8');
            for (const pattern of forbidden) {
                assert.doesNotMatch(
                    contents,
                    pattern,
                    `${path.relative(repositoryRoot, file)} matches ${pattern}`
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
