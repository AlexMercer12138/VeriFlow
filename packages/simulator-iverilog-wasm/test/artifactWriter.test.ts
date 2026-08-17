import assert from 'node:assert/strict';
import {
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ArtifactWriteError,
    writeRequestedArtifacts,
    type ArtifactWriterFileSystem,
} from '../src/artifactWriter';
import { ArtifactWriteError as PublicArtifactWriteError } from '../src';

test('exports structured artifact write errors from the package root', () => {
    assert.equal(PublicArtifactWriteError, ArtifactWriteError);
});

test('rejects unsafe artifact names before touching destinations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-name-'));
    const invalidNames = [
        '/absolute.vcd',
        'C:\\absolute.vcd',
        '../',
        'nested/../escape.vcd',
        'bad\0name.vcd',
        '.iverilog',
        '.iverilog/program.vvp',
        '../.iverilog/program.vvp',
    ];

    try {
        for (const artifactPath of invalidNames) {
            const destination = path.join(root, `${invalidNames.indexOf(artifactPath)}.out`);
            await assert.rejects(
                writeRequestedArtifacts(
                    new Map([[artifactPath, Buffer.from('data')]]),
                    [{ path: artifactPath, destination }],
                    { cwd: root },
                ),
                /artifact path/i,
            );
            await assert.rejects(lstat(destination), { code: 'ENOENT' });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writes artifacts keyed by normalized leading parent paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-parent-'));
    const destination = path.join(root, 'copied.vcd');
    const logicalPath = '../../external/wave.vcd';

    try {
        const results = await writeRequestedArtifacts(
            new Map([[logicalPath, Buffer.from('vcd')]]),
            [{ path: logicalPath, destination }],
            { cwd: path.join(root, 'project', 'rtl') },
        );

        assert.equal(await readFile(destination, 'utf8'), 'vcd');
        assert.deepEqual(results, [{
            path: logicalPath,
            destination,
            written: true,
            size: 3,
        }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writes only requested artifacts as exact bytes and replaces regular files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-write-'));
    const absoluteDestination = path.join(root, 'absolute.vcd');
    const relativeDestination = 'relative.bin';
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x0a]);

    try {
        await writeFile(absoluteDestination, 'old contents');
        const results = await writeRequestedArtifacts(new Map([
            ['wave.vcd', bytes],
            ['missing.bin', Buffer.from('not returned')],
            ['unrequested.log', Buffer.from('must not be written')],
            ['.iverilog-cache/output.bin', Buffer.from([0x42])],
        ]), [
            { path: 'wave.vcd', destination: absoluteDestination },
            { path: 'missing.bin', destination: relativeDestination },
            {
                path: '.iverilog-cache/output.bin',
                destination: path.join(root, 'prefix-is-not-reserved.bin'),
            },
            { path: 'not-produced.txt', destination: path.join(root, 'not-produced.txt') },
        ], { cwd: root });

        assert.deepEqual(await readFile(absoluteDestination), bytes);
        assert.equal(await readFile(path.join(root, relativeDestination), 'utf8'), 'not returned');
        assert.deepEqual(
            await readFile(path.join(root, 'prefix-is-not-reserved.bin')),
            Buffer.from([0x42]),
        );
        assert.deepEqual(results.map(result => ({
            path: result.path,
            written: result.written,
            size: result.size,
        })), [
            { path: 'wave.vcd', written: true, size: 4 },
            { path: 'missing.bin', written: true, size: 12 },
            { path: '.iverilog-cache/output.bin', written: true, size: 1 },
            { path: 'not-produced.txt', written: false, size: 0 },
        ]);
        assert.equal((await readdir(root)).includes('unrequested.log'), false);
        assert.equal((await readdir(root)).some(name => name.includes('.tmp')), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects duplicate and source-aliasing artifact requests before writing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-alias-'));
    const source = path.join(root, 'source.v');
    const destination = path.join(root, 'same.out');

    try {
        await writeFile(source, 'module source; endmodule\n');
        const artifacts = new Map([
            ['same.vcd', Buffer.from('one')],
            ['other.vcd', Buffer.from('two')],
        ]);

        await assert.rejects(
            writeRequestedArtifacts(artifacts, [
                { path: 'same.vcd', destination },
                { path: 'same.vcd', destination: path.join(root, 'other.out') },
            ], { cwd: root }),
            /duplicate artifact path/i,
        );
        await assert.rejects(
            writeRequestedArtifacts(artifacts, [
                { path: 'same.vcd', destination },
                { path: 'other.vcd', destination: path.join(root, '.', 'same.out') },
            ], { cwd: root }),
            /duplicate artifact destination/i,
        );
        await assert.rejects(
            writeRequestedArtifacts(artifacts, [
                { path: 'same.vcd', destination },
            ], {
                cwd: root,
                protectedVirtualPaths: ['same.vcd'],
            }),
            /aliases a source path/i,
        );
        await assert.rejects(
            writeRequestedArtifacts(artifacts, [
                { path: 'same.vcd', destination: source },
            ], {
                cwd: root,
                protectedHostPaths: [source],
            }),
            /aliases a source destination/i,
        );
        assert.equal(await readFile(source, 'utf8'), 'module source; endmodule\n');
        assert.equal((await readdir(root)).some(name => name.includes('.tmp')), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('folds Windows comparison keys without changing filesystem I/O paths', async () => {
    const ioPaths: Array<{ operation: string; path: string }> = [];
    const fileSystem = {
        pathComparisonKey(hostPath: string) {
            return hostPath.toLowerCase();
        },
        async lstat(hostPath: string): Promise<never> {
            ioPaths.push({ operation: 'lstat', path: hostPath });
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        async realpath(hostPath: string): Promise<string> {
            ioPaths.push({ operation: 'realpath', path: hostPath });
            return hostPath;
        },
        async openExclusive(tempPath: string) {
            ioPaths.push({ operation: 'open', path: tempPath });
            return {
                async writeFile() {},
                async sync() {},
                async close() {},
            };
        },
        async rename(oldPath: string, newPath: string) {
            ioPaths.push({ operation: 'rename-from', path: oldPath });
            ioPaths.push({ operation: 'rename-to', path: newPath });
        },
        async unlink(hostPath: string) {
            ioPaths.push({ operation: 'unlink', path: hostPath });
        },
    } satisfies ArtifactWriterFileSystem & {
        pathComparisonKey(hostPath: string): string;
    };
    const cwd = path.join(path.parse(process.cwd()).root, 'WorkspaceRoot');
    const upperDestination = path.join(cwd, 'CaseSensitive', 'WaveCase.VCD');
    const lowerDestination = path.join(cwd, 'casesensitive', 'wavecase.vcd');

    await assert.rejects(
        writeRequestedArtifacts(new Map([
            ['first.vcd', Buffer.from('first')],
            ['second.vcd', Buffer.from('second')],
        ]), [
            { path: 'first.vcd', destination: upperDestination },
            { path: 'second.vcd', destination: lowerDestination },
        ], { cwd, fileSystem }),
        /duplicate artifact destination/i,
    );
    assert.equal(ioPaths.length, 0);

    await writeRequestedArtifacts(
        new Map([['wave.vcd', Buffer.from('wave')]]),
        [{ path: 'wave.vcd', destination: upperDestination }],
        { cwd, fileSystem },
    );

    assert.equal(
        ioPaths.find(entry => entry.operation === 'lstat')?.path,
        upperDestination,
    );
    assert.equal(
        ioPaths.find(entry => entry.operation === 'rename-to')?.path,
        upperDestination,
    );
    const tempPath = ioPaths.find(entry => entry.operation === 'open')?.path;
    assert.ok(tempPath !== undefined);
    assert.equal(path.dirname(tempPath), path.dirname(upperDestination));
    assert.match(path.basename(tempPath), /^\.WaveCase\.VCD\./);
});

test('rejects symlink destinations without modifying their targets', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-link-'));
    const target = path.join(root, 'target.vcd');
    const destination = path.join(root, 'linked.vcd');

    try {
        await writeFile(target, 'original');
        try {
            await symlink(target, destination, 'file');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                t.skip(`file links are unavailable: ${code}`);
                return;
            }
            throw error;
        }

        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('replacement')]]),
                [{ path: 'wave.vcd', destination }],
                { cwd: root },
            ),
            /symbolic link/i,
        );
        assert.equal(await readFile(target, 'utf8'), 'original');
        assert.equal((await readdir(root)).some(name => name.includes('.tmp')), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects protected destinations reached through a symlink parent', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-parent-link-'));
    const realDirectory = path.join(root, 'real');
    const linkedDirectory = path.join(root, 'linked');
    const source = path.join(realDirectory, 'source.v');

    try {
        await mkdir(realDirectory);
        await writeFile(source, 'module source; endmodule\n');
        try {
            await symlink(realDirectory, linkedDirectory, 'dir');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                t.skip(`directory links are unavailable: ${code}`);
                return;
            }
            throw error;
        }

        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['source.v', Buffer.from('replacement')]]),
                [{
                    path: 'source.v',
                    destination: path.join(linkedDirectory, 'source.v'),
                }],
                { cwd: root, protectedHostPaths: [source] },
            ),
            /aliases a source destination/i,
        );
        assert.equal(await readFile(source, 'utf8'), 'module source; endmodule\n');
        assert.equal((await readdir(realDirectory)).some(name => name.includes('.tmp')), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects a destination whose symlink parent changes after validation', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-parent-race-'));
    const safeDirectory = path.join(root, 'safe');
    const sourceDirectory = path.join(root, 'source');
    const linkedDirectory = path.join(root, 'linked');
    const replacementLink = path.join(root, 'replacement-link');
    const source = path.join(sourceDirectory, 'top.v');
    const destination = path.join(linkedDirectory, 'top.v');

    try {
        await Promise.all([
            mkdir(safeDirectory),
            mkdir(sourceDirectory),
        ]);
        await writeFile(source, 'module top; endmodule\n');
        try {
            await Promise.all([
                symlink(safeDirectory, linkedDirectory, 'dir'),
                symlink(sourceDirectory, replacementLink, 'dir'),
            ]);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                t.skip(`directory links are unavailable: ${code}`);
                return;
            }
            throw error;
        }

        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('replacement')]]),
                [{ path: 'wave.vcd', destination }],
                {
                    cwd: root,
                    protectedHostPaths: [source],
                    fileSystem: {
                        async openExclusive(tempPath) {
                            await rename(replacementLink, linkedDirectory);
                            return open(tempPath, 'wx', 0o600);
                        },
                    },
                },
            ),
            /symbolic link|destination parent/i,
        );
        assert.equal(await readFile(source, 'utf8'), 'module top; endmodule\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('cleans sibling temporary files when fsync fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-fail-'));
    const openedPaths: string[] = [];
    const fileSystem: ArtifactWriterFileSystem = {
        async openExclusive(tempPath) {
            openedPaths.push(tempPath);
            const handle = await open(tempPath, 'wx', 0o600);
            return {
                writeFile: data => handle.writeFile(data),
                async sync() {
                    await handle.sync();
                    throw new Error('injected fsync failure');
                },
                close: () => handle.close(),
            };
        },
    };

    try {
        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('partial')]]),
                [{ path: 'wave.vcd', destination: path.join(root, 'wave.vcd') }],
                { cwd: root, fileSystem },
            ),
            /injected fsync failure/,
        );
        assert.equal(openedPaths.length, 1);
        assert.equal(path.dirname(openedPaths[0]), root);
        assert.equal((await readdir(root)).length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reports both synchronization and close failures', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-close-'));
    const syncError = new Error('injected synchronization failure');
    const closeError = new Error('injected close failure');
    let closeCalls = 0;
    const fileSystem: ArtifactWriterFileSystem = {
        async openExclusive() {
            return {
                async writeFile() {},
                async sync() {
                    throw syncError;
                },
                async close() {
                    closeCalls += 1;
                    throw closeError;
                },
            };
        },
    };

    try {
        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('partial')]]),
                [{ path: 'wave.vcd', destination: path.join(root, 'wave.vcd') }],
                { cwd: root, fileSystem },
            ),
            error => reportsErrors(error, [syncError, closeError]),
        );
        assert.equal(closeCalls, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reports cleanup unlink failures with the original write failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-unlink-'));
    const writeError = new Error('injected write failure');
    const cleanupError = new Error('injected unlink failure');
    const fileSystem: ArtifactWriterFileSystem = {
        async openExclusive() {
            return {
                async writeFile() {
                    throw writeError;
                },
                async sync() {},
                async close() {},
            };
        },
        async unlink() {
            throw cleanupError;
        },
    };

    try {
        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('partial')]]),
                [{ path: 'wave.vcd', destination: path.join(root, 'wave.vcd') }],
                { cwd: root, fileSystem },
            ),
            error => reportsErrors(error, [writeError, cleanupError]),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reports non-Error cleanup failures without replacing them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-null-cleanup-'));
    const writeError = new Error('injected write failure');
    const cleanupError = undefined;
    const fileSystem: ArtifactWriterFileSystem = {
        async openExclusive() {
            return {
                async writeFile() {
                    throw writeError;
                },
                async sync() {},
                async close() {},
            };
        },
        async unlink() {
            throw cleanupError;
        },
    };

    try {
        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('partial')]]),
                [{ path: 'wave.vcd', destination: path.join(root, 'wave.vcd') }],
                { cwd: root, fileSystem },
            ),
            error => reportsErrors(error, [writeError, cleanupError]),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('cleans uncommitted temporary files after a later rename fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-rename-'));
    const renameError = new Error('injected rename failure');
    let renames = 0;
    const fileSystem: ArtifactWriterFileSystem = {
        async rename(oldPath, newPath) {
            renames += 1;
            if (renames === 2) throw renameError;
            await rename(oldPath, newPath);
        },
    };

    try {
        let captured: unknown;
        await assert.rejects(
            writeRequestedArtifacts(new Map([
                ['first.vcd', Buffer.from('first')],
                ['second.vcd', Buffer.from('second')],
            ]), [
                { path: 'first.vcd', destination: path.join(root, 'first.vcd') },
                { path: 'second.vcd', destination: path.join(root, 'second.vcd') },
            ], { cwd: root, fileSystem }),
            error => {
                captured = error;
                return error instanceof Error && error.name === 'ArtifactWriteError';
            },
        );
        const artifactError = captured as Error & {
            cause: unknown;
            results: Array<{
                path: string;
                destination: string;
                written: boolean;
                size: number;
            }>;
        };
        assert.equal(artifactError.cause, renameError);
        assert.deepEqual(artifactError.results, [
            {
                path: 'first.vcd',
                destination: path.join(root, 'first.vcd'),
                written: true,
                size: 5,
            },
            {
                path: 'second.vcd',
                destination: path.join(root, 'second.vcd'),
                written: false,
                size: 0,
            },
        ]);
        assert.equal(await readFile(path.join(root, 'first.vcd'), 'utf8'), 'first');
        await assert.rejects(lstat(path.join(root, 'second.vcd')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(root), ['first.vcd']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('stops committing artifacts when aborted between renames', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-rename-abort-'));
    const controller = new AbortController();
    let renames = 0;
    const fileSystem: ArtifactWriterFileSystem = {
        async rename(oldPath, newPath) {
            renames += 1;
            await rename(oldPath, newPath);
            if (renames === 1) controller.abort();
        },
    };

    try {
        let captured: unknown;
        await assert.rejects(
            writeRequestedArtifacts(new Map([
                ['first.vcd', Buffer.from('first')],
                ['second.vcd', Buffer.from('second')],
            ]), [
                { path: 'first.vcd', destination: path.join(root, 'first.vcd') },
                { path: 'second.vcd', destination: path.join(root, 'second.vcd') },
            ], {
                cwd: root,
                signal: controller.signal,
                fileSystem,
            }),
            error => {
                captured = error;
                return error instanceof Error && error.name === 'ArtifactWriteError';
            },
        );
        const artifactError = captured as Error & {
            cause: unknown;
            results: Array<{
                path: string;
                destination: string;
                written: boolean;
                size: number;
            }>;
        };
        assert.ok(artifactError.cause instanceof Error);
        assert.equal(artifactError.cause.name, 'AbortError');
        assert.deepEqual(artifactError.results, [
            {
                path: 'first.vcd',
                destination: path.join(root, 'first.vcd'),
                written: true,
                size: 5,
            },
            {
                path: 'second.vcd',
                destination: path.join(root, 'second.vcd'),
                written: false,
                size: 0,
            },
        ]);
        assert.equal(renames, 1);
        assert.equal(await readFile(path.join(root, 'first.vcd'), 'utf8'), 'first');
        await assert.rejects(lstat(path.join(root, 'second.vcd')), { code: 'ENOENT' });
        assert.deepEqual(await readdir(root), ['first.vcd']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('preserves the original partial-write cause alongside cleanup diagnostics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-partial-cleanup-'));
    const renameError = new Error('injected rename failure');
    const cleanupError = new Error('injected cleanup failure');
    let renames = 0;
    const fileSystem: ArtifactWriterFileSystem = {
        async rename(oldPath, newPath) {
            renames += 1;
            if (renames === 2) throw renameError;
            await rename(oldPath, newPath);
        },
        async unlink(hostPath) {
            if (path.basename(hostPath).startsWith('.second.vcd.')) {
                throw cleanupError;
            }
            await unlink(hostPath);
        },
    };

    try {
        let captured: unknown;
        await assert.rejects(
            writeRequestedArtifacts(new Map([
                ['first.vcd', Buffer.from('first')],
                ['second.vcd', Buffer.from('second')],
            ]), [
                { path: 'first.vcd', destination: path.join(root, 'first.vcd') },
                { path: 'second.vcd', destination: path.join(root, 'second.vcd') },
            ], { cwd: root, fileSystem }),
            error => {
                captured = error;
                return error instanceof Error && error.name === 'ArtifactWriteError';
            },
        );
        const artifactError = captured as Error & {
            cause: unknown;
            cleanupErrors: readonly unknown[];
            errors: readonly unknown[];
            results: Array<{ path: string; written: boolean; size: number }>;
        };
        assert.equal(artifactError.cause, renameError);
        assert.deepEqual(artifactError.cleanupErrors, [cleanupError]);
        assert.deepEqual(artifactError.errors, [renameError, cleanupError]);
        assert.deepEqual(artifactError.results.map(result => ({
            path: result.path,
            written: result.written,
            size: result.size,
        })), [
            { path: 'first.vcd', written: true, size: 5 },
            { path: 'second.vcd', written: false, size: 0 },
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('cleans staged temporary files when aborted before commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-abort-'));
    const controller = new AbortController();
    const fileSystem: ArtifactWriterFileSystem = {
        async openExclusive(tempPath) {
            const handle = await open(tempPath, 'wx', 0o600);
            return {
                writeFile: data => handle.writeFile(data),
                async sync() {
                    await handle.sync();
                    controller.abort();
                },
                close: () => handle.close(),
            };
        },
    };

    try {
        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('complete bytes')]]),
                [{ path: 'wave.vcd', destination: path.join(root, 'wave.vcd') }],
                { cwd: root, signal: controller.signal, fileSystem },
            ),
            error => error instanceof Error && error.name === 'AbortError',
        );
        assert.equal((await readdir(root)).length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('does not create missing artifact destination directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-artifact-parent-'));
    const destination = path.join(root, 'missing', 'wave.vcd');

    try {
        await assert.rejects(
            writeRequestedArtifacts(
                new Map([['wave.vcd', Buffer.from('data')]]),
                [{ path: 'wave.vcd', destination }],
                { cwd: root },
            ),
            { code: 'ENOENT' },
        );
        await assert.rejects(lstat(path.dirname(destination)), { code: 'ENOENT' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function reportsErrors(error: unknown, expected: readonly unknown[]): boolean {
    assert.ok(error instanceof ArtifactWriteError);
    const reported = error as ArtifactWriteError & {
        cleanupErrors?: readonly unknown[];
    };
    assert.deepEqual(reported.errors, expected);
    assert.equal(reported.cause, expected[0]);
    assert.deepEqual(reported.cleanupErrors, expected.slice(1));
    return true;
}
