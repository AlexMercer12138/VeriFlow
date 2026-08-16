import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ConfiguredNativeSimulatorBackend,
    NativeSimulatorBackend as RootNativeSimulatorBackend,
    type SimulationFailureCause,
} from '@veriflow/flow-core';
// @ts-expect-error The named legacy backend is available only from its direct subpath.
import { LegacyNativeSimulatorBackend as RootLegacyNativeSimulatorBackend } from '@veriflow/flow-core';
// @ts-expect-error Legacy native requests are available only from the simulation subpath.
import type { LegacyNativeSimulationRequest as RootLegacyRequest } from '@veriflow/flow-core';
// @ts-expect-error Legacy executions are available only from the simulation subpath.
import type { LegacySimulationExecution as RootLegacyExecution } from '@veriflow/flow-core';
import {
    LegacyNativeSimulatorBackend,
    LinuxProcessIdentityProvider,
    NativeSimulatorBackend,
    NodeCommandExecutor,
    NodeProcessTreeTerminator,
    type ProcessIdentityProvider,
    type ProcessTreeTerminator,
} from '@veriflow/flow-core/nativeSimulatorBackend';
import {
    createSimulationRequest,
    type CommandExecutor,
    type LegacyNativeSimulationRequest,
    type LegacySimulationExecution,
    type SimulationArtifactResult,
    type SimulationExecution,
    type SimulationRequest,
} from '@veriflow/flow-core/simulation';
import { SimulatorBackendRegistry } from '@veriflow/flow-core/simulatorBackendRegistry';
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

function processExists(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForFile(filepath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(filepath)) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${filepath}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Timed out after ${timeoutMs} ms`)),
                    timeoutMs
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function assertBackendTypeBoundaries(
    strictBackend: NativeSimulatorBackend,
    legacyBackend: LegacyNativeSimulatorBackend,
    normalized: SimulationRequest,
    legacy: LegacyNativeSimulationRequest
): Promise<void> {
    // @ts-expect-error Strict backends accept only normalized requests.
    void strictBackend.compileAndRun(legacy);
    // @ts-expect-error Legacy backends accept only legacy requests.
    void legacyBackend.compileAndRun(normalized);

    const strictResult = await strictBackend.compileAndRun(normalized);
    // @ts-expect-error Strict results do not expose legacy command aliases.
    void strictResult.compileCommand;
    const legacyResult = await legacyBackend.compileAndRun(legacy);
    // @ts-expect-error Legacy results expose only the compatibility result contract.
    void legacyResult.commands;
}

function assertRootBackendAliases(
    executor: CommandExecutor,
    simulator: SimulatorConfig
): void {
    void new RootNativeSimulatorBackend(executor);
    void new ConfiguredNativeSimulatorBackend('native:fake', simulator, executor);
    // @ts-expect-error Strict direct-subpath backends require configuration.
    void new NativeSimulatorBackend(executor);
    // @ts-expect-error Legacy backends accept only an optional executor.
    void new LegacyNativeSimulatorBackend('native:fake', simulator, executor);
}

function legacyArtifacts(result: LegacySimulationExecution): unknown {
    return (result as unknown as { artifacts: unknown }).artifacts;
}

function infrastructureCause(cause: SimulationFailureCause): SimulationFailureCause {
    return cause;
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
        assert.ok((result.timings.compile ?? -1) >= 0);
        assert.ok((result.timings.run ?? -1) >= 0);
        assert.ok((result.timings.artifact ?? -1) >= 0);
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

test('native execution forwards the request signal and records separate stage timings', async () => {
    const controller = new AbortController();
    const calls: Array<{ timeoutSeconds: number; signal?: AbortSignal }> = [];
    const executor: CommandExecutor = {
        async execute(_command, _cwd, timeoutSeconds, signal) {
            calls.push({ timeoutSeconds, signal });
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
                elapsedTime: calls.length === 1 ? 0.125 : 0.25,
            };
        },
    };
    const input = createSimulationRequest({
        files: ['/workspace/top.v'],
        output: '/workspace/top.out',
        cwd: '/workspace',
        timeoutMs: 1_500,
        signal: controller.signal,
    });

    const result = await new NativeSimulatorBackend(
        'native:fake',
        { name: 'fake', compileCmd: 'compile {files}', runCmd: 'run {output}' },
        executor
    ).compileAndRun(input);

    assert.deepEqual(calls, [
        { timeoutSeconds: 1.5, signal: controller.signal },
        { timeoutSeconds: 1.5, signal: controller.signal },
    ]);
    assert.deepEqual(result.timings, { compile: 0.125, run: 0.25 });
    assert.equal(result.elapsedTime, 0.375);
});

test('configured native backends remain compatible with registry providers', async () => {
    const registry = new SimulatorBackendRegistry();
    registry.register('native:fake', () => new NativeSimulatorBackend(
        'native:fake',
        { name: 'fake', compileCmd: 'compile {files}', runCmd: 'run {output}' },
        successfulExecutor()
    ));

    const result = await registry.run(
        'native:fake',
        normalizedRequest('/workspace')
    );

    assert.equal(result.backendId, 'native:fake');
    assert.equal(result.success, true);
});

test('native execution reports a requested VCD in place without copying it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-artifact-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const sourcePath = path.join(root, 'wave.vcd');
    const destination = path.join(root, 'copied', 'wave.vcd');
    const simulator = simulatorConfig(capturePath);
    simulator.runCmd = simulator.runCmd.replace(
        ' run "{output}"',
        ' run-artifact "{output}" "wave.vcd"'
    );
    try {
        const input = normalizedRequest(root);
        input.artifacts.push({ kind: 'vcd', path: 'wave.vcd', destination });

        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulator
        ).compileAndRun(input);

        assert.equal(readFileSync(sourcePath, 'utf8'), 'VCD DATA\n');
        assert.equal(existsSync(destination), false);
        assert.deepEqual(result.artifacts, [{
            kind: 'vcd',
            path: 'wave.vcd',
            destination,
            written: true,
            size: 9,
        }]);
        assert.ok((result.timings.artifact ?? -1) >= 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('native template arguments cannot execute shell substitutions', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-quote-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const sideEffectPath = path.join(root, 'injected');
    const simulator = simulatorConfig(capturePath);
    simulator.compileCmd = simulator.compileCmd.replace(
        'compile "{output}" {files}',
        'compile {defines} {include_dirs}'
    );
    const defineValue = `value"$(touch "${sideEffectPath}")`;
    const includeDir = `headers"` + '`' + `touch "${sideEffectPath}"` + '`';
    try {
        const input = normalizedRequest(root);
        input.defines = { PAYLOAD: defineValue };
        input.includeDirs = [includeDir];

        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulator
        ).compileAndRun(input);

        assert.equal(result.success, true);
        assert.equal(existsSync(sideEffectPath), false);
        assert.deepEqual(captures(capturePath)[0].args, [
            `-DPAYLOAD=${defineValue}`,
            `-I${includeDir}`,
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('aborting native execution terminates the process and returns infrastructure failure', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-abort-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const pidPath = path.join(root, 'simulator.pid');
    const controller = new AbortController();
    const simulator = simulatorConfig(capturePath, 'wait');
    simulator.compileCmd += ` ${quote(pidPath)}`;
    try {
        const running = new NativeSimulatorBackend(
            'native:fake',
            simulator
        ).compileAndRun(createSimulationRequest({
            files: [path.join(root, 'top.v')],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 5_000,
            signal: controller.signal,
        }));
        await waitForFile(pidPath, 2_000);
        const processId = Number(readFileSync(pidPath, 'utf8'));

        controller.abort();
        const result = await running;

        assert.equal(result.success, false);
        assert.equal(result.stage, 'infrastructure');
        assert.match(result.stderr, /aborted/i);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(processExists(processId), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('native abort escalates to SIGKILL and waits for a SIGTERM-resistant descendant', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-kill-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const pidPath = path.join(root, 'simulator.pid');
    const controller = new AbortController();
    const simulator = simulatorConfig(capturePath, 'wait-ignore-term');
    simulator.compileCmd += ` ${quote(pidPath)}`;
    let processId: number | undefined;
    let running: Promise<SimulationExecution> | undefined;
    try {
        running = new NativeSimulatorBackend(
            'native:fake',
            simulator
        ).compileAndRun(createSimulationRequest({
            files: [path.join(root, 'top.v')],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 5_000,
            signal: controller.signal,
        }));
        await waitForFile(pidPath, 2_000);
        processId = Number(readFileSync(pidPath, 'utf8'));

        controller.abort();
        const result = await withTimeout(running, 1_000);

        assert.equal(result.stage, 'infrastructure');
        assert.equal(processExists(processId), false);
    } finally {
        if (processId !== undefined && processExists(processId)) {
            process.kill(processId, 'SIGKILL');
        }
        if (running !== undefined) await running.catch(() => {});
        rmSync(root, { recursive: true, force: true });
    }
});

test('a pre-aborted signal returns without starting a command', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-pre-abort-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const controller = new AbortController();
    const terminated: Array<number | undefined> = [];
    controller.abort();
    try {
        const result = await new NodeCommandExecutor({
            terminate(processId) {
                terminated.push(processId);
            },
        }).execute(
            simulatorConfig(capturePath).compileCmd,
            root,
            1,
            controller.signal
        );

        assert.equal(result.termination, 'abort');
        assert.match(result.stderr, /aborted/i);
        assert.equal(existsSync(capturePath), false);
        assert.deepEqual(terminated, []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('native timeout is infrastructure failure while HDL exit remains a compile failure', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-timeout-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const timeoutPidPath = path.join(root, 'timeout.pid');
    const timedOutSimulator = simulatorConfig(capturePath, 'wait');
    timedOutSimulator.compileCmd += ` ${quote(timeoutPidPath)}`;
    try {
        const timedOut = await new NativeSimulatorBackend(
            'native:fake',
            timedOutSimulator
        ).compileAndRun(createSimulationRequest({
            files: [path.join(root, 'top.v')],
            output: path.join(root, 'top.out'),
            cwd: root,
            timeoutMs: 50,
        }));
        const hdlFailure = await new NativeSimulatorBackend(
            'native:fake',
            simulatorConfig(capturePath, 'compile-fail')
        ).compileAndRun(normalizedRequest(root));

        assert.equal(timedOut.stage, 'infrastructure');
        assert.match(timedOut.stderr, /timed out/i);
        assert.equal(hdlFailure.stage, 'compile');
        assert.equal(hdlFailure.exitCode, 2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('node command executor removes abort listeners after completion', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let activeAbortListeners = 0;
    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions) => {
        if (type === 'abort') activeAbortListeners += 1;
        originalAdd(type, listener, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions) => {
        if (type === 'abort') activeAbortListeners -= 1;
        originalRemove(type, listener, options);
    }) as typeof signal.removeEventListener;

    await new NodeCommandExecutor().execute(
        `${quote(process.execPath)} -e ""`,
        process.cwd(),
        1,
        signal
    );

    assert.equal(activeAbortListeners, 0);
});

test('non-numeric command failures expose an infrastructure cause', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-cwd-'));
    const missingCwd = path.join(root, 'missing');
    try {
        const processResult = await new NodeCommandExecutor().execute(
            `${quote(process.execPath)} -e ""`,
            missingCwd,
            1
        );
        const execution = await new NativeSimulatorBackend(
            'native:fake',
            { name: 'fake', compileCmd: 'compile', runCmd: 'run' },
            {
                async execute() {
                    return processResult;
                },
            }
        ).compileAndRun(normalizedRequest(root));

        assert.equal(processResult.termination, 'infrastructure');
        assert.equal(infrastructureCause(processResult.cause!).code, 'ENOENT');
        assert.match(processResult.cause?.message ?? '', /ENOENT/);
        assert.equal(execution.stage, 'infrastructure');
        assert.deepEqual(execution.cause, processResult.cause);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('Windows process-tree termination invokes taskkill without shell interpolation', () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const terminator = new NodeProcessTreeTerminator(
        'win32',
        (executable, args) => {
            calls.push({ executable, args });
            return '';
        }
    );

    terminator.terminate(12_345);

    assert.deepEqual(calls, [{
        executable: 'taskkill',
        args: ['/PID', '12345', '/T', '/F'],
    }]);
});

test('Windows process-tree termination tolerates an already-exited process', async () => {
    const terminator = new NodeProcessTreeTerminator('win32', () => {
        const error = new Error('process not found') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
    });

    await assert.doesNotReject(terminator.terminate(12_345));
});

test('Linux identities parse starttime after process names with spaces and parentheses', () => {
    const fields = ['S', '1'];
    while (fields.length < 19) fields.push(String(fields.length));
    fields.push('987654321');
    const provider = new LinuxProcessIdentityProvider(filepath => {
        assert.equal(filepath, '/proc/42/stat');
        return `42 (sim worker (phase 1)) ${fields.join(' ')}\n`;
    });

    assert.equal(provider.identity(42, 'fallback'), 'linux:987654321');
    assert.equal(provider.supportsForcedTermination, true);
});

test('POSIX cleanup never signals a reused PID with a changed precise identity', async () => {
    const signals: Array<{ processId: number; signal: NodeJS.Signals }> = [];
    let identityReads = 0;
    const identityProvider: ProcessIdentityProvider = {
        supportsForcedTermination: true,
        identity(processId, fallback) {
            assert.equal(processId, 42);
            assert.match(fallback, /same-second/);
            identityReads += 1;
            return identityReads === 1 ? 'linux:old-start-ticks' : 'linux:new-start-ticks';
        },
    };
    const terminator = new NodeProcessTreeTerminator(
        'linux',
        () => [
            '41 1 S Sun Aug 16 12:00:00 2026 parent',
            '42 41 S Sun Aug 16 12:00:00 2026 same-second',
        ].join('\n'),
        identityProvider,
        (processId, signal) => {
            signals.push({ processId, signal });
        }
    );

    await terminator.terminate(41);

    assert.deepEqual(signals, []);
});

test('Darwin cleanup uses a stable composite only for immediate SIGTERM', async () => {
    const signals: Array<{ processId: number; signal: NodeJS.Signals }> = [];
    const terminator = new NodeProcessTreeTerminator(
        'darwin',
        () => [
            '41 1 S Sun Aug 16 12:00:00 2026 parent command',
            '42 41 S Sun Aug 16 12:00:00 2026 child command',
        ].join('\n'),
        undefined,
        (processId, signal) => {
            signals.push({ processId, signal });
        }
    );

    await terminator.terminate(41);

    assert.deepEqual(signals, [{ processId: 42, signal: 'SIGTERM' }]);
});

test('shell exit 127 is a compile infrastructure failure with a cause', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-127-'));
    try {
        const result = await new NativeSimulatorBackend('native:missing', {
            name: 'missing',
            compileCmd: 'veriflow-command-that-does-not-exist-127',
            runCmd: 'unused',
        }).compileAndRun(normalizedRequest(root));

        assert.equal(result.exitCode, 127);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.cause?.code, 'SHELL_EXIT_127');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('shell exit 126 is a run infrastructure failure with a cause', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-126-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const nonExecutable = path.join(root, 'not-executable');
    writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const simulator = simulatorConfig(capturePath);
    simulator.runCmd = quote(nonExecutable);
    try {
        const result = await new NativeSimulatorBackend(
            'native:not-executable',
            simulator
        ).compileAndRun(normalizedRequest(root));

        assert.equal(result.exitCode, 126);
        assert.equal(result.stage, 'infrastructure');
        assert.equal(result.cause?.code, 'SHELL_EXIT_126');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('ordinary numeric run exits remain HDL run failures', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-run-exit-'));
    const capturePath = path.join(root, 'calls.jsonl');
    const simulator = simulatorConfig(capturePath);
    simulator.runCmd = simulator.runCmd.replace(' run ', ' run-fail ');
    try {
        const result = await new NativeSimulatorBackend(
            'native:fake',
            simulator
        ).compileAndRun(normalizedRequest(root));

        assert.equal(result.exitCode, 3);
        assert.equal(result.stage, 'run');
        assert.equal(result.cause, undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('abort invokes process-tree cleanup without replacing the abort result', async () => {
    const controller = new AbortController();
    const processIds: number[] = [];
    const nativeTerminator = new NodeProcessTreeTerminator();
    const terminator: ProcessTreeTerminator = {
        async terminate(processId) {
            if (processId !== undefined) processIds.push(processId);
            await nativeTerminator.terminate(processId);
            throw new Error('cleanup failed');
        },
    };
    const execution = new NodeCommandExecutor(terminator).execute(
        `${quote(process.execPath)} -e "setInterval(() => {}, 1000)"`,
        process.cwd(),
        5,
        controller.signal
    );
    setTimeout(() => controller.abort(), 25);

    const result = await execution;

    assert.equal(result.termination, 'abort');
    assert.match(result.stderr, /aborted/i);
    assert.equal(processIds.length, 1);
    assert.ok(Number.isInteger(processIds[0]) && processIds[0] > 0);
});

test('timeout invokes process-tree cleanup without replacing the timeout result', async () => {
    const processIds: number[] = [];
    const nativeTerminator = new NodeProcessTreeTerminator();
    const terminator: ProcessTreeTerminator = {
        async terminate(processId) {
            if (processId !== undefined) processIds.push(processId);
            await nativeTerminator.terminate(processId);
            throw new Error('cleanup failed');
        },
    };

    const result = await new NodeCommandExecutor(terminator).execute(
        `${quote(process.execPath)} -e "setInterval(() => {}, 1000)"`,
        process.cwd(),
        0.025
    );

    assert.equal(result.termination, 'timeout');
    assert.match(result.stderr, /timed out/i);
    assert.equal(processIds.length, 1);
    assert.ok(Number.isInteger(processIds[0]) && processIds[0] > 0);
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
            new LegacyNativeSimulatorBackend().compileAndRun(
                input as unknown as LegacyNativeSimulationRequest
            ),
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
        assert.ok((result.timings.compile ?? -1) >= 0);
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
        const result = await new LegacyNativeSimulatorBackend().compileAndRun(
            request(root, capturePath)
        );

        assert.match(result.compileCommand, / compile "top\.out" "child\.v" "top\.v"$/);
        assert.match(result.runCommand, / run "top\.out"$/);
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
        const result = await new LegacyNativeSimulatorBackend(
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
        assert.deepEqual(legacyArtifacts(result), [], field);
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

    const result = await new LegacyNativeSimulatorBackend(
        successfulExecutor()
    ).compileAndRun(input);

    assert.deepEqual(legacyArtifacts(result), []);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), true);
});

test('legacy constructor mode requires an own simulator configuration', async () => {
    const { simulator, ...withoutSimulator } = legacyContractRequest();
    Object.setPrototypeOf(withoutSimulator, { simulator });

    await assert.rejects(
        new LegacyNativeSimulatorBackend(successfulExecutor()).compileAndRun(
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

    const result = await new LegacyNativeSimulatorBackend(
        successfulExecutor()
    ).compileAndRun(input);

    assert.deepEqual(reads, []);
    assert.deepEqual(legacyArtifacts(result), []);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'compileCommand'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'runCommand'), true);
});

test('native simulator backend runs rendered commands in the requested cwd', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-native-sim-'));
    const capturePath = path.join(root, 'calls.jsonl');
    try {
        const result = await new LegacyNativeSimulatorBackend().compileAndRun(
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
        const result = await new LegacyNativeSimulatorBackend().compileAndRun(
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
