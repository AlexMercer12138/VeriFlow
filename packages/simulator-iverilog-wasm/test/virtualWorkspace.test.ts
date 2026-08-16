import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildVirtualWorkspace } from '../src/virtualWorkspace';

test('maps project sources in dependency order and keeps runtime data out of sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-workspace-'));
    const first = path.join(root, 'rtl', 'first.v');
    const second = path.join(root, 'rtl', 'second.v');
    const memory = path.join(root, 'data', 'memory.bin');

    try {
        await Promise.all([
            mkdir(path.dirname(first), { recursive: true }),
            mkdir(path.dirname(memory), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(first, Buffer.from([0xff, 0x00, 0x31])),
            writeFile(second, 'module second; endmodule\n'),
            writeFile(memory, Buffer.from([0x80, 0x00, 0x7f])),
            writeFile(path.join(root, 'data', 'unrequested.hex'), 'ff\n'),
        ]);

        const reads = new Map<string, number>();
        const workspace = await buildVirtualWorkspace({
            cwd: root,
            files: [second, first],
            runtimeFiles: [memory],
            includeDirs: [],
        }, {
            async readFile(hostPath) {
                reads.set(hostPath, (reads.get(hostPath) ?? 0) + 1);
                return readFile(hostPath);
            },
        });

        assert.deepEqual(workspace.sources, [
            'workspace/rtl/second.v',
            'workspace/rtl/first.v',
        ]);
        assert.deepEqual(
            workspace.files.map(file => file.path),
            [...workspace.sources, 'workspace/data/memory.bin'],
        );
        assert.deepEqual([...workspace.files[1].data], [0xff, 0x00, 0x31]);
        assert.deepEqual([...workspace.files[2].data], [0x80, 0x00, 0x7f]);
        assert.deepEqual(workspace.includeDirs, []);
        assert.equal(workspace.hostPathByVirtualPath.get(workspace.sources[0]), second);
        assert.equal(reads.size, 3);
        assert.ok([...reads.values()].every(count => count === 1));
        assert.equal(
            workspace.files.some(file => file.path.includes('unrequested.hex')),
            false,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('uses the Node reader when filesystem overrides are empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-default-reader-'));
    const source = path.join(root, 'top.v');

    try {
        await writeFile(source, 'module top; endmodule\n');
        const workspace = await buildVirtualWorkspace({
            cwd: root,
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
        }, {});

        assert.equal(
            new TextDecoder().decode(workspace.files[0].data),
            'module top; endmodule\n',
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('uses the longest configured root and preserves include-root indexes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-roots-'));
    const broadRoot = path.join(root, 'vendor');
    const narrowRoot = path.join(broadRoot, 'nested');
    const projectFile = path.join(root, 'top.v');
    const broadFile = path.join(broadRoot, 'broad.v');
    const narrowFile = path.join(narrowRoot, 'narrow.vh');

    try {
        await mkdir(narrowRoot, { recursive: true });
        await Promise.all([
            writeFile(projectFile, 'module top; endmodule\n'),
            writeFile(broadFile, '`define BROAD 1\n'),
            writeFile(narrowFile, '`define NARROW 1\n'),
        ]);

        const workspace = await buildVirtualWorkspace({
            cwd: root,
            files: [projectFile, broadFile, narrowFile],
            runtimeFiles: [],
            includeDirs: [broadRoot, narrowRoot],
        });

        assert.deepEqual(workspace.sources, [
            'workspace/top.v',
            'libraries/0/broad.v',
            'libraries/1/narrow.vh',
        ]);
        assert.deepEqual(workspace.includeDirs, ['libraries/0', 'libraries/1']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('resolves relative sources and include roots from the request cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-relative-'));
    const projectFile = path.join(root, 'rtl', 'top.v');
    const libraryFile = path.join(root, 'vendor', 'defs.vh');

    try {
        await Promise.all([
            mkdir(path.dirname(projectFile), { recursive: true }),
            mkdir(path.dirname(libraryFile), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(projectFile, 'module top; endmodule\n'),
            writeFile(libraryFile, '`define WIDTH 8\n'),
        ]);

        const workspace = await buildVirtualWorkspace({
            cwd: root,
            files: ['rtl/top.v', 'vendor/defs.vh'],
            runtimeFiles: [],
            includeDirs: ['vendor'],
        });

        assert.deepEqual(workspace.sources, [
            'workspace/rtl/top.v',
            'libraries/0/defs.vh',
        ]);
        assert.equal(
            workspace.hostPathByVirtualPath.get('workspace/rtl/top.v'),
            projectFile,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('maps external files to stable hashes of normalized parent directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-external-'));
    const projectRoot = path.join(root, 'project');
    const externalRoot = path.join(root, 'external', 'rtl', '..', 'rtl');
    const externalFile = path.join(externalRoot, 'outside.v');

    try {
        await Promise.all([
            mkdir(projectRoot, { recursive: true }),
            mkdir(path.normalize(externalRoot), { recursive: true }),
        ]);
        await writeFile(externalFile, 'module outside; endmodule\n');

        const first = await buildVirtualWorkspace({
            cwd: projectRoot,
            files: [externalFile],
            runtimeFiles: [],
            includeDirs: [],
        });
        const second = await buildVirtualWorkspace({
            cwd: `${projectRoot}${path.sep}.`,
            files: [path.normalize(externalFile)],
            runtimeFiles: [],
            includeDirs: [],
        });
        const digest = createHash('sha256')
            .update(path.dirname(path.normalize(externalFile)))
            .digest('hex');

        assert.deepEqual(first.sources, [`external/${digest}/outside.v`]);
        assert.deepEqual(second.sources, first.sources);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('normalizes Windows drives and separators into valid POSIX virtual paths', async () => {
    const readPaths: string[] = [];
    const workspace = await buildVirtualWorkspace({
        cwd: 'c:\\repo',
        files: [
            'C:\\repo\\rtl\\top.v',
            'D:\\sdk\\include\\defs.vh',
            'E:\\outside\\data.hex',
        ],
        runtimeFiles: [],
        includeDirs: ['d:\\sdk\\include'],
    }, {
        async readFile(hostPath) {
            readPaths.push(hostPath);
            return Buffer.from(hostPath);
        },
        async realpath(hostPath) {
            return hostPath;
        },
    });

    assert.deepEqual(workspace.sources.slice(0, 2), [
        'workspace/rtl/top.v',
        'libraries/0/defs.vh',
    ]);
    assert.match(workspace.sources[2], /^external\/[0-9a-f]{64}\/data\.hex$/);
    assert.ok(workspace.files.every(file => !/[\\:]/.test(file.path)));
    assert.deepEqual(readPaths, [
        'C:\\repo\\rtl\\top.v',
        'D:\\sdk\\include\\defs.vh',
        'E:\\outside\\data.hex',
    ]);
});

test('rejects duplicate logical paths before reading host files', async () => {
    let reads = 0;

    await assert.rejects(
        buildVirtualWorkspace({
            cwd: '/project',
            files: ['/project/rtl/../top.v'],
            runtimeFiles: ['/project/top.v'],
            includeDirs: [],
        }, {
            async readFile() {
                reads += 1;
                return Buffer.alloc(0);
            },
        }),
        /duplicate virtual path.*workspace\/top\.v/i,
    );
    assert.equal(reads, 0);
});

test('rejects source aliases that resolve to the same host file', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-source-alias-'));
    const source = path.join(root, 'source.v');
    const alias = path.join(root, 'alias.v');
    let reads = 0;

    try {
        await writeFile(source, 'module source; endmodule\n');
        try {
            await symlink(source, alias, 'file');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                t.skip(`file links are unavailable: ${code}`);
                return;
            }
            throw error;
        }

        await assert.rejects(
            buildVirtualWorkspace({
                cwd: root,
                files: [source, alias],
                runtimeFiles: [],
                includeDirs: [],
            }, {
                async readFile(hostPath) {
                    reads += 1;
                    return readFile(hostPath);
                },
            }),
            /duplicate host file|duplicate virtual path/i,
        );
        assert.equal(reads, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
