import assert from 'node:assert/strict';
import {
    link,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createEmptyArchDesign,
    exportArchDesignRtl,
    parseArchDesignRtlMarker,
} from '@veriflow/schematic-core/arch-design';

import {
    GeneratedFileConflictError,
    publishGeneratedFileAtomic,
    type AtomicGeneratedFileOperations,
} from '../src/runtime/atomicGeneratedFile';

async function withTemporaryDirectory(
    run: (directory: string) => Promise<void>
): Promise<void> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'veriflow-generated-file-'));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function generatedRtl(moduleName: string): string {
    const result = exportArchDesignRtl(createEmptyArchDesign(moduleName), []);
    assert.equal(result.status, 'generated');
    if (result.status !== 'generated') throw new Error('expected generated RTL');
    assert.notEqual(parseArchDesignRtlMarker(result.text), undefined);
    return result.text;
}

async function assertOnlyTarget(directory: string, targetName: string): Promise<void> {
    assert.deepEqual((await readdir(directory)).sort(), [targetName]);
}

function filesystemOperations(
    overrides: Partial<AtomicGeneratedFileOperations> = {}
): AtomicGeneratedFileOperations {
    return {
        readFile: filepath => readFile(filepath, 'utf8'),
        makeDirectory: directory => mkdir(directory, { recursive: true }).then(() => undefined),
        writeTemporary: (filepath, text) => writeFile(filepath, text, {
            encoding: 'utf8',
            flag: 'wx',
        }),
        link,
        rename,
        remove: filepath => unlink(filepath),
        ...overrides,
    };
}

test('publishes complete bytes without leaving a temporary file', async () => {
    await withTemporaryDirectory(async directory => {
        const outputDirectory = path.join(directory, 'nested');
        const target = path.join(outputDirectory, 'soc.v');
        const text = generatedRtl('soc');

        await publishGeneratedFileAtomic(target, text);

        assert.equal(await readFile(target, 'utf8'), text);
        await assertOnlyTarget(outputDirectory, 'soc.v');
    });
});

test('atomically replaces a target carrying a valid generated marker', async () => {
    await withTemporaryDirectory(async directory => {
        const target = path.join(directory, 'soc.v');
        const replacement = generatedRtl('replacement_soc');
        await writeFile(target, generatedRtl('original_soc'), 'utf8');

        await publishGeneratedFileAtomic(target, replacement);

        assert.equal(await readFile(target, 'utf8'), replacement);
        await assertOnlyTarget(directory, 'soc.v');
    });
});

test('rejects handwritten RTL before writing a temporary file', async () => {
    await withTemporaryDirectory(async directory => {
        const target = path.join(directory, 'soc.v');
        const handwritten = 'module soc;\nendmodule\n';
        let temporaryWrites = 0;
        await writeFile(target, handwritten, 'utf8');

        await assert.rejects(
            publishGeneratedFileAtomic(target, generatedRtl('replacement_soc'), {
                writeTemporary: async () => { temporaryWrites += 1; },
            }),
            GeneratedFileConflictError
        );

        assert.equal(temporaryWrites, 0);
        assert.equal(await readFile(target, 'utf8'), handwritten);
        await assertOnlyTarget(directory, 'soc.v');
    });
});

test('rejects malformed and non-leading generated markers before temporary writes', async () => {
    await withTemporaryDirectory(async directory => {
        const valid = generatedRtl('original_soc');
        const malformed = valid.replace(/schema=\d+/, 'schema=invalid');
        const fixtures = [malformed, `\n${valid}`];
        assert.deepEqual(fixtures.map(parseArchDesignRtlMarker), [undefined, undefined]);
        let temporaryWrites = 0;

        for (const [index, fixture] of fixtures.entries()) {
            const target = path.join(directory, `soc-${index}.v`);
            await writeFile(target, fixture, 'utf8');

            await assert.rejects(
                publishGeneratedFileAtomic(target, generatedRtl(`replacement_${index}`), {
                    writeTemporary: async () => { temporaryWrites += 1; },
                }),
                GeneratedFileConflictError
            );

            assert.equal(await readFile(target, 'utf8'), fixture);
        }

        assert.equal(temporaryWrites, 0);
        assert.deepEqual((await readdir(directory)).sort(), ['soc-0.v', 'soc-1.v']);
    });
});

test('preserves a target created concurrently before no-clobber publication', async () => {
    await withTemporaryDirectory(async directory => {
        const target = path.join(directory, 'soc.v');
        const concurrent = 'module concurrent_owner;\nendmodule\n';
        const operations = filesystemOperations({
            link: async (source, destination) => {
                await writeFile(destination, concurrent, 'utf8');
                await link(source, destination);
            },
        });

        await assert.rejects(
            publishGeneratedFileAtomic(target, generatedRtl('soc'), operations),
            GeneratedFileConflictError
        );

        assert.equal(await readFile(target, 'utf8'), concurrent);
        await assertOnlyTarget(directory, 'soc.v');
    });
});

test('preserves an existing generated target when the temporary write fails', async () => {
    await withTemporaryDirectory(async directory => {
        const target = path.join(directory, 'soc.v');
        const original = generatedRtl('original_soc');
        await writeFile(target, original, 'utf8');

        await assert.rejects(
            publishGeneratedFileAtomic(target, generatedRtl('replacement_soc'), {
                writeTemporary: async filepath => {
                    await writeFile(filepath, 'partial bytes', 'utf8');
                    const error = new Error('temporary write failed') as NodeJS.ErrnoException;
                    error.code = 'EIO';
                    throw error;
                },
            }),
            /temporary write failed/
        );

        assert.equal(await readFile(target, 'utf8'), original);
        await assertOnlyTarget(directory, 'soc.v');
    });
});

test('preserves a target that becomes handwritten before the ownership recheck', async () => {
    await withTemporaryDirectory(async directory => {
        const target = path.join(directory, 'soc.v');
        const handwritten = 'module new_owner;\nendmodule\n';
        await writeFile(target, generatedRtl('original_soc'), 'utf8');
        let targetReads = 0;
        const operations = filesystemOperations({
            readFile: async filepath => {
                targetReads += 1;
                if (targetReads === 2) await writeFile(filepath, handwritten, 'utf8');
                return readFile(filepath, 'utf8');
            },
        });

        await assert.rejects(
            publishGeneratedFileAtomic(target, generatedRtl('replacement_soc'), operations),
            GeneratedFileConflictError
        );

        assert.equal(targetReads, 2);
        assert.equal(await readFile(target, 'utf8'), handwritten);
        await assertOnlyTarget(directory, 'soc.v');
    });
});

test('preserves an existing generated target when atomic rename fails', async () => {
    await withTemporaryDirectory(async directory => {
        const target = path.join(directory, 'soc.v');
        const original = generatedRtl('original_soc');
        await writeFile(target, original, 'utf8');
        const operations = filesystemOperations({
            rename: async () => {
                const error = new Error('rename failed') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            },
        });

        await assert.rejects(
            publishGeneratedFileAtomic(target, generatedRtl('replacement_soc'), operations),
            /rename failed/
        );

        assert.equal(await readFile(target, 'utf8'), original);
        await assertOnlyTarget(directory, 'soc.v');
    });
});

test('removes only its own temporary file after a publication failure', async () => {
    await withTemporaryDirectory(async directory => {
        const target = path.join(directory, 'soc.v');
        const unrelated = path.join(directory, 'unrelated.tmp');
        let temporaryPath = '';
        await writeFile(unrelated, 'keep me', 'utf8');
        const operations = filesystemOperations({
            writeTemporary: async (filepath, text) => {
                temporaryPath = filepath;
                await writeFile(filepath, text, { encoding: 'utf8', flag: 'wx' });
            },
            link: async () => {
                const error = new Error('publication failed') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            },
        });

        await assert.rejects(
            publishGeneratedFileAtomic(target, generatedRtl('soc'), operations),
            /publication failed/
        );

        assert.equal(path.dirname(temporaryPath), directory);
        assert.match(
            path.basename(temporaryPath),
            new RegExp(`^soc\\.v\\.${process.pid}\\.[0-9a-f]{32}\\.tmp$`)
        );
        assert.deepEqual(await readdir(directory), ['unrelated.tmp']);
        assert.equal(await readFile(unrelated, 'utf8'), 'keep me');
    });
});
