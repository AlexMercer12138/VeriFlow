import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createIverilogSourceArchive,
    parseIverilogSource,
    readIverilogSource,
} from './iverilog-source.mjs';

const PACKAGE_NAME = '@veriflow/iverilog-wasm';
const PACKAGE_VERSION = '0.1.2';
const REVISION = '19fe69b3ca34f597aaf4c188f4d75a2d6ee6e3d1';
const REPOSITORY = 'https://github.com/AlexMercer12138/iverilog';
const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
);

function sourceText({ repository = REPOSITORY, revision = REVISION } = {}) {
    return [
        '# Corresponding Source',
        '',
        `- Repository: ${repository}`,
        `- Git revision: \`${revision}\``,
        '',
    ].join('\n');
}

function createPackageFixture(options = {}) {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'iverilog-source-test-'));
    const packageRoot = path.join(fixtureRoot, 'package');
    mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
        name: options.name ?? PACKAGE_NAME,
        version: options.version ?? PACKAGE_VERSION,
        repository: options.manifestRepository ?? {
            type: 'git',
            url: 'git+https://github.com/AlexMercer12138/iverilog.git',
            directory: 'wasm/package',
        },
    }, null, 2)}\n`);
    writeFileSync(
        path.join(packageRoot, 'dist', 'SOURCE.md'),
        options.source ?? sourceText(),
    );
    return { fixtureRoot, packageRoot };
}

test('parses an HTTPS repository and exact lowercase revision', () => {
    assert.deepEqual(parseIverilogSource(sourceText()), {
        repository: REPOSITORY,
        revision: REVISION,
    });
});

test('rejects missing or malformed repository metadata', () => {
    for (const source of [
        sourceText().replace(/^- Repository:.*\n/m, ''),
        sourceText({ repository: 'http://github.com/example/iverilog' }),
        sourceText({ repository: 'https://example.com/placeholder/iverilog' }),
        `${sourceText()}- Repository: https://github.com/other/iverilog\n`,
    ]) {
        assert.throws(() => parseIverilogSource(source), /repository/i);
    }
});

test('rejects missing, malformed, uppercase, or placeholder revisions', () => {
    for (const source of [
        sourceText().replace(/^- Git revision:.*\n/m, ''),
        sourceText({ revision: '1234' }),
        sourceText({ revision: REVISION.toUpperCase() }),
        sourceText({ revision: '0000000000000000000000000000000000000000' }),
        sourceText({ revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
        sourceText({ revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
        sourceText({ revision: 'todo' }),
        `${sourceText()}- Git revision: \`1111111111111111111111111111111111111111\`\n`,
    ]) {
        assert.throws(() => parseIverilogSource(source), /revision/i);
    }
});

test('reads package provenance and validates package identity', () => {
    const { packageRoot } = createPackageFixture();
    assert.deepEqual(readIverilogSource({
        packageRoot,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
    }), {
        packageRoot,
        packageName: PACKAGE_NAME,
        packageVersion: PACKAGE_VERSION,
        repository: REPOSITORY,
        revision: REVISION,
        sourceFile: path.join(packageRoot, 'dist', 'SOURCE.md'),
    });
});

test('rejects package name, version, and repository mismatches', () => {
    const fixtures = [
        createPackageFixture({ name: '@example/not-iverilog' }),
        createPackageFixture({ version: '0.1.1' }),
        createPackageFixture({
            manifestRepository: 'https://github.com/other/iverilog.git',
        }),
    ];
    for (const { packageRoot } of fixtures) {
        assert.throws(() => readIverilogSource({
            packageRoot,
            expectedName: PACKAGE_NAME,
            expectedVersion: PACKAGE_VERSION,
        }), /(name|version|repository)/i);
    }
});

test('rejects symlinked package roots and provenance files', () => {
    const rootFixture = createPackageFixture();
    const rootLink = path.join(rootFixture.fixtureRoot, 'package-link');
    symlinkSync(rootFixture.packageRoot, rootLink, 'dir');
    assert.throws(() => readIverilogSource({
        packageRoot: rootLink,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
    }), /symbolic link/i);

    const sourceFixture = createPackageFixture();
    const sourceFile = path.join(sourceFixture.packageRoot, 'dist', 'SOURCE.md');
    const externalSource = path.join(sourceFixture.fixtureRoot, 'SOURCE.md');
    writeFileSync(externalSource, sourceText());
    writeFileSync(sourceFile, sourceText());
    const linkedFixture = createPackageFixture();
    const linkedSource = path.join(linkedFixture.packageRoot, 'dist', 'SOURCE.md');
    const linkedTarget = path.join(linkedFixture.fixtureRoot, 'external-source.md');
    writeFileSync(linkedTarget, sourceText());
    // Replace only through a fresh fixture path to keep the fixture helper simple.
    const sourceLinkRoot = path.join(linkedFixture.fixtureRoot, 'linked-package');
    mkdirSync(path.join(sourceLinkRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(sourceLinkRoot, 'package.json'), `${JSON.stringify({
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        repository: 'https://github.com/AlexMercer12138/iverilog.git',
    })}\n`);
    symlinkSync(linkedTarget, path.join(sourceLinkRoot, 'dist', 'SOURCE.md'));
    assert.throws(() => readIverilogSource({
        packageRoot: sourceLinkRoot,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
    }), /symbolic link/i);
    assert.ok(sourceFile);
    assert.ok(linkedSource);
});

test('rejects a symlinked provenance directory', () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'iverilog-source-link-test-'));
    const packageRoot = path.join(fixtureRoot, 'package');
    const externalDist = path.join(fixtureRoot, 'external-dist');
    mkdirSync(packageRoot);
    mkdirSync(externalDist);
    writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        repository: `${REPOSITORY}.git`,
    })}\n`);
    writeFileSync(path.join(externalDist, 'SOURCE.md'), sourceText());
    symlinkSync(externalDist, path.join(packageRoot, 'dist'), 'dir');

    assert.throws(() => readIverilogSource({
        packageRoot,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
    }), /symbolic link/i);
});

test('rejects non-normalized package-root traversal', () => {
    const { fixtureRoot, packageRoot } = createPackageFixture();
    assert.throws(() => readIverilogSource({
        packageRoot: `${fixtureRoot}/missing/../${path.basename(packageRoot)}`,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
    }), /traversal/i);
});

function git(args, cwd, environment = process.env) {
    return execFileSync('git', args, {
        cwd,
        env: environment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function initializeRepository(repository) {
    mkdirSync(repository, { recursive: true });
    git(['init', '--initial-branch=main'], repository);
    git(['config', 'user.name', 'Release Test'], repository);
    git(['config', 'user.email', 'release-test@example.invalid'], repository);
}

test('archives the exact revision and recorded submodule source without Git metadata', () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'iverilog-archive-test-'));
    const submoduleRoot = path.join(fixtureRoot, 'submodule');
    initializeRepository(submoduleRoot);
    writeFileSync(path.join(submoduleRoot, 'submodule-source.c'), 'int submodule_value = 1;\n');
    git(['add', '.'], submoduleRoot);
    git(['commit', '-m', 'submodule source'], submoduleRoot);

    const upstreamRoot = path.join(fixtureRoot, 'upstream');
    initializeRepository(upstreamRoot);
    mkdirSync(path.join(upstreamRoot, 'wasm'), { recursive: true });
    writeFileSync(path.join(upstreamRoot, 'README.md'), 'pinned source\n');
    writeFileSync(path.join(upstreamRoot, 'wasm', 'build.sh'), '#!/bin/sh\nmake wasm\n');
    git(['add', '.'], upstreamRoot);
    git(['commit', '-m', 'source and build scripts'], upstreamRoot);
    git([
        '-c', 'protocol.file.allow=always',
        'submodule', 'add', submoduleRoot, 'third_party/example',
    ], upstreamRoot);
    git(['commit', '-am', 'record exact submodule'], upstreamRoot);
    const pinnedRevision = git(['rev-parse', 'HEAD'], upstreamRoot);
    writeFileSync(path.join(upstreamRoot, 'README.md'), 'newer source must not ship\n');
    git(['commit', '-am', 'newer unpinned source'], upstreamRoot);

    const repository = 'https://source.test/iverilog';
    const { packageRoot } = createPackageFixture({
        source: sourceText({ repository, revision: pinnedRevision }),
        manifestRepository: `${repository}.git`,
    });
    const destination = path.join(fixtureRoot, 'release-assets');
    mkdirSync(destination);
    const gitEnvironment = {
        ...process.env,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: `url.file://${upstreamRoot}/.insteadOf`,
        GIT_CONFIG_VALUE_0: repository,
        GIT_CONFIG_KEY_1: 'protocol.file.allow',
        GIT_CONFIG_VALUE_1: 'always',
    };

    const archive = createIverilogSourceArchive({
        packageRoot,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
        destination,
        environment: gitEnvironment,
    });
    assert.equal(
        path.basename(archive),
        `iverilog-wasm-source-${pinnedRevision}.tar.gz`,
    );
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
        .trim().split('\n');
    assert.ok(listing.some(entry => entry.endsWith('/wasm/build.sh')));
    assert.ok(listing.some(entry => entry.endsWith('/third_party/example/submodule-source.c')));
    assert.equal(listing.some(entry => /(^|\/)\.git(?:\/|$)/.test(entry)), false);

    const extractedRoot = path.join(fixtureRoot, 'extracted');
    mkdirSync(extractedRoot);
    execFileSync('tar', ['-xzf', archive, '-C', extractedRoot]);
    const [archiveDirectory] = readdirSync(extractedRoot);
    assert.equal(
        readFileSync(path.join(extractedRoot, archiveDirectory, 'README.md'), 'utf8'),
        'pinned source\n',
    );
    assert.equal(existsSync(path.join(extractedRoot, archiveDirectory, '.git')), false);
});

test('CI and tagged release keep provenance validation and source delivery wired', () => {
    const ci = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /node --test scripts\/lib\/iverilog-source\.test\.mjs/);
    assert.match(ci, /iverilog-source\.mjs validate/);
    assert.match(ci, /npm run test:release/);

    const release = readFileSync(
        path.join(repositoryRoot, '.github/workflows/release.yml'),
        'utf8',
    );
    assert.match(release, /environment:\s*\n\s+name: gpl-release-review/);
    assert.match(release, /iverilog-source\.mjs archive/);
    assert.match(release, /release-assets/);
    assert.match(release, /iverilog-wasm-source-/);
    assert.match(release, /SHA256SUMS\.txt/);
});

test('release documentation records pinned GPL corresponding-source delivery', () => {
    const documentation = readFileSync(
        path.join(repositoryRoot, 'docs/licenses/iverilog-wasm.md'),
        'utf8',
    );
    for (const marker of [
        'GPL-2.0-or-later',
        PACKAGE_VERSION,
        REPOSITORY,
        REVISION,
        'npm',
        'VSIX',
        'iverilog-wasm-source-',
        'legal review',
    ]) {
        assert.ok(documentation.includes(marker), `license documentation missing ${marker}`);
    }
    assert.match(documentation, /git checkout --detach/);
    assert.match(documentation, /make -C wasm clean build package/);
    assert.doesNotMatch(documentation, /(?:constitutes|provides) legal advice/i);
});
