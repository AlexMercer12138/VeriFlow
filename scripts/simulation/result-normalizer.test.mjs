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
    materializePinnedCorpus,
    parseRegressionArguments,
    prepareNativeToolchain,
    runRegressionSuite,
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
});

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
