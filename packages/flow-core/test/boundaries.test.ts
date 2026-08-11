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
const archDesignRuntimeExports = [
    'ARCH_DESIGN_FORMAT',
    'ARCH_DESIGN_SCHEMA_VERSION',
    'createEmptyArchDesign',
    'parseArchDesignText',
    'parseArchDesignValue',
    'serializeArchDesign',
    'semanticArchDesignFingerprint',
    'validateArchDesign',
    'isSafeDefaultExpression',
    'projectArchDesignGraph',
    'projectArchDesignPlacement',
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
            if (packageName === '@veriflow/schematic-core') {
                assert.deepEqual(manifest.exports['./arch-design'], {
                    types: './dist/archDesign/index.d.ts',
                    require: './dist/archDesign/index.js',
                    default: './dist/archDesign/index.js',
                });
                assert.deepEqual(manifest.typesVersions['*']['arch-design'], [
                    'dist/archDesign/index.d.ts',
                ]);
                assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
                    '@veriflow/hdl-core',
                ]);
            }
        }
        writeFileSync(path.join(consumerRoot, 'consumer.ts'), [
            ...sharedPackages.map(packageName => `import '${packageName}';`),
            "import {",
            "    ARCH_DESIGN_FORMAT,",
            "    ARCH_DESIGN_SCHEMA_VERSION,",
            "    createEmptyArchDesign,",
            "    isSafeDefaultExpression,",
            "    parseArchDesignText,",
            "    parseArchDesignValue,",
            "    projectArchDesignGraph,",
            "    projectArchDesignPlacement,",
            "    semanticArchDesignFingerprint,",
            "    serializeArchDesign,",
            "    validateArchDesign,",
            "    type ArchDesign,",
            "    type ArchDesignDiagnostic,",
            "    type ArchDesignGraphProjection,",
            "    type ArchDesignModuleDefinition,",
            "    type ArchDesignNodePlacement,",
            "    type ArchDesignPresentation,",
            "    type ArchDesignReadResult,",
            "    type ArchDesignValidationResult,",
            "} from '@veriflow/schematic-core/arch-design';",
            "import * as schematicModel from '@veriflow/schematic-core/model';",
            "export type SchematicGraph = import('@veriflow/schematic-core/model').SchematicGraph;",
            "export type ArchDesignPublicTypes = [",
            "    ArchDesign,",
            "    ArchDesignDiagnostic,",
            "    ArchDesignGraphProjection,",
            "    ArchDesignModuleDefinition,",
            "    ArchDesignNodePlacement,",
            "    ArchDesignPresentation,",
            "    ArchDesignReadResult,",
            "    ArchDesignValidationResult,",
            "];",
            "const design: ArchDesign = createEmptyArchDesign('consumer_top');",
            "const definitions: readonly ArchDesignModuleDefinition[] = [];",
            "const graphProjection: ArchDesignGraphProjection = projectArchDesignGraph(",
            "    design, definitions, { fileUri: 'file:///consumer.ad' }",
            ");",
            "const validation: ArchDesignValidationResult = validateArchDesign(",
            "    design, definitions",
            ");",
            "const presentation: ArchDesignPresentation = design.presentation;",
            "export const archDesignRuntime = {",
            "    format: ARCH_DESIGN_FORMAT,",
            "    schemaVersion: ARCH_DESIGN_SCHEMA_VERSION,",
            "    parsedText: parseArchDesignText(serializeArchDesign(design)),",
            "    parsedValue: parseArchDesignValue(design),",
            "    fingerprint: semanticArchDesignFingerprint(design),",
            "    safeDefault: isSafeDefaultExpression(\"1'b0\"),",
            "    graphProjection,",
            "    placement: projectArchDesignPlacement(design, graphProjection.graph),",
            "    presentation,",
            "    validation,",
            "};",
            'export const schematicModelRuntime = schematicModel;',
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

test('schematic-core root does not load or re-export Arch Design runtime', () => {
    const packageRoot = packageDirectory('@veriflow/schematic-core');
    const archDesignDistRoot = path.join(packageRoot, 'dist', 'archDesign') + path.sep;
    const script = [
        `const root = require(${JSON.stringify(packageRoot)});`,
        `const runtimeExports = ${JSON.stringify(archDesignRuntimeExports)};`,
        "const leakedExports = runtimeExports.filter(name =>",
        "    Object.prototype.hasOwnProperty.call(root, name)",
        ");",
        `const archDesignRoot = ${JSON.stringify(archDesignDistRoot)};`,
        "const loadedModules = Object.keys(require.cache).filter(file =>",
        "    file.startsWith(archDesignRoot)",
        ");",
        "if (leakedExports.length > 0 || loadedModules.length > 0) {",
        "    console.error(JSON.stringify({ leakedExports, loadedModules }));",
        "    process.exitCode = 1;",
        "}",
        '',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
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
        || /(?:^|[/\\])src[/\\]presentation(?:[/\\]|$)/.test(specifier)
        || /(?:PySide|QtWidgets|\.py$)/.test(specifier);
}

function sharedDependencySpecifiers(contents: string): string[] {
    const preprocessed = ts.preProcessFile(contents, true, true);
    return [
        ...preprocessed.importedFiles,
        ...preprocessed.referencedFiles,
        ...preprocessed.typeReferenceDirectives,
        ...preprocessed.libReferenceDirectives,
    ].map(dependency => dependency.fileName);
}

function allowedArchDesignImport(specifier: string): boolean {
    return specifier.startsWith('.')
        || specifier === '@veriflow/hdl-core'
        || specifier.startsWith('@veriflow/hdl-core/');
}

function pathIsInside(directory: string, candidate: string): boolean {
    const relative = path.relative(directory, candidate);
    return relative === ''
        || (!relative.startsWith(`..${path.sep}`)
            && relative !== '..'
            && !path.isAbsolute(relative));
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
    assert.equal(forbiddenSharedImport('./presentation'), false);
    assert.equal(forbiddenSharedImport('node:path'), false);
    assert.equal(forbiddenSharedImport('@veriflow/hdl-core'), false);
});

test('shared dependency discovery includes TypeScript reference directives', () => {
    const contents = [
        '/// <reference types="veriflow" />',
        '/// <reference path="veriflow-vscode/src/config.d.ts" />',
        '/// <reference lib="dom" />',
        '',
    ].join('\n');
    assert.deepEqual(sharedDependencySpecifiers(contents).sort(), [
        'dom',
        'veriflow',
        'veriflow-vscode/src/config.d.ts',
    ]);
});

test('Arch Design import policy allows only local source and hdl-core', () => {
    for (const specifier of [
        'vscode',
        'electron/main',
        '@antv/x6',
        'dom',
        'node:fs',
        'fs/promises',
        'node:process',
        'process',
        '@veriflow/hdl-runtime',
        '@veriflow/cli/internal',
        '@veriflow/schematic-webview',
        'veriflow-vscode/src/config',
    ]) {
        assert.equal(allowedArchDesignImport(specifier), false, specifier);
    }
    assert.equal(allowedArchDesignImport('./model'), true);
    assert.equal(allowedArchDesignImport('../model'), true);
    assert.equal(allowedArchDesignImport('@veriflow/hdl-core/model'), true);
});

test('Arch Design sources remain host-neutral and depend only on hdl-core', () => {
    const schematicSourceRoot = path.join(
        packageDirectory('@veriflow/schematic-core'),
        'src'
    );
    const archDesignSourceRoot = path.join(schematicSourceRoot, 'archDesign');
    for (const file of sourceFiles(archDesignSourceRoot)) {
        const contents = readFileSync(file, 'utf8');
        for (const imported of sharedDependencySpecifiers(contents)) {
            const context = `${path.relative(repositoryRoot, file)} imports ${imported}`;
            assert.equal(
                allowedArchDesignImport(imported),
                true,
                context
            );
            if (!imported.startsWith('.')) continue;
            assert.equal(
                pathIsInside(
                    schematicSourceRoot,
                    path.resolve(path.dirname(file), imported)
                ),
                true,
                context
            );
        }
    }
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
