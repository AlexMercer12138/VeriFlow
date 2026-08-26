import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createBuiltinBenchmarkBackend,
    createChildRssTracker,
    createNativeBenchmarkBackend,
    loadBenchmarkCases,
    parseBenchmarkArguments,
    runBenchmarkCommand,
    runBenchmarkSuite,
} from './benchmark.mjs';

test('excludes warmups and separates compile, run, and end-to-end samples', async () => {
    const monotonic = fakeMonotonicClock();
    const compileDurations = [];
    const runDurations = [999, 1, 2, 3, 4, 5];
    const endToEndDurations = [784, 17, 27, 37, 47, 57];
    const timeoutValues = [];
    let compileCalls = 0;
    let runCalls = 0;
    let endToEndCalls = 0;
    let cleanupCalls = 0;
    const backend = {
        async metadata() {
            return { version: 'fake-1.0' };
        },
        async prepare(benchmarkCase) {
            return { benchmarkCase };
        },
        async compile(_prepared, { timeoutMs }) {
            timeoutValues.push(timeoutMs);
            compileCalls += 1;
            compileDurations.push(7);
            monotonic.advance(7);
            return {
                success: true,
                executable: { compileCall: compileCalls },
                stdout: '',
                stderr: '',
            };
        },
        async run(_prepared, compiled, { timeoutMs }) {
            timeoutValues.push(timeoutMs);
            const duration = runDurations[runCalls];
            runCalls += 1;
            monotonic.advance(duration);
            return {
                success: true,
                stdout: 'PASS fake\n',
                stderr: '',
                peakRssBytes: duration * 100,
                vcdBytes: compiled.compileCall === 1 ? 64 : 0,
            };
        },
        async endToEnd(benchmarkCase, { timeoutMs }) {
            timeoutValues.push(timeoutMs);
            const duration = endToEndDurations[endToEndCalls];
            endToEndCalls += 1;
            monotonic.advance(duration);
            return {
                success: true,
                stdout: `PASS ${benchmarkCase.id}\n`,
                stderr: '',
                peakRssBytes: Math.max(0, duration - 7) * 100,
                vcdBytes: 128,
            };
        },
        async cleanup() {
            cleanupCalls += 1;
        },
    };

    const report = await runBenchmarkSuite({
        cases: [benchmarkCase('fake')],
        backendIds: ['fake'],
        backends: { fake: backend },
        samples: 5,
        warmups: 1,
        timeoutMs: 1_234,
        clock: monotonic.now,
        system: sampleSystem(),
        generatedAt: '2026-08-26T00:00:00.000Z',
    });

    assert.equal(compileCalls, 1);
    assert.equal(runCalls, 6);
    assert.equal(endToEndCalls, 6);
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(new Set(timeoutValues), new Set([1_234]));
    assert.deepEqual(compileDurations, [7]);
    assert.deepEqual(report.results, [{
        caseId: 'fake',
        backendId: 'fake',
        success: true,
        expectedEvents: 42,
        compileMs: 7,
        run: {
            samplesMs: [1, 2, 3, 4, 5],
            medianMs: 3,
            p95Ms: 5,
            peakRssBytes: 500,
            vcdBytes: 64,
        },
        endToEnd: {
            samplesMs: [17, 27, 37, 47, 57],
            medianMs: 37,
            p95Ms: 57,
            peakRssBytes: 5_000,
            vcdBytes: 128,
        },
    }]);
});

test('records timeout and compile failures without dropping later cases', async () => {
    const timeoutValues = [];
    const backend = {
        async metadata() {
            return { version: 'fake-2.0' };
        },
        async prepare(benchmarkCase) {
            return { benchmarkCase };
        },
        async compile(prepared, { timeoutMs }) {
            timeoutValues.push(timeoutMs);
            if (prepared.benchmarkCase.id === 'compile-failure') {
                return {
                    success: false,
                    stdout: '',
                    stderr: 'compile failed',
                };
            }
            return {
                success: true,
                executable: {},
                stdout: '',
                stderr: '',
            };
        },
        async run(prepared, _compiled, { timeoutMs }) {
            timeoutValues.push(timeoutMs);
            if (prepared.benchmarkCase.id === 'timeout') {
                throw Object.assign(new Error('run exceeded deadline'), {
                    code: 'BENCHMARK_TIMEOUT',
                });
            }
            return {
                success: true,
                stdout: `PASS ${prepared.benchmarkCase.id}\n`,
                stderr: '',
                peakRssBytes: 100,
                vcdBytes: 0,
            };
        },
        async endToEnd(benchmarkCase, { timeoutMs }) {
            timeoutValues.push(timeoutMs);
            return {
                success: true,
                stdout: `PASS ${benchmarkCase.id}\n`,
                stderr: '',
                peakRssBytes: 100,
                vcdBytes: 0,
            };
        },
        async cleanup() {},
    };

    const report = await runBenchmarkSuite({
        cases: [
            benchmarkCase('timeout'),
            benchmarkCase('compile-failure'),
            benchmarkCase('after-failure'),
        ],
        backendIds: ['fake'],
        backends: { fake: backend },
        samples: 1,
        warmups: 0,
        timeoutMs: 987,
        clock: () => 0,
        system: sampleSystem(),
        generatedAt: '2026-08-26T00:00:00.000Z',
    });

    assert.deepEqual(report.results.map(result => ({
        caseId: result.caseId,
        success: result.success,
        error: result.error,
    })), [
        {
            caseId: 'timeout',
            success: false,
            error: {
                stage: 'run',
                code: 'BENCHMARK_TIMEOUT',
                message: 'run exceeded deadline',
            },
        },
        {
            caseId: 'compile-failure',
            success: false,
            error: {
                stage: 'compile',
                message: 'compile failed',
            },
        },
        {
            caseId: 'after-failure',
            success: true,
            error: undefined,
        },
    ]);
    assert.deepEqual(new Set(timeoutValues), new Set([987]));
});

test('emits the stable benchmark JSON schema and backend metadata', async () => {
    const backend = immediateBackend();
    const report = await runBenchmarkSuite({
        cases: [{ ...benchmarkCase('schema'), specify: true }],
        backendIds: ['fake'],
        backends: { fake: backend },
        samples: 1,
        warmups: 0,
        timeoutMs: 30_000,
        clock: () => 0,
        system: sampleSystem(),
        generatedAt: '2026-08-26T00:00:00.000Z',
    });

    assert.deepEqual(report, {
        schemaVersion: 1,
        generatedAt: '2026-08-26T00:00:00.000Z',
        system: sampleSystem(),
        configuration: {
            samples: 1,
            warmups: 0,
            timeoutMs: 30_000,
        },
        backends: {
            fake: { version: 'fake-3.0' },
        },
        cases: [{
            id: 'schema',
            top: 'schema_bench',
            sourceCount: 1,
            specify: true,
            expectedEvents: 42,
        }],
        results: [{
            caseId: 'schema',
            backendId: 'fake',
            success: true,
            expectedEvents: 42,
            compileMs: 0,
            run: {
                samplesMs: [0],
                medianMs: 0,
                p95Ms: 0,
                peakRssBytes: 123,
                vcdBytes: 0,
            },
            endToEnd: {
                samplesMs: [0],
                medianMs: 0,
                p95Ms: 0,
                peakRssBytes: 123,
                vcdBytes: 0,
            },
        }],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('parses strict benchmark command options', () => {
    assert.deepEqual(parseBenchmarkArguments([
        '--backend', 'native-iverilog,builtin',
        '--samples', '5',
        '--json', '/tmp/benchmark.json',
        '--iverilog-root', '/src/iverilog',
        '--timeout-ms', '30000',
    ]), {
        backendIds: ['native-iverilog', 'builtin'],
        samples: 5,
        warmups: 1,
        json: '/tmp/benchmark.json',
        iverilogRoot: '/src/iverilog',
        timeoutMs: 30_000,
    });
    assert.throws(
        () => parseBenchmarkArguments(['--backend', 'builtin,builtin']),
        /Duplicate backend: builtin/,
    );
    assert.throws(
        () => parseBenchmarkArguments(['--samples', '0']),
        /samples must be a positive integer/,
    );
    assert.throws(
        () => parseBenchmarkArguments(['--wat']),
        /Unknown option: --wat/,
    );
});

test('loads benchmark case metadata and source bytes from safe relative paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-benchmark-cases-'));
    try {
        const caseRoot = path.join(root, 'alpha');
        await mkdir(path.join(caseRoot, 'rtl'), { recursive: true });
        await writeFile(path.join(caseRoot, 'rtl', 'alpha.v'), [
            'module alpha_bench;',
            '  initial begin $display("PASS alpha"); $finish; end',
            'endmodule',
            '',
        ].join('\n'));
        await writeFile(path.join(caseRoot, 'case.json'), JSON.stringify({
            id: 'alpha',
            top: 'alpha_bench',
            sources: ['rtl/alpha.v'],
            expectedOutput: 'PASS alpha',
            expectedEvents: 12,
            artifactPath: 'waves/alpha.vcd',
            specify: true,
        }));

        const cases = await loadBenchmarkCases(root);

        assert.deepEqual(cases, [{
            id: 'alpha',
            top: 'alpha_bench',
            sources: ['rtl/alpha.v'],
            files: [{
                path: 'rtl/alpha.v',
                data: await readFile(path.join(caseRoot, 'rtl', 'alpha.v'), 'utf8'),
            }],
            expectedOutput: 'PASS alpha',
            expectedEvents: 12,
            artifactPath: 'waves/alpha.vcd',
            specify: true,
        }]);

        await writeFile(path.join(caseRoot, 'case.json'), JSON.stringify({
            id: 'alpha',
            top: 'alpha_bench',
            sources: ['rtl/alpha.v'],
            expectedOutput: 'PASS alpha',
            specify: 'yes',
        }));
        await assert.rejects(
            loadBenchmarkCases(root),
            /Invalid benchmark specify option: alpha/,
        );

        await writeFile(path.join(caseRoot, 'case.json'), JSON.stringify({
            id: 'alpha',
            top: 'alpha_bench',
            sources: ['../outside.v'],
            expectedOutput: 'PASS alpha',
        }));
        await assert.rejects(
            loadBenchmarkCases(root),
            /Unsafe benchmark source path: \.\.\/outside\.v/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('native adapter compiles with g2005 and measures vvp separately', async () => {
    const calls = [];
    const processRunner = async (executable, args, options) => {
        calls.push({ executable, args, ...options });
        if (args.includes('-V')) {
            return processExecution({
                stdout: executable === 'iverilog-test'
                    ? 'Icarus Verilog version test\n'
                    : 'Icarus Verilog runtime version test\n',
            });
        }
        if (executable === 'vvp-test') {
            await new Promise(resolve => setTimeout(resolve, 10));
            await access(path.join(options.cwd, args.at(-1)));
            await mkdir(path.join(options.cwd, 'waves'), { recursive: true });
            await writeFile(path.join(options.cwd, 'waves', 'alpha.vcd'), 'vcd');
            return processExecution({
                stdout: 'PASS alpha\n',
                peakRssBytes: 4_096,
            });
        }
        const outputIndex = args.indexOf('-o');
        await writeFile(
            path.join(options.cwd, args[outputIndex + 1]),
            'compiled',
        );
        return processExecution({
            peakRssBytes: options.measureRss ? 16_384 : null,
        });
    };
    const backend = createNativeBenchmarkBackend({
        toolchain: {
            commands: { iverilog: 'iverilog-test', vvp: 'vvp-test' },
            compilerPrefixArgs: ['--compiler-prefix'],
            runtimePrefixArgs: ['--runtime-prefix'],
        },
        processRunner,
    });
    const testCase = {
        ...benchmarkCase('alpha'),
        artifactPath: 'waves/alpha.vcd',
    };
    const prepared = await backend.prepare(testCase);
    const preparedRoot = prepared.root;
    try {
        const metadata = await backend.metadata();
        const compiled = await backend.compile(prepared, { timeoutMs: 321 });
        const execution = await backend.run(
            prepared,
            compiled.executable,
            { timeoutMs: 654 },
        );
        const endToEnd = await backend.endToEnd(testCase, { timeoutMs: 987 });

        assert.deepEqual(metadata, {
            iverilogVersion: 'Icarus Verilog version test',
            vvpVersion: 'Icarus Verilog runtime version test',
            memoryMeasurement: process.platform === 'linux'
                ? 'linux-proc-child-rss'
                : 'unavailable',
        });
        assert.equal(compiled.success, true);
        assert.deepEqual(execution, {
            success: true,
            stdout: 'PASS alpha\n',
            stderr: '',
            peakRssBytes: 4_096,
            vcdBytes: 3,
        });
        assert.equal(endToEnd.success, true);
        assert.equal(endToEnd.vcdBytes, 3);
        assert.equal(endToEnd.peakRssBytes, 16_384);

        const compileCalls = calls.filter(call => call.executable === 'iverilog-test'
            && !call.args.includes('-V'));
        const runCalls = calls.filter(call => call.executable === 'vvp-test'
            && !call.args.includes('-V'));
        assert.equal(compileCalls.length, 2);
        assert.equal(runCalls.length, 2);
        assert.deepEqual(compileCalls[0].args.slice(0, 6), [
            '--compiler-prefix',
            '-g2005',
            '-s',
            'alpha_bench',
            '-o',
            'benchmark.out',
        ]);
        assert.equal(compileCalls[0].args.at(-1), 'alpha.v');
        assert.deepEqual(runCalls[0].args, [
            '--runtime-prefix',
            'benchmark.out',
        ]);
        assert.equal(compileCalls[0].timeoutMs, 321);
        assert.equal(runCalls[0].timeoutMs, 654);
        assert.equal(compileCalls[0].measureRss, false);
        assert.equal(compileCalls[1].measureRss, true);
        assert.equal(runCalls[0].measureRss, true);
        assert.equal(compileCalls[0].args.includes('-gspecify'), false);
        assert.equal(compileCalls[1].args.includes('-gspecify'), false);
        await assert.rejects(access(runCalls[1].cwd));
    } finally {
        await backend.cleanup(prepared);
    }
    await assert.rejects(access(preparedRoot));
});

test('native adapter enables specify timing only for marked cases', async () => {
    const compileArguments = [];
    const backend = createNativeBenchmarkBackend({
        toolchain: {
            commands: { iverilog: 'iverilog-test', vvp: 'vvp-test' },
            compilerPrefixArgs: [],
            runtimePrefixArgs: [],
        },
        async processRunner(_executable, args) {
            compileArguments.push(args);
            return processExecution();
        },
    });
    const prepared = await backend.prepare({
        ...benchmarkCase('specify'),
        specify: true,
    });
    try {
        const compiled = await backend.compile(prepared, { timeoutMs: 100 });
        assert.equal(compiled.success, true);
        assert.deepEqual(compileArguments[0].slice(0, 3), [
            '-g2005',
            '-gspecify',
            '-s',
        ]);
    } finally {
        await backend.cleanup(prepared);
    }
});

test('native RSS sampling degrades to unavailable when proc status cannot be read', async () => {
    const tracker = createChildRssTracker(123, true, {
        async readStatus() {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
        schedule() {
            return { unref() {} };
        },
        cancel() {},
    });

    assert.equal(await tracker.stop(), null);
});

test('builtin adapter uses compile/run for engine timing and simulate end to end', async () => {
    const calls = [];
    const api = {
        async compile(request) {
            calls.push({ method: 'compile', request });
            return {
                success: true,
                program: new Uint8Array([1, 2, 3]),
                stdout: '',
                stderr: '',
            };
        },
        async run(request) {
            calls.push({ method: 'run', request });
            return {
                success: true,
                stdout: 'PASS alpha\n',
                stderr: '',
                artifacts: new Map([[
                    'waves/alpha.vcd',
                    new Uint8Array([1, 2, 3, 4]),
                ]]),
            };
        },
        async simulate(request) {
            calls.push({ method: 'simulate', request });
            return {
                success: true,
                stdout: 'PASS alpha\n',
                stderr: '',
                artifacts: new Map([[
                    'waves/alpha.vcd',
                    new Uint8Array([1, 2, 3, 4, 5]),
                ]]),
            };
        },
    };
    const backend = createBuiltinBenchmarkBackend({
        api,
        metadata: {
            packageVersion: '0.1.test',
            sourceRevision: '0123456789012345678901234567890123456789',
        },
        measureOperation: async operation => ({
            value: await operation(),
            peakRssBytes: 8_192,
        }),
    });
    const testCase = {
        ...benchmarkCase('alpha'),
        artifactPath: 'waves/alpha.vcd',
    };
    const prepared = await backend.prepare(testCase);
    const compiled = await backend.compile(prepared, { timeoutMs: 111 });
    const execution = await backend.run(
        prepared,
        compiled.executable,
        { timeoutMs: 222 },
    );
    const endToEnd = await backend.endToEnd(testCase, { timeoutMs: 333 });

    assert.deepEqual(await backend.metadata(), {
        packageVersion: '0.1.test',
        sourceRevision: '0123456789012345678901234567890123456789',
        memoryMeasurement: 'node-process-rss',
    });
    assert.deepEqual(execution, {
        success: true,
        stdout: 'PASS alpha\n',
        stderr: '',
        peakRssBytes: 8_192,
        vcdBytes: 4,
    });
    assert.deepEqual(endToEnd, {
        success: true,
        stdout: 'PASS alpha\n',
        stderr: '',
        peakRssBytes: 8_192,
        vcdBytes: 5,
    });
    assert.deepEqual(calls.map(call => call.method), [
        'compile',
        'run',
        'simulate',
    ]);
    assert.equal(calls[0].request.generation, '2005');
    assert.equal(calls[0].request.specify, false);
    assert.equal(calls[0].request.timeoutMs, 111);
    assert.deepEqual(calls[0].request.sources, ['alpha.v']);
    assert.deepEqual(calls[1].request.program, new Uint8Array([1, 2, 3]));
    assert.deepEqual(calls[1].request.artifacts, ['waves/alpha.vcd']);
    assert.equal(calls[1].request.timeoutMs, 222);
    assert.equal(calls[2].request.generation, '2005');
    assert.equal(calls[2].request.specify, false);
    assert.deepEqual(calls[2].request.artifacts, ['waves/alpha.vcd']);
    assert.equal(calls[2].request.timeoutMs, 333);
});

test('builtin adapter enables specify timing only for marked cases', async () => {
    const requests = [];
    const api = {
        async compile(request) {
            requests.push(request);
            return {
                success: true,
                program: new Uint8Array([1]),
                stdout: '',
                stderr: '',
            };
        },
        async simulate(request) {
            requests.push(request);
            return {
                success: true,
                stdout: 'PASS specify\n',
                stderr: '',
                artifacts: new Map(),
            };
        },
    };
    const backend = createBuiltinBenchmarkBackend({
        api,
        metadata: {
            packageVersion: '0.1.test',
            sourceRevision: '0123456789012345678901234567890123456789',
        },
        measureOperation: async operation => ({
            value: await operation(),
            peakRssBytes: 1,
        }),
    });
    const benchmark = { ...benchmarkCase('specify'), specify: true };
    const prepared = await backend.prepare(benchmark);

    await backend.compile(prepared, { timeoutMs: 100 });
    await backend.endToEnd(benchmark, { timeoutMs: 100 });

    assert.deepEqual(requests.map(request => request.specify), [true, true]);
});

test('builtin-only benchmark command skips native setup and writes JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-benchmark-command-'));
    const json = path.join(root, 'report.json');
    let nativePreparationCalls = 0;
    try {
        const outcome = await runBenchmarkCommand({
            backendIds: ['builtin'],
            samples: 1,
            warmups: 0,
            timeoutMs: 100,
            json,
        }, {
            async loadCases() {
                return [benchmarkCase('command')];
            },
            async prepareNative() {
                nativePreparationCalls += 1;
                throw new Error('native setup must not run');
            },
            createBuiltinBackend() {
                return immediateBackend();
            },
            system: sampleSystem(),
            generatedAt: '2026-08-26T00:00:00.000Z',
            async repositoryMetadata() {
                return {
                    veriflowRevision: '0123456789012345678901234567890123456789',
                    veriflowDirty: false,
                };
            },
        });
        const report = JSON.parse(await readFile(json, 'utf8'));

        assert.equal(outcome.exitCode, 0);
        assert.equal(nativePreparationCalls, 0);
        assert.equal(report.results.length, 1);
        assert.equal(report.results[0].success, true);
        assert.deepEqual(report.provenance, {
            veriflowRevision: '0123456789012345678901234567890123456789',
            veriflowDirty: false,
        });
        assert.equal(report.backends.fake, undefined);
        assert.deepEqual(report.backends.builtin, { version: 'fake-3.0' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('benchmark command writes failed results before returning nonzero', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-benchmark-failure-'));
    const json = path.join(root, 'report.json');
    try {
        const outcome = await runBenchmarkCommand({
            backendIds: ['builtin'],
            samples: 1,
            warmups: 0,
            timeoutMs: 100,
            json,
        }, {
            async loadCases() {
                return [benchmarkCase('failure')];
            },
            createBuiltinBackend() {
                return {
                    ...immediateBackend(),
                    async compile() {
                        return {
                            success: false,
                            stdout: '',
                            stderr: 'intentional compile failure',
                        };
                    },
                };
            },
            system: sampleSystem(),
            generatedAt: '2026-08-26T00:00:00.000Z',
            async repositoryMetadata() {
                return {
                    veriflowRevision: '0123456789012345678901234567890123456789',
                    veriflowDirty: true,
                };
            },
        });
        const report = JSON.parse(await readFile(json, 'utf8'));

        assert.equal(outcome.exitCode, 1);
        assert.equal(report.results[0].success, false);
        assert.deepEqual(report.results[0].error, {
            stage: 'compile',
            message: 'intentional compile failure',
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('root package exposes the simulation benchmark command', async () => {
    const packageMetadata = JSON.parse(await readFile(
        new URL('../../package.json', import.meta.url),
        'utf8',
    ));

    assert.equal(
        packageMetadata.scripts['benchmark:sim'],
        'node scripts/simulation/benchmark.mjs',
    );
});

test('project benchmark corpus covers every planned bounded Verilog-2005 case', async () => {
    const cases = await loadBenchmarkCases();

    assert.deepEqual(cases.map(benchmarkCase => benchmarkCase.id), [
        'arithmetic',
        'counter',
        'fifo',
        'generate',
        'memory',
        'multi-driver',
        'specify',
        'uart',
        'udp',
        'vcd-heavy',
        'wide-vector',
    ]);
    assert.deepEqual(
        cases.filter(benchmarkCase => benchmarkCase.artifactPath !== undefined)
            .map(benchmarkCase => benchmarkCase.id),
        ['vcd-heavy'],
    );
    assert.deepEqual(
        cases.filter(benchmarkCase => benchmarkCase.specify)
            .map(benchmarkCase => benchmarkCase.id),
        ['specify'],
    );
    for (const benchmarkCase of cases) {
        const source = benchmarkCase.files.map(file => file.data).join('\n');
        assert.match(source, new RegExp(`PASS ${benchmarkCase.id}`));
        assert.match(source, /\$finish\s*;/u);
        assert.ok(Number.isSafeInteger(benchmarkCase.expectedEvents));
        assert.ok(benchmarkCase.expectedEvents > 0);
        if (benchmarkCase.id !== 'vcd-heavy') {
            assert.doesNotMatch(source, /\$(?:dumpfile|dumpvars|fopen|fwrite)/u);
        }
    }

    const specify = cases.find(benchmarkCase => benchmarkCase.id === 'specify');
    const specifySource = specify.files.map(file => file.data).join('\n');
    assert.match(specifySource, /#1;\s*if \(destination !== previous\)/u);
    assert.match(specifySource, /#5;\s*if \(destination !== source\)/u);
});

test('clocked counter releases reset away from the active sampling edge', async () => {
    const cases = await loadBenchmarkCases();
    const counter = cases.find(benchmarkCase => benchmarkCase.id === 'counter');
    const source = counter.files.map(file => file.data).join('\n');

    assert.match(
        source,
        /repeat \(2\) @\(posedge clk\);\s*@\(negedge clk\);\s*reset = 1'b0;/u,
    );
});

test('benchmark CLI runs every case with builtin and no native tools in PATH', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-benchmark-cli-'));
    const json = path.join(root, 'report.json');
    try {
        execFileSync(process.execPath, [
            new URL('./benchmark.mjs', import.meta.url).pathname,
            '--backend', 'builtin',
            '--samples', '1',
            '--warmups', '0',
            '--timeout-ms', '30000',
            '--json', json,
        ], {
            cwd: new URL('../..', import.meta.url).pathname,
            env: { ...process.env, PATH: '' },
            encoding: 'utf8',
            timeout: 120_000,
        });
        const report = JSON.parse(await readFile(json, 'utf8'));

        assert.equal(report.results.length, 11);
        assert.equal(report.results.every(result => result.success), true);
        assert.equal(report.provenance.unavailable, true);
        assert.match(report.provenance.reason, /spawn git ENOENT/u);
        assert.equal(report.backends.builtin.packageVersion, '0.1.4');
        assert.equal(
            report.backends.builtin.sourceRevision,
            '75c777c993c2bbc6ffe7f9138f25a76e14db5325',
        );
        assert.equal(report.results.every(result => result.run.samplesMs.length === 1), true);
        assert.equal(
            report.results.find(result => result.caseId === 'vcd-heavy').run.vcdBytes > 0,
            true,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function benchmarkCase(id) {
    return {
        id,
        top: `${id}_bench`,
        files: [{ path: `${id}.v`, data: 'module benchmark; endmodule\n' }],
        sources: [`${id}.v`],
        expectedOutput: `PASS ${id}`,
        expectedEvents: 42,
    };
}

function fakeMonotonicClock() {
    let value = 0;
    return {
        now: () => value,
        advance(duration) {
            value += duration;
        },
    };
}

function immediateBackend() {
    return {
        async metadata() {
            return { version: 'fake-3.0' };
        },
        async prepare(benchmarkCase) {
            return { benchmarkCase };
        },
        async compile() {
            return {
                success: true,
                executable: {},
                stdout: '',
                stderr: '',
            };
        },
        async run(prepared) {
            return {
                success: true,
                stdout: `PASS ${prepared.benchmarkCase.id}\n`,
                stderr: '',
                peakRssBytes: 123,
                vcdBytes: 0,
            };
        },
        async endToEnd(benchmarkCase) {
            return {
                success: true,
                stdout: `PASS ${benchmarkCase.id}\n`,
                stderr: '',
                peakRssBytes: 123,
                vcdBytes: 0,
            };
        },
        async cleanup() {},
    };
}

function sampleSystem() {
    return {
        platform: 'test-platform',
        arch: 'test-arch',
        nodeVersion: 'v-test',
        cpuModel: 'test-cpu',
        cpuCount: 1,
    };
}

function processExecution(overrides = {}) {
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        peakRssBytes: null,
        ...overrides,
    };
}
