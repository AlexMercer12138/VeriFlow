#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import nativeSimulatorBackend from '@veriflow/flow-core/nativeSimulatorBackend';
import * as defaultIverilogApi from '@veriflow/iverilog-wasm';

import {
    prepareNativeToolchain,
    readRepositoryMetadata,
} from './run-iverilog-regression.mjs';

const BENCHMARK_BACKENDS = new Set(['native-iverilog', 'builtin']);
const DEFAULT_SAMPLES = 5;
const DEFAULT_WARMUPS = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const processTreeTerminator = new nativeSimulatorBackend.NodeProcessTreeTerminator();

export async function loadBenchmarkCases(root = fileURLToPath(new URL(
    '../../benchmarks/verilog-simulator/cases/',
    import.meta.url,
))) {
    const entries = (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
    const cases = [];
    for (const entry of entries) {
        const caseRoot = path.join(root, entry.name);
        const descriptor = JSON.parse(await readFile(
            path.join(caseRoot, 'case.json'),
            'utf8',
        ));
        validateCaseDescriptor(descriptor, entry.name);
        const files = await Promise.all(descriptor.sources.map(async source => ({
            path: source,
            data: await readFile(path.join(caseRoot, ...source.split('/')), 'utf8'),
        })));
        cases.push({
            id: descriptor.id,
            top: descriptor.top,
            sources: [...descriptor.sources],
            files,
            expectedOutput: descriptor.expectedOutput,
            ...(descriptor.expectedEvents === undefined
                ? {}
                : { expectedEvents: descriptor.expectedEvents }),
            ...(descriptor.artifactPath === undefined
                ? {}
                : { artifactPath: descriptor.artifactPath }),
            ...(descriptor.specify === true ? { specify: true } : {}),
        });
    }
    if (cases.length === 0) throw new Error(`No benchmark cases found in ${root}`);
    return cases;
}

export function createNativeBenchmarkBackend({
    toolchain,
    processRunner = runNativeProcess,
}) {
    let metadata;
    const backend = {
        async metadata() {
            if (metadata !== undefined) return metadata;
            const [compiler, runtime] = await Promise.all([
                processRunner(
                    toolchain.commands.iverilog,
                    [...toolchain.compilerPrefixArgs, '-V'],
                    { cwd: process.cwd(), timeoutMs: DEFAULT_TIMEOUT_MS, measureRss: false },
                ),
                processRunner(
                    toolchain.commands.vvp,
                    [...toolchain.runtimePrefixArgs, '-V'],
                    { cwd: process.cwd(), timeoutMs: DEFAULT_TIMEOUT_MS, measureRss: false },
                ),
            ]);
            ensureNativeSuccess(compiler, 'iverilog version probe');
            ensureNativeSuccess(runtime, 'vvp version probe');
            metadata = {
                iverilogVersion: versionSummary(compiler),
                vvpVersion: versionSummary(runtime),
                memoryMeasurement: process.platform === 'linux'
                    ? 'linux-proc-child-rss'
                    : 'unavailable',
            };
            return metadata;
        },
        async prepare(benchmarkCase) {
            const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-benchmark-native-'));
            try {
                for (const file of benchmarkCase.files) {
                    const destination = path.join(root, ...file.path.split('/'));
                    await mkdir(path.dirname(destination), { recursive: true });
                    await writeFile(destination, file.data);
                }
                return { root, benchmarkCase };
            } catch (error) {
                await rm(root, { recursive: true, force: true });
                throw error;
            }
        },
        async compile(prepared, { timeoutMs, measureRss = false }) {
            const output = 'benchmark.out';
            const execution = await processRunner(
                toolchain.commands.iverilog,
                [
                    ...toolchain.compilerPrefixArgs,
                    '-g2005',
                    ...(prepared.benchmarkCase.specify === true
                        ? ['-gspecify']
                        : []),
                    '-s',
                    prepared.benchmarkCase.top,
                    '-o',
                    output,
                    ...prepared.benchmarkCase.sources,
                ],
                { cwd: prepared.root, timeoutMs, measureRss },
            );
            const success = nativeExecutionSucceeded(execution);
            return {
                success,
                ...(success ? { executable: output } : {}),
                stdout: execution.stdout,
                stderr: execution.stderr,
                peakRssBytes: execution.peakRssBytes ?? null,
                ...(nativeExecutionCode(execution) === undefined
                    ? {}
                    : { code: nativeExecutionCode(execution) }),
            };
        },
        async run(prepared, executable, { timeoutMs }) {
            const artifactPath = prepared.benchmarkCase.artifactPath;
            if (artifactPath !== undefined) {
                await rm(
                    path.join(prepared.root, ...artifactPath.split('/')),
                    { force: true },
                );
            }
            const execution = await processRunner(
                toolchain.commands.vvp,
                [...toolchain.runtimePrefixArgs, executable],
                { cwd: prepared.root, timeoutMs, measureRss: true },
            );
            return nativeRunResult(execution, prepared.root, artifactPath);
        },
        async endToEnd(benchmarkCase, { timeoutMs }) {
            const prepared = await backend.prepare(benchmarkCase);
            try {
                const compiled = await backend.compile(prepared, {
                    timeoutMs,
                    measureRss: true,
                });
                if (!compiled.success || compiled.executable === undefined) {
                    return {
                        success: false,
                        stdout: compiled.stdout,
                        stderr: compiled.stderr,
                        ...(compiled.code === undefined ? {} : { code: compiled.code }),
                        peakRssBytes: null,
                        vcdBytes: 0,
                    };
                }
                const execution = await backend.run(
                    prepared,
                    compiled.executable,
                    { timeoutMs },
                );
                return {
                    ...execution,
                    peakRssBytes: maximumNullable(
                        compiled.peakRssBytes,
                        execution.peakRssBytes,
                    ),
                };
            } finally {
                await backend.cleanup(prepared);
            }
        },
        async cleanup(prepared) {
            await rm(prepared.root, { recursive: true, force: true });
        },
    };
    return backend;
}

export function createBuiltinBenchmarkBackend({
    api = defaultIverilogApi,
    metadata,
    measureOperation = measureNodeOperation,
} = {}) {
    let resolvedMetadata;
    const backend = {
        async metadata() {
            resolvedMetadata ??= {
                ...(metadata ?? await readBuiltinMetadata()),
                memoryMeasurement: 'node-process-rss',
            };
            return resolvedMetadata;
        },
        async prepare(benchmarkCase) {
            return { benchmarkCase };
        },
        async compile(prepared, { timeoutMs }) {
            const request = builtinCompileRequest(prepared.benchmarkCase, timeoutMs);
            const measurement = await measureOperation(() => api.compile(request));
            const execution = measurement.value;
            const success = execution.success && execution.program !== undefined;
            return {
                success,
                ...(success ? { executable: execution.program } : {}),
                stdout: execution.stdout,
                stderr: execution.stderr,
            };
        },
        async run(prepared, executable, { timeoutMs }) {
            const artifactPath = prepared.benchmarkCase.artifactPath;
            const measurement = await measureOperation(() => api.run({
                program: executable,
                artifacts: artifactPath === undefined ? [] : [artifactPath],
                timeoutMs,
            }));
            return builtinRunResult(
                measurement.value,
                measurement.peakRssBytes,
                artifactPath,
            );
        },
        async endToEnd(benchmarkCase, { timeoutMs }) {
            const artifactPath = benchmarkCase.artifactPath;
            const measurement = await measureOperation(() => api.simulate({
                ...builtinCompileRequest(benchmarkCase, timeoutMs),
                artifacts: artifactPath === undefined ? [] : [artifactPath],
            }));
            return builtinRunResult(
                measurement.value,
                measurement.peakRssBytes,
                artifactPath,
            );
        },
        async cleanup() {},
    };
    return backend;
}

export async function runBenchmarkCommand(options, {
    loadCases = loadBenchmarkCases,
    prepareNative = prepareNativeToolchain,
    createNativeBackend = createNativeBenchmarkBackend,
    createBuiltinBackend = createBuiltinBenchmarkBackend,
    system,
    generatedAt,
    repositoryMetadata = readRepositoryMetadata,
} = {}) {
    const cases = await loadCases();
    const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
    let provenance;
    try {
        provenance = await repositoryMetadata(repositoryRoot);
    } catch (error) {
        provenance = {
            unavailable: true,
            reason: normalizeError(error).message,
        };
    }
    const backends = {};
    let nativeToolchain;
    try {
        if (options.backendIds.includes('native-iverilog')) {
            nativeToolchain = await prepareNative({
                iverilogRoot: options.iverilogRoot
                    ?? process.env.IVERILOG_ROOT
                    ?? '',
            });
            backends['native-iverilog'] = createNativeBackend({
                toolchain: nativeToolchain,
            });
        }
        if (options.backendIds.includes('builtin')) {
            backends.builtin = createBuiltinBackend();
        }
        const report = await runBenchmarkSuite({
            cases,
            backendIds: options.backendIds,
            backends,
            samples: options.samples,
            warmups: options.warmups,
            timeoutMs: options.timeoutMs,
            ...(system === undefined ? {} : { system }),
            ...(generatedAt === undefined ? {} : { generatedAt }),
            provenance,
        });
        if (options.json !== undefined) {
            await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
            await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
        }
        return {
            report,
            exitCode: report.results.every(result => result.success) ? 0 : 1,
        };
    } finally {
        await nativeToolchain?.cleanup();
    }
}

function validateCaseDescriptor(descriptor, directoryName) {
    if (descriptor === null
        || typeof descriptor !== 'object'
        || Array.isArray(descriptor)) {
        throw new Error(`Invalid benchmark descriptor: ${directoryName}/case.json`);
    }
    if (descriptor.id !== directoryName) {
        throw new Error(
            `Benchmark case ID must match its directory: ${directoryName}`,
        );
    }
    if (typeof descriptor.top !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(descriptor.top)) {
        throw new Error(`Invalid benchmark top module: ${String(descriptor.top)}`);
    }
    if (!Array.isArray(descriptor.sources) || descriptor.sources.length === 0) {
        throw new Error(`Benchmark ${directoryName} requires at least one source`);
    }
    const sourceSet = new Set();
    for (const source of descriptor.sources) {
        validateSafeBenchmarkPath(source, 'source');
        if (sourceSet.has(source)) {
            throw new Error(`Duplicate benchmark source path: ${source}`);
        }
        sourceSet.add(source);
    }
    if (typeof descriptor.expectedOutput !== 'string'
        || descriptor.expectedOutput === ''
        || descriptor.expectedOutput.includes('\n')
        || descriptor.expectedOutput.includes('\r')) {
        throw new Error(`Invalid benchmark expected output: ${directoryName}`);
    }
    if (descriptor.expectedEvents !== undefined
        && (!Number.isSafeInteger(descriptor.expectedEvents)
            || descriptor.expectedEvents < 0)) {
        throw new Error(`Invalid benchmark expectedEvents: ${directoryName}`);
    }
    if (descriptor.artifactPath !== undefined) {
        validateSafeBenchmarkPath(descriptor.artifactPath, 'artifact');
    }
    if (descriptor.specify !== undefined
        && typeof descriptor.specify !== 'boolean') {
        throw new Error(`Invalid benchmark specify option: ${directoryName}`);
    }
}

function validateSafeBenchmarkPath(value, kind) {
    if (typeof value !== 'string'
        || value === ''
        || value.includes('\0')
        || value.includes('\\')
        || path.posix.isAbsolute(value)
        || path.posix.normalize(value) !== value
        || value === '..'
        || value.startsWith('../')) {
        throw new Error(`Unsafe benchmark ${kind} path: ${String(value)}`);
    }
}

function builtinCompileRequest(benchmarkCase, timeoutMs) {
    return {
        files: benchmarkCase.files.map(file => ({
            path: file.path,
            data: file.data,
        })),
        sources: [...benchmarkCase.sources],
        top: benchmarkCase.top,
        generation: '2005',
        specify: benchmarkCase.specify === true,
        timeoutMs,
    };
}

function builtinRunResult(execution, peakRssBytes, artifactPath) {
    let vcdBytes = 0;
    if (artifactPath !== undefined) {
        const artifact = execution.artifacts?.get(artifactPath);
        if (artifact === undefined && execution.success) {
            return {
                success: false,
                stdout: execution.stdout ?? '',
                stderr: `missing benchmark artifact: ${artifactPath}`,
                code: 'BENCHMARK_MISSING_ARTIFACT',
                peakRssBytes,
                vcdBytes: 0,
            };
        }
        vcdBytes = artifact?.byteLength ?? 0;
    }
    return {
        success: execution.success,
        stdout: execution.stdout ?? '',
        stderr: execution.stderr ?? '',
        peakRssBytes,
        vcdBytes,
    };
}

async function readBuiltinMetadata() {
    const entry = fileURLToPath(import.meta.resolve('@veriflow/iverilog-wasm'));
    const packageRoot = path.resolve(path.dirname(entry), '..');
    const packageMetadata = JSON.parse(await readFile(
        path.join(packageRoot, 'package.json'),
        'utf8',
    ));
    const source = await readFile(
        path.join(packageRoot, 'dist', 'SOURCE.md'),
        'utf8',
    );
    const revision = source.match(/Git revision:\s*`([0-9a-f]{40})`/u)?.[1];
    if (typeof packageMetadata.version !== 'string' || revision === undefined) {
        throw new Error('Invalid @veriflow/iverilog-wasm package metadata');
    }
    return {
        packageVersion: packageMetadata.version,
        sourceRevision: revision,
    };
}

async function measureNodeOperation(operation) {
    let peakRssBytes = process.memoryUsage().rss;
    const sample = () => {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    };
    const interval = setInterval(sample, 2);
    interval.unref();
    try {
        const value = await operation();
        sample();
        return { value, peakRssBytes };
    } finally {
        clearInterval(interval);
    }
}

async function nativeRunResult(execution, root, artifactPath) {
    let vcdBytes = 0;
    if (artifactPath !== undefined && nativeExecutionSucceeded(execution)) {
        try {
            const metadata = await stat(path.join(root, ...artifactPath.split('/')));
            if (!metadata.isFile()) throw new Error('artifact is not a regular file');
            vcdBytes = metadata.size;
        } catch (error) {
            return {
                success: false,
                stdout: execution.stdout,
                stderr: `missing benchmark artifact ${artifactPath}: ${error.message}`,
                code: 'BENCHMARK_MISSING_ARTIFACT',
                peakRssBytes: execution.peakRssBytes ?? null,
                vcdBytes: 0,
            };
        }
    }
    return {
        success: nativeExecutionSucceeded(execution),
        stdout: execution.stdout,
        stderr: execution.stderr,
        ...(nativeExecutionCode(execution) === undefined
            ? {}
            : { code: nativeExecutionCode(execution) }),
        peakRssBytes: execution.peakRssBytes ?? null,
        vcdBytes,
    };
}

function nativeExecutionSucceeded(execution) {
    return execution.exitCode === 0
        && execution.termination === undefined
        && execution.cause === undefined;
}

function nativeExecutionCode(execution) {
    if (execution.termination === 'timeout') return 'BENCHMARK_TIMEOUT';
    if (execution.cause !== undefined) return 'BENCHMARK_INFRASTRUCTURE_ERROR';
    if (execution.exitCode !== 0) return 'BENCHMARK_PROCESS_FAILED';
    return undefined;
}

function ensureNativeSuccess(execution, stage) {
    if (!nativeExecutionSucceeded(execution)) {
        throw benchmarkError(
            `${stage} failed: ${executionFailure(execution, `exit ${execution.exitCode}`)}`,
            nativeExecutionCode(execution),
        );
    }
}

function versionSummary(execution) {
    return `${execution.stdout}\n${execution.stderr}`
        .split(/\r?\n/u)
        .map(line => line.trim())
        .find(line => line !== '') ?? 'unknown';
}

async function runNativeProcess(executable, args, {
    cwd,
    timeoutMs,
    measureRss,
}) {
    return new Promise(resolve => {
        const stdout = [];
        const stderr = [];
        let cause;
        let termination;
        let terminationPromise;
        let settled = false;
        const child = spawn(executable, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const rssTracker = createChildRssTracker(child.pid, measureRss);
        const terminate = () => {
            terminationPromise ??= Promise.resolve(
                Number.isSafeInteger(child.pid)
                    ? processTreeTerminator.terminate(child.pid)
                    : undefined,
            )
                .catch(() => {})
                .then(() => {
                    child.kill('SIGKILL');
                });
            return terminationPromise;
        };
        const timeout = setTimeout(() => {
            termination = 'timeout';
            void terminate();
        }, timeoutMs);
        child.stdout.on('data', chunk => stdout.push(chunk.toString()));
        child.stderr.on('data', chunk => stderr.push(chunk.toString()));
        child.on('error', error => {
            cause = { message: error.message, code: error.code };
        });
        child.on('close', async (exitCode, signalCode) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            await terminationPromise;
            if (cause !== undefined && termination === undefined) {
                termination = 'infrastructure';
            } else if (signalCode !== null && termination === undefined) {
                termination = 'signal';
            }
            resolve({
                exitCode: exitCode ?? -1,
                stdout: stdout.join(''),
                stderr: stderr.join(''),
                ...(termination === undefined ? {} : { termination }),
                ...(signalCode === null ? {} : { signalCode }),
                ...(cause === undefined ? {} : { cause }),
                peakRssBytes: await rssTracker.stop(),
            });
        });
    });
}

export function createChildRssTracker(processId, enabled, {
    readStatus = filepath => readFile(filepath, 'utf8'),
    schedule = setInterval,
    cancel = clearInterval,
} = {}) {
    if (!enabled || process.platform !== 'linux' || !Number.isSafeInteger(processId)) {
        return { async stop() { return null; } };
    }
    let peakRssBytes = null;
    let pending = Promise.resolve();
    let measurementUnavailable = false;
    const sample = async () => {
        try {
            const status = await readStatus(`/proc/${processId}/status`);
            for (const key of ['VmHWM', 'VmRSS']) {
                const kibibytes = Number(status.match(
                    new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'mu'),
                )?.[1]);
                if (Number.isSafeInteger(kibibytes)) {
                    peakRssBytes = Math.max(peakRssBytes ?? 0, kibibytes * 1_024);
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') measurementUnavailable = true;
        }
    };
    const queueSample = () => {
        pending = pending.then(sample, sample);
    };
    queueSample();
    const interval = schedule(queueSample, 2);
    interval.unref?.();
    return {
        async stop() {
            cancel(interval);
            await pending;
            return measurementUnavailable ? null : peakRssBytes;
        },
    };
}

export async function runBenchmarkSuite({
    cases,
    backendIds,
    backends,
    samples = DEFAULT_SAMPLES,
    warmups = DEFAULT_WARMUPS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    clock = performance.now.bind(performance),
    system = systemMetadata(),
    generatedAt = new Date().toISOString(),
    provenance,
}) {
    validatePositiveInteger(samples, 'samples');
    validateNonNegativeInteger(warmups, 'warmups');
    validatePositiveInteger(timeoutMs, 'timeoutMs');
    validateUniqueStrings(backendIds, 'backend');
    validateUniqueStrings(cases.map(benchmarkCase => benchmarkCase.id), 'case');

    const backendMetadata = {};
    for (const backendId of backendIds) {
        const backend = backends[backendId];
        if (backend === undefined) {
            throw new Error(`Unknown benchmark backend: ${backendId}`);
        }
        backendMetadata[backendId] = await backend.metadata();
    }

    const results = [];
    for (const benchmarkCase of cases) {
        for (const backendId of backendIds) {
            results.push(await benchmarkOne({
                benchmarkCase,
                backendId,
                backend: backends[backendId],
                samples,
                warmups,
                timeoutMs,
                clock,
            }));
        }
    }

    return {
        schemaVersion: 1,
        generatedAt,
        system,
        ...(provenance === undefined ? {} : { provenance }),
        configuration: { samples, warmups, timeoutMs },
        backends: backendMetadata,
        cases: cases.map(benchmarkCase => ({
            id: benchmarkCase.id,
            top: benchmarkCase.top,
            sourceCount: benchmarkCase.sources.length,
            ...(benchmarkCase.specify === true ? { specify: true } : {}),
            ...(benchmarkCase.artifactPath === undefined
                ? {}
                : { artifactPath: benchmarkCase.artifactPath }),
            ...(benchmarkCase.expectedEvents === undefined
                ? {}
                : { expectedEvents: benchmarkCase.expectedEvents }),
        })),
        results,
    };
}

async function benchmarkOne({
    benchmarkCase,
    backendId,
    backend,
    samples,
    warmups,
    timeoutMs,
    clock,
}) {
    let prepared;
    let result;
    let stage = 'prepare';
    try {
        prepared = await backend.prepare(benchmarkCase);
        stage = 'compile';
        const compileMeasurement = await measure(clock, () => backend.compile(
            prepared,
            { timeoutMs },
        ));
        const compiled = compileMeasurement.value;
        if (!compiled.success || compiled.executable === undefined) {
            result = failedBenchmarkResult(
                benchmarkCase,
                backendId,
                'compile',
                executionFailure(compiled, 'benchmark compile failed'),
            );
        } else {
            stage = 'run';
            const runMetrics = await measureSeries({
                samples,
                warmups,
                clock,
                operation: () => backend.run(
                    prepared,
                    compiled.executable,
                    { timeoutMs },
                ),
                validate: execution => validateExecution(benchmarkCase, execution),
            });
            stage = 'end-to-end';
            const endToEndMetrics = await measureSeries({
                samples,
                warmups,
                clock,
                operation: () => backend.endToEnd(
                    benchmarkCase,
                    { timeoutMs },
                ),
                validate: execution => validateExecution(benchmarkCase, execution),
            });
            result = {
                caseId: benchmarkCase.id,
                backendId,
                success: true,
                ...(benchmarkCase.expectedEvents === undefined
                    ? {}
                    : { expectedEvents: benchmarkCase.expectedEvents }),
                compileMs: compileMeasurement.durationMs,
                run: runMetrics,
                endToEnd: endToEndMetrics,
            };
        }
    } catch (error) {
        result = failedBenchmarkResult(
            benchmarkCase,
            backendId,
            stage,
            error,
        );
    }

    if (prepared !== undefined) {
        try {
            await backend.cleanup(prepared);
        } catch (error) {
            if (result.success) {
                result = failedBenchmarkResult(
                    benchmarkCase,
                    backendId,
                    'cleanup',
                    error,
                );
            }
        }
    }
    return result;
}

async function measureSeries({
    samples,
    warmups,
    clock,
    operation,
    validate,
}) {
    for (let index = 0; index < warmups; index += 1) {
        const warmup = await operation();
        validate(warmup);
    }

    const durations = [];
    const executions = [];
    for (let index = 0; index < samples; index += 1) {
        const measurement = await measure(clock, operation);
        validate(measurement.value);
        durations.push(measurement.durationMs);
        executions.push(measurement.value);
    }

    const vcdSizes = executions.map(execution => execution.vcdBytes ?? 0);
    if (new Set(vcdSizes).size !== 1) {
        throw benchmarkError(
            'benchmark produced inconsistent VCD sizes across measured samples',
            'BENCHMARK_NONDETERMINISTIC_ARTIFACT',
        );
    }
    const rssValues = executions
        .map(execution => execution.peakRssBytes)
        .filter(value => Number.isSafeInteger(value) && value >= 0);

    return {
        samplesMs: durations,
        medianMs: median(durations),
        p95Ms: percentile95(durations),
        peakRssBytes: rssValues.length === 0 ? null : Math.max(...rssValues),
        vcdBytes: vcdSizes[0],
    };
}

async function measure(clock, operation) {
    const startedAt = clock();
    const value = await operation();
    const finishedAt = clock();
    const durationMs = finishedAt - startedAt;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(`Invalid monotonic duration: ${durationMs}`);
    }
    return { durationMs, value };
}

function validateExecution(benchmarkCase, execution) {
    if (!execution.success) {
        throw benchmarkError(
            executionFailure(execution, 'benchmark run failed'),
            execution.code,
        );
    }
    const lines = `${execution.stdout ?? ''}\n${execution.stderr ?? ''}`
        .replaceAll('\r\n', '\n')
        .split('\n');
    if (!lines.includes(benchmarkCase.expectedOutput)) {
        throw benchmarkError(
            `expected output line ${JSON.stringify(benchmarkCase.expectedOutput)}`,
            'BENCHMARK_SELF_CHECK_FAILED',
        );
    }
}

function executionFailure(execution, fallback) {
    const detail = [execution.stderr, execution.stdout]
        .find(value => typeof value === 'string' && value.trim() !== '');
    return detail?.trim() ?? fallback;
}

function failedBenchmarkResult(benchmarkCase, backendId, stage, error) {
    const normalized = normalizeError(error);
    return {
        caseId: benchmarkCase.id,
        backendId,
        success: false,
        ...(benchmarkCase.expectedEvents === undefined
            ? {}
            : { expectedEvents: benchmarkCase.expectedEvents }),
        error: {
            stage,
            ...(normalized.code === undefined ? {} : { code: normalized.code }),
            message: normalized.message,
        },
    };
}

function normalizeError(error) {
    if (error instanceof Error) {
        return {
            message: error.message,
            ...(typeof error.code === 'string' ? { code: error.code } : {}),
        };
    }
    return { message: String(error) };
}

function benchmarkError(message, code) {
    const error = new Error(message);
    if (typeof code === 'string') error.code = code;
    return error;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function percentile95(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function maximumNullable(...values) {
    const numbers = values.filter(
        value => Number.isSafeInteger(value) && value >= 0,
    );
    return numbers.length === 0 ? null : Math.max(...numbers);
}

export function parseBenchmarkArguments(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const keyByOption = {
            '--backend': 'backend',
            '--samples': 'samples',
            '--warmups': 'warmups',
            '--json': 'json',
            '--iverilog-root': 'iverilogRoot',
            '--timeout-ms': 'timeoutMs',
        };
        const key = keyByOption[argument];
        if (key === undefined) throw new Error(`Unknown option: ${argument}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        values[key] = value;
        index += 1;
    }

    const backendIds = (values.backend ?? 'native-iverilog,builtin').split(',');
    validateUniqueStrings(backendIds, 'backend');
    for (const backendId of backendIds) {
        if (!BENCHMARK_BACKENDS.has(backendId)) {
            throw new Error(`Unknown benchmark backend: ${backendId}`);
        }
    }
    const samples = integerOption(values.samples, DEFAULT_SAMPLES, 'samples', true);
    const warmups = integerOption(values.warmups, DEFAULT_WARMUPS, 'warmups', false);
    const timeoutMs = integerOption(
        values.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        'timeoutMs',
        true,
    );
    return {
        backendIds,
        samples,
        warmups,
        ...(values.json === undefined ? {} : { json: values.json }),
        ...(values.iverilogRoot === undefined
            ? {}
            : { iverilogRoot: values.iverilogRoot }),
        timeoutMs,
    };
}

function integerOption(value, fallback, name, positive) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
        throw new Error(
            `${name} must be a ${positive ? 'positive' : 'non-negative'} integer`,
        );
    }
    return parsed;
}

function validatePositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}

function validateNonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
}

function validateUniqueStrings(values, name) {
    const seen = new Set();
    for (const value of values) {
        if (typeof value !== 'string' || value === '') {
            throw new Error(`Invalid ${name}: ${String(value)}`);
        }
        if (seen.has(value)) throw new Error(`Duplicate ${name}: ${value}`);
        seen.add(value);
    }
}

function systemMetadata() {
    const cpus = os.cpus();
    return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        cpuModel: cpus[0]?.model ?? 'unknown',
        cpuCount: cpus.length,
    };
}

async function main() {
    const options = parseBenchmarkArguments(process.argv.slice(2));
    if (options.json === undefined) {
        throw new Error('Missing required option: --json');
    }
    const outcome = await runBenchmarkCommand(options);
    for (const backendId of options.backendIds) {
        const results = outcome.report.results.filter(
            result => result.backendId === backendId,
        );
        const success = results.filter(result => result.success).length;
        console.log(
            `${backendId}: success=${success} failure=${results.length - success}`,
        );
    }
    console.log(`json=${path.resolve(options.json)}`);
    process.exitCode = outcome.exitCode;
}

if (process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
