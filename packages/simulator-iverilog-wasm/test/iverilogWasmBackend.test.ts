import assert from 'node:assert/strict';
import {
    copyFile,
    mkdtemp,
    mkdir,
    readFile,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import test from 'node:test';

import {
    IverilogWasmBackend,
    type IverilogApiProvider,
} from '../src/iverilogWasmBackend';
import type {
    IverilogApi,
    RunResult,
    SimulateRequest,
} from '../src/iverilogApi';

const packageRoot = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(packageRoot, 'test', 'fixtures');

function apiReturning(
    result: RunResult,
    requests: SimulateRequest[] = [],
): IverilogApi {
    return {
        async compile(): Promise<never> {
            throw new Error('compile() must not be called');
        },
        async run(): Promise<never> {
            throw new Error('run() must not be called');
        },
        async simulate(request): Promise<RunResult> {
            requests.push(request);
            return result;
        },
    };
}

function providerFor(api: IverilogApi): IverilogApiProvider {
    return async () => api;
}

async function createSourceRoot(prefix: string): Promise<{
    root: string;
    source: string;
}> {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    const source = path.join(root, 'top.v');
    await writeFile(source, 'module top; endmodule\n');
    return { root, source };
}

function messagePortCount(): number {
    return process.getActiveResourcesInfo()
        .filter(resource => resource === 'MessagePort').length;
}

test('forwards the normalized request to one Verilog-2005 simulation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-forward-'));
    const sourceDir = path.join(root, 'rtl');
    const includeDir = path.join(root, 'include');
    const dataDir = path.join(root, 'data');
    const source = path.join(sourceDir, 'top.v');
    const runtimeData = path.join(dataDir, 'input.hex');
    const waveFile = path.join(sourceDir, 'top.vcd');
    const controller = new AbortController();
    const requests: SimulateRequest[] = [];
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: 'PASS\n',
        stderr: '',
        timings: { preprocess: 10, compile: 20, run: 30 },
        artifacts: new Map([[
            'workspace/rtl/top.vcd',
            Buffer.from('$date\n$end\n'),
        ]]),
    }, requests);

    try {
        await Promise.all([
            mkdir(sourceDir),
            mkdir(includeDir),
            mkdir(dataDir),
        ]);
        await Promise.all([
            writeFile(source, 'module top; endmodule\n'),
            writeFile(runtimeData, '2a\n'),
        ]);

        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [runtimeData],
            includeDirs: [includeDir],
            defines: { TRACE: true, WIDTH: 8 },
            plusargs: ['+seed=42'],
            artifacts: [{
                kind: 'vcd',
                path: 'top.vcd',
                destination: waveFile,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: sourceDir,
            topModule: 'top',
            timeoutMs: 1_234,
            signal: controller.signal,
        });

        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0], {
            files: [
                {
                    path: 'workspace/rtl/top.v',
                    data: new Uint8Array(await readFile(source)),
                },
                {
                    path: 'workspace/data/input.hex',
                    data: new Uint8Array(await readFile(runtimeData)),
                },
            ],
            sources: ['workspace/rtl/top.v'],
            includeDirs: ['libraries/0'],
            runCwd: 'workspace/rtl',
            generation: '2005',
            top: 'top',
            defines: { TRACE: true, WIDTH: 8 },
            plusargs: ['+seed=42'],
            artifacts: ['workspace/rtl/top.vcd'],
            timeoutMs: 1_234,
            signal: controller.signal,
        });
        assert.equal(result.success, true);
        assert.equal(result.backendId, 'builtin');
        assert.equal(result.stage, 'run');
        assert.deepEqual(result.timings, {
            preprocess: 0.01,
            compile: 0.02,
            run: 0.03,
            artifact: result.timings.artifact,
        });
        assert.ok((result.timings.artifact ?? -1) >= 0);
        assert.equal(result.elapsedTime, (
            0.01 + 0.02 + 0.03 + (result.timings.artifact ?? 0)
        ));
        assert.deepEqual(result.commands, {});
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: 'top.vcd',
            destination: waveFile,
            required: true,
            written: true,
            size: 11,
        }]);
        assert.equal(result.waveFile, waveFile);
        assert.equal(await readFile(waveFile, 'utf8'), '$date\n$end\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('stages nested artifact directories without adding marker files to sources', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-artifact-dir-');
    const destinationDir = path.join(root, 'host-waves');
    const destination = path.join(destinationDir, 'top.vcd');
    const requests: SimulateRequest[] = [];
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: 'PASS\n',
        stderr: '',
        timings: { preprocess: 1, compile: 1, run: 1 },
        artifacts: new Map([[
            'workspace/waves/top.vcd',
            Buffer.from('nested vcd'),
        ]]),
    }, requests);

    try {
        await mkdir(destinationDir);
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'waves/top.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            topModule: 'top',
            timeoutMs: 1_000,
        });

        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].sources, ['workspace/top.v']);
        assert.equal(requests[0].runCwd, 'workspace');
        assert.deepEqual(requests[0].artifacts, ['workspace/waves/top.vcd']);
        const marker = requests[0].files.find(file => (
            file.path.startsWith('workspace/waves/')
        ));
        assert.ok(marker);
        assert.match(
            marker.path,
            /^workspace\/waves\/\.veriflow-artifact-dir(?:-\d+)?$/,
        );
        assert.equal((marker.data as Uint8Array).byteLength, 0);
        assert.equal(requests[0].sources.includes(marker.path), false);
        assert.equal(result.success, true);
        assert.equal(await readFile(destination, 'utf8'), 'nested vcd');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('stages an otherwise empty run cwd without adding its marker to sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-run-cwd-'));
    const cwd = path.join(root, 'project');
    const sourceRoot = path.join(root, 'external');
    const source = path.join(sourceRoot, 'top.v');
    const requests: SimulateRequest[] = [];
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: 'PASS\n',
        stderr: '',
        timings: { preprocess: 1, compile: 1, run: 1 },
        artifacts: new Map(),
    }, requests);

    try {
        await Promise.all([
            mkdir(cwd, { recursive: true }),
            mkdir(sourceRoot, { recursive: true }),
        ]);
        await writeFile(source, [
            'module top;',
            '  initial begin',
            '    $display("PASS");',
            '    $finish;',
            '  end',
            'endmodule',
            '',
        ].join('\n'));

        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(cwd, 'top.out'),
            cwd,
            topModule: 'top',
            timeoutMs: 1_000,
        });

        assert.equal(result.success, true);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].runCwd, 'workspace');
        assert.match(requests[0].sources[0], /^external\/[0-9a-f]{64}\/top\.v$/);
        const marker = requests[0].files.find(file => (
            /^workspace\/\.veriflow-run-cwd(?:-\d+)?$/.test(file.path)
        ));
        assert.ok(marker);
        assert.equal((marker.data as Uint8Array).byteLength, 0);
        assert.equal(requests[0].sources.includes(marker.path), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('maps a multi-level logical artifact path to a safe upstream key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-external-wave-'));
    const cwd = path.join(root, 'demo', 'project', 'rtl');
    const source = path.join(cwd, 'top.v');
    const destinationDir = path.join(root, 'copied');
    const destination = path.join(destinationDir, 'top.vcd');
    const requests: SimulateRequest[] = [];
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: 'PASS\n',
        stderr: '',
        timings: { preprocess: 1, compile: 1, run: 1 },
        artifacts: new Map([[
            'workspace/waves/top.vcd',
            Buffer.from('external vcd'),
        ]]),
    }, requests);

    try {
        await Promise.all([
            mkdir(cwd, { recursive: true }),
            mkdir(destinationDir, { recursive: true }),
        ]);
        await writeFile(source, 'module top; endmodule\n');

        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: '../../waves/top.vcd',
                destination,
                required: true,
            }],
            output: path.join(cwd, 'top.out'),
            cwd,
            topModule: 'top',
            timeoutMs: 1_000,
        });

        assert.equal(requests.length, 1);
        assert.equal(requests[0].runCwd, 'workspace/project/rtl');
        assert.deepEqual(requests[0].artifacts, ['workspace/waves/top.vcd']);
        assert.ok(requests[0].files.some(file => (
            /^workspace\/waves\/\.veriflow-artifact-dir(?:-\d+)?$/.test(file.path)
        )));
        assert.equal(result.success, true);
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: '../../waves/top.vcd',
            destination,
            required: true,
            written: true,
            size: 12,
        }]);
        assert.equal(result.waveFile, destination);
        assert.equal(await readFile(destination, 'utf8'), 'external vcd');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects unsafe or conflicting artifact paths before calling the API', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-artifact-input-'));
    const source = path.join(root, 'top.v');
    const runtimeFile = path.join(root, 'vectors', 'input.hex');
    let apiCalls = 0;
    const api: IverilogApi = {
        compile: async () => { throw new Error('compile() must not be called'); },
        run: async () => { throw new Error('run() must not be called'); },
        async simulate(): Promise<RunResult> {
            apiCalls += 1;
            return {
                success: true,
                stage: 'run',
                exitCode: 0,
                stdout: '',
                stderr: '',
                timings: {},
                artifacts: new Map(),
            };
        },
    };

    try {
        await mkdir(path.dirname(runtimeFile), { recursive: true });
        await Promise.all([
            writeFile(source, 'module top; endmodule\n'),
            writeFile(runtimeFile, '2a\n'),
        ]);
        const invalidArtifactSets = [
            ['../'],
            ['waves/../escape.vcd'],
            ['top.v'],
            ['vectors/input.hex'],
            ['waves/top.vcd', 'waves/top.vcd'],
            ['waves', 'waves/top.vcd'],
        ];

        for (const artifactPaths of invalidArtifactSets) {
            await assert.rejects(
                new IverilogWasmBackend(providerFor(api)).compileAndRun({
                    files: [source],
                    runtimeFiles: [runtimeFile],
                    includeDirs: [],
                    defines: {},
                    plusargs: [],
                    artifacts: artifactPaths.map((artifactPath, index) => ({
                        kind: 'file' as const,
                        path: artifactPath,
                        destination: path.join(root, `artifact-${index}`),
                    })),
                    output: path.join(root, 'top.out'),
                    cwd: root,
                    timeoutMs: 1_000,
                }),
                /artifact path|duplicate artifact|aliases a source/i,
            );
        }
        assert.equal(apiCalls, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('preflights duplicate and protected artifact destinations before simulation', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-destination-input-');
    let apiCalls = 0;
    const api: IverilogApi = {
        compile: async () => { throw new Error('compile() must not be called'); },
        run: async () => { throw new Error('run() must not be called'); },
        async simulate(): Promise<RunResult> {
            apiCalls += 1;
            return {
                success: true,
                stage: 'run',
                exitCode: 0,
                stdout: '',
                stderr: '',
                timings: {},
                artifacts: new Map(),
            };
        },
    };

    try {
        const destination = path.join(root, 'same.vcd');
        const requests = [
            [
                { kind: 'file' as const, path: 'first.vcd', destination },
                {
                    kind: 'file' as const,
                    path: 'second.vcd',
                    destination: path.join(root, '.', 'same.vcd'),
                },
            ],
            [{ kind: 'file' as const, path: 'wave.vcd', destination: source }],
        ];

        for (const artifacts of requests) {
            const result = await new IverilogWasmBackend(
                providerFor(api),
            ).compileAndRun({
                files: [source],
                runtimeFiles: [],
                includeDirs: [],
                defines: {},
                plusargs: [],
                artifacts,
                output: path.join(root, 'top.out'),
                cwd: root,
                timeoutMs: 1_000,
            });

            assert.equal(result.success, false);
            assert.equal(result.stage, 'infrastructure');
        }
        assert.equal(apiCalls, 0);
        assert.equal(await readFile(source, 'utf8'), 'module top; endmodule\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('preflights artifact destinations through symlink parents before simulation', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-destination-link-'));
    const physicalRoot = path.join(root, 'physical');
    const linkedRoot = path.join(root, 'linked');
    const source = path.join(physicalRoot, 'top.v');
    let apiCalls = 0;
    const api: IverilogApi = {
        compile: async () => { throw new Error('compile() must not be called'); },
        run: async () => { throw new Error('run() must not be called'); },
        async simulate(): Promise<RunResult> {
            apiCalls += 1;
            return {
                success: true,
                stage: 'run',
                exitCode: 0,
                stdout: '',
                stderr: '',
                timings: {},
                artifacts: new Map([['workspace/wave.vcd', Buffer.from('wave')]]),
            };
        },
    };

    try {
        await mkdir(physicalRoot, { recursive: true });
        await writeFile(source, 'module top; endmodule\n');
        try {
            await symlink(physicalRoot, linkedRoot, 'dir');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                t.skip(`directory links are unavailable: ${code}`);
                return;
            }
            throw error;
        }

        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'wave.vcd',
                destination: path.join(linkedRoot, 'top.v'),
                required: true,
            }],
            output: path.join(physicalRoot, 'top.out'),
            cwd: physicalRoot,
            timeoutMs: 1_000,
        });

        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(apiCalls, 0);
        assert.equal(await readFile(source, 'utf8'), 'module top; endmodule\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('keeps compile and run stage timings separate and maps diagnostics to host paths', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-diagnostic-');
    const api = apiReturning({
        success: false,
        stage: 'preprocess',
        exitCode: 2,
        stdout: '',
        stderr: 'workspace/top.v:1: syntax error\n',
        timings: { preprocess: 7, compile: 11 },
        artifacts: new Map(),
    });

    try {
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(result.success, false);
        assert.equal(result.stage, 'compile');
        assert.equal(result.timings.run, undefined);
        assert.deepEqual(result.timings, { preprocess: 0.007, compile: 0.011 });
        assert.equal(result.elapsedTime, 0.018);
        assert.match(result.stderr, new RegExp(`${escapeRegExp(source)}:1:`));
        assert.deepEqual(result.logEntries.filter(
            (entry: { level: string }) => entry.level === 'ERROR',
        ), [{
            level: 'ERROR',
            message: 'syntax error',
            fileRef: source,
            lineNo: 1,
        }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('does not remap host path text introduced by diagnostic mapping', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-remap-'));
    const topSource = path.join(root, 'top.v');
    const nestedDirectory = path.join(root, 'workspace');
    const nestedSource = path.join(nestedDirectory, 'top.v');
    const api = apiReturning({
        success: false,
        stage: 'compile',
        exitCode: 2,
        stdout: '',
        stderr: 'workspace/workspace/top.v:1: syntax error\n',
        timings: { preprocess: 1, compile: 1 },
        artifacts: new Map(),
    });

    try {
        await mkdir(nestedDirectory);
        await Promise.all([
            writeFile(topSource, 'module top; endmodule\n'),
            writeFile(nestedSource, 'module nested; endmodule\n'),
        ]);
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [topSource, nestedSource],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(result.stderr, `${nestedSource}:1: syntax error\n`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('maps only complete virtual path tokens in diagnostic-shaped output', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-token-');
    const stdout = [
        'prefixworkspace/top.vsuffix',
        '$display workspace/top.v',
        '',
    ].join('\n');
    const stderr = [
        'prefixworkspace/top.v:12: error: embedded token',
        'workspace/top.v.bak:1: error: backup file',
        'workspace/top.v:12: error: mapped relative',
        '/work/workspace/top.v:13: error: mapped absolute',
        '',
    ].join('\n');
    const api = apiReturning({
        success: false,
        stage: 'compile',
        exitCode: 2,
        stdout,
        stderr,
        timings: { preprocess: 1, compile: 1 },
        artifacts: new Map(),
    });

    try {
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(result.stdout, stdout);
        assert.equal(result.stderr, [
            'prefixworkspace/top.v:12: error: embedded token',
            'workspace/top.v.bak:1: error: backup file',
            `${source}:12: error: mapped relative`,
            `${source}:13: error: mapped absolute`,
            '',
        ].join('\n'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reports a missing optional VCD without failing the simulation', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-optional-');
    const destination = path.join(root, 'optional.vcd');
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: '',
        stderr: '',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map(),
    });

    try {
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'optional.vcd',
                destination,
                required: false,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(result.success, true);
        assert.equal(result.stage, 'run');
        assert.equal(result.waveFile, null);
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: 'optional.vcd',
            destination,
            required: false,
            written: false,
            size: 0,
        }]);
        await assert.rejects(readFile(destination), { code: 'ENOENT' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('maps a missing required artifact to an artifact infrastructure failure', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-required-');
    const destination = path.join(root, 'required.vcd');
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: 'simulation completed\n',
        stderr: '',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map(),
    });

    try {
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'required.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.exitCode, -1);
        assert.deepEqual(result.cause, {
            code: 'ARTIFACT_MISSING',
            message: 'Required artifacts were not produced: required.vcd',
        });
        assert.ok((result.timings.artifact ?? -1) >= 0);
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: 'required.vcd',
            destination,
            required: true,
            written: false,
            size: 0,
        }]);
        assert.equal(result.waveFile, null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('required artifact absence overrides an HDL run failure without losing diagnostics', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-required-fail-');
    const destination = path.join(root, 'required-after-failure.vcd');
    const api = apiReturning({
        success: false,
        stage: 'run',
        exitCode: 1,
        stdout: 'output before failure\n',
        stderr: 'workspace/top.v:1: error: runtime failed\n',
        timings: { preprocess: 4, compile: 5, run: 6 },
        artifacts: new Map(),
    });

    try {
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'required-after-failure.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        const missingMessage = 'Required artifacts were not produced: '
            + 'required-after-failure.vcd';
        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.exitCode, -1);
        assert.deepEqual(result.cause, {
            code: 'ARTIFACT_MISSING',
            message: missingMessage,
        });
        assert.equal(result.stdout, 'output before failure\n');
        assert.equal(
            result.stderr,
            `${source}:1: error: runtime failed\n${missingMessage}\n`,
        );
        assert.equal(result.timings.preprocess, 0.004);
        assert.equal(result.timings.compile, 0.005);
        assert.equal(result.timings.run, 0.006);
        assert.ok((result.timings.artifact ?? -1) >= 0);
        assert.deepEqual(result.logEntries.filter(entry => entry.level === 'ERROR'), [
            {
                level: 'ERROR',
                message: 'runtime failed',
                fileRef: source,
                lineNo: 1,
            },
            { level: 'ERROR', message: missingMessage },
        ]);
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: 'required-after-failure.vcd',
            destination,
            required: true,
            written: false,
            size: 0,
        }]);
        assert.equal(result.waveFile, null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writes artifacts returned before an expected HDL runtime failure', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-run-fail-');
    const destination = path.join(root, 'failure.vcd');
    const api = apiReturning({
        success: false,
        stage: 'run',
        exitCode: 1,
        stdout: '',
        stderr: 'FATAL: top.v:1: intentional failure\n',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map([[
            'workspace/failure.vcd',
            Buffer.from('partial vcd'),
        ]]),
    });

    try {
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'failure.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(result.success, false);
        assert.equal(result.stage, 'run');
        assert.equal(result.exitCode, 1);
        assert.equal(result.cause, undefined);
        assert.equal(result.waveFile, destination);
        assert.equal(await readFile(destination, 'utf8'), 'partial vcd');
        assert.equal(result.artifacts[0].written, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('maps abort after simulation settle and before artifact commit as aborted infrastructure', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-artifact-abort-');
    const destination = path.join(root, 'aborted.vcd');
    const controller = new AbortController();
    const api: IverilogApi = {
        async compile(): Promise<never> {
            throw new Error('compile() must not be called');
        },
        async run(): Promise<never> {
            throw new Error('run() must not be called');
        },
        async simulate(): Promise<RunResult> {
            controller.abort();
            return {
                success: true,
                stage: 'run',
                exitCode: 0,
                stdout: '',
                stderr: '',
                timings: { preprocess: 1, compile: 2, run: 3 },
                artifacts: new Map([[
                    'workspace/aborted.vcd',
                    Buffer.from('not committed'),
                ]]),
            };
        },
    };

    try {
        const result = await new IverilogWasmBackend(providerFor(api)).compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'aborted.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
            signal: controller.signal,
        });

        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.cause?.code, 'ABORTED');
        assert.ok((result.timings.artifact ?? -1) >= 0);
        await assert.rejects(readFile(destination), { code: 'ENOENT' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reports artifacts committed before a later artifact rename failure', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-partial-write-');
    const firstDestination = path.join(root, 'first.vcd');
    const secondDestination = path.join(root, 'second.vcd');
    const renameError = new Error('injected second rename failure');
    let renames = 0;
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: 'simulation completed\n',
        stderr: '',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map([
            ['workspace/first.vcd', Buffer.from('first')],
            ['workspace/second.vcd', Buffer.from('second')],
        ]),
    });
    const backend = new IverilogWasmBackend(providerFor(api), {
        artifactFileSystem: {
            async rename(oldPath: string, newPath: string) {
                renames += 1;
                if (renames === 2) throw renameError;
                await rename(oldPath, newPath);
            },
        },
    });

    try {
        const result = await backend.compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [
                {
                    kind: 'vcd',
                    path: 'first.vcd',
                    destination: firstDestination,
                    required: true,
                },
                {
                    kind: 'vcd',
                    path: 'second.vcd',
                    destination: secondDestination,
                    required: true,
                },
            ],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.deepEqual(result.cause, {
            code: 'ARTIFACT_WRITE',
            message: renameError.message,
        });
        assert.deepEqual(result.artifacts, [
            {
                kind: 'vcd',
                path: 'first.vcd',
                destination: firstDestination,
                required: true,
                written: true,
                size: 5,
            },
            {
                kind: 'vcd',
                path: 'second.vcd',
                destination: secondDestination,
                required: true,
                written: false,
                size: 0,
            },
        ]);
        assert.equal(result.waveFile, firstDestination);
        assert.ok((result.timings.artifact ?? -1) >= 0);
        assert.equal(await readFile(firstDestination, 'utf8'), 'first');
        await assert.rejects(readFile(secondDestination), { code: 'ENOENT' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reports cleanup diagnostics after a partial artifact rename failure', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-partial-cleanup-');
    const firstDestination = path.join(root, 'first.vcd');
    const secondDestination = path.join(root, 'second.vcd');
    const renameError = new Error('injected second rename failure');
    const cleanupError = new Error('injected cleanup failure');
    let renames = 0;
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: '',
        stderr: '',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map([
            ['workspace/first.vcd', Buffer.from('first')],
            ['workspace/second.vcd', Buffer.from('second')],
        ]),
    });
    const backend = new IverilogWasmBackend(providerFor(api), {
        artifactFileSystem: {
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
        },
    });

    try {
        const result = await backend.compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: partialArtifactRequests(firstDestination, secondDestination),
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        const cleanupMessage = `Artifact cleanup failed: ${cleanupError.message}`;
        assert.deepEqual(result.cause, {
            code: 'ARTIFACT_WRITE',
            message: renameError.message,
        });
        assert.equal(
            result.stderr,
            `${renameError.message}\n${cleanupMessage}\n`,
        );
        assert.deepEqual(result.logEntries.filter(entry => entry.level === 'ERROR'), [
            { level: 'ERROR', message: renameError.message },
            { level: 'ERROR', message: cleanupMessage },
        ]);
        assertPartialArtifactExecution(result, firstDestination, secondDestination);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reports cleanup diagnostics after aborting between artifact renames', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-partial-abort-');
    const firstDestination = path.join(root, 'first.vcd');
    const secondDestination = path.join(root, 'second.vcd');
    const cleanupError = new Error('injected abort cleanup failure');
    const controller = new AbortController();
    let renames = 0;
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: '',
        stderr: '',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map([
            ['workspace/first.vcd', Buffer.from('first')],
            ['workspace/second.vcd', Buffer.from('second')],
        ]),
    });
    const backend = new IverilogWasmBackend(providerFor(api), {
        artifactFileSystem: {
            async rename(oldPath, newPath) {
                renames += 1;
                await rename(oldPath, newPath);
                if (renames === 1) controller.abort();
            },
            async unlink(hostPath) {
                if (path.basename(hostPath).startsWith('.second.vcd.')) {
                    throw cleanupError;
                }
                await unlink(hostPath);
            },
        },
    });

    try {
        const result = await backend.compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: partialArtifactRequests(firstDestination, secondDestination),
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
            signal: controller.signal,
        });

        const cleanupMessage = `Artifact cleanup failed: ${cleanupError.message}`;
        assert.equal(result.cause?.code, 'ABORTED');
        assert.equal(result.cause?.message, 'Artifact writing aborted');
        assert.equal(
            result.stderr,
            `Artifact writing aborted\n${cleanupMessage}\n`,
        );
        assert.deepEqual(result.logEntries.filter(entry => entry.level === 'ERROR'), [
            { level: 'ERROR', message: 'Artifact writing aborted' },
            { level: 'ERROR', message: cleanupMessage },
        ]);
        assertPartialArtifactExecution(result, firstDestination, secondDestination);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('preserves cleanup errors with identical messages and distinct codes', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-cleanup-codes-');
    const destination = path.join(root, 'wave.vcd');
    const operationError = new Error('injected artifact write failure');
    const accessError = Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
    const permissionError = Object.assign(new Error('cleanup failed'), { code: 'EPERM' });
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: '',
        stderr: '',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map([['workspace/wave.vcd', Buffer.from('wave')]]),
    });
    const backend = new IverilogWasmBackend(providerFor(api), {
        artifactFileSystem: {
            async openExclusive() {
                return {
                    async writeFile() {
                        throw operationError;
                    },
                    async sync() {},
                    async close() {
                        throw accessError;
                    },
                };
            },
            async unlink() {
                throw permissionError;
            },
        },
    });

    try {
        const result = await backend.compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'wave.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        const accessMessage = 'Artifact cleanup failed (EACCES): cleanup failed';
        const permissionMessage = 'Artifact cleanup failed (EPERM): cleanup failed';
        assert.deepEqual(result.cause, {
            code: 'ARTIFACT_WRITE',
            message: operationError.message,
        });
        assert.equal(
            result.stderr,
            `${operationError.message}\n${accessMessage}\n${permissionMessage}\n`,
        );
        assert.deepEqual(result.logEntries.filter(entry => entry.level === 'ERROR'), [
            { level: 'ERROR', message: operationError.message },
            { level: 'ERROR', message: accessMessage },
            { level: 'ERROR', message: permissionMessage },
        ]);
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: 'wave.vcd',
            destination,
            required: true,
            written: false,
            size: 0,
        }]);
        assert.equal(result.waveFile, null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('does not report AggregateError children as artifact cleanup failures', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-aggregate-write-');
    const destination = path.join(root, 'wave.vcd');
    const AggregateErrorConstructor = (globalThis as unknown as {
        AggregateError: new (
            errors: readonly unknown[],
            message: string,
        ) => Error & { errors: readonly unknown[] };
    }).AggregateError;
    const operationError = new AggregateErrorConstructor([
        new Error('first operation detail'),
        new Error('second operation detail'),
    ], 'aggregate operation failed');
    const api = apiReturning({
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout: '',
        stderr: '',
        timings: { preprocess: 1, compile: 2, run: 3 },
        artifacts: new Map([['workspace/wave.vcd', Buffer.from('wave')]]),
    });
    const backend = new IverilogWasmBackend(providerFor(api), {
        artifactFileSystem: {
            async rename() {
                throw operationError;
            },
        },
    });

    try {
        const result = await backend.compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'wave.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.deepEqual(result.cause, {
            code: 'ARTIFACT_WRITE',
            message: operationError.message,
        });
        assert.equal(result.stderr, `${operationError.message}\n`);
        assert.deepEqual(result.logEntries.filter(entry => entry.level === 'ERROR'), [
            { level: 'ERROR', message: operationError.message },
        ]);
        assert.doesNotMatch(result.stderr, /Artifact cleanup failed/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('maps worker, protocol, timeout, trap, and abort rejections to infrastructure failures', async () => {
    const failures = [
        {
            error: Object.assign(new Error('worker unavailable'), { code: 'WORKER_START' }),
            code: 'WORKER_START',
        },
        {
            error: Object.assign(new Error('bad worker reply'), { code: 'PROTOCOL_MISMATCH' }),
            code: 'PROTOCOL_MISMATCH',
        },
        {
            error: Object.assign(new Error('simulation timed out'), { code: 'TIMEOUT' }),
            code: 'TIMEOUT',
        },
        {
            error: new WebAssembly.RuntimeError('unreachable'),
            code: 'WASM_TRAP',
        },
        {
            error: new DOMException('The operation was aborted', 'AbortError'),
            code: 'ABORTED',
        },
    ];

    for (const failure of failures) {
        const { root, source } = await createSourceRoot('veriflow-wasm-infra-');
        let loadCalls = 0;
        let simulateCalls = 0;
        const provider: IverilogApiProvider = async () => {
            loadCalls += 1;
            return {
                async compile(): Promise<never> {
                    throw new Error('compile() must not be called');
                },
                async run(): Promise<never> {
                    throw new Error('run() must not be called');
                },
                async simulate(): Promise<never> {
                    simulateCalls += 1;
                    throw failure.error;
                },
            };
        };

        try {
            const result = await new IverilogWasmBackend(provider).compileAndRun({
                files: [source],
                runtimeFiles: [],
                includeDirs: [],
                defines: {},
                plusargs: [],
                artifacts: [],
                output: path.join(root, 'top.out'),
                cwd: root,
                timeoutMs: 1_000,
            });

            assert.equal(result.success, false);
            assert.equal(result.stage, 'infrastructure');
            assert.equal(result.exitCode, -1);
            assert.equal(result.cause?.code, failure.code);
            assert.equal(result.cause?.message, failure.error.message);
            assert.equal(loadCalls, 1);
            assert.equal(simulateCalls, 1);
            assert.deepEqual(result.commands, {});
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test('pre-aborted requests skip workspace reads and API loading', async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    let realpaths = 0;
    let loadCalls = 0;
    const destination = path.join(os.tmpdir(), 'pre-aborted.vcd');
    const backend = new IverilogWasmBackend(async () => {
        loadCalls += 1;
        throw new Error('API must not load');
    }, {
        workspaceFileSystem: {
            async readFile() {
                reads += 1;
                return Buffer.alloc(0);
            },
            async realpath(hostPath: string) {
                realpaths += 1;
                return hostPath;
            },
        },
    });

    const result = await backend.compileAndRun({
        files: ['/virtual/top.v'],
        runtimeFiles: [],
        includeDirs: [],
        defines: {},
        plusargs: [],
        artifacts: [{
            kind: 'vcd',
            path: 'pre-aborted.vcd',
            destination,
            required: true,
        }],
        output: '/virtual/top.out',
        cwd: '/virtual',
        timeoutMs: 1_000,
        signal: controller.signal,
    });

    assert.equal(reads, 0);
    assert.equal(realpaths, 0);
    assert.equal(loadCalls, 0);
    assert.equal(result.backendId, 'builtin');
    assert.equal(result.success, false);
    assert.equal(result.stage, 'infrastructure');
    assert.equal(result.exitCode, -1);
    assert.equal(result.cause?.code, 'ABORTED');
    assert.deepEqual(result.commands, {});
    assert.deepEqual(result.timings, {});
    assert.deepEqual(result.artifacts, [{
        kind: 'vcd',
        path: 'pre-aborted.vcd',
        destination,
        required: true,
        written: false,
        size: 0,
    }]);
});

test('workspace read and canonicalization errors return infrastructure executions', async () => {
    const failures = [
        {
            error: Object.assign(new Error('custom read failure'), {
                code: 'CUSTOM_READ',
            }),
            fileSystem: {
                async readFile(): Promise<never> {
                    throw Object.assign(new Error('custom read failure'), {
                        code: 'CUSTOM_READ',
                    });
                },
                async realpath(hostPath: string) {
                    return hostPath;
                },
            },
        },
        {
            error: Object.assign(new Error('custom realpath failure'), {
                code: 'CUSTOM_REALPATH',
            }),
            fileSystem: {
                async readFile(): Promise<never> {
                    throw new Error('read must not run');
                },
                async realpath(): Promise<never> {
                    throw Object.assign(new Error('custom realpath failure'), {
                        code: 'CUSTOM_REALPATH',
                    });
                },
            },
        },
    ];

    for (const failure of failures) {
        let loadCalls = 0;
        const destination = path.join(os.tmpdir(), `${failure.error.code}.vcd`);
        const result = await new IverilogWasmBackend(async () => {
            loadCalls += 1;
            throw new Error('API must not load');
        }, {
            workspaceFileSystem: failure.fileSystem,
        }).compileAndRun({
            files: ['/virtual/top.v'],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'workspace-error.vcd',
                destination,
            }],
            output: '/virtual/top.out',
            cwd: '/virtual',
            timeoutMs: 1_000,
        });

        assert.equal(loadCalls, 0);
        assert.equal(result.backendId, 'builtin');
        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.exitCode, -1);
        assert.deepEqual(result.cause, {
            code: failure.error.code,
            message: failure.error.message,
        });
        assert.deepEqual(result.commands, {});
        assert.deepEqual(result.timings, {});
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: 'workspace-error.vcd',
            destination,
            written: false,
            size: 0,
        }]);
    }
});

test('missing source files return ENOENT infrastructure executions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-missing-'));
    const missingSource = path.join(root, 'missing.v');
    let loadCalls = 0;

    try {
        const result = await new IverilogWasmBackend(async () => {
            loadCalls += 1;
            throw new Error('API must not load');
        }).compileAndRun({
            files: [missingSource],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(root, 'missing.out'),
            cwd: root,
            timeoutMs: 1_000,
        });

        assert.equal(loadCalls, 0);
        assert.equal(result.backendId, 'builtin');
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.cause?.code, 'ENOENT');
        assert.match(result.cause?.message ?? '', /ENOENT/);
        assert.deepEqual(result.artifacts, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('preserves rejected upstream input errors instead of relabeling them as infrastructure', async () => {
    const { root, source } = await createSourceRoot('veriflow-wasm-input-');
    const inputError = Object.assign(new TypeError('invalid define name'), {
        code: 'INVALID_INPUT',
    });
    const api: IverilogApi = {
        async compile(): Promise<never> {
            throw new Error('compile() must not be called');
        },
        async run(): Promise<never> {
            throw new Error('run() must not be called');
        },
        async simulate(): Promise<never> {
            throw inputError;
        },
    };

    try {
        await assert.rejects(
            new IverilogWasmBackend(providerFor(api)).compileAndRun({
                files: [source],
                runtimeFiles: [],
                includeDirs: [],
                defines: { 'INVALID NAME': true },
                plusargs: [],
                artifacts: [],
                output: path.join(root, 'top.out'),
                cwd: root,
                timeoutMs: 1_000,
            }),
            error => error === inputError,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('backend implementation has no native simulator fallback boundary', async () => {
    const source = await readFile(
        path.join(packageRoot, 'src', 'iverilogWasmBackend.ts'),
        'utf8',
    );

    assert.doesNotMatch(source, /node:child_process|NativeSimulatorBackend/);
});

test('real Icarus runs Verilog-2005 and writes non-empty VCD bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-real-'));
    const source = path.join(root, 'counter.v');
    const destination = path.join(root, 'counter.vcd');

    try {
        await copyFile(path.join(fixtureRoot, 'counter.v'), source);
        const result = await new IverilogWasmBackend().compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: 'counter.vcd',
                destination,
                required: true,
            }],
            output: path.join(root, 'counter.out'),
            cwd: root,
            topModule: 'counter',
            timeoutMs: 10_000,
        });

        assert.equal(result.success, true, result.stderr);
        assert.equal(result.stage, 'run');
        assert.match(result.stdout, /(^|\n)PASS\n/);
        assert.ok((await readFile(destination)).byteLength > 0);
        assert.equal(result.waveFile, destination);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('real Icarus resolves a physical header through a symlink include root', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-link-include-'));
    const sourceRoot = path.join(root, 'rtl');
    const physicalInclude = path.join(root, 'physical-include');
    const linkedInclude = path.join(root, 'linked-include');
    const source = path.join(sourceRoot, 'top.v');
    const header = path.join(physicalInclude, 'defs.vh');

    try {
        await Promise.all([
            mkdir(sourceRoot, { recursive: true }),
            mkdir(physicalInclude, { recursive: true }),
        ]);
        await Promise.all([
            writeFile(source, [
                '`include "defs.vh"',
                'module top;',
                '  initial begin',
                '    if (`EXPECTED == 7) $display("PASS");',
                '    else $display("FAIL");',
                '    $finish;',
                '  end',
                'endmodule',
                '',
            ].join('\n')),
            writeFile(header, '`define EXPECTED 7\n'),
        ]);
        try {
            await symlink(physicalInclude, linkedInclude, 'dir');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
                t.skip(`directory links are unavailable: ${code}`);
                return;
            }
            throw error;
        }

        const result = await new IverilogWasmBackend().compileAndRun({
            files: [source, header],
            runtimeFiles: [],
            includeDirs: [linkedInclude],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(root, 'top.out'),
            cwd: sourceRoot,
            topModule: 'top',
            timeoutMs: 10_000,
        });

        assert.equal(result.success, true, result.stderr);
        assert.match(result.stdout, /(^|\n)PASS\n/);
        assert.doesNotMatch(result.stderr, /Include file defs\.vh not found/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('real Icarus runs an external-only source from an explicitly staged cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-external-cwd-'));
    const cwd = path.join(root, 'project');
    const sourceRoot = path.join(root, 'external');
    const source = path.join(sourceRoot, 'top.v');

    try {
        await Promise.all([
            mkdir(cwd, { recursive: true }),
            mkdir(sourceRoot, { recursive: true }),
        ]);
        await writeFile(source, [
            'module top;',
            '  initial begin',
            '    $display("PASS");',
            '    $finish;',
            '  end',
            'endmodule',
            '',
        ].join('\n'));

        const result = await new IverilogWasmBackend().compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(cwd, 'top.out'),
            cwd,
            topModule: 'top',
            timeoutMs: 10_000,
        });

        assert.equal(result.success, true, result.stderr);
        assert.match(result.stdout, /(^|\n)PASS\n/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('real invalid HDL resolves as a compile failure result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-invalid-'));
    const source = path.join(root, 'compile-error.v');

    try {
        await copyFile(path.join(fixtureRoot, 'compile-error.v'), source);
        const result = await new IverilogWasmBackend().compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(root, 'compile-error.out'),
            cwd: root,
            topModule: 'compile_error',
            timeoutMs: 10_000,
        });

        assert.equal(result.success, false);
        assert.equal(result.stage, 'compile');
        assert.notEqual(result.stage, 'infrastructure');
        assert.match(result.stderr, new RegExp(escapeRegExp(source)));
        assert.equal(result.logEntries.some((entry: {
            level: string;
            fileRef?: string;
        }) => (
            entry.level === 'ERROR' && entry.fileRef === source
        )), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('real abort stops an infinite simulation without leaving a worker handle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-wasm-abort-'));
    const source = path.join(root, 'infinite.v');
    const baseline = messagePortCount();
    const controller = new AbortController();

    try {
        await copyFile(path.join(fixtureRoot, 'infinite.v'), source);
        const started = performance.now();
        const pending = new IverilogWasmBackend().compileAndRun({
            files: [source],
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            output: path.join(root, 'infinite.out'),
            cwd: root,
            topModule: 'infinite',
            timeoutMs: 10_000,
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 30);

        const result = await pending;
        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.cause?.code, 'ABORTED');
        assert.ok(performance.now() - started < 1_000);
        await waitImmediate();
        assert.equal(messagePortCount(), baseline);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function partialArtifactRequests(
    firstDestination: string,
    secondDestination: string,
) {
    return [
        {
            kind: 'vcd' as const,
            path: 'first.vcd',
            destination: firstDestination,
            required: true,
        },
        {
            kind: 'vcd' as const,
            path: 'second.vcd',
            destination: secondDestination,
            required: true,
        },
    ];
}

function assertPartialArtifactExecution(
    result: Awaited<ReturnType<IverilogWasmBackend['compileAndRun']>>,
    firstDestination: string,
    secondDestination: string,
): void {
    assert.equal(result.success, false);
    assert.equal(result.stage, 'infrastructure');
    assert.deepEqual(result.artifacts, [
        {
            kind: 'vcd',
            path: 'first.vcd',
            destination: firstDestination,
            required: true,
            written: true,
            size: 5,
        },
        {
            kind: 'vcd',
            path: 'second.vcd',
            destination: secondDestination,
            required: true,
            written: false,
            size: 0,
        },
    ]);
    assert.equal(result.waveFile, firstDestination);
}
