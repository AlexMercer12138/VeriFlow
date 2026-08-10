import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
    assertRepositoryPathsUnchanged,
    createIsolatedRepository,
    snapshotRepositoryPaths,
} from './helpers/isolatedRepository';

const extensionRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(extensionRoot, '..');

const expectedRuntimeEntries = [
    'extension/dist/extension.js',
    'extension/dist/workers/hdlParserWorker.js',
    'extension/dist/workers/waveformWorker.js',
    'extension/media/parsers/tree-sitter-systemverilog.wasm',
    'extension/media/parsers/web-tree-sitter.wasm',
    'extension/media/schematic/index.css',
    'extension/media/schematic/index.html',
    'extension/media/schematic/index.js',
    'extension/media/waveform/index.css',
    'extension/media/waveform/index.html',
    'extension/media/waveform/index.js',
    'extension/media/waveform/viewer-core.js',
    'extension/media/waveform/viewer-transport.js',
];

function zipCentralDirectoryEntries(archive: Buffer): string[] {
    const endOfCentralDirectorySignature = 0x06054b50;
    const centralDirectorySignature = 0x02014b50;
    const minimumEndRecordSize = 22;
    const maximumCommentSize = 0xffff;
    const searchStart = Math.max(
        0,
        archive.length - minimumEndRecordSize - maximumCommentSize
    );
    let endRecordOffset = -1;
    for (let offset = archive.length - minimumEndRecordSize; offset >= searchStart; offset -= 1) {
        if (archive.readUInt32LE(offset) === endOfCentralDirectorySignature) {
            endRecordOffset = offset;
            break;
        }
    }
    assert.notStrictEqual(endRecordOffset, -1, 'VSIX is missing a ZIP central directory');

    const diskNumber = archive.readUInt16LE(endRecordOffset + 4);
    const directoryDisk = archive.readUInt16LE(endRecordOffset + 6);
    const diskEntryCount = archive.readUInt16LE(endRecordOffset + 8);
    const entryCount = archive.readUInt16LE(endRecordOffset + 10);
    const directorySize = archive.readUInt32LE(endRecordOffset + 12);
    const directoryOffset = archive.readUInt32LE(endRecordOffset + 16);
    assert.strictEqual(diskNumber, 0, 'multi-disk VSIX archives are unsupported');
    assert.strictEqual(directoryDisk, 0, 'multi-disk VSIX archives are unsupported');
    assert.strictEqual(diskEntryCount, entryCount, 'inconsistent VSIX entry counts');
    assert.notStrictEqual(entryCount, 0xffff, 'ZIP64 VSIX archives are unsupported');
    assert.notStrictEqual(directoryOffset, 0xffffffff, 'ZIP64 VSIX archives are unsupported');
    assert.ok(
        directoryOffset + directorySize <= endRecordOffset,
        'VSIX central directory extends past its end record'
    );

    const entries: string[] = [];
    let offset = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
        assert.strictEqual(
            archive.readUInt32LE(offset),
            centralDirectorySignature,
            `invalid VSIX central directory entry ${index}`
        );
        const nameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
        assert.ok(entryEnd <= archive.length, `truncated VSIX central directory entry ${index}`);
        const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        assert.ok(!name.includes('\\'), `VSIX entry is not slash-normalized: ${name}`);
        entries.push(name);
        offset = entryEnd;
    }
    assert.strictEqual(
        offset,
        directoryOffset + directorySize,
        'VSIX central directory size does not match its entries'
    );
    return entries;
}

function packageFailure(result: ReturnType<typeof spawnSync>): string {
    return [
        `VSIX packaging failed with status ${result.status}`,
        `error: ${result.error?.stack ?? 'none'}`,
        `stdout:\n${String(result.stdout ?? '')}`,
        `stderr:\n${String(result.stderr ?? '')}`,
    ].join('\n');
}

function run(): void {
    const npmExecPath = process.env.npm_execpath;
    assert.ok(npmExecPath, 'npm_execpath is required to invoke the active npm CLI');
    assert.ok(path.isAbsolute(npmExecPath), `npm_execpath must be absolute: ${npmExecPath}`);

    const protectedPaths = [
        ...['flow-core', 'hdl-core', 'schematic-core', 'hdl-runtime', 'waveform-runtime']
            .map(workspace => path.join(repositoryRoot, 'packages', workspace, 'dist')),
        path.join(extensionRoot, 'out'),
        path.join(extensionRoot, 'dist'),
        path.join(repositoryRoot, 'web-dist'),
        path.join(extensionRoot, 'media', 'parsers'),
        path.join(extensionRoot, 'media', 'waveform'),
        path.join(extensionRoot, 'media', 'schematic'),
    ];
    const protectedSnapshots = snapshotRepositoryPaths(protectedPaths);
    let isolated: ReturnType<typeof createIsolatedRepository> | undefined;
    try {
        isolated = createIsolatedRepository(repositoryRoot, 'veriflow-vsix-packaging');
        const fixtureRoot = isolated.repositoryRoot;
        const fixtureExtensionRoot = path.join(fixtureRoot, 'veriflow-vscode');
        const vsixPath = path.join(isolated.temporaryRoot, 'veriflow-clean-checkout.vsix');
        const cleanBuildTargets = [
            path.join(fixtureRoot, 'packages', 'hdl-core', 'dist'),
            path.join(fixtureRoot, 'packages', 'schematic-core', 'dist'),
            path.join(fixtureExtensionRoot, 'out'),
            path.join(fixtureExtensionRoot, 'dist'),
            path.join(fixtureRoot, 'web-dist'),
            path.join(fixtureExtensionRoot, 'media', 'waveform'),
            path.join(fixtureExtensionRoot, 'media', 'schematic'),
        ];
        for (const target of cleanBuildTargets) {
            assert.strictEqual(fs.existsSync(target), false, `${target} must start clean`);
        }

        const result = spawnSync(process.execPath, [
            npmExecPath,
            'run',
            'package',
            '--workspace',
            'veriflow-vscode',
            '--',
            '--out',
            vsixPath,
        ], {
            cwd: fixtureRoot,
            encoding: 'utf8',
            timeout: 180_000,
        });
        assert.strictEqual(result.status, 0, packageFailure(result));
        assert.ok(fs.existsSync(vsixPath), `${vsixPath} was not created`);
        for (const target of cleanBuildTargets) {
            assert.ok(fs.existsSync(target), `${target} was not generated in the fixture`);
        }

        const entries = zipCentralDirectoryEntries(fs.readFileSync(vsixPath));
        assert.ok(
            entries.includes('extension/dist/extension.js'),
            'VSIX is missing the extension/dist/extension.js main bundle'
        );
        const runtimeEntries = entries.filter(entry => (
            entry.startsWith('extension/dist/')
            || entry.startsWith('extension/media/parsers/')
            || entry.startsWith('extension/media/waveform/')
            || entry.startsWith('extension/media/schematic/')
        )).sort();
        assert.deepStrictEqual(
            runtimeEntries,
            expectedRuntimeEntries,
            [
                'VSIX must contain exactly the required compiled and generated runtime files.',
                `Actual runtime entries: ${JSON.stringify(runtimeEntries)}`,
                `Packaging stdout:\n${String(result.stdout ?? '')}`,
                `Packaging stderr:\n${String(result.stderr ?? '')}`,
            ].join('\n')
        );

        for (const forbiddenPrefix of [
            'extension/src/',
            'extension/webview/',
            'extension/web-dist/',
            'extension/packages/waveform-webview/',
            'extension/packages/schematic-webview/',
            'extension/packages/schematic-core/',
            'extension/node_modules/@veriflow/schematic-core/',
        ]) {
            assert.deepStrictEqual(
                entries.filter(entry => entry.startsWith(forbiddenPrefix)),
                [],
                `VSIX contains forbidden web source entries under ${forbiddenPrefix}`
            );
        }
        assert.deepStrictEqual(
            entries.filter(entry => (
                entry.includes('/schematic-core/src/')
                || entry.includes('/schematic-core/dist-test/')
                || entry.includes('/schematic-core/test/')
            )),
            [],
            'VSIX must not contain schematic-core source or test build output'
        );
    } finally {
        try {
            isolated?.dispose();
        } finally {
            assertRepositoryPathsUnchanged(protectedSnapshots);
        }
    }
}

run();
console.log('VSIX packaging tests passed');
