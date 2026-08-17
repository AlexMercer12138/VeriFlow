import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { inflateRawSync } from 'zlib';

import {
    assertRepositoryPathsUnchanged,
    createIsolatedRepository,
    snapshotRepositoryPaths,
} from './helpers/isolatedRepository';

const extensionRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(extensionRoot, '..');

const upstreamRuntimeRoot = path.join(
    repositoryRoot,
    'node_modules',
    '@veriflow',
    'iverilog-wasm'
);

function packageFiles(root: string, relative = ''): string[] {
    return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
        const child = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
        if (entry.isDirectory()) return packageFiles(root, child);
        assert.ok(entry.isFile(), `upstream runtime contains non-file entry ${child}`);
        return [child];
    });
}

const expectedVendorFiles = [
    'package.json',
    ...packageFiles(upstreamRuntimeRoot).filter(relative => relative !== 'package.json'),
].sort();
const expectedVendorEntries = expectedVendorFiles.map(
    relative => `extension/dist/vendor/iverilog-wasm/${relative}`
);

const expectedRuntimeEntries = [
    'extension/dist/extension.js',
    'extension/dist/workers/hdlParserWorker.js',
    'extension/dist/workers/waveformWorker.js',
    ...expectedVendorEntries,
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
].sort();

type ZipEntry = Readonly<{
    name: string;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}>;

function zipCentralDirectoryEntries(archive: Buffer): ZipEntry[] {
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

    const entries: ZipEntry[] = [];
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
        assert.ok(!path.posix.isAbsolute(name), `VSIX entry is absolute: ${name}`);
        assert.strictEqual(
            path.posix.normalize(name),
            name,
            `VSIX entry contains path traversal or redundant segments: ${name}`
        );
        assert.ok(
            !name.split('/').includes('..'),
            `VSIX entry contains path traversal: ${name}`
        );
        entries.push({
            name,
            compressionMethod: archive.readUInt16LE(offset + 10),
            compressedSize: archive.readUInt32LE(offset + 20),
            uncompressedSize: archive.readUInt32LE(offset + 24),
            localHeaderOffset: archive.readUInt32LE(offset + 42),
        });
        offset = entryEnd;
    }
    assert.strictEqual(
        offset,
        directoryOffset + directorySize,
        'VSIX central directory size does not match its entries'
    );
    return entries;
}

function zipEntryContents(archive: Buffer, entry: ZipEntry): Buffer {
    const localHeaderSignature = 0x04034b50;
    assert.strictEqual(
        archive.readUInt32LE(entry.localHeaderOffset),
        localHeaderSignature,
        `invalid local header for ${entry.name}`
    );
    const nameLength = archive.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    assert.ok(dataEnd <= archive.length, `truncated ZIP data for ${entry.name}`);
    const compressed = archive.subarray(dataStart, dataEnd);
    const contents = entry.compressionMethod === 0
        ? compressed
        : entry.compressionMethod === 8
            ? inflateRawSync(compressed)
            : assert.fail(
                `unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}`
            );
    assert.strictEqual(
        contents.length,
        entry.uncompressedSize,
        `uncompressed size mismatch for ${entry.name}`
    );
    return contents;
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

        const archive = fs.readFileSync(vsixPath);
        const zipEntries = zipCentralDirectoryEntries(archive);
        const entries = zipEntries.map(entry => entry.name);
        const entryText = (name: string): string => {
            const entry = zipEntries.find(candidate => candidate.name === name);
            assert.ok(entry, `VSIX is missing ${name}`);
            return zipEntryContents(archive, entry).toString('utf8');
        };
        assert.ok(
            entries.includes('extension/dist/extension.js'),
            'VSIX is missing the extension/dist/extension.js main bundle'
        );
        const packagedManifest = JSON.parse(entryText('extension/package.json'));
        const archDesignEditor = packagedManifest.contributes.customEditors.find(
            (item: { viewType?: string }) => item.viewType === 'veriflow.archDesignEditor'
        );
        assert.deepStrictEqual(archDesignEditor, {
            viewType: 'veriflow.archDesignEditor',
            displayName: 'VeriFlow Arch Design Editor',
            selector: [{ filenamePattern: '*.ad' }],
            priority: 'default',
        });
        assert.ok(
            packagedManifest.activationEvents.includes(
                'onCustomEditor:veriflow.archDesignEditor'
            ),
            'VSIX manifest does not activate the Arch Design editor'
        );
        for (const command of [
            'veriflow.createArchDesign',
            'veriflow.refreshArchDesigns',
            'veriflow.openArchDesign',
            'veriflow.validateArchDesign',
            'veriflow.exportArchDesign',
        ]) {
            assert.ok(
                packagedManifest.contributes.commands.some(
                    (item: { command?: string }) => item.command === command
                ),
                `VSIX manifest is missing ${command}`
            );
        }
        assert.deepStrictEqual(
            packagedManifest.contributes.views.veriflow.map(
                (item: { id?: string }) => item.id
            ),
            ['veriflow.modules', 'veriflow.archDesigns', 'veriflow.testbench']
        );
        assert.strictEqual(
            packagedManifest.contributes.views.veriflow[0].name,
            'Simulation'
        );
        assert.ok(
            packagedManifest.activationEvents.includes('onView:veriflow.archDesigns'),
            'VSIX manifest does not activate the Arch Designs view'
        );
        assert.ok(
            packagedManifest.activationEvents.includes(
                'onCommand:veriflow.createArchDesign'
            ),
            'VSIX manifest does not activate Arch Design creation'
        );
        assert.ok(
            packagedManifest.contributes.viewsWelcome.some(
                (item: { view?: string; contents?: string }) =>
                    item.view === 'veriflow.archDesigns'
                    && item.contents?.includes(
                        '[Create Arch Design](command:veriflow.createArchDesign)'
                    )
            ),
            'VSIX manifest is missing the Arch Designs empty state'
        );
        for (const command of [
            'veriflow.validateArchDesign',
            'veriflow.exportArchDesign',
        ]) {
            assert.ok(
                !packagedManifest.contributes.menus['editor/title'].some(
                    (item: { command?: string }) => item.command === command
                ),
                `VSIX manifest duplicates ${command} in the editor title`
            );
            assert.ok(
                packagedManifest.contributes.menus['view/item/context'].some(
                    (item: { command?: string; when?: string }) =>
                        item.command === command
                        && item.when?.includes('viewItem == archDesignFile')
                ),
                `VSIX manifest is missing the ${command} tree action`
            );
        }

        const extensionBundle = entryText('extension/dist/extension.js');
        assert.ok(extensionBundle.length < 2_000_000, 'extension bundle unexpectedly inlines WASM');
        assert.doesNotMatch(extensionBundle, /data:application\/wasm/i);
        assert.doesNotMatch(extensionBundle, /AGFzbQE[A-Za-z0-9+/=]{100,}/);
        for (const marker of [
            'vik-veriflow.arch-design',
            'veriflow.archDesignEditor',
            'applyArchDesignEdit',
            'exportArchDesignRtl',
            'Arch Design RTL exported',
            'createInterfaceProtocolCatalog',
            'interface_protocols',
            'amba.axi4',
            'amba.axis',
            'amba.apb',
            'amba.ahb-lite',
        ]) {
            assert.ok(
                extensionBundle.includes(marker),
                `VSIX extension bundle is missing Arch Design runtime marker: ${marker}`
            );
        }
        const schematicHtml = entryText('extension/media/schematic/index.html');
        for (const controlId of [
            'add-instance-button',
            'add-port-button',
            'connect-button',
            'export-button',
        ]) {
            assert.ok(
                schematicHtml.includes(`id="${controlId}"`),
                `VSIX schematic HTML is missing ${controlId}`
            );
        }
        const schematicBundle = entryText('extension/media/schematic/index.js');
        for (const marker of [
            'editArchDesign',
            'exportArchDesign',
            'archDesignState',
            'connectInterface',
            'promoteInterface',
            'setInterfaceDefault',
            'setInterfaceOverride',
            'interface-collapse',
        ]) {
            assert.ok(
                schematicBundle.includes(marker),
                `VSIX schematic bundle is missing authoring marker: ${marker}`
            );
        }
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

        for (const relative of expectedVendorFiles) {
            const entryName = `extension/dist/vendor/iverilog-wasm/${relative}`;
            const entry = zipEntries.find(candidate => candidate.name === entryName);
            assert.ok(entry, `VSIX is missing ${entryName}`);
            assert.deepStrictEqual(
                zipEntryContents(archive, entry),
                fs.readFileSync(path.join(upstreamRuntimeRoot, relative)),
                `VSIX vendor file differs from upstream: ${relative}`
            );
        }
        const extractedRuntimeRoot = path.join(isolated.temporaryRoot, 'extracted-runtime');
        const emptyPath = path.join(isolated.temporaryRoot, 'empty-path');
        fs.mkdirSync(emptyPath);
        for (const relative of expectedVendorFiles) {
            const entryName = `extension/dist/vendor/iverilog-wasm/${relative}`;
            const entry = zipEntries.find(candidate => candidate.name === entryName)!;
            const destination = path.join(extractedRuntimeRoot, relative);
            const destinationRelative = path.relative(extractedRuntimeRoot, destination);
            assert.ok(
                destinationRelative !== '..'
                && !destinationRelative.startsWith(`..${path.sep}`)
                && !path.isAbsolute(destinationRelative),
                `unsafe extraction destination for ${entryName}`
            );
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, zipEntryContents(archive, entry));
        }
        const smoke = spawnSync(process.execPath, [
            path.join(extensionRoot, 'out', 'test', 'builtinSimulatorAssets.test.js'),
        ], {
            cwd: isolated.temporaryRoot,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
                ...process.env,
                PATH: emptyPath,
                VERIFLOW_BUILTIN_ASSETS_ROOT: extractedRuntimeRoot,
            },
        });
        assert.strictEqual(smoke.status, 0, [
            `extracted packaged simulator smoke failed with status ${smoke.status}`,
            `stdout:\n${String(smoke.stdout ?? '')}`,
            `stderr:\n${String(smoke.stderr ?? '')}`,
        ].join('\n'));

        for (const forbiddenPrefix of [
            'extension/src/',
            'extension/test/',
            'extension/out/',
            'extension/dist-test/',
            'extension/webview/',
            'extension/web-dist/',
            'extension/packages/waveform-webview/',
            'extension/packages/schematic-webview/',
            'extension/packages/schematic-core/',
            'extension/node_modules/@veriflow/schematic-core/',
            'extension/node_modules/',
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
        assert.deepStrictEqual(
            entries.filter(entry => (
                /(^|\/)(src|test|tests|dist-test)(\/|$)/i.test(entry)
                || /\.(?<!\.d\.)tsx?$/i.test(entry)
            )),
            [],
            'VSIX must not contain TypeScript source or test directories'
        );
        assert.deepStrictEqual(
            entries.filter(entry => (
                /(^|\/)(__pycache__|python)(\/|$)/i.test(entry)
                || /\.(py|pyc|pyo|pyd|whl)$/i.test(entry)
            )),
            [],
            'VSIX must not contain Python source, bytecode, packages, or runtime directories'
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
