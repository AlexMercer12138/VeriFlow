import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createIverilogSourceArchive,
    parseIverilogSource,
    readIverilogSource,
    runIverilogSourceCli,
} from './iverilog-source.mjs';

const PACKAGE_NAME = '@veriflow/iverilog-wasm';
const PACKAGE_VERSION = '0.1.4';
const REVISION = '75c777c993c2bbc6ffe7f9138f25a76e14db5325';
const REPOSITORY = 'https://github.com/AlexMercer12138/iverilog';
const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
);
const temporaryRoots = new Set();

function temporaryRoot(prefix) {
    const root = mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryRoots.add(root);
    return root;
}

after(() => {
    for (const root of temporaryRoots) {
        rmSync(root, { recursive: true, force: true });
    }
});

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
    const fixtureRoot = temporaryRoot('iverilog-source-test-');
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
    const fixtureRoot = temporaryRoot('iverilog-source-link-test-');
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

test('CLI rejects unknown, duplicate, and command-inapplicable options', () => {
    const { packageRoot } = createPackageFixture();
    const required = [
        '--package-root', packageRoot,
        '--expected-version', PACKAGE_VERSION,
    ];
    assert.throws(
        () => runIverilogSourceCli(['validate', ...required, '--unknown', 'value']),
        /unknown option/i,
    );
    assert.throws(
        () => runIverilogSourceCli([
            'validate', ...required, '--expected-version', PACKAGE_VERSION,
        ]),
        /duplicate option/i,
    );
    assert.throws(
        () => runIverilogSourceCli(['validate', ...required, '--destination', 'release-assets']),
        /not valid.*validate/i,
    );
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

function createArchiveFixture(prefix) {
    const fixtureRoot = temporaryRoot(prefix);
    const upstreamRoot = path.join(fixtureRoot, 'upstream');
    initializeRepository(upstreamRoot);
    mkdirSync(path.join(upstreamRoot, 'wasm'));
    writeFileSync(path.join(upstreamRoot, 'README.md'), 'source\n');
    writeFileSync(path.join(upstreamRoot, 'wasm', 'build.sh'), '#!/bin/sh\nmake wasm\n');
    git(['add', '.'], upstreamRoot);
    git(['commit', '-m', 'source commit'], upstreamRoot);
    const revision = git(['rev-parse', 'HEAD'], upstreamRoot);
    const repository = `https://source.test/${path.basename(fixtureRoot)}`;
    const { packageRoot } = createPackageFixture({
        source: sourceText({ repository, revision }),
        manifestRepository: `${repository}.git`,
    });
    const destination = path.join(fixtureRoot, 'release-assets');
    mkdirSync(destination);
    const environment = {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${upstreamRoot}/.insteadOf`,
        GIT_CONFIG_VALUE_0: repository,
    };
    return { destination, environment, fixtureRoot, packageRoot, revision };
}

function sha256(filepath) {
    return createHash('sha256').update(readFileSync(filepath)).digest('hex');
}

test('archives the exact revision and recorded submodule source without Git metadata', () => {
    const fixtureRoot = temporaryRoot('iverilog-archive-test-');
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

test('rejects an annotated tag object instead of silently archiving its peeled commit', () => {
    const fixtureRoot = temporaryRoot('iverilog-tag-object-test-');
    const upstreamRoot = path.join(fixtureRoot, 'upstream');
    initializeRepository(upstreamRoot);
    mkdirSync(path.join(upstreamRoot, 'wasm'));
    writeFileSync(path.join(upstreamRoot, 'wasm', 'build.sh'), '#!/bin/sh\nmake wasm\n');
    git(['add', '.'], upstreamRoot);
    git(['commit', '-m', 'source commit'], upstreamRoot);
    git(['tag', '-a', 'release-object', '-m', 'annotated release'], upstreamRoot);
    const tagObjectRevision = git(['rev-parse', 'release-object'], upstreamRoot);
    assert.equal(git(['cat-file', '-t', tagObjectRevision], upstreamRoot), 'tag');

    const repository = 'https://source.test/annotated-iverilog';
    const { packageRoot } = createPackageFixture({
        source: sourceText({ repository, revision: tagObjectRevision }),
        manifestRepository: `${repository}.git`,
    });
    const destination = path.join(fixtureRoot, 'release-assets');
    const environment = {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${upstreamRoot}/.insteadOf`,
        GIT_CONFIG_VALUE_0: repository,
    };

    assert.throws(() => createIverilogSourceArchive({
        packageRoot,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
        destination,
        environment,
    }), /revision.*commit|commit.*revision|object type/i);
});

test('creates byte-reproducible source archives for the same commit', () => {
    const fixture = createArchiveFixture('iverilog-reproducible-test-');
    const options = {
        packageRoot: fixture.packageRoot,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
        destination: fixture.destination,
        environment: fixture.environment,
    };
    const firstArchive = createIverilogSourceArchive(options);
    const firstDigest = sha256(firstArchive);
    execFileSync('sleep', ['1.1']);
    const secondArchive = createIverilogSourceArchive(options);
    assert.equal(sha256(secondArchive), firstDigest);
});

test('preserves an existing archive when replacement creation fails', () => {
    const fixture = createArchiveFixture('iverilog-atomic-test-');
    const options = {
        packageRoot: fixture.packageRoot,
        expectedName: PACKAGE_NAME,
        expectedVersion: PACKAGE_VERSION,
        destination: fixture.destination,
        environment: fixture.environment,
    };
    const archive = createIverilogSourceArchive(options);
    const originalDigest = sha256(archive);
    const commandRoot = path.join(fixture.fixtureRoot, 'commands');
    mkdirSync(commandRoot);
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(commandRoot, 'git'));
    const failingTar = path.join(commandRoot, 'tar');
    writeFileSync(failingTar, '#!/bin/sh\nexit 23\n');
    chmodSync(failingTar, 0o755);

    assert.throws(() => createIverilogSourceArchive({
        ...options,
        environment: {
            ...fixture.environment,
            PATH: `${commandRoot}${path.delimiter}${process.env.PATH}`,
        },
    }), /tar failed/i);
    assert.equal(sha256(archive), originalDigest);
    assert.deepEqual(
        readdirSync(fixture.destination).filter(name => name.startsWith('.iverilog-source-publish-')),
        [],
    );
});

function workflowBlock(source, heading, indent = 2) {
    const prefix = ' '.repeat(indent);
    const lines = source.split('\n');
    const start = lines.findIndex(line => line === `${prefix}${heading}:`);
    assert.notEqual(start, -1, `workflow block ${heading} must exist`);
    let end = start + 1;
    while (end < lines.length) {
        const line = lines[end];
        if (line !== '' && !line.startsWith(' '.repeat(indent + 1))) break;
        end += 1;
    }
    return lines.slice(start, end).join('\n');
}

test('CI and tagged release keep provenance validation and source delivery wired', () => {
    const ci = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /node --test scripts\/lib\/iverilog-source\.test\.mjs/);
    assert.match(ci, /iverilog-source\.mjs validate/);
    assert.match(ci, /npm run test:release/);
    const platformSmokeJob = workflowBlock(ci, 'node-install-smoke');
    assert.match(platformSmokeJob, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
    assert.match(
        platformSmokeJob,
        /npm run test:vsix --workspace veriflow-vscode/,
    );
    const baselineJob = workflowBlock(ci, 'vscode-runtime-baseline');
    assert.match(baselineJob, /node-version: "18\.15\.0"/);
    assert.match(baselineJob, /builtinSimulatorAssets\.test\.js/);
    assert.match(baselineJob, /VERIFLOW_BUILTIN_ASSETS_ROOT/);

    const release = readFileSync(
        path.join(repositoryRoot, '.github/workflows/release.yml'),
        'utf8',
    );
    const workflowPermissions = workflowBlock(release, 'permissions', 0);
    assert.match(workflowPermissions, /^  contents: read$/m);
    assert.match(workflowPermissions, /^  actions: read$/m);
    assert.doesNotMatch(workflowPermissions, /contents: write/);

    const buildJob = workflowBlock(release, 'node-artifacts');
    assert.match(buildJob, /^    needs: verify-main-ci$/m);
    assert.doesNotMatch(buildJob, /^    environment:/m);
    assert.match(buildJob, /iverilog-source\.mjs archive/);
    assert.match(buildJob, /name: veriflow-node-release/);
    for (const packagedFile of [
        'dist/vendor/iverilog-wasm/LICENSE',
        'dist/vendor/iverilog-wasm/dist/SOURCE.md',
        'dist/vendor/iverilog-wasm/dist/worker.js',
        'dist/vendor/iverilog-wasm/dist/runtime/ivl.wasm',
        'dist/vendor/iverilog-wasm/dist/runtime/vvp.wasm',
    ]) {
        assert.ok(buildJob.includes(packagedFile), `release payload check missing ${packagedFile}`);
    }
    assert.doesNotMatch(buildJob, /SHA256SUMS\.txt/);

    const finalizeJob = workflowBlock(release, 'finalize-release-assets');
    assert.match(finalizeJob, /^    needs: node-artifacts$/m);
    assert.match(finalizeJob, /name: veriflow-node-release/);
    assert.match(finalizeJob, /SHA256SUMS\.txt/);
    assert.match(finalizeJob, /name: veriflow-final-release/);
    assert.doesNotMatch(finalizeJob, /gpl-release-review|gh release create/);

    const publishJob = workflowBlock(release, 'github-release');
    assert.match(publishJob, /^    needs: finalize-release-assets$/m);
    assert.match(publishJob, /^    environment:\s*\n      name: gpl-release-review$/m);
    assert.match(publishJob, /^    permissions:\s*\n      contents: write$/m);
    assert.match(publishJob, /name: veriflow-final-release/);
    assert.match(publishJob, /gh release create/);
    assert.doesNotMatch(publishJob, /sha256sum|SHA256SUMS\.txt/);
});

test('local release checks include Icarus source provenance tests', () => {
    const manifest = JSON.parse(
        readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    assert.match(manifest.scripts['test:release'], /scripts\/lib\/iverilog-source\.test\.mjs/);
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
    assert.doesNotMatch(documentation, /VeriFlow \d+\.\d+\.\d+ includes/);
    assert.doesNotMatch(documentation, /(?:constitutes|provides) legal advice/i);
});
