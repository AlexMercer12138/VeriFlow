import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// @ts-expect-error Legacy native requests are available only from the simulation subpath.
import type { LegacyNativeSimulationRequest as RootLegacyRequest } from '@veriflow/flow-core';
// @ts-expect-error Legacy executions are available only from the simulation subpath.
import type { LegacySimulationExecution as RootLegacyExecution } from '@veriflow/flow-core';
import { NativeSimulatorBackend } from '@veriflow/flow-core/nativeSimulatorBackend';
import {
    createSimulationRequest,
    type CommandExecutor,
    type LegacyNativeSimulationRequest,
    type SimulationArtifactResult,
    type SimulationExecution,
    type SimulationRequest,
} from '@veriflow/flow-core/simulation';
import type { SimulatorConfig } from '@veriflow/flow-core/types';

type Capture = {
    action: string;
    args: string[];
    cwd: string;
};

function quote(value: string): string {
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function request(
    root: string,
    capturePath: string,
    compileAction = 'compile'
): LegacyNativeSimulationRequest {
    return {
        files: [path.join(root, 'child.v'), path.join(root, 'top.v')],
        output: path.join(root, 'top.out'),
        simulator: simulatorConfig(capturePath, compileAction),
        cwd: root,
        topModule: 'top',
    };
}

function simulatorConfig(capturePath: string, compileAction = 'compile'): SimulatorConfig {
    const fixture = path.resolve(
        __dirname,
        '..',
        '..',
        'test',
        'fixtures',
        'fakeSimulator.mjs'
    );
    const prefix = `${quote(process.execPath)} ${quote(fixture)} ${quote(capturePath)}`;
    return {
        name: 'fake',
        compileCmd: `${prefix} ${compileAction} "{output}" {files}`,
        runCmd: `${prefix} run "{output}"`,
    };
}

function normalizedRequest(root: string): SimulationRequest {
    return createSimulationRequest({
        files: [path.join(root, 'child.v'), path.join(root, 'top.v')],
        output: path.join(root, 'top.out'),
        cwd: root,
        topModule: 'top',
    });
}

function legacyContractRequest(): LegacyNativeSimulationRequest {
    return {
        files: ['/workspace/top.v'],
        output: '/workspace/top.out',
        simulator: {
            name: 'fake',
            compileCmd: 'compile "{output}" {files}',
            runCmd: 'run "{output}"',
        },
        cwd: '/workspace',
        topModule: 'top',
    };
}

function successfulExecutor(): CommandExecutor {
    return {
        async execute() {
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
                elapsedTime: 0,
            };
        },
    };
}

function captures(filepath: string): Capture[] {
    return readFileSync(filepath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('simulation requests use conservative defaults', () => {
    const result = createSimulationRequest({
        files: ['top.v'],
        output: 'top.out',
        cwd: '/workspace',
    });

    assert.deepEqual(result, {
        files: ['top.v'],
        runtimeFiles: [],
        includeDirs: [],
        defines: {},
        plusargs: [],
        artifacts: [],
        output: 'top.out',
        cwd: '/workspace',
        timeoutMs: 300_000,
    });
});

test('simulation requests clone caller-owned collections and artifact entries', () => {
    const files = ['top.v'];
    const runtimeFiles = ['runtime.hex'];
    const includeDirs = ['include'];
    const defines = { WIDTH: 8, TRACE: true };
    const plusargs = ['+seed=1'];
    const artifacts = [{
        kind: 'vcd' as const,
        path: 'wave.vcd',
        destination: '/workspace/wave.vcd',
        required: true,
    }];

    const result = createSimulationRequest({
        files,
        runtimeFiles,
        includeDirs,
        defines,
        plusargs,
        artifacts,
        output: 'top.out',
        cwd: '/workspace',
    });

    files.push('late.v');
    runtimeFiles.push('late.hex');
    includeDirs.push('late-include');
    defines.WIDTH = 16;
    plusargs.push('+late');
    artifacts[0].destination = '/tmp/changed.vcd';
    artifacts.push({
        kind: 'vcd',
        path: 'late.vcd',
        destination: '/workspace/late.vcd',
        required: false,
    });

    assert.deepEqual(result.files, ['top.v']);
    assert.deepEqual(result.runtimeFiles, ['runtime.hex']);
    assert.deepEqual(result.includeDirs, ['include']);
    assert.deepEqual(result.defines, { WIDTH: 8, TRACE: true });
    assert.deepEqual(result.plusargs, ['+seed=1']);
    assert.deepEqual(result.artifacts, [{
        kind: 'vcd',
        path: 'wave.vcd',
        destination: '/workspace/wave.vcd',
        required: true,
    }]);
    assert.notEqual(result.files, files);
    assert.notEqual(result.defines, defines);
    assert.notEqual(result.artifacts, artifacts);
    assert.notEqual(result.artifacts[0], artifacts[0]);
});

test('simulation requests validate the Node timer range', () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        assert.throws(() => createSimulationRequest({
            files: ['top.v'],
            output: 'top.out',
            cwd: '/workspace',
            timeoutMs,
        }), /timeoutMs/);
    }

    assert.equal(createSimulationRequest({
        files: ['top.v'],
        output: 'top.out',
        cwd: '/workspace',
        timeoutMs: 2_147_483_647,
    }).timeoutMs, 2_147_483_647);
});

test('simulation requests reject null timeout values', () => {
    assert.throws(() => createSimulationRequest({
        files: ['top.v'],
        output: 'top.out',
        cwd: '/workspace',
        timeoutMs: null as unknown as number,
    }), /timeoutMs/);
});

test('simulation requests preserve the exact abort signal', () => {
    const controller = new AbortController();
    const result = createSimulationRequest({
        files: ['top.v'],
        output: 'top.out',
        cwd: '/workspace',
        signal: controller.signal,
    });

    assert.equal(result.signal, controller.signal);
});

test('normalized native results report backend, stage, commands, timings, and artifacts', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-contract-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const input = normalizedRequest(root);
        input.artifacts.push({
            kind: 'vcd',
            path: 'wave.vcd',
            destination: path.join(root, 'wave.vcd'),
        });
        const result: SimulationExecution = await new NativeSimulatorBackend(
            'native:fake',
            simulatorConfig(capturePath)
        ).compileAndRun(input);
        const artifact: SimulationArtifactResult = result.artifacts[0];

        assert.equal(result.backendId, 'native:fake');
        assert.equal(result.stage, 'run');
        assert.deepEqual(result.timings, {});
        assert.match(result.commands.compile ?? '', / compile "top\.out" "child\.v" "top\.v"$/);
        assert.match(result.commands.run ?? '', / run "top\.out"$/);
        assert.deepEqual(artifact, {
            kind: 'vcd',
            path: 'wave.vcd',
            destination: path.join(root, 'wave.vcd'),
            written: false,
            size: 0,
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('normalized native results omit legacy command aliases', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-no-aliases-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulatorConfig(capturePath)
        ).compileAndRun(normalizedRequest(root));

        assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('normalized native requests ignore inherited simulator configuration', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-prototype-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const input = normalizedRequest(root);
        Object.setPrototypeOf(input, { simulator: simulatorConfig(capturePath) });

        await assert.rejects(
            new NativeSimulatorBackend().compileAndRun(input),
            /Native simulator configuration is required/
        );

        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulatorConfig(capturePath)
        ).compileAndRun(input);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('configured native requests ignore an own simulator property', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-hybrid-'));
    const legacyCapturePath = path.join(root, 'legacy-calls.jsonl');
    const normalizedCapturePath = path.join(root, 'normalized-calls.jsonl');
    try {
        const input = Object.assign(normalizedRequest(root), {
            simulator: simulatorConfig(legacyCapturePath, 'compile-fail'),
        });

        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulatorConfig(normalizedCapturePath)
        ).compileAndRun(input);
        assert.equal(result.success, true);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('configured native mode does not infer legacy from request shape', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-mode-'));
    const legacyCapturePath = path.join(root, 'legacy-calls.jsonl');
    const normalizedCapturePath = path.join(root, 'normalized-calls.jsonl');
    try {
        const input = {
            files: [path.join(root, 'child.v'), path.join(root, 'top.v')],
            output: path.join(root, 'top.out'),
            cwd: root,
            topModule: 'top',
            simulator: simulatorConfig(legacyCapturePath, 'compile-fail'),
        } as unknown as SimulationRequest;
        Object.setPrototypeOf(input, {
            runtimeFiles: [],
            includeDirs: [],
            defines: {},
            plusargs: [],
            artifacts: [],
            timeoutMs: 300_000,
        });

        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulatorConfig(normalizedCapturePath)
        ).compileAndRun(input);

        assert.equal(result.success, true);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('configured native mode normalizes hostile request values', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-validation-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const input = normalizedRequest(root);
        input.timeoutMs = null as unknown as number;

        await assert.rejects(
            new NativeSimulatorBackend(
                'native:fake',
                simulatorConfig(capturePath)
            ).compileAndRun(input),
            /timeoutMs/
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('normalized native compile failures retain contract metadata', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-contract-fail-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const input = normalizedRequest(root);
        input.artifacts.push({
            kind: 'file',
            path: 'compile.log',
            destination: path.join(root, 'compile.log'),
            required: true,
        });
        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulatorConfig(capturePath, 'compile-fail')
        ).compileAndRun(input);

        assert.equal(result.success, false);
        assert.equal(result.stage, 'compile');
        assert.deepEqual(result.timings, {});
        assert.match(result.commands.compile ?? '', / compile-fail "top\.out"/);
        assert.equal(result.commands.run, undefined);
        assert.deepEqual(result.artifacts, [{
            kind: 'file',
            path: 'compile.log',
            destination: path.join(root, 'compile.log'),
            required: true,
            written: false,
            size: 0,
        }]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('legacy native request adapter preserves command aliases', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-legacy-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const result = await new NativeSimulatorBackend().compileAndRun(
            request(root, capturePath)
        );

        assert.equal(result.commands.compile, result.compileCommand);
        assert.equal(result.commands.run, result.runCommand);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('legacy requests remain legacy with individual normalized option fields', async () => {
    const extras: Array<[string, Record<string, unknown>]> = [
        ['runtimeFiles', { runtimeFiles: ['runtime.hex'] }],
        ['includeDirs', { includeDirs: ['include'] }],
        ['defines', { defines: { TRACE: true } }],
        ['plusargs', { plusargs: ['+trace'] }],
        ['artifacts', { artifacts: [{
            kind: 'vcd',
            path: 'wave.vcd',
            destination: '/workspace/wave.vcd',
        }] }],
        ['timeoutMs', { timeoutMs: 1_000 }],
        ['signal', { signal: new AbortController().signal }],
    ];

    for (const [field, extra] of extras) {
        const input = Object.assign(legacyContractRequest(), extra);
        const result = await new NativeSimulatorBackend(
            successfulExecutor()
        ).compileAndRun(input);

        assert.equal(
            Object.prototype.hasOwnProperty.call(result, 'compileCommand'),
            true,
            field
        );
        assert.equal(
            Object.prototype.hasOwnProperty.call(result, 'runCommand'),
            true,
            field
        );
        assert.deepEqual(result.artifacts, [], field);
    }
});

test('legacy constructor mode ignores a complete normalized-looking extension', async () => {
    const input = Object.assign(legacyContractRequest(), {
        runtimeFiles: ['runtime.hex'],
        includeDirs: ['include'],
        defines: { TRACE: true },
        plusargs: ['+trace'],
        artifacts: [{
            kind: 'vcd' as const,
            path: 'wave.vcd',
            destination: '/workspace/wave.vcd',
        }],
        timeoutMs: -1,
        signal: new AbortController().signal,
    });

    const result = await new NativeSimulatorBackend(
        successfulExecutor()
    ).compileAndRun(input);

    assert.deepEqual(result.artifacts, []);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), true);
});

test('legacy constructor mode requires an own simulator configuration', async () => {
    const { simulator, ...withoutSimulator } = legacyContractRequest();
    Object.setPrototypeOf(withoutSimulator, { simulator });

    await assert.rejects(
        new NativeSimulatorBackend(successfulExecutor()).compileAndRun(
            withoutSimulator as LegacyNativeSimulationRequest
        ),
        /Native simulator configuration is required/
    );
});

test('legacy adaptation does not read inherited normalized options', async () => {
    const reads: string[] = [];
    const inheritedOptions = {
        runtimeFiles: ['runtime.hex'],
        includeDirs: ['include'],
        defines: { TRACE: true },
        plusargs: ['+trace'],
        artifacts: [{
            kind: 'vcd' as const,
            path: 'wave.vcd',
            destination: '/workspace/wave.vcd',
        }],
        timeoutMs: 1_000,
        signal: new AbortController().signal,
    };
    const prototype = {};
    for (const [field, value] of Object.entries(inheritedOptions)) {
        Object.defineProperty(prototype, field, {
            configurable: true,
            get() {
                reads.push(field);
                return value;
            },
        });
    }
    const input = legacyContractRequest();
    Object.setPrototypeOf(input, prototype);

    const result = await new NativeSimulatorBackend(
        successfulExecutor()
    ).compileAndRun(input);

    assert.deepEqual(reads, []);
    assert.deepEqual(result.artifacts, []);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), true);
});

test('native simulator backend runs rendered commands in the requested cwd', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-sim-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const result = await new NativeSimulatorBackend().compileAndRun(
            request(root, capturePath)
        );

        assert.equal(result.success, true);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'RUN OK\n');
        assert.equal(result.stderr, '');
        assert.ok(result.elapsedTime >= 0);
        assert.match(result.compileCommand, / compile "top\.out" "child\.v" "top\.v"$/);
        assert.match(result.runCommand, / run "top\.out"$/);
        assert.deepEqual(captures(capturePath), [
            { action: 'compile', args: ['top.out', 'child.v', 'top.v'], cwd: root },
            { action: 'run', args: ['top.out'], cwd: root },
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('native simulator backend stops after a compile error and parses diagnostics', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-sim-fail-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const result = await new NativeSimulatorBackend().compileAndRun(
            request(root, capturePath, 'compile-fail')
        );

        assert.equal(result.success, false);
        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, 'COMPILE OUTPUT\n');
        assert.equal(result.stderr, 'top.v:3: error: compile failed\n');
        assert.equal(result.runCommand, '');
        assert.deepEqual(result.logEntries.filter(entry => entry.level === 'ERROR'), [{
            level: 'ERROR',
            message: 'compile failed',
            fileRef: 'top.v',
            lineNo: 3,
        }]);
        assert.deepEqual(captures(capturePath).map(call => call.action), ['compile-fail']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
