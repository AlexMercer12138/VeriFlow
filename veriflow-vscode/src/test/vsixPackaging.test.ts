import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const mediaRoot = path.resolve(extensionRoot, 'media');

const expectedRuntimeEntries = [
    'extension/media/schematic/index.css',
    'extension/media/schematic/index.html',
    'extension/media/schematic/index.js',
    'extension/media/waveform/index.css',
    'extension/media/waveform/index.html',
    'extension/media/waveform/index.js',
    'extension/media/waveform/viewer-core.js',
    'extension/media/waveform/viewer-transport.js',
];

function exactBuildPath(parent: string, name: string): string {
    const resolvedParent = path.resolve(parent);
    const candidate = path.resolve(resolvedParent, name);
    const relative = path.relative(resolvedParent, candidate);
    assert.strictEqual(path.dirname(candidate), resolvedParent);
    assert.strictEqual(path.basename(candidate), name);
    assert.ok(relative && !path.isAbsolute(relative));
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`));
    return candidate;
}

const buildTargets = [
    exactBuildPath(extensionRoot, 'dist'),
    exactBuildPath(repositoryRoot, 'web-dist'),
    exactBuildPath(mediaRoot, 'waveform'),
    exactBuildPath(mediaRoot, 'schematic'),
];

type SavedBuildTarget = {
    target: string;
    backup: string;
    existed: boolean;
};

function saveBuildTargets(temporaryRoot: string): SavedBuildTarget[] {
    const backupRoot = path.join(temporaryRoot, 'saved-build-state');
    fs.mkdirSync(backupRoot, { recursive: true });
    return buildTargets.map((target, index) => {
        const backup = path.join(backupRoot, String(index));
        const existed = fs.existsSync(target);
        if (existed) fs.cpSync(target, backup, { recursive: true });
        return { target, backup, existed };
    });
}

function restoreBuildTargets(savedTargets: SavedBuildTarget[]): void {
    for (const { target, backup, existed } of savedTargets) {
        fs.rmSync(target, { recursive: true, force: true });
        if (existed) fs.cpSync(backup, target, { recursive: true });
    }
}

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

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-vsix-packaging-'));
    const vsixPath = path.join(temporaryRoot, 'veriflow-clean-checkout.vsix');
    let savedTargets: SavedBuildTarget[] | undefined;
    try {
        savedTargets = saveBuildTargets(temporaryRoot);
        for (const target of buildTargets) {
            fs.rmSync(target, { recursive: true, force: true });
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
            cwd: repositoryRoot,
            encoding: 'utf8',
            timeout: 180_000,
        });
        assert.strictEqual(result.status, 0, packageFailure(result));
        assert.ok(fs.existsSync(vsixPath), `${vsixPath} was not created`);

        const entries = zipCentralDirectoryEntries(fs.readFileSync(vsixPath));
        assert.ok(
            entries.includes('extension/dist/extension.js'),
            'VSIX is missing the extension/dist/extension.js main bundle'
        );
        const runtimeEntries = entries.filter(entry => (
            entry.startsWith('extension/media/waveform/')
            || entry.startsWith('extension/media/schematic/')
        )).sort();
        assert.deepStrictEqual(
            runtimeEntries,
            expectedRuntimeEntries,
            [
                'VSIX must contain exactly the eight generated web runtime files.',
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
        ]) {
            assert.deepStrictEqual(
                entries.filter(entry => entry.startsWith(forbiddenPrefix)),
                [],
                `VSIX contains forbidden web source entries under ${forbiddenPrefix}`
            );
        }
    } finally {
        if (savedTargets) restoreBuildTargets(savedTargets);
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

run();
console.log('VSIX packaging tests passed');
