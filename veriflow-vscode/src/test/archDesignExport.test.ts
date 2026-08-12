import * as assert from 'assert';
import {
    link,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
    createEmptyArchDesign,
    parseArchDesignRtlMarker,
    type ArchDesign,
} from '@veriflow/schematic-core/arch-design';
import { createInterfaceProtocolCatalog } from '@veriflow/schematic-core/interfaces';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import {
    ArchDesignGeneratedFileConflictError,
    exportArchDesignToFile,
    type ArchDesignExportFileOperations,
} from '../archDesign/archDesignExport';

function design(overrides: Partial<ArchDesign> = {}): ArchDesign {
    return {
        ...createEmptyArchDesign('soc'),
        ...overrides,
    } as ArchDesign;
}

function definition(name: string, filepath: string): HdlDefinitionSummary {
    const uri = pathToFileURL(filepath).toString();
    return {
        key: `module:${uri}:0`,
        kind: 'module',
        name,
        uri,
        declarationStart: 0,
        declarationLine: 1,
        parameters: [],
        ports: [],
        dependencies: [],
        modelFingerprint: `${name}-v1`,
    };
}

async function withTemporaryDirectory(
    run: (directory: string) => Promise<void>
): Promise<void> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'veriflow-vscode-ad-export-'));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function filesystemOperations(
    overrides: Partial<ArchDesignExportFileOperations> = {}
): ArchDesignExportFileOperations {
    return {
        readFile: filepath => readFile(filepath, 'utf8'),
        makeDirectory: directory => mkdir(directory, { recursive: true }).then(() => undefined),
        writeTemporary: (filepath, text) => writeFile(
            filepath,
            text,
            { encoding: 'utf8', flag: 'wx' }
        ),
        link,
        rename,
        remove: unlink,
        ...overrides,
    };
}

async function testDefaultAndConfiguredTargets(): Promise<void> {
    await withTemporaryDirectory(async directory => {
        const designPath = path.join(directory, 'design', 'soc.ad');
        await mkdir(path.dirname(designPath), { recursive: true });
        await writeFile(designPath, '{}\n', 'utf8');

        const first = await exportArchDesignToFile(designPath, design(), []);
        assert.strictEqual(first.status, 'published');
        if (first.status !== 'published') return;
        assert.strictEqual(first.outputPath, path.join(directory, 'design', 'soc.v'));
        const verilog = await readFile(first.outputPath, 'utf8');
        assert.strictEqual(parseArchDesignRtlMarker(verilog)?.language, 'verilog');
        assert.ok(verilog.includes('// vik-veriflow:source "soc.ad"'));

        const second = await exportArchDesignToFile(designPath, design({
            export: { language: 'systemverilog', output: 'rtl/soc.sv' },
        }), []);
        assert.strictEqual(second.status, 'published');
        if (second.status !== 'published') return;
        assert.strictEqual(second.outputPath, path.join(directory, 'design', 'rtl', 'soc.sv'));
        const systemVerilog = await readFile(second.outputPath, 'utf8');
        assert.strictEqual(
            parseArchDesignRtlMarker(systemVerilog)?.language,
            'systemverilog'
        );
        assert.ok(systemVerilog.includes('// vik-veriflow:source "../soc.ad"'));
    });
}

async function testExtensionValidationAndOutputExclusion(): Promise<void> {
    await withTemporaryDirectory(async directory => {
        const designPath = path.join(directory, 'soc.ad');
        const invalidParent = path.join(directory, 'generated');
        await assert.rejects(
            exportArchDesignToFile(designPath, design({
                export: { language: 'verilog', output: 'generated/soc.sv' },
            }), []),
            /Output file extension must be \.v for verilog/
        );
        await assert.rejects(readdir(invalidParent), { code: 'ENOENT' });

        const outputPath = path.join(directory, 'soc.v');
        const result = await exportArchDesignToFile(designPath, design({
            instances: [{ name: 'u_generated', module: 'generated_only' }],
        }), [definition('generated_only', outputPath)]);
        assert.strictEqual(result.status, 'invalid');
        if (result.status !== 'invalid') return;
        assert.deepStrictEqual(result.diagnostics.map(item => item.code), [
            'AD_MODULE_UNRESOLVED',
        ]);
        await assert.rejects(readFile(outputPath, 'utf8'), { code: 'ENOENT' });
    });
}

async function testPhysicalOutputDefinitionExclusion(): Promise<void> {
    await withTemporaryDirectory(async directory => {
        const realDirectory = path.join(directory, 'real');
        const aliasDirectory = path.join(directory, 'alias');
        await mkdir(realDirectory);
        try {
            await symlink(realDirectory, aliasDirectory, 'dir');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return;
            throw error;
        }
        const designPath = path.join(realDirectory, 'soc.ad');
        const physicalOutputPath = path.join(realDirectory, 'soc.v');
        const result = await exportArchDesignToFile(
            designPath,
            design({
                module: 'generated_top',
                instances: [{ name: 'u_old', module: 'generated_top' }],
                export: { output: '../alias/soc.v' },
            }),
            [definition('generated_top', physicalOutputPath)]
        );
        assert.strictEqual(result.status, 'invalid');
        if (result.status !== 'invalid') return;
        assert.deepStrictEqual(result.diagnostics.map(item => item.code), [
            'AD_MODULE_UNRESOLVED',
        ]);
    });
}

async function testOwnershipAndReplacement(): Promise<void> {
    await withTemporaryDirectory(async directory => {
        const designPath = path.join(directory, 'soc.ad');
        const outputPath = path.join(directory, 'soc.v');
        await writeFile(outputPath, 'module handwritten; endmodule\n', 'utf8');
        await assert.rejects(
            exportArchDesignToFile(designPath, design(), []),
            ArchDesignGeneratedFileConflictError
        );
        assert.strictEqual(
            await readFile(outputPath, 'utf8'),
            'module handwritten; endmodule\n'
        );

        await rm(outputPath);
        const first = await exportArchDesignToFile(designPath, design(), []);
        assert.strictEqual(first.status, 'published');
        const original = await readFile(outputPath, 'utf8');
        const second = await exportArchDesignToFile(
            designPath,
            design({ module: 'updated_soc' }),
            []
        );
        assert.strictEqual(second.status, 'published');
        const replacement = await readFile(outputPath, 'utf8');
        assert.notStrictEqual(replacement, original);
        assert.ok(replacement.includes('module updated_soc;'));
    });
}

async function testPublicationFailuresPreserveTarget(): Promise<void> {
    await withTemporaryDirectory(async directory => {
        const designPath = path.join(directory, 'soc.ad');
        const outputPath = path.join(directory, 'soc.v');
        const first = await exportArchDesignToFile(designPath, design(), []);
        assert.strictEqual(first.status, 'published');
        const original = await readFile(outputPath, 'utf8');

        await assert.rejects(
            exportArchDesignToFile(
                designPath,
                design({ module: 'write_failure' }),
                [],
                filesystemOperations({
                    writeTemporary: async () => {
                        const error = new Error('temporary write failed');
                        Object.assign(error, { code: 'EIO' });
                        throw error;
                    },
                })
            ),
            /temporary write failed/
        );
        assert.strictEqual(await readFile(outputPath, 'utf8'), original);

        await assert.rejects(
            exportArchDesignToFile(
                designPath,
                design({ module: 'rename_failure' }),
                [],
                filesystemOperations({
                    rename: async () => {
                        const error = new Error('rename failed');
                        Object.assign(error, { code: 'EIO' });
                        throw error;
                    },
                })
            ),
            /rename failed/
        );
        assert.strictEqual(await readFile(outputPath, 'utf8'), original);

        await assert.rejects(
            exportArchDesignToFile(
                designPath,
                design({ module: 'original_error' }),
                [],
                filesystemOperations({
                    rename: async () => { throw new Error('original rename failure'); },
                    remove: async filepath => {
                        await unlink(filepath);
                        throw new Error('cleanup failure');
                    },
                })
            ),
            /original rename failure/
        );
        assert.strictEqual(await readFile(outputPath, 'utf8'), original);
        assert.deepStrictEqual(await readdir(directory), ['soc.v']);
    });
}

async function testExportUsesProvidedInterfaceCatalog(): Promise<void> {
    await withTemporaryDirectory(async directory => {
        const designPath = path.join(directory, 'soc.ad');
        const catalog = createInterfaceProtocolCatalog([{
            source: path.join(directory, 'protocol.json'),
            value: {
                format: 'veriflow-interface-protocol',
                schemaVersion: 1,
                id: 'test.link',
                name: 'Link',
                separator: '_',
                priority: 100,
                members: [
                    {
                        name: 'data',
                        direction: 'master-to-slave',
                        default: "4'ha",
                    },
                    { name: 'ready', direction: 'slave-to-master' },
                    {
                        name: 'tag',
                        direction: 'master-to-slave',
                        default: "4'ha",
                    },
                ],
                recognitionGroups: [['data', 'ready']],
            },
        }]);
        const selectedDesign = design({
            instances: [
                { name: 'u_source', module: 'source' },
                { name: 'u_sink', module: 'sink' },
            ],
            interfaceConnections: [{
                name: 'link',
                master: { kind: 'instance', instance: 'u_source', interface: 'm' },
                slave: { kind: 'instance', instance: 'u_sink', interface: 's' },
            }],
        });
        const source = definition('source', path.join(directory, 'source.sv'));
        source.ports = [
            { name: 'm_data', direction: 'output', width: { kind: 'known', bits: 4 } },
            { name: 'm_ready', direction: 'input', width: { kind: 'known', bits: 1 } },
        ];
        const sink = definition('sink', path.join(directory, 'sink.sv'));
        sink.ports = [
            { name: 's_data', direction: 'input', width: { kind: 'known', bits: 4 } },
            { name: 's_ready', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 's_tag', direction: 'input', width: { kind: 'known', bits: 4 } },
        ];

        const result = await exportArchDesignToFile(
            designPath,
            selectedDesign,
            [source, sink],
            { interfaceCatalog: catalog }
        );

        assert.strictEqual(result.status, 'published');
        if (result.status !== 'published') return;
        assert.match(await readFile(result.outputPath, 'utf8'), /\.s_tag\s*\(4'ha\)/);
    });
}

async function main(): Promise<void> {
    await testDefaultAndConfiguredTargets();
    await testExtensionValidationAndOutputExclusion();
    await testPhysicalOutputDefinitionExclusion();
    await testOwnershipAndReplacement();
    await testPublicationFailuresPreserveTarget();
    await testExportUsesProvidedInterfaceCatalog();
    console.log('Arch Design export tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
