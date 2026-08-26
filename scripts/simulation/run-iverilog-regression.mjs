#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
    compareNormalizedResults,
    normalizeRegressionResult,
    normalizeText,
} from './result-normalizer.mjs';
import { parseRegressionList } from './read-iverilog-regress.mjs';

const executeFile = promisify(execFile);

export function createNativeRegressionBackend({
    corpusRoot,
    commands = { iverilog: 'iverilog', vvp: 'vvp' },
    compilerPrefixArgs = [],
    runtimePrefixArgs = [],
    processRunner = runProcess,
    timeoutMs = 30_000,
}) {
    let capability;
    return {
        async probe() {
            if (capability !== undefined) return capability;
            const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-probe-'));
            try {
                const source = path.join(root, 'top.v');
                const output = path.join(root, 'smoke.out');
                await writeFile(source, [
                    'module top;',
                    '  initial begin $display("PASSED"); $finish; end',
                    'endmodule',
                    '',
                ].join('\n'));
                const version = await processRunner(
                    commands.iverilog,
                    [...compilerPrefixArgs, '-V'],
                    { cwd: root, timeoutMs },
                );
                if (version.exitCode !== 0 || version.termination !== undefined) {
                    capability = unavailableNativeCapability('version probe', version);
                    return capability;
                }
                const compiled = await processRunner(
                    commands.iverilog,
                    [...compilerPrefixArgs, '-g2005', '-o', output, source],
                    { cwd: root, timeoutMs },
                );
                if (compiled.exitCode !== 0 || compiled.termination !== undefined) {
                    capability = unavailableNativeCapability('compile smoke', compiled);
                    return capability;
                }
                const ran = await processRunner(
                    commands.vvp,
                    [...runtimePrefixArgs, output],
                    { cwd: root, timeoutMs },
                );
                if (ran.exitCode !== 0
                    || ran.termination !== undefined
                    || !hasPassedOutput(ran.stdout, ran.stderr)) {
                    capability = unavailableNativeCapability('runtime smoke', ran);
                    return capability;
                }
                capability = { available: true };
                return capability;
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
        async runCase(testCase) {
            const root = await createNativeCaseRoot(corpusRoot);
            try {
                const source = `.${path.sep}${testCase.source
                    .split('/')
                    .join(path.sep)}`;
                const output = 'vsim';
                const compilerArgs = [
                    ...compilerPrefixArgs,
                    '-g2005',
                    '-D__ICARUS_UNSIZED__',
                    ...testCase.compilerOptions,
                    ...(testCase.topModule === undefined
                        ? []
                        : ['-s', testCase.topModule]),
                    '-o',
                    output,
                    source,
                ];
                const compiled = await processRunner(
                    commands.iverilog,
                    compilerArgs,
                    { cwd: root, timeoutMs },
                );
                if (compiled.exitCode !== 0 || compiled.termination !== undefined) {
                    const result = processExecution('compile', compiled, {
                        unexpectedFiles: await unexpectedFiles(
                            root,
                            declaredArtifactPaths(testCase),
                        ),
                    });
                    return attachOutputComparison(testCase, result, corpusRoot, root);
                }
                if (testCase.type === 'CO') {
                    return processExecution('compile', compiled, {
                        unexpectedFiles: await unexpectedFiles(
                            root,
                            declaredArtifactPaths(testCase),
                        ),
                    });
                }
                const ran = await processRunner(
                    commands.vvp,
                    [...runtimePrefixArgs, output, ...testCase.plusargs],
                    { cwd: root, timeoutMs },
                );
                const result = processExecution('run', ran, {
                    stdout: compiled.stdout + ran.stdout,
                    stderr: compiled.stderr + ran.stderr,
                    combinedOutput: compiled.combinedOutput + ran.combinedOutput,
                    unexpectedFiles: await unexpectedFiles(
                        root,
                        declaredArtifactPaths(testCase),
                    ),
                    timings: {
                        compile: compiled.elapsedTime ?? 0,
                        run: ran.elapsedTime ?? 0,
                    },
                });
                return attachOutputComparison(testCase, result, corpusRoot, root);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    };
}

export async function prepareNativeToolchain({
    iverilogRoot,
    environment = process.env,
}) {
    const installedIverilog = await findExecutable('iverilog', environment);
    const installedVvp = await findExecutable('vvp', environment);
    if (installedIverilog !== undefined && installedVvp !== undefined) {
        return {
            commands: { iverilog: installedIverilog, vvp: installedVvp },
            compilerPrefixArgs: [],
            runtimePrefixArgs: [],
            cleanup: async () => {},
        };
    }

    const buildFiles = {
        iverilog: path.join(iverilogRoot, 'driver', 'iverilog'),
        vvp: path.join(iverilogRoot, 'vvp', 'vvp'),
        ivlpp: path.join(iverilogRoot, 'ivlpp', 'ivlpp'),
        ivl: path.join(iverilogRoot, 'ivl'),
        config: path.join(iverilogRoot, 'tgt-vvp', 'vvp.conf'),
        target: path.join(iverilogRoot, 'tgt-vvp', 'vvp.tgt'),
    };
    const required = [
        [buildFiles.iverilog, fsConstants.X_OK],
        [buildFiles.vvp, fsConstants.X_OK],
        [buildFiles.ivlpp, fsConstants.X_OK],
        [buildFiles.ivl, fsConstants.X_OK],
        [buildFiles.config, fsConstants.R_OK],
        [buildFiles.target, fsConstants.R_OK],
    ];
    const complete = (await Promise.all(required.map(async ([filepath, mode]) => {
        try {
            await access(filepath, mode);
            return true;
        } catch {
            return false;
        }
    }))).every(Boolean);
    if (!complete) {
        return {
            commands: { iverilog: 'iverilog', vvp: 'vvp' },
            compilerPrefixArgs: [],
            runtimePrefixArgs: [],
            cleanup: async () => {},
        };
    }

    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-runtime-'));
    try {
        await Promise.all([
            symlink(buildFiles.ivlpp, path.join(runtimeRoot, 'ivlpp'), 'file'),
            symlink(buildFiles.ivl, path.join(runtimeRoot, 'ivl'), 'file'),
            symlink(buildFiles.config, path.join(runtimeRoot, 'vvp.conf'), 'file'),
            symlink(buildFiles.target, path.join(runtimeRoot, 'vvp.tgt'), 'file'),
        ]);
        const vpiRoot = path.join(iverilogRoot, 'vpi');
        for (const entry of await readdir(vpiRoot, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.vpi')) continue;
            await symlink(
                path.join(vpiRoot, entry.name),
                path.join(runtimeRoot, entry.name),
                'file',
            );
        }
        return {
            commands: {
                iverilog: buildFiles.iverilog,
                vvp: buildFiles.vvp,
            },
            compilerPrefixArgs: ['-B', runtimeRoot],
            runtimePrefixArgs: ['-M', runtimeRoot],
            cleanup: () => rm(runtimeRoot, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(runtimeRoot, { recursive: true, force: true });
        throw error;
    }
}

async function findExecutable(name, environment) {
    for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
        if (directory === '') continue;
        const candidate = path.join(directory, name);
        try {
            await access(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
        }
    }
    return undefined;
}

function unavailableNativeCapability(stage, execution) {
    const detail = `${execution.stderr}${execution.stdout}`.trim()
        || execution.cause?.message
        || `exit ${execution.exitCode}`;
    return {
        available: false,
        reason: `native-iverilog unavailable: ${stage} failed: ${detail}`,
    };
}

async function createNativeCaseRoot(corpusRoot) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-native-case-'));
    for (const entry of await readdir(corpusRoot, { withFileTypes: true })) {
        if (entry.name === 'work' || entry.name === 'log') {
            await mkdir(path.join(root, entry.name), { recursive: true });
            continue;
        }
        await symlink(
            path.join(corpusRoot, entry.name),
            path.join(root, entry.name),
            entry.isDirectory() ? 'dir' : 'file',
        );
    }
    await Promise.all([
        mkdir(path.join(root, 'work'), { recursive: true }),
        mkdir(path.join(root, 'log'), { recursive: true }),
    ]);
    return root;
}

function declaredArtifactPaths(testCase) {
    return testCase.comparison?.kind === 'diff'
        ? [path.posix.normalize(testCase.comparison.actual).replace(/^\.\//, '')]
        : [];
}

async function unexpectedFiles(root, excludedFiles = []) {
    const excluded = new Set(excludedFiles);
    const files = [];
    const visit = async (directory, relativeRoot = '') => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const relative = path.posix.join(relativeRoot, entry.name);
            const filepath = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) await visit(filepath, relative);
            else if (relative !== 'vsim' && !excluded.has(relative)) files.push(relative);
        }
    };
    await visit(root);
    return files.sort();
}

function processExecution(stage, execution, overrides = {}) {
    const signalCode = execution.signalCode ?? execution.signal;
    const termination = execution.termination
        ?? (signalCode === undefined
            ? (execution.cause === undefined ? undefined : 'infrastructure')
            : 'signal');
    const infrastructure = termination !== undefined;
    const stderr = overrides.stderr ?? execution.stderr;
    return {
        success: !infrastructure && execution.exitCode === 0,
        stage: infrastructure ? 'infrastructure' : stage,
        exitCode: execution.exitCode,
        stdout: overrides.stdout ?? execution.stdout,
        stderr,
        combinedOutput: overrides.combinedOutput ?? execution.combinedOutput,
        diagnostics: diagnosticLines(stderr),
        unexpectedFiles: overrides.unexpectedFiles ?? [],
        ...(overrides.timings === undefined
            ? { timings: { [stage]: execution.elapsedTime ?? 0 } }
            : { timings: overrides.timings }),
        ...(execution.cause === undefined ? {} : { cause: execution.cause }),
        ...(termination === undefined ? {} : { termination }),
        ...(signalCode === undefined ? {} : { signalCode }),
    };
}

function diagnosticLines(stderr) {
    if (stderr === '') return [];
    return stderr.replace(/\r\n?/g, '\n').split('\n')
        .filter(line => line !== '');
}

async function attachOutputComparison(
    testCase,
    execution,
    corpusRoot,
    caseRoot,
    comparisonActualPath,
) {
    const comparison = testCase.comparison;
    if (comparison === undefined) return execution;
    let actual = execution.combinedOutput
        ?? `${execution.stdout ?? ''}${execution.stderr ?? ''}`;
    if (comparison.kind === 'diff') {
        if (comparisonActualPath !== undefined) {
            actual = await readFile(comparisonActualPath, 'utf8');
        } else if (caseRoot === undefined) {
            throw new Error(`Comparison artifact is unavailable: ${comparison.actual}`);
        } else {
            actual = await readFile(path.join(caseRoot, comparison.actual), 'utf8');
        }
    }
    actual = normalizeText(actual, {
        rootPrefixes: [
            ...(caseRoot === undefined ? [] : [{ path: caseRoot, replacement: '.' }]),
            { path: corpusRoot, replacement: '.' },
        ],
    });
    const expected = await readFile(path.join(corpusRoot, comparison.path), 'utf8');
    const match = compareDeclaredOutput(actual, expected, comparison);
    return {
        ...execution,
        comparison: {
            kind: comparison.kind,
            path: comparison.path,
            match,
            ...(match ? {} : { reason: `output differs from ${comparison.path}` }),
        },
    };
}

function compareDeclaredOutput(actual, expected, comparison) {
    const offset = comparison.offset ?? 0;
    const actualLines = normalizedLines(actual).slice(offset);
    const expectedLines = normalizedLines(expected).slice(offset);
    if (comparison.kind === 'unordered') {
        actualLines.sort();
        expectedLines.sort();
    }
    return JSON.stringify(actualLines) === JSON.stringify(expectedLines);
}

function normalizedLines(value) {
    return value.replace(/\r\n?/g, '\n').split('\n');
}

function hasPassedOutput(stdout, stderr) {
    return `${stdout}\n${stderr}`.replace(/\r\n?/g, '\n').split('\n')
        .some(line => line.trim().toLowerCase() === 'passed');
}

async function runProcess(executable, args, { cwd, timeoutMs }) {
    const started = performance.now();
    return new Promise(resolve => {
        const stdout = [];
        const stderr = [];
        const combined = [];
        let termination;
        let cause;
        let settled = false;
        const child = spawn(executable, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const timeout = setTimeout(() => {
            termination = 'timeout';
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', chunk => {
            const value = chunk.toString();
            stdout.push(value);
            combined.push(value);
        });
        child.stderr.on('data', chunk => {
            const value = chunk.toString();
            stderr.push(value);
            combined.push(value);
        });
        child.on('error', error => {
            cause = { message: error.message, code: error.code };
        });
        child.on('close', (exitCode, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (cause !== undefined && termination === undefined) {
                termination = 'infrastructure';
            } else if (signal !== null && termination === undefined) {
                termination = 'signal';
            }
            resolve({
                exitCode: exitCode ?? -1,
                stdout: stdout.join(''),
                stderr: stderr.join(''),
                combinedOutput: combined.join(''),
                elapsedTime: (performance.now() - started) / 1_000,
                ...(termination === undefined ? {} : { termination }),
                ...(cause === undefined ? {} : { cause }),
                ...(signal === null ? {} : { signalCode: signal }),
            });
        });
    });
}

export function createBuiltinRegressionBackend({
    corpusRoot,
    backendFactory = defaultBuiltinBackendFactory,
    timeoutMs = 30_000,
}) {
    let backend;
    let probe;
    const loadBackend = async () => {
        backend ??= backendFactory();
        return backend;
    };
    return {
        async probe() {
            if (probe !== undefined) return probe;
            const root = await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-probe-'));
            try {
                const source = path.join(root, 'top.v');
                await writeFile(source, [
                    'module top;',
                    '  initial begin $display("PASSED"); $finish; end',
                    'endmodule',
                    '',
                ].join('\n'));
                const execution = await (await loadBackend()).compileAndRun({
                    files: [source],
                    runtimeFiles: [],
                    includeDirs: [root],
                    defines: { __ICARUS_UNSIZED__: true },
                    plusargs: [],
                    artifacts: [],
                    output: path.join(root, 'smoke.out'),
                    cwd: root,
                    topModule: 'top',
                    timeoutMs,
                });
                if (!execution.success || !hasPassedOutput(
                    execution.stdout,
                    execution.stderr,
                )) {
                    throw new Error(
                        `${execution.stderr}${execution.stdout}`.trim()
                        || `stage ${execution.stage} exited ${execution.exitCode}`,
                    );
                }
                probe = { available: true };
            } catch (error) {
                probe = {
                    available: false,
                    reason: `builtin unavailable: ${errorMessage(error)}`,
                };
            } finally {
                await rm(root, { recursive: true, force: true });
            }
            return probe;
        },
        async runCase(testCase) {
            if (testCase.type === 'CO') {
                return { skipReason: 'builtin adapter has no compile-only entry' };
            }
            const unsupported = unsupportedBuiltinOption(testCase.compilerOptions);
            if (unsupported !== undefined) {
                return {
                    skipReason: `builtin cannot represent compiler option: ${unsupported}`,
                };
            }
            const artifactRoot = testCase.comparison?.kind === 'diff'
                ? await mkdtemp(path.join(os.tmpdir(), 'veriflow-builtin-diff-'))
                : undefined;
            try {
                const source = path.join(corpusRoot, testCase.source);
                const cwd = corpusRoot;
                const runtimeFiles = await collectRuntimeDependencies(source, corpusRoot);
                const artifactDestination = artifactRoot === undefined
                    ? undefined
                    : path.join(artifactRoot, 'declared-artifact');
                const artifacts = artifactDestination === undefined
                    ? []
                    : [{
                        kind: 'file',
                        path: testCase.comparison.actual,
                        destination: artifactDestination,
                        required: true,
                    }];
                const execution = await (await loadBackend()).compileAndRun({
                    files: [source],
                    runtimeFiles,
                    includeDirs: [cwd],
                    defines: {
                        __ICARUS_UNSIZED__: true,
                        ...compilerDefines(testCase.compilerOptions),
                    },
                    plusargs: testCase.plusargs,
                    artifacts,
                    output: path.join(cwd, '.veriflow-regression.out'),
                    cwd,
                    ...(testCase.topModule === undefined
                        ? {}
                        : { topModule: testCase.topModule }),
                    timeoutMs,
                });
                const result = {
                    ...execution,
                    diagnostics: diagnosticLines(execution.stderr ?? ''),
                    unexpectedFiles: [],
                };
                if (execution.stage === 'infrastructure') return result;
                return attachOutputComparison(
                    testCase,
                    result,
                    corpusRoot,
                    undefined,
                    artifactDestination,
                );
            } finally {
                if (artifactRoot !== undefined) {
                    await rm(artifactRoot, { recursive: true, force: true });
                }
            }
        },
    };
}

async function defaultBuiltinBackendFactory() {
    const adapter = await import('@veriflow/simulator-iverilog-wasm');
    return new adapter.IverilogWasmBackend();
}

function unsupportedBuiltinOption(options) {
    return options.find(option => (
        option !== '-g2005'
        && !option.startsWith('-D')
    ));
}

function compilerDefines(options) {
    return Object.fromEntries(options.filter(option => option.startsWith('-D'))
        .map(option => {
            const definition = option.slice(2);
            const separator = definition.indexOf('=');
            return separator < 0
                ? [definition, true]
                : [definition.slice(0, separator), definition.slice(separator + 1)];
        }));
}

async function collectRuntimeDependencies(source, corpusRoot) {
    const dependencies = new Set();
    const visited = new Set();
    const visit = async filepath => {
        const normalized = path.resolve(filepath);
        if (visited.has(normalized)) return;
        visited.add(normalized);
        const sourceText = await readFile(normalized, 'utf8');
        const directory = path.dirname(normalized);
        for (const match of sourceText.matchAll(/`include\s+"([^"]+)"/g)) {
            const dependency = await firstExistingPath([
                path.resolve(corpusRoot, match[1]),
                path.resolve(directory, match[1]),
            ]);
            dependencies.add(dependency);
            await visit(dependency);
        }
        for (const match of sourceText.matchAll(
            /\$(?:readmem[hb]|sdf_annotate)\s*\(\s*"([^"]+)"/g,
        )) {
            try {
                const dependency = await firstExistingPath([
                    path.resolve(corpusRoot, match[1]),
                    path.resolve(directory, match[1]),
                ]);
                dependencies.add(dependency);
            } catch {
            }
        }
        for (const match of sourceText.matchAll(
            /\$fopen\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g,
        )) {
            if (!match[2].toLowerCase().startsWith('r')) continue;
            try {
                const dependency = await firstExistingPath([
                    path.resolve(corpusRoot, match[1]),
                    path.resolve(directory, match[1]),
                ]);
                dependencies.add(dependency);
            } catch {
            }
        }
    };
    await visit(source);
    dependencies.delete(path.resolve(source));
    return [...dependencies];
}

async function firstExistingPath(candidates) {
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
        }
    }
    throw new Error(`Regression dependency is missing: ${candidates.join(', ')}`);
}

export async function materializePinnedCorpus({ iverilogRoot, revision }) {
    if (!/^[0-9a-f]{40}$/.test(revision)) {
        throw new Error('Pinned Icarus revision must be 40 lowercase hex characters');
    }
    const objectType = (await executeFile(
        'git',
        ['cat-file', '-t', revision],
        { cwd: iverilogRoot, encoding: 'utf8' },
    )).stdout.trim();
    if (objectType !== 'commit') {
        throw new Error(`Pinned Icarus revision must be a commit, received ${objectType}`);
    }
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'veriflow-iverilog-corpus-'));
    const archive = path.join(temporaryRoot, 'ivtest.tar');
    try {
        await executeFile('git', [
            'archive',
            '--format=tar',
            `--output=${archive}`,
            revision,
            'ivtest',
        ], { cwd: iverilogRoot });
        await executeFile('tar', ['-xf', archive, '-C', temporaryRoot]);
        return {
            root: path.join(temporaryRoot, 'ivtest'),
            cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(temporaryRoot, { recursive: true, force: true });
        throw error;
    }
}

export async function runRegressionSuite({
    manifest,
    backendIds,
    backends,
    shard = { index: 0, total: 1 },
    normalizerOptions = {},
}) {
    validateShard(shard);
    validateCaseIdentities(manifest.cases);
    const eligibleCases = manifest.cases.filter(testCase => (
        testCase.exclusionReason === undefined
    ));
    const selected = eligibleCases.filter((_, index) => (
        index % shard.total === shard.index
    ));
    const results = [];
    const summary = Object.fromEntries(backendIds.map(id => [id, {
        pass: 0,
        fail: 0,
        skip: 0,
    }]));

    for (const backendId of backendIds) {
        const backend = backends[backendId];
        const capability = backend === undefined
            ? { available: false, reason: `Unknown backend: ${backendId}` }
            : await backend.probe();
        for (const testCase of selected) {
            let result;
            if (!capability.available) {
                result = skippedResult(backendId, testCase, capability.reason);
            } else {
                result = await runBackendCase(backendId, backend, testCase);
            }
            result = normalizeRegressionResult(result, normalizerOptions);
            summary[backendId][result.status] += 1;
            results.push(result);
        }
    }

    return {
        schemaVersion: 1,
        activeCases: manifest.activeCount ?? manifest.cases.length,
        eligibleCases: eligibleCases.length,
        selectedCases: selected.length,
        shard,
        backends: backendIds,
        summary,
        results,
        mismatches: collectMismatches(results, backendIds, normalizerOptions),
    };
}

async function runBackendCase(backendId, backend, testCase) {
    try {
        const execution = await backend.runCase(testCase);
        if (execution?.skipReason !== undefined) {
            return skippedResult(backendId, testCase, execution.skipReason);
        }
        const exitClass = classifyExit(execution);
        const expectation = evaluateExpectation(testCase, execution, exitClass);
        return {
            caseId: testCase.caseId,
            caseName: testCase.name,
            caseType: testCase.type,
            backendId,
            status: expectation.pass ? 'pass' : 'fail',
            ...(expectation.pass ? {} : { reason: expectation.reason }),
            exitClass,
            stage: execution.stage,
            exitCode: execution.exitCode,
            stdout: execution.stdout ?? '',
            stderr: execution.stderr ?? '',
            diagnostics: execution.diagnostics ?? [],
            unexpectedFiles: execution.unexpectedFiles ?? [],
            ...(execution.timings === undefined ? {} : { timings: execution.timings }),
            ...(execution.cause === undefined ? {} : { cause: execution.cause }),
            ...(execution.termination === undefined
                ? {}
                : { termination: execution.termination }),
            ...(execution.signalCode === undefined
                ? {}
                : { signalCode: execution.signalCode }),
            ...(execution.comparison === undefined
                ? {}
                : { comparison: execution.comparison }),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            caseId: testCase.caseId,
            caseName: testCase.name,
            caseType: testCase.type,
            backendId,
            status: 'fail',
            reason: `backend infrastructure failure: ${message}`,
            exitClass: 'infrastructure-error',
            stage: 'infrastructure',
            exitCode: -1,
            stdout: '',
            stderr: message,
            diagnostics: [],
            unexpectedFiles: [],
            cause: { message },
        };
    }
}

function classifyExit(execution) {
    if (execution.stage === 'infrastructure' || execution.stage === 'input') {
        return 'infrastructure-error';
    }
    if (execution.success) return 'success';
    if (execution.stage === 'compile') return 'compile-error';
    if (execution.stage === 'run') return 'runtime-error';
    return 'infrastructure-error';
}

function evaluateExpectation(testCase, execution, exitClass) {
    let exitExpectation;
    if (testCase.type === 'CE') {
        exitExpectation = exitClass === 'compile-error'
            ? { pass: true }
            : { pass: false, reason: `expected compile-error, got ${exitClass}` };
    } else if (testCase.type === 'RE') {
        exitExpectation = exitClass === 'runtime-error'
            ? { pass: true }
            : { pass: false, reason: `expected runtime-error, got ${exitClass}` };
    } else {
        exitExpectation = exitClass === 'success'
            ? { pass: true }
            : { pass: false, reason: `expected success, got ${exitClass}` };
    }
    if (!exitExpectation.pass) return exitExpectation;
    if (testCase.comparison !== undefined) {
        if (execution.comparison === undefined) {
            return { pass: false, reason: 'declared output comparison was not performed' };
        }
        return execution.comparison.match
            ? { pass: true }
            : { pass: false, reason: execution.comparison.reason };
    }
    if (testCase.type === 'CE' || testCase.type === 'RE') {
        return { pass: true };
    }
    if (testCase.type === 'CO') {
        return { pass: true };
    }
    const output = `${execution.stdout ?? ''}\n${execution.stderr ?? ''}`;
    const hasPassedLine = output.replace(/\r\n?/g, '\n').split('\n')
        .some(line => line.trim().toLowerCase() === 'passed');
    return hasPassedLine
        ? { pass: true }
        : { pass: false, reason: 'expected output containing PASSED' };
}

function skippedResult(backendId, testCase, reason) {
    return {
        caseId: testCase.caseId,
        caseName: testCase.name,
        caseType: testCase.type,
        backendId,
        status: 'skip',
        reason: reason ?? 'backend unavailable',
        exitClass: 'not-run',
        stdout: '',
        stderr: '',
        diagnostics: [],
        unexpectedFiles: [],
    };
}

function collectMismatches(results, backendIds, normalizerOptions) {
    if (backendIds.length < 2) return [];
    const byCase = new Map();
    for (const result of results) {
        if (result.status === 'skip') continue;
        const entry = byCase.get(result.caseId) ?? {
            caseName: result.caseName,
            results: new Map(),
        };
        entry.results.set(result.backendId, result);
        byCase.set(result.caseId, entry);
    }
    const mismatches = [];
    for (const [caseId, entry] of byCase) {
        for (let leftIndex = 0; leftIndex < backendIds.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < backendIds.length; rightIndex += 1) {
                const leftBackend = backendIds[leftIndex];
                const rightBackend = backendIds[rightIndex];
                const left = entry.results.get(leftBackend);
                const right = entry.results.get(rightBackend);
                if (left === undefined || right === undefined) continue;
                const comparison = compareNormalizedResults(
                    normalizeRegressionResult(left, normalizerOptions),
                    normalizeRegressionResult(right, normalizerOptions),
                );
                if (!comparison.match) {
                    mismatches.push({
                        caseId,
                        caseName: entry.caseName,
                        leftBackend,
                        rightBackend,
                        fields: comparison.fields,
                    });
                }
            }
        }
    }
    return mismatches;
}

function validateCaseIdentities(cases) {
    if (!Array.isArray(cases)) throw new Error('Regression manifest cases must be an array');
    const caseIds = new Set();
    for (const [index, testCase] of cases.entries()) {
        assertPlainObject(testCase, `Regression manifest case ${index}`);
        assertNonemptyString(testCase.caseId, `Regression manifest case ${index}.caseId`);
        if (caseIds.has(testCase.caseId)) {
            throw new Error(`Duplicate caseId in regression manifest: ${testCase.caseId}`);
        }
        caseIds.add(testCase.caseId);
    }
}

function validateShard(shard) {
    if (!Number.isInteger(shard.index)
        || !Number.isInteger(shard.total)
        || shard.total <= 0
        || shard.index < 0
        || shard.index >= shard.total) {
        throw new Error(`Invalid shard ${shard.index}/${shard.total}`);
    }
}

const BASELINE_ROOT_KEYS = [
    'schemaVersion',
    'corpusRevision',
    'failures',
    'mismatches',
];
const BASELINE_FAILURE_KEYS = [
    'caseId',
    'caseName',
    'backendId',
    'status',
    'exitClass',
    'reason',
    'resultDigest',
];
const BASELINE_MISMATCH_KEYS = [
    'caseId',
    'caseName',
    'leftBackend',
    'rightBackend',
    'fields',
    'leftResultDigest',
    'rightResultDigest',
];
const EXIT_CLASSES = new Set([
    'success',
    'compile-error',
    'runtime-error',
    'infrastructure-error',
]);
const MISMATCH_FIELDS = new Set([
    'status',
    'exitClass',
    'termination',
    'signalCode',
    'stdout',
    'stderr',
    'diagnostics',
    'unexpectedFiles',
    'cause',
]);
const RESULT_DIGEST_EXCLUDED_KEYS = new Set([
    'timings',
    'approved',
    'resultDigest',
    'leftResultDigest',
    'rightResultDigest',
]);

export function regressionResultDigest(result) {
    assertPlainObject(result, 'Regression result');
    assertNonemptyString(result.caseId, 'Regression result.caseId');
    const normalized = normalizeRegressionResult(result);
    const projection = Object.fromEntries(Object.entries(normalized).filter(
        ([key]) => !RESULT_DIGEST_EXCLUDED_KEYS.has(key),
    ));
    return createHash('sha256')
        .update(canonicalJson(projection))
        .digest('hex');
}

function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(item => canonicalJson(item) ?? 'null').join(',')}]`;
    }
    const entries = Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
}

export function validateRegressionBaseline(baseline, expectedRevision) {
    assertPlainObject(baseline, 'Regression baseline');
    assertExactKeys(baseline, BASELINE_ROOT_KEYS, 'regression baseline');
    if (baseline.schemaVersion !== 2) {
        throw new Error(`Unsupported regression baseline schema: ${baseline.schemaVersion}`);
    }
    if (!/^[0-9a-f]{40}$/.test(baseline.corpusRevision)) {
        throw new Error('Regression baseline corpusRevision must be 40 lowercase hex characters');
    }
    if (baseline.corpusRevision !== expectedRevision) {
        throw new Error(
            `Regression baseline revision mismatch: expected ${expectedRevision}, received ${baseline.corpusRevision}`,
        );
    }
    if (!Array.isArray(baseline.failures) || !Array.isArray(baseline.mismatches)) {
        throw new Error('Regression baseline failures and mismatches must be arrays');
    }

    const failureIdentities = new Set();
    const failures = baseline.failures.map((failure, index) => {
        const label = `regression baseline failure ${index}`;
        assertPlainObject(failure, label);
        assertExactKeys(failure, BASELINE_FAILURE_KEYS, label);
        assertNonemptyString(failure.caseId, `${label}.caseId`);
        assertNonemptyString(failure.caseName, `${label}.caseName`);
        assertNonemptyString(failure.backendId, `${label}.backendId`);
        if (failure.status !== 'fail') {
            throw new Error(`${label}.status must be fail`);
        }
        if (!EXIT_CLASSES.has(failure.exitClass)) {
            throw new Error(`${label}.exitClass is invalid: ${failure.exitClass}`);
        }
        assertNonemptyString(failure.reason, `${label}.reason`);
        assertSha256(failure.resultDigest, `${label}.resultDigest`);
        const identity = `${failure.caseId}\0${failure.backendId}`;
        if (failureIdentities.has(identity)) {
            throw new Error(
                `Duplicate failure approval: ${failure.caseId}/${failure.backendId}`,
            );
        }
        failureIdentities.add(identity);
        return { ...failure };
    });

    const mismatchIdentities = new Set();
    const mismatches = baseline.mismatches.map((mismatch, index) => {
        const label = `regression baseline mismatch ${index}`;
        assertPlainObject(mismatch, label);
        assertExactKeys(mismatch, BASELINE_MISMATCH_KEYS, label);
        assertNonemptyString(mismatch.caseId, `${label}.caseId`);
        assertNonemptyString(mismatch.caseName, `${label}.caseName`);
        assertNonemptyString(mismatch.leftBackend, `${label}.leftBackend`);
        assertNonemptyString(mismatch.rightBackend, `${label}.rightBackend`);
        if (mismatch.leftBackend === mismatch.rightBackend) {
            throw new Error(`${label} must name two different backends`);
        }
        if (!Array.isArray(mismatch.fields) || mismatch.fields.length === 0) {
            throw new Error(`${label}.fields must be a nonempty array`);
        }
        const fields = new Set();
        for (const field of mismatch.fields) {
            if (!MISMATCH_FIELDS.has(field)) {
                throw new Error(`${label}.fields contains unknown field: ${field}`);
            }
            if (fields.has(field)) {
                throw new Error(`${label}.fields contains duplicate field: ${field}`);
            }
            fields.add(field);
        }
        assertSha256(mismatch.leftResultDigest, `${label}.leftResultDigest`);
        assertSha256(mismatch.rightResultDigest, `${label}.rightResultDigest`);
        const identity = [
            mismatch.caseId,
            mismatch.leftBackend,
            mismatch.rightBackend,
        ].join('\0');
        if (mismatchIdentities.has(identity)) {
            throw new Error(
                `Duplicate mismatch approval: ${mismatch.caseId}/${mismatch.leftBackend}/${mismatch.rightBackend}`,
            );
        }
        mismatchIdentities.add(identity);
        return { ...mismatch, fields: [...mismatch.fields] };
    });

    return {
        schemaVersion: 2,
        corpusRevision: baseline.corpusRevision,
        failures,
        mismatches,
    };
}

function assertPlainObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}

function assertExactKeys(value, expectedKeys, label) {
    const expected = new Set(expectedKeys);
    for (const key of Object.keys(value)) {
        if (!expected.has(key)) throw new Error(`${label} has unexpected key: ${key}`);
    }
    for (const key of expectedKeys) {
        if (!(key in value)) throw new Error(`${label} is missing key: ${key}`);
    }
}

function assertNonemptyString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a nonempty string`);
    }
}

function assertSha256(value, label) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${label} must be 64 lowercase hex characters`);
    }
}

function failureApproval(result, resultDigest) {
    return {
        caseId: result.caseId,
        caseName: result.caseName,
        backendId: result.backendId,
        status: result.status,
        exitClass: result.exitClass,
        reason: result.reason,
        resultDigest,
    };
}

function resultIdentity(caseId, backendId) {
    assertNonemptyString(caseId, 'Regression result.caseId');
    assertNonemptyString(backendId, 'Regression result.backendId');
    return `${caseId}\0${backendId}`;
}

function mismatchApproval(mismatch, resultDigests) {
    return {
        caseId: mismatch.caseId,
        caseName: mismatch.caseName,
        leftBackend: mismatch.leftBackend,
        rightBackend: mismatch.rightBackend,
        fields: mismatch.fields,
        leftResultDigest: resultDigests.get(resultIdentity(
            mismatch.caseId,
            mismatch.leftBackend,
        )) ?? null,
        rightResultDigest: resultDigests.get(resultIdentity(
            mismatch.caseId,
            mismatch.rightBackend,
        )) ?? null,
    };
}

function approvalKey(value) {
    return canonicalJson(value);
}

function annotateRegressionReport(report, baseline) {
    const failureApprovals = new Map((baseline?.failures ?? []).map(approval => (
        [approvalKey(approval), approval]
    )));
    const mismatchApprovals = new Map((baseline?.mismatches ?? []).map(approval => (
        [approvalKey(approval), approval]
    )));
    const usedFailureApprovals = new Set();
    const usedMismatchApprovals = new Set();
    const resultDigests = new Map();
    for (const result of report.results) {
        const identity = resultIdentity(result.caseId, result.backendId);
        if (resultDigests.has(identity)) {
            throw new Error(`Duplicate regression result: ${result.caseId}/${result.backendId}`);
        }
        resultDigests.set(identity, regressionResultDigest(result));
    }
    let unapprovedFailureCount = 0;
    const results = report.results.map(result => {
        if (result.status !== 'fail') return result;
        const resultDigest = resultDigests.get(resultIdentity(
            result.caseId,
            result.backendId,
        ));
        const key = approvalKey(failureApproval(result, resultDigest));
        const approved = failureApprovals.has(key);
        if (approved) usedFailureApprovals.add(key);
        else unapprovedFailureCount += 1;
        return { ...result, resultDigest, approved };
    });
    let unapprovedMismatchCount = 0;
    const mismatches = report.mismatches.map(mismatch => {
        const approval = mismatchApproval(mismatch, resultDigests);
        const key = approvalKey(approval);
        const approved = mismatchApprovals.has(key);
        if (approved) usedMismatchApprovals.add(key);
        else unapprovedMismatchCount += 1;
        return {
            ...mismatch,
            leftResultDigest: approval.leftResultDigest,
            rightResultDigest: approval.rightResultDigest,
            approved,
        };
    });
    const staleApprovals = [
        ...(baseline?.failures ?? [])
            .filter(approval => !usedFailureApprovals.has(approvalKey(approval)))
            .map(approval => ({ kind: 'failure', ...approval })),
        ...(baseline?.mismatches ?? [])
            .filter(approval => !usedMismatchApprovals.has(approvalKey(approval)))
            .map(approval => ({ kind: 'mismatch', ...approval })),
    ];
    const clean = unapprovedFailureCount === 0
        && unapprovedMismatchCount === 0
        && staleApprovals.length === 0;
    return {
        ...report,
        results,
        mismatches,
        baseline: {
            provided: baseline !== undefined,
            valid: true,
            clean,
            ...(baseline === undefined
                ? {}
                : { corpusRevision: baseline.corpusRevision }),
            unapprovedFailureCount,
            unapprovedMismatchCount,
            staleApprovals,
        },
    };
}

export async function finalizeRegressionReport({
    report,
    baseline,
    baselineError,
    jsonPath,
}) {
    let finalized;
    try {
        if (baselineError !== undefined) throw baselineError;
        const validated = baseline === undefined
            ? undefined
            : validateRegressionBaseline(baseline, report.corpus.revision);
        finalized = annotateRegressionReport(report, validated);
    } catch (error) {
        finalized = annotateRegressionReport(report);
        finalized.baseline = {
            ...finalized.baseline,
            provided: true,
            valid: false,
            clean: false,
            error: errorMessage(error),
        };
    }
    await mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(finalized, null, 2)}\n`, 'utf8');
    return {
        report: finalized,
        exitCode: finalized.baseline.clean ? 0 : 1,
    };
}

export function parseRegressionArguments(argv) {
    const values = {};
    const optionNames = new Map([
        ['--iverilog-root', 'iverilogRoot'],
        ['--backend', 'backend'],
        ['--shard', 'shard'],
        ['--json', 'json'],
        ['--timeout-ms', 'timeoutMs'],
        ['--baseline', 'baseline'],
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const key = optionNames.get(argument);
        if (key === undefined) throw new Error(`Unknown option: ${argument}`);
        if (values[key] !== undefined) throw new Error(`Duplicate option: ${argument}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        values[key] = value;
        index += 1;
    }
    for (const [key, option] of [
        ['iverilogRoot', '--iverilog-root'],
        ['backend', '--backend'],
        ['json', '--json'],
    ]) {
        if (values[key] === undefined) throw new Error(`${option} is required`);
    }
    const backendIds = values.backend.split(',').filter(Boolean);
    if (backendIds.length === 0 || new Set(backendIds).size !== backendIds.length) {
        throw new Error('--backend must contain unique comma-separated backend IDs');
    }
    for (const backendId of backendIds) {
        if (backendId !== 'native-iverilog' && backendId !== 'builtin') {
            throw new Error(`Unknown backend: ${backendId}`);
        }
    }
    const shardMatch = /^(\d+)\/(\d+)$/.exec(values.shard ?? '0/1');
    if (shardMatch === null) throw new Error(`Invalid shard ${values.shard}`);
    const shard = { index: Number(shardMatch[1]), total: Number(shardMatch[2]) };
    validateShard(shard);
    const timeoutMs = values.timeoutMs === undefined ? 30_000 : Number(values.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive safe integer');
    }
    return {
        iverilogRoot: values.iverilogRoot,
        backendIds,
        shard,
        json: values.json,
        timeoutMs,
        ...(values.baseline === undefined ? {} : { baseline: values.baseline }),
    };
}

async function main() {
    const options = parseRegressionArguments(process.argv.slice(2));
    const revisionFile = fileURLToPath(new URL(
        '../../tools/simulation/iverilog-revision.json',
        import.meta.url,
    ));
    const revision = JSON.parse(await readFile(revisionFile, 'utf8'));
    const corpus = await materializePinnedCorpus({
        iverilogRoot: options.iverilogRoot,
        revision: revision.revision,
    });
    try {
        const nativeToolchain = await prepareNativeToolchain({
            iverilogRoot: options.iverilogRoot,
        });
        try {
            const listText = await readFile(
                path.join(corpus.root, 'regress-vlg.list'),
                'utf8',
            );
            const manifest = {
                ...parseRegressionList(listText),
                repository: revision.repository,
                revision: revision.revision,
                list: revision.list,
            };
            if (manifest.activeCount !== revision.activeCases
                || manifest.eligibleCount !== revision.eligibleCases) {
                throw new Error(
                    `Pinned corpus count mismatch: expected active=${revision.activeCases} eligible=${revision.eligibleCases}, received active=${manifest.activeCount} eligible=${manifest.eligibleCount}`,
                );
            }
            const backends = {
                'native-iverilog': createNativeRegressionBackend({
                    corpusRoot: corpus.root,
                    commands: nativeToolchain.commands,
                    compilerPrefixArgs: nativeToolchain.compilerPrefixArgs,
                    runtimePrefixArgs: nativeToolchain.runtimePrefixArgs,
                    timeoutMs: options.timeoutMs,
                }),
                builtin: createBuiltinRegressionBackend({
                    corpusRoot: corpus.root,
                    timeoutMs: options.timeoutMs,
                }),
            };
            const report = await runRegressionSuite({
                manifest,
                backendIds: options.backendIds,
                backends,
                shard: options.shard,
                normalizerOptions: {
                    rootPrefixes: [
                        {
                            path: corpus.root,
                            replacement: '<IVERILOG>/ivtest',
                        },
                        {
                            path: './ivltests',
                            replacement: '<IVERILOG>/ivtest/ivltests',
                        },
                    ],
                },
            });
            report.corpus = {
                repository: revision.repository,
                revision: revision.revision,
                list: revision.list,
            };
            let baseline;
            let baselineError;
            if (options.baseline !== undefined) {
                try {
                    baseline = JSON.parse(await readFile(options.baseline, 'utf8'));
                } catch (error) {
                    baselineError = new Error(
                        `Unable to load regression baseline ${options.baseline}: ${errorMessage(error)}`,
                    );
                }
            }
            const finalized = await finalizeRegressionReport({
                report,
                baseline,
                baselineError,
                jsonPath: options.json,
            });
            const finalReport = finalized.report;
            console.log(
                `active=${finalReport.activeCases} eligible=${finalReport.eligibleCases} selected=${finalReport.selectedCases}`,
            );
            for (const backendId of options.backendIds) {
                const counts = finalReport.summary[backendId];
                console.log(
                    `${backendId}: pass=${counts.pass} fail=${counts.fail} skip=${counts.skip}`,
                );
            }
            console.log(`mismatch=${finalReport.mismatches.length} json=${options.json}`);
            console.log(
                `baseline=${finalReport.baseline.clean ? 'clean' : 'dirty'} approved=${finalReport.baseline.provided}`,
            );
            return finalized.exitCode;
        } finally {
            await nativeToolchain.cleanup();
        }
    } finally {
        await corpus.cleanup();
    }
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

const isMain = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main()
        .then(exitCode => {
            process.exitCode = exitCode;
        })
        .catch(error => {
            console.error(errorMessage(error));
            process.exitCode = 1;
        });
}
