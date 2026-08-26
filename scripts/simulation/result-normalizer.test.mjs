import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
    compareNormalizedResults,
    normalizeRegressionResult,
} from './result-normalizer.mjs';
import {
    createBuiltinRegressionBackend,
    createNativeRegressionBackend,
    finalizeRegressionReport,
    materializePinnedCorpus,
    parseRegressionArguments,
    prepareNativeToolchain,
    regressionResultDigest,
    runRegressionSuite,
    validateRegressionBaseline,
} from './run-iverilog-regression.mjs';

test('normalizes only line endings, configured roots, and declared timing text', () => {
    const result = normalizeRegressionResult({
        exitClass: 'success',
        stdout: 'first C:\\checkout\\ivtest\\top.v\r\nran in 42.1 ms\rsecond\n',
        stderr: '/repo/ivtest/top.v:3: warning: exact diagnostic\r\n',
        diagnostics: ['C:\\checkout\\ivtest\\top.v:3: warning: exact diagnostic\r\n'],
        unexpectedFiles: ['/repo/ivtest/generated.out'],
    }, {
        rootPrefixes: [
            { path: 'C:\\checkout\\ivtest', replacement: '<CORPUS>' },
            { path: '/repo/ivtest', replacement: '<CORPUS>' },
        ],
        timingPatterns: [{
            pattern: /ran in \d+(?:\.\d+)? ms/g,
            replacement: 'ran in <TIME> ms',
        }],
    });

    assert.deepEqual(result, {
        exitClass: 'success',
        stdout: 'first <CORPUS>\\top.v\nran in <TIME> ms\nsecond\n',
        stderr: '<CORPUS>/top.v:3: warning: exact diagnostic\n',
        diagnostics: ['<CORPUS>\\top.v:3: warning: exact diagnostic\n'],
        unexpectedFiles: ['<CORPUS>/generated.out'],
    });
});

test('normalizes configured roots inside structured diagnostics without changing fields', () => {
    const result = normalizeRegressionResult({
        diagnostics: [{
            level: 'ERROR',
            message: 'exact diagnostic',
            fileRef: '/repo/ivtest/top.v',
            lineNo: 7,
        }],
    }, {
        rootPrefixes: [{ path: '/repo/ivtest', replacement: '<CORPUS>' }],
    });

    assert.deepEqual(result.diagnostics, [{
        level: 'ERROR',
        message: 'exact diagnostic',
        fileRef: '<CORPUS>/top.v',
        lineNo: 7,
    }]);
});

test('normalizes failure causes and compares termination details', () => {
    const left = normalizeRegressionResult({
        status: 'fail',
        exitClass: 'infrastructure-error',
        stdout: '',
        stderr: '',
        diagnostics: [],
        unexpectedFiles: [],
        termination: 'signal',
        signalCode: 'SIGSEGV',
        cause: { code: 'CRASH', message: '/repo/ivtest/compiler crashed' },
    }, {
        rootPrefixes: [{ path: '/repo/ivtest', replacement: '<CORPUS>' }],
    });
    const right = {
        ...left,
        signalCode: 'SIGKILL',
        cause: { code: 'CRASH', message: '<CORPUS>/different crash' },
    };

    assert.equal(left.cause.message, '<CORPUS>/compiler crashed');
    assert.deepEqual(compareNormalizedResults(left, right), {
        match: false,
        fields: ['signalCode', 'cause'],
    });
});

test('preserves stdout order, diagnostics, exit class, files, and undeclared timing', () => {
    const input = {
        exitClass: 'compile-error',
        stdout: 'second\nfirst\ncompleted at 99 ns\n',
        stderr: 'top.v:7: syntax error\n',
        diagnostics: [
            'top.v:7: syntax error',
            'top.v:8: malformed statement',
        ],
        unexpectedFiles: ['trace.log', 'work/output.bin'],
    };

    assert.deepEqual(normalizeRegressionResult(input), input);
});

test('keeps a native and WASM output difference visible as a mismatch', () => {
    const comparison = compareNormalizedResults(
        normalizeRegressionResult({
            exitClass: 'success',
            stdout: 'native\n',
            stderr: '',
            diagnostics: [],
            unexpectedFiles: [],
        }),
        normalizeRegressionResult({
            exitClass: 'success',
            stdout: 'builtin\n',
            stderr: '',
            diagnostics: [],
            unexpectedFiles: [],
        }),
    );

    assert.equal(comparison.match, false);
    assert.deepEqual(comparison.fields, ['stdout']);
});

test('keeps a backend expectation-status difference visible as a mismatch', () => {
    const sharedResult = {
        exitClass: 'runtime-error',
        stdout: 'program: Program not runnable\n',
        stderr: 'exact diagnostic\n',
        diagnostics: ['exact diagnostic'],
        unexpectedFiles: [],
    };
    const comparison = compareNormalizedResults(
        { ...sharedResult, status: 'pass' },
        { ...sharedResult, status: 'fail' },
    );

    assert.equal(comparison.match, false);
    assert.deepEqual(comparison.fields, ['status']);
});

test('runner selects a deterministic shard and records explicit backend skips', async () => {
    const seen = [];
    const manifest = manifestWithCases(['alpha', 'beta', 'gamma', 'delta']);
    const report = await runRegressionSuite({
        manifest,
        backendIds: ['native-iverilog', 'builtin'],
        shard: { index: 1, total: 2 },
        backends: {
            'native-iverilog': availableBackend(async testCase => {
                seen.push(testCase.name);
                return successfulExecution('PASSED\n');
            }),
            builtin: unavailableBackend('WASM worker is unavailable'),
        },
    });

    assert.deepEqual(seen, ['beta', 'delta']);
    assert.equal(report.selectedCases, 2);
    assert.deepEqual(report.summary, {
        'native-iverilog': { pass: 2, fail: 0, skip: 0 },
        builtin: { pass: 0, fail: 0, skip: 2 },
    });
    assert.deepEqual(
        report.results.filter(result => result.backendId === 'builtin')
            .map(result => ({ caseName: result.caseName, status: result.status, reason: result.reason })),
        [
            { caseName: 'beta', status: 'skip', reason: 'WASM worker is unavailable' },
            { caseName: 'delta', status: 'skip', reason: 'WASM worker is unavailable' },
        ],
    );
});

test('runner evaluates normal, CE, RE, and CO expectations', async () => {
    const cases = [
        regressionCase('normal_case', 'normal'),
        regressionCase('compile_error', 'CE'),
        regressionCase('runtime_error', 'RE'),
        regressionCase('compile_only', 'CO'),
    ];
    const report = await runRegressionSuite({
        manifest: { cases },
        backendIds: ['fake'],
        backends: {
            fake: availableBackend(async testCase => {
                if (testCase.type === 'CE') return failedExecution('compile', 2);
                if (testCase.type === 'RE') return failedExecution('run', 3);
                return successfulExecution('PASSED\n');
            }),
        },
    });

    assert.deepEqual(report.results.map(result => result.status), [
        'pass',
        'pass',
        'pass',
        'pass',
    ]);
    assert.deepEqual(report.results.map(result => result.exitClass), [
        'success',
        'compile-error',
        'runtime-error',
        'success',
    ]);
});

test('runner records backend output mismatches without changing pass status', async () => {
    const report = await runRegressionSuite({
        manifest: manifestWithCases(['different']),
        backendIds: ['native-iverilog', 'builtin'],
        backends: {
            'native-iverilog': availableBackend(async () => (
                successfulExecution('PASSED\nnative\n')
            )),
            builtin: availableBackend(async () => (
                successfulExecution('PASSED\nbuiltin\n')
            )),
        },
    });

    assert.deepEqual(report.results.map(result => result.status), ['pass', 'pass']);
    assert.deepEqual(report.mismatches, [{
        caseName: 'different',
        leftBackend: 'native-iverilog',
        rightBackend: 'builtin',
        fields: ['stdout'],
    }]);
});

test('runner preserves diagnostics and unexpected files on expectation failure', async () => {
    const report = await runRegressionSuite({
        manifest: manifestWithCases(['missing_pass']),
        backendIds: ['fake'],
        backends: {
            fake: availableBackend(async () => ({
                ...successfulExecution('completed at 99 ns\n'),
                stderr: 'top.v:7: warning: exact text\n',
                diagnostics: ['top.v:7: warning: exact text'],
                unexpectedFiles: ['trace.log'],
            })),
        },
    });

    assert.equal(report.results[0].status, 'fail');
    assert.match(report.results[0].reason, /PASSED/);
    assert.equal(report.results[0].stdout, 'completed at 99 ns\n');
    assert.equal(report.results[0].stderr, 'top.v:7: warning: exact text\n');
    assert.deepEqual(report.results[0].diagnostics, ['top.v:7: warning: exact text']);
    assert.deepEqual(report.results[0].unexpectedFiles, ['trace.log']);
});

test('runner requires PASSED on its own output line', async () => {
    const report = await runRegressionSuite({
        manifest: manifestWithCases(['false_positive']),
        backendIds: ['fake'],
        backends: {
            fake: availableBackend(async () => successfulExecution('NOT PASSED here\n')),
        },
    });

    assert.equal(report.results[0].status, 'fail');
});

test('runner fails a declared output comparison mismatch and preserves it', async () => {
    const testCase = {
        ...regressionCase('gold_mismatch', 'normal'),
        comparison: { kind: 'gold', path: 'gold/gold_mismatch.gold' },
    };
    const report = await runRegressionSuite({
        manifest: { cases: [testCase] },
        backendIds: ['fake'],
        backends: {
            fake: availableBackend(async () => ({
                ...successfulExecution('actual\n'),
                comparison: {
                    kind: 'gold',
                    path: 'gold/gold_mismatch.gold',
                    match: false,
                    reason: 'output differs from gold/gold_mismatch.gold',
                },
            })),
        },
    });

    assert.equal(report.results[0].status, 'fail');
    assert.equal(report.results[0].reason, 'output differs from gold/gold_mismatch.gold');
    assert.equal(report.results[0].comparison.match, false);
});

test('builtin backend stages recursive includes and literal readmem inputs', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-corpus-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const requests = [];
    try {
        await mkdir(sourceRoot);
        await Promise.all([
            writeFile(path.join(sourceRoot, 'sample.v'), [
                '`include "defs.vh"',
                'module sample;',
                '  reg [7:0] memory [0:0];',
                '  initial begin $readmemh("ivltests/input.hex", memory); $display("PASSED"); end',
                'endmodule',
                '',
            ].join('\n')),
            writeFile(path.join(sourceRoot, 'defs.vh'), '`define WIDTH 8\n'),
            writeFile(path.join(sourceRoot, 'input.hex'), '2a\n'),
        ]);
        const backend = createBuiltinRegressionBackend({
            corpusRoot,
            backendFactory: () => ({
                async compileAndRun(request) {
                    requests.push(request);
                    return successfulExecution('PASSED\n');
                },
            }),
        });

        assert.deepEqual(await backend.probe(), { available: true });
        assert.equal(requests.length, 1);
        await backend.runCase(regressionCase('sample', 'normal'));
        assert.equal(requests.length, 2);
        const caseRequest = requests[1];
        assert.equal(caseRequest.files[0], path.join(sourceRoot, 'sample.v'));
        assert.deepEqual(caseRequest.runtimeFiles.sort(), [
            path.join(sourceRoot, 'defs.vh'),
            path.join(sourceRoot, 'input.hex'),
        ].sort());
        assert.equal(caseRequest.cwd, corpusRoot);
        assert.deepEqual(caseRequest.includeDirs, [corpusRoot]);
        assert.equal(caseRequest.defines.__ICARUS_UNSIZED__, true);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('builtin backend stages existing literal fopen inputs from recursive includes', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-fopen-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const requests = [];
    try {
        await mkdir(sourceRoot);
        await Promise.all([
            writeFile(path.join(sourceRoot, 'sample.v'), [
                '`include "reader.vh"',
                'module sample; initial begin open_inputs; $display("PASSED"); end endmodule',
                '',
            ].join('\n')),
            writeFile(path.join(sourceRoot, 'reader.vh'), [
                'task open_inputs;',
                '  integer input_fd, missing_fd, output_fd;',
                '  begin',
                '    input_fd = $fopen("ivltests/input.txt", "r");',
                '    missing_fd = $fopen("ThisFileDoesNotExist.txt", "r");',
                '    output_fd = $fopen("work/output.txt", "w");',
                '  end',
                'endtask',
                '',
            ].join('\n')),
            writeFile(path.join(sourceRoot, 'input.txt'), 'fixture input\n'),
        ]);
        const backend = createBuiltinRegressionBackend({
            corpusRoot,
            backendFactory: () => ({
                async compileAndRun(request) {
                    requests.push(request);
                    return successfulExecution('PASSED\n');
                },
            }),
        });

        await backend.probe();
        await backend.runCase(regressionCase('sample', 'normal'));

        assert.deepEqual(requests[1].runtimeFiles.sort(), [
            path.join(sourceRoot, 'input.txt'),
            path.join(sourceRoot, 'reader.vh'),
        ].sort());
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('builtin gold comparison maps only the configured corpus root prefix', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-gold-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const goldRoot = path.join(corpusRoot, 'gold');
    try {
        await Promise.all([mkdir(sourceRoot), mkdir(goldRoot)]);
        await writeFile(path.join(sourceRoot, 'sample.v'), 'module sample; endmodule\n');
        await writeFile(
            path.join(goldRoot, 'sample.gold'),
            './ivltests/sample.v:1: exact diagnostic\n',
        );
        const backend = createBuiltinRegressionBackend({
            corpusRoot,
            backendFactory: () => ({
                async compileAndRun() {
                    return successfulExecution(
                        `${path.join(corpusRoot, 'ivltests', 'sample.v')}:1: exact diagnostic\n`,
                    );
                },
            }),
        });
        const execution = await backend.runCase({
            ...regressionCase('sample', 'normal'),
            comparison: { kind: 'gold', path: 'gold/sample.gold' },
        });

        assert.equal(execution.comparison.match, true);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('exact gold comparison preserves the final newline difference', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-gold-eof-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const goldRoot = path.join(corpusRoot, 'gold');
    try {
        await Promise.all([mkdir(sourceRoot), mkdir(goldRoot)]);
        await writeFile(path.join(sourceRoot, 'sample.v'), 'module sample; endmodule\n');
        await writeFile(path.join(goldRoot, 'sample.gold'), 'exact\n');
        const backend = createBuiltinRegressionBackend({
            corpusRoot,
            backendFactory: () => ({
                async compileAndRun() {
                    return successfulExecution('exact');
                },
            }),
        });
        const execution = await backend.runCase({
            ...regressionCase('sample', 'normal'),
            comparison: { kind: 'gold', path: 'gold/sample.gold' },
        });

        assert.equal(execution.comparison.match, false);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('builtin backend preserves exact stderr lines as diagnostics', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-diag-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    try {
        await mkdir(sourceRoot);
        await writeFile(path.join(sourceRoot, 'bad.v'), 'module bad; endmodule\n');
        const backend = createBuiltinRegressionBackend({
            corpusRoot,
            backendFactory: () => ({
                async compileAndRun(request) {
                    if (path.basename(request.files[0]) === 'top.v') {
                        return successfulExecution('PASSED\n');
                    }
                    return {
                        ...failedExecution('compile', 1),
                        stderr: 'bad.v:1: exact error\nsecond diagnostic\n',
                        logEntries: [{ level: 'ERROR', message: 'parsed and changed' }],
                    };
                },
            }),
        });
        await backend.probe();
        const execution = await backend.runCase(regressionCase('bad', 'CE'));

        assert.deepEqual(execution.diagnostics, [
            'bad.v:1: exact error',
            'second diagnostic',
        ]);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('builtin backend explicitly skips unsupported compiler options', async () => {
    const backend = createBuiltinRegressionBackend({
        corpusRoot: '/unused',
        backendFactory: () => ({
            async compileAndRun() {
                throw new Error('unsupported case must not run');
            },
        }),
    });
    const testCase = {
        ...regressionCase('specify', 'normal'),
        compilerOptions: ['-gspecify'],
    };

    assert.deepEqual(await backend.runCase(testCase), {
        skipReason: 'builtin cannot represent compiler option: -gspecify',
    });
});

test('builtin backend retrieves declared diff artifacts and cleans its destination', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-diff-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const goldRoot = path.join(corpusRoot, 'gold');
    let artifactRequest;
    try {
        await Promise.all([mkdir(sourceRoot), mkdir(goldRoot)]);
        await writeFile(path.join(sourceRoot, 'sample.v'), 'module sample; endmodule\n');
        await writeFile(path.join(goldRoot, 'sample.gold'), 'generated output\n');
        const backend = createBuiltinRegressionBackend({
            corpusRoot,
            backendFactory: () => ({
                async compileAndRun(request) {
                    [artifactRequest] = request.artifacts;
                    await writeFile(artifactRequest.destination, 'generated output\n');
                    return {
                        ...successfulExecution('PASSED\n'),
                        artifacts: [{ ...artifactRequest, written: true, size: 17 }],
                    };
                },
            }),
        });

        const execution = await backend.runCase({
            ...regressionCase('sample', 'normal'),
            comparison: {
                kind: 'diff',
                actual: 'work/sample.out',
                path: 'gold/sample.gold',
                offset: 0,
            },
        });

        assert.deepEqual({
            kind: artifactRequest.kind,
            path: artifactRequest.path,
            required: artifactRequest.required,
        }, {
            kind: 'file',
            path: 'work/sample.out',
            required: true,
        });
        assert.equal(execution.comparison.match, true);
        await assert.rejects(readFile(artifactRequest.destination), { code: 'ENOENT' });
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('builtin backend preserves a missing required diff artifact as infrastructure failure', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-diff-missing-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const goldRoot = path.join(corpusRoot, 'gold');
    try {
        await Promise.all([mkdir(sourceRoot), mkdir(goldRoot)]);
        await writeFile(path.join(sourceRoot, 'sample.v'), 'module sample; endmodule\n');
        await writeFile(path.join(goldRoot, 'sample.gold'), 'expected\n');
        const backend = createBuiltinRegressionBackend({
            corpusRoot,
            backendFactory: () => ({
                async compileAndRun(request) {
                    return {
                        ...failedExecution('infrastructure', -1),
                        artifacts: request.artifacts.map(artifact => ({
                            ...artifact,
                            written: false,
                            size: 0,
                        })),
                        cause: {
                            code: 'ARTIFACT_MISSING',
                            message: 'Required artifacts were not produced: work/sample.out',
                        },
                    };
                },
            }),
        });

        const execution = await backend.runCase({
            ...regressionCase('sample', 'normal'),
            comparison: {
                kind: 'diff',
                actual: 'work/sample.out',
                path: 'gold/sample.gold',
                offset: 0,
            },
        });

        assert.equal(execution.stage, 'infrastructure');
        assert.equal(execution.comparison, undefined);
        assert.equal(execution.cause.code, 'ARTIFACT_MISSING');
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('native backend excludes only the declared diff artifact from unexpected files', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-diff-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const goldRoot = path.join(corpusRoot, 'gold');
    try {
        await Promise.all([mkdir(sourceRoot), mkdir(goldRoot)]);
        await writeFile(path.join(sourceRoot, 'sample.v'), 'module sample; endmodule\n');
        await writeFile(path.join(goldRoot, 'sample.gold'), 'generated output\n');
        const backend = createNativeRegressionBackend({
            corpusRoot,
            commands: { iverilog: 'iverilog', vvp: 'vvp' },
            processRunner: async (executable, args, options) => {
                if (args.includes('-V')) return processResult('version\n');
                if (executable === 'iverilog') {
                    await writeFile(path.join(options.cwd, 'vsim'), 'compiled');
                } else if (args.some(argument => String(argument).endsWith('smoke.out'))) {
                    return processResult('PASSED\n');
                } else {
                    await Promise.all([
                        writeFile(path.join(options.cwd, 'work', 'sample.out'), 'generated output\n'),
                        writeFile(path.join(options.cwd, 'trace.log'), 'undeclared'),
                    ]);
                }
                return processResult(executable === 'vvp' ? 'PASSED\n' : '');
            },
        });

        await backend.probe();
        const execution = await backend.runCase({
            ...regressionCase('sample', 'normal'),
            comparison: {
                kind: 'diff',
                actual: 'work/sample.out',
                path: 'gold/sample.gold',
                offset: 0,
            },
        });

        assert.equal(execution.comparison.match, true);
        assert.deepEqual(execution.unexpectedFiles, ['trace.log']);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('materializes the pinned corpus commit instead of checkout HEAD', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'veriflow-corpus-git-'));
    try {
        execFileSync('git', ['init', '-q'], { cwd: repository });
        execFileSync('git', ['config', 'user.name', 'Regression Test'], { cwd: repository });
        execFileSync('git', ['config', 'user.email', 'regression@example.invalid'], { cwd: repository });
        await mkdir(path.join(repository, 'ivtest'));
        await writeFile(
            path.join(repository, 'ivtest', 'regress-vlg.list'),
            'pinned normal ivltests\n',
        );
        execFileSync('git', ['add', 'ivtest'], { cwd: repository });
        execFileSync('git', ['commit', '-qm', 'pinned'], { cwd: repository });
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository,
            encoding: 'utf8',
        }).trim();
        await writeFile(
            path.join(repository, 'ivtest', 'regress-vlg.list'),
            'checkout normal ivltests\n',
        );
        execFileSync('git', ['commit', '-qam', 'checkout'], { cwd: repository });

        const corpus = await materializePinnedCorpus({
            iverilogRoot: repository,
            revision,
        });
        try {
            assert.equal(
                await readFile(path.join(corpus.root, 'regress-vlg.list'), 'utf8'),
                'pinned normal ivltests\n',
            );
        } finally {
            await corpus.cleanup();
        }
    } finally {
        await rm(repository, { recursive: true, force: true });
    }
});

test('native backend probes compile/run and preserves case arguments and files', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-corpus-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    const calls = [];
    try {
        await mkdir(sourceRoot);
        await writeFile(
            path.join(sourceRoot, 'sample.v'),
            'module sample; initial $display("PASSED"); endmodule\n',
        );
        const backend = createNativeRegressionBackend({
            corpusRoot,
            commands: { iverilog: '/fake/iverilog', vvp: '/fake/vvp' },
            compilerPrefixArgs: ['-B', '/fake/runtime'],
            runtimePrefixArgs: ['-M', '/fake/runtime'],
            processRunner: async (executable, args, options) => {
                calls.push({ executable, args, cwd: options.cwd });
                if (args.includes('-V')) return processResult('version\n');
                if (executable.endsWith('iverilog')) {
                    await writeFile(path.join(options.cwd, 'vsim'), 'compiled');
                    return processResult('');
                }
                await writeFile(path.join(options.cwd, 'trace.log'), 'trace');
                return processResult('PASSED\n');
            },
        });

        assert.deepEqual(await backend.probe(), { available: true });
        const testCase = {
            ...regressionCase('sample', 'normal'),
            compilerOptions: ['-Ttyp'],
            plusargs: ['+seed=7'],
            topModule: 'sample',
        };
        const execution = await backend.runCase(testCase);

        const caseCalls = calls.slice(3);
        assert.equal(caseCalls.length, 2);
        assert.equal(caseCalls[0].executable, '/fake/iverilog');
        assert.deepEqual(caseCalls[0].args.slice(0, 7), [
            '-B',
            '/fake/runtime',
            '-g2005',
            '-D__ICARUS_UNSIZED__',
            '-Ttyp',
            '-s',
            'sample',
        ]);
        assert.deepEqual(
            caseCalls[0].args.slice(-3),
            ['-o', 'vsim', './ivltests/sample.v'],
        );
        assert.equal(caseCalls[1].executable, '/fake/vvp');
        assert.deepEqual(caseCalls[1].args.slice(0, 2), ['-M', '/fake/runtime']);
        assert.deepEqual(caseCalls[1].args.slice(-1), ['+seed=7']);
        assert.equal(execution.success, true);
        assert.equal(execution.stage, 'run');
        assert.equal(execution.stdout, 'PASSED\n');
        assert.deepEqual(execution.unexpectedFiles, ['trace.log']);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('prepares a flat native toolchain from a built Icarus tree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-tree-'));
    try {
        await Promise.all([
            mkdir(path.join(root, 'driver')),
            mkdir(path.join(root, 'vvp')),
            mkdir(path.join(root, 'ivlpp')),
            mkdir(path.join(root, 'tgt-vvp')),
            mkdir(path.join(root, 'vpi')),
        ]);
        const executables = [
            path.join(root, 'driver', 'iverilog'),
            path.join(root, 'vvp', 'vvp'),
            path.join(root, 'ivlpp', 'ivlpp'),
            path.join(root, 'ivl'),
        ];
        await Promise.all(executables.map(async filepath => {
            await writeFile(filepath, 'fake');
            await chmod(filepath, 0o755);
        }));
        await Promise.all([
            writeFile(path.join(root, 'tgt-vvp', 'vvp.conf'), 'fake'),
            writeFile(path.join(root, 'tgt-vvp', 'vvp.tgt'), 'fake'),
            writeFile(path.join(root, 'vpi', 'system.vpi'), 'fake'),
            writeFile(path.join(root, 'vpi', 'v2005_math.vpi'), 'fake'),
        ]);

        const toolchain = await prepareNativeToolchain({
            iverilogRoot: root,
            environment: { PATH: '' },
        });
        try {
            assert.deepEqual(toolchain.commands, {
                iverilog: path.join(root, 'driver', 'iverilog'),
                vvp: path.join(root, 'vvp', 'vvp'),
            });
            assert.equal(toolchain.compilerPrefixArgs[0], '-B');
            assert.equal(toolchain.runtimePrefixArgs[0], '-M');
            assert.equal(
                toolchain.compilerPrefixArgs[1],
                toolchain.runtimePrefixArgs[1],
            );
            await readFile(path.join(toolchain.compilerPrefixArgs[1], 'vvp.conf'));
        } finally {
            await toolchain.cleanup();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('native backend compile-only cases never invoke vvp', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-co-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    let runCalls = 0;
    try {
        await mkdir(sourceRoot);
        await writeFile(path.join(sourceRoot, 'only.v'), 'module only; endmodule\n');
        const backend = createNativeRegressionBackend({
            corpusRoot,
            commands: { iverilog: 'iverilog', vvp: 'vvp' },
            processRunner: async (executable, args, options) => {
                if (args.includes('-V')) return processResult('version\n');
                if (executable === 'vvp') runCalls += 1;
                if (executable === 'iverilog') {
                    await writeFile(path.join(options.cwd, 'vsim'), 'compiled');
                }
                return processResult('');
            },
        });

        await backend.probe();
        const execution = await backend.runCase(regressionCase('only', 'CO'));

        assert.equal(execution.success, true);
        assert.equal(execution.stage, 'compile');
        assert.equal(runCalls, 1);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('native backend classifies compile signals, spawn failures, and run timeouts as infrastructure', async () => {
    const corpusRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-crash-'));
    const sourceRoot = path.join(corpusRoot, 'ivltests');
    let currentCase;
    try {
        await mkdir(sourceRoot);
        await Promise.all([
            writeFile(path.join(sourceRoot, 'compile_signal.v'), 'module compile_signal; endmodule\n'),
            writeFile(path.join(sourceRoot, 'compile_spawn.v'), 'module compile_spawn; endmodule\n'),
            writeFile(path.join(sourceRoot, 'runtime_timeout.v'), 'module runtime_timeout; endmodule\n'),
        ]);
        const backend = createNativeRegressionBackend({
            corpusRoot,
            commands: { iverilog: 'iverilog', vvp: 'vvp' },
            processRunner: async (executable, args) => {
                if (args.includes('-V')) return processResult('version\n');
                if (executable === 'iverilog') {
                    const source = String(args.at(-1));
                    if (source.endsWith('top.v')) return processResult('');
                    currentCase = path.basename(source, '.v');
                    if (currentCase === 'compile_signal') {
                        return processResult('', {
                            exitCode: -1,
                            signalCode: 'SIGSEGV',
                        });
                    }
                    if (currentCase === 'compile_spawn') {
                        return processResult('', {
                            exitCode: -1,
                            cause: { code: 'ENOENT', message: 'spawn iverilog ENOENT' },
                        });
                    }
                    return processResult('');
                }
                if (currentCase === undefined) return processResult('PASSED\n');
                return processResult('', {
                    exitCode: -1,
                    termination: 'timeout',
                    signalCode: 'SIGKILL',
                });
            },
        });
        const report = await runRegressionSuite({
            manifest: { cases: [
                regressionCase('compile_signal', 'CE'),
                regressionCase('compile_spawn', 'CE'),
                regressionCase('runtime_timeout', 'RE'),
            ] },
            backendIds: ['native-iverilog'],
            backends: { 'native-iverilog': backend },
        });

        assert.deepEqual(report.results.map(result => ({
            caseName: result.caseName,
            status: result.status,
            exitClass: result.exitClass,
            termination: result.termination,
            signalCode: result.signalCode,
            cause: result.cause,
        })), [
            {
                caseName: 'compile_signal',
                status: 'fail',
                exitClass: 'infrastructure-error',
                termination: 'signal',
                signalCode: 'SIGSEGV',
                cause: undefined,
            },
            {
                caseName: 'compile_spawn',
                status: 'fail',
                exitClass: 'infrastructure-error',
                termination: 'infrastructure',
                signalCode: undefined,
                cause: { code: 'ENOENT', message: 'spawn iverilog ENOENT' },
            },
            {
                caseName: 'runtime_timeout',
                status: 'fail',
                exitClass: 'infrastructure-error',
                termination: 'timeout',
                signalCode: 'SIGKILL',
                cause: undefined,
            },
        ]);
    } finally {
        await rm(corpusRoot, { recursive: true, force: true });
    }
});

test('regression CLI parses strict backend, shard, root, and JSON options', () => {
    assert.deepEqual(parseRegressionArguments([
        '--iverilog-root', '/src/iverilog',
        '--backend', 'native-iverilog,builtin',
        '--shard', '3/20',
        '--json', '/tmp/results.json',
    ]), {
        iverilogRoot: '/src/iverilog',
        backendIds: ['native-iverilog', 'builtin'],
        shard: { index: 3, total: 20 },
        json: '/tmp/results.json',
        timeoutMs: 30_000,
    });
    assert.throws(
        () => parseRegressionArguments(['--iverilog-root', '/src', '--wat']),
        /Unknown option: --wat/,
    );
    assert.throws(
        () => parseRegressionArguments([
            '--iverilog-root', '/src',
            '--backend', 'builtin',
            '--shard', '20/20',
            '--json', '/tmp/results.json',
        ]),
        /Invalid shard 20\/20/,
    );
    assert.equal(parseRegressionArguments([
        '--iverilog-root', '/src/iverilog',
        '--backend', 'builtin',
        '--json', '/tmp/results.json',
        '--baseline', '/src/baseline.json',
    ]).baseline, '/src/baseline.json');
});

test('validates regression baseline revision, shape, and duplicate identities', () => {
    const baseline = sampleBaseline();
    assert.deepEqual(
        validateRegressionBaseline(baseline, SAMPLE_REVISION),
        baseline,
    );
    assert.throws(
        () => validateRegressionBaseline({ ...baseline, corpusRevision: '0'.repeat(40) }, SAMPLE_REVISION),
        /revision/i,
    );
    assert.throws(
        () => validateRegressionBaseline({ ...baseline, unexpected: true }, SAMPLE_REVISION),
        /unexpected key/i,
    );
    assert.throws(
        () => validateRegressionBaseline({
            ...baseline,
            failures: [...baseline.failures, baseline.failures[0]],
        }, SAMPLE_REVISION),
        /duplicate failure approval/i,
    );
    assert.throws(
        () => validateRegressionBaseline({
            ...baseline,
            mismatches: [...baseline.mismatches, baseline.mismatches[0]],
        }, SAMPLE_REVISION),
        /duplicate mismatch approval/i,
    );
});

test('result digest is canonical, ignores derived timing, and covers semantic fields', () => {
    const left = {
        caseName: 'digest-case',
        caseType: 'RE',
        backendId: 'builtin',
        status: 'fail',
        exitClass: 'runtime-error',
        stdout: 'same\r\n',
        stderr: '',
        diagnostics: [{ message: 'error', level: 'ERROR' }],
        unexpectedFiles: [],
        cause: { message: 'cause', code: 'RUNTIME' },
        timings: { run: 1 },
        approved: false,
    };
    const reordered = {
        approved: true,
        timings: { run: 999 },
        cause: { code: 'RUNTIME', message: 'cause' },
        unexpectedFiles: [],
        diagnostics: [{ level: 'ERROR', message: 'error' }],
        stderr: '',
        stdout: 'same\n',
        exitClass: 'runtime-error',
        status: 'fail',
        backendId: 'builtin',
        caseType: 'RE',
        caseName: 'digest-case',
    };

    assert.equal(regressionResultDigest(left), regressionResultDigest(reordered));
    assert.notEqual(
        regressionResultDigest(left),
        regressionResultDigest({ ...reordered, stdout: 'changed\n' }),
    );
    assert.match(regressionResultDigest(left), /^[0-9a-f]{64}$/);
});

test('known baseline keeps raw failures visible, marks approvals, writes JSON, and exits zero', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-baseline-known-'));
    const jsonPath = path.join(root, 'report.json');
    try {
        const finalized = await finalizeRegressionReport({
            report: sampleRegressionReport(),
            baseline: sampleBaseline(),
            jsonPath,
        });
        const written = JSON.parse(await readFile(jsonPath, 'utf8'));

        assert.equal(finalized.exitCode, 0);
        assert.equal(written.results[0].status, 'fail');
        assert.equal(written.results[0].approved, true);
        assert.match(written.results[0].resultDigest, /^[0-9a-f]{64}$/);
        assert.equal(written.mismatches[0].approved, true);
        assert.match(written.mismatches[0].leftResultDigest, /^[0-9a-f]{64}$/);
        assert.match(written.mismatches[0].rightResultDigest, /^[0-9a-f]{64}$/);
        assert.deepEqual(written.baseline.staleApprovals, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('baseline approval matching is independent of JSON object key order', async () => {
    const baseline = sampleBaseline();
    baseline.failures[0] = Object.fromEntries(
        Object.entries(baseline.failures[0]).reverse(),
    );
    baseline.mismatches[0] = Object.fromEntries(
        Object.entries(baseline.mismatches[0]).reverse(),
    );
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-baseline-key-order-'));
    const jsonPath = path.join(root, 'report.json');
    try {
        const finalized = await finalizeRegressionReport({
            report: sampleRegressionReport(),
            baseline,
            jsonPath,
        });

        assert.equal(finalized.exitCode, 0);
        assert.equal(finalized.report.results[0].approved, true);
        assert.equal(finalized.report.mismatches[0].approved, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('failure approval is invalidated by any stable result-content change after JSON write', async () => {
    const mutations = [
        ['stdout', result => { result.stdout = 'changed output\n'; }],
        ['diagnostics', result => { result.diagnostics = ['changed diagnostic']; }],
        ['unexpectedFiles', result => { result.unexpectedFiles = ['new.file']; }],
        ['cause', result => { result.cause = { code: 'CRASH', message: 'changed cause' }; }],
        ['exitCode', result => { result.exitCode = 99; }],
    ];
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-baseline-result-change-'));
    try {
        for (const [name, mutate] of mutations) {
            const original = sampleRegressionReport();
            const baseline = sampleBaseline(original);
            const changed = structuredClone(original);
            mutate(changed.results.find(result => result.caseName === 'known-failure'));
            const jsonPath = path.join(root, `${name}.json`);

            const finalized = await finalizeRegressionReport({
                report: changed,
                baseline,
                jsonPath,
            });
            const written = JSON.parse(await readFile(jsonPath, 'utf8'));
            const failure = written.results.find(result => (
                result.caseName === 'known-failure'
            ));

            assert.equal(finalized.exitCode, 1, name);
            assert.equal(failure.status, 'fail', name);
            assert.equal(failure.reason, 'output differs from gold/known.gold', name);
            assert.equal(failure.approved, false, name);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('mismatch approval is invalidated when either backend result changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-baseline-side-change-'));
    try {
        for (const backendId of ['native-iverilog', 'builtin']) {
            const original = sampleRegressionReport();
            const baseline = sampleBaseline(original);
            const changed = structuredClone(original);
            changed.results.find(result => (
                result.caseName === 'known-mismatch'
                && result.backendId === backendId
            )).stdout += 'changed\n';
            const jsonPath = path.join(root, `${backendId}.json`);

            const finalized = await finalizeRegressionReport({
                report: changed,
                baseline,
                jsonPath,
            });
            const written = JSON.parse(await readFile(jsonPath, 'utf8'));

            assert.equal(finalized.exitCode, 1, backendId);
            assert.deepEqual(written.mismatches[0].fields, ['stdout']);
            assert.equal(written.mismatches[0].approved, false, backendId);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('baseline rejects missing or malformed digests and does not approve forged digests', async () => {
    const report = sampleRegressionReport();
    const baseline = sampleBaseline(report);
    const missing = structuredClone(baseline);
    delete missing.failures[0].resultDigest;
    assert.throws(
        () => validateRegressionBaseline(missing, SAMPLE_REVISION),
        /missing key: resultDigest/i,
    );
    const malformed = structuredClone(baseline);
    malformed.mismatches[0].leftResultDigest = 'ABC123';
    assert.throws(
        () => validateRegressionBaseline(malformed, SAMPLE_REVISION),
        /leftResultDigest.*64 lowercase hex/i,
    );

    const forged = structuredClone(baseline);
    forged.failures[0].resultDigest = '0'.repeat(64);
    forged.mismatches[0].leftResultDigest = '0'.repeat(64);
    forged.mismatches[0].rightResultDigest = '0'.repeat(64);
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-baseline-forged-'));
    const jsonPath = path.join(root, 'report.json');
    try {
        const finalized = await finalizeRegressionReport({
            report,
            baseline: forged,
            jsonPath,
        });
        const written = JSON.parse(await readFile(jsonPath, 'utf8'));

        assert.equal(finalized.exitCode, 1);
        assert.equal(written.results[0].approved, false);
        assert.equal(written.mismatches[0].approved, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('new failures, new mismatches, and stale approvals exit nonzero after writing JSON', async () => {
    const scenarios = [
        {
            name: 'new-failure',
            report: sampleRegressionReport({ includeExtraFailure: true }),
            baseline: sampleBaseline(),
        },
        {
            name: 'new-mismatch',
            report: sampleRegressionReport({ includeExtraMismatch: true }),
            baseline: sampleBaseline(),
        },
        {
            name: 'stale-approval',
            report: sampleRegressionReport({ includeFailure: false }),
            baseline: sampleBaseline(),
        },
    ];

    for (const scenario of scenarios) {
        const root = await mkdtemp(path.join(os.tmpdir(), `veriflow-baseline-${scenario.name}-`));
        const jsonPath = path.join(root, 'report.json');
        try {
            const finalized = await finalizeRegressionReport({
                report: scenario.report,
                baseline: scenario.baseline,
                jsonPath,
            });
            const written = JSON.parse(await readFile(jsonPath, 'utf8'));

            assert.equal(finalized.exitCode, 1, scenario.name);
            assert.equal(written.baseline.clean, false, scenario.name);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test('invalid or absent baseline leaves failures unapproved and still writes JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-baseline-invalid-'));
    try {
        for (const [name, options] of [
            ['absent', {}],
            ['invalid', { baseline: { ...sampleBaseline(), schemaVersion: 2 } }],
        ]) {
            const jsonPath = path.join(root, `${name}.json`);
            const finalized = await finalizeRegressionReport({
                report: sampleRegressionReport(),
                jsonPath,
                ...options,
            });
            const written = JSON.parse(await readFile(jsonPath, 'utf8'));

            assert.equal(finalized.exitCode, 1, name);
            assert.equal(written.results[0].approved, false, name);
            assert.equal(written.mismatches[0].approved, false, name);
            assert.equal(written.baseline.clean, false, name);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('CI passes the pinned baseline and always uploads both regression reports', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const baselineUses = workflow.match(
        /--baseline tools\/simulation\/iverilog-regression-baseline\.json/g,
    ) ?? [];
    const alwaysUploads = workflow.match(/if: always\(\)/g) ?? [];

    assert.equal(baselineUses.length, 2);
    assert.ok(alwaysUploads.length >= 2);
});

test('tracked regression baseline validates against the pinned corpus revision', async () => {
    const revision = JSON.parse(await readFile(
        new URL('../../tools/simulation/iverilog-revision.json', import.meta.url),
        'utf8',
    ));
    const baseline = JSON.parse(await readFile(
        new URL('../../tools/simulation/iverilog-regression-baseline.json', import.meta.url),
        'utf8',
    ));

    assert.deepEqual(
        validateRegressionBaseline(baseline, revision.revision),
        baseline,
    );
});

const SAMPLE_REVISION = '1234567890abcdef1234567890abcdef12345678';

function sampleBaseline(report = sampleRegressionReport()) {
    const failure = report.results.find(result => result.caseName === 'known-failure');
    const mismatch = report.mismatches.find(entry => entry.caseName === 'known-mismatch');
    const left = report.results.find(result => (
        result.caseName === mismatch.caseName
        && result.backendId === mismatch.leftBackend
    ));
    const right = report.results.find(result => (
        result.caseName === mismatch.caseName
        && result.backendId === mismatch.rightBackend
    ));
    return {
        schemaVersion: 1,
        corpusRevision: SAMPLE_REVISION,
        failures: [{
            caseName: 'known-failure',
            backendId: 'builtin',
            status: 'fail',
            exitClass: 'runtime-error',
            reason: 'output differs from gold/known.gold',
            resultDigest: regressionResultDigest(failure),
        }],
        mismatches: [{
            caseName: 'known-mismatch',
            leftBackend: 'native-iverilog',
            rightBackend: 'builtin',
            fields: ['stdout'],
            leftResultDigest: regressionResultDigest(left),
            rightResultDigest: regressionResultDigest(right),
        }],
    };
}

function sampleRegressionReport({
    includeFailure = true,
    includeExtraFailure = false,
    includeExtraMismatch = false,
} = {}) {
    const failures = includeFailure ? [{
        caseName: 'known-failure',
        caseType: 'RE',
        backendId: 'builtin',
        status: 'fail',
        reason: 'output differs from gold/known.gold',
        exitClass: 'runtime-error',
        stage: 'run',
        exitCode: 3,
        stdout: 'runtime failed\n',
        stderr: '',
        diagnostics: [],
        unexpectedFiles: [],
        comparison: {
            kind: 'gold',
            path: 'gold/known.gold',
            match: false,
            reason: 'output differs from gold/known.gold',
        },
    }] : [];
    if (includeExtraFailure) {
        failures.push({
            ...failures[0],
            caseName: 'new-failure',
            reason: 'new failure',
        });
    }
    const mismatchResults = [
        {
            caseName: 'known-mismatch',
            caseType: 'normal',
            backendId: 'native-iverilog',
            status: 'pass',
            exitClass: 'success',
            stage: 'run',
            exitCode: 0,
            stdout: 'native\n',
            stderr: '',
            diagnostics: [],
            unexpectedFiles: [],
        },
        {
            caseName: 'known-mismatch',
            caseType: 'normal',
            backendId: 'builtin',
            status: 'pass',
            exitClass: 'success',
            stage: 'run',
            exitCode: 0,
            stdout: 'builtin\n',
            stderr: '',
            diagnostics: [],
            unexpectedFiles: [],
        },
    ];
    const mismatches = [{
        caseName: 'known-mismatch',
        leftBackend: 'native-iverilog',
        rightBackend: 'builtin',
        fields: ['stdout'],
    }];
    if (includeExtraMismatch) {
        mismatchResults.push(
            {
                ...mismatchResults[0],
                caseName: 'new-mismatch',
                stderr: 'native stderr\n',
            },
            {
                ...mismatchResults[1],
                caseName: 'new-mismatch',
                stderr: 'builtin stderr\n',
            },
        );
        mismatches.push({
            caseName: 'new-mismatch',
            leftBackend: 'native-iverilog',
            rightBackend: 'builtin',
            fields: ['stderr'],
        });
    }
    return {
        schemaVersion: 1,
        corpus: { revision: SAMPLE_REVISION },
        results: [...failures, ...mismatchResults],
        mismatches,
    };
}

function processResult(stdout, overrides = {}) {
    return {
        exitCode: 0,
        stdout,
        stderr: '',
        combinedOutput: stdout,
        ...overrides,
    };
}

function manifestWithCases(names) {
    return { cases: names.map(name => regressionCase(name, 'normal')) };
}

function regressionCase(name, type) {
    return {
        name,
        type,
        sourceDirectory: 'ivltests',
        source: `ivltests/${name}.v`,
        compilerOptions: [],
        plusargs: [],
    };
}

function availableBackend(runCase) {
    return {
        async probe() {
            return { available: true };
        },
        runCase,
    };
}

function unavailableBackend(reason) {
    return {
        async probe() {
            return { available: false, reason };
        },
        async runCase() {
            throw new Error('unavailable backend must not run');
        },
    };
}

function successfulExecution(stdout) {
    return {
        success: true,
        stage: 'run',
        exitCode: 0,
        stdout,
        stderr: '',
        diagnostics: [],
        unexpectedFiles: [],
    };
}

function failedExecution(stage, exitCode) {
    return {
        success: false,
        stage,
        exitCode,
        stdout: '',
        stderr: `${stage} failed\n`,
        diagnostics: [`${stage} failed`],
        unexpectedFiles: [],
    };
}
