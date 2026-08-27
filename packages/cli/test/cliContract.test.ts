import assert from 'node:assert/strict';
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DependencyResult } from '@veriflow/flow-core/types';
import type {
    CommandExecutor,
    ProcessExecution,
    SimulationExecution,
    SimulationRequest,
    SimulatorBackend,
} from '@veriflow/flow-core/simulation';
import type { WaveViewerLauncher } from '../src/commands/wave';
import { CliEnvironment, runCli } from '../src/main';

type JsonObject = Record<string, unknown>;

type ContractFile = {
    path: string;
    fixture?: string;
    content?: string;
    json?: unknown;
    mode?: string;
};

type ContractCase = {
    id: string;
    argv: string[];
    cwd: string;
    initial_files: ContractFile[];
    process_results?: Array<{
        exit_code: number;
        stdout: string;
        stderr: string;
        elapsed: number;
    }>;
    observe_json: string[];
    expected: JsonObject;
};

const repositoryRoot = path.resolve(__dirname, '../../../..');
const fixtureRoot = path.join(repositoryRoot, 'tests', 'cli_contract', 'fixtures');
const contract = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'tests', 'cli_contract', 'cases.json'),
    'utf8'
)) as { cases: ContractCase[] };

const configurationCases = contract.cases.filter(contractCase => {
    const command = contractCase.argv[0];
    return contractCase.argv.length === 0
        || command === 'project'
        || command === 'lib'
        || command === 'top'
        || command === 'analyze'
        || command === 'sim'
        || command === 'wave'
        || ['-h', '--help', '-v', '--version'].includes(command)
        || contractCase.id.startsWith('help_')
        || contractCase.id === 'unknown_command';
});

function replaceTokens(value: unknown, tokens: Record<string, string>): unknown {
    if (typeof value === 'string') {
        let result = value;
        for (const [token, replacement] of Object.entries(tokens)) {
            result = result.split(token).join(replacement);
        }
        return result;
    }
    if (Array.isArray(value)) return value.map(item => replaceTokens(item, tokens));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(
            ([key, item]) => [key, replaceTokens(item, tokens)]
        ));
    }
    return value;
}

function writeInitialFiles(
    caseRoot: string,
    files: ContractFile[],
    tokens: Record<string, string>
): void {
    for (const entry of files) {
        const destination = path.join(caseRoot, entry.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        if (entry.fixture) {
            copyFileSync(path.join(fixtureRoot, entry.fixture), destination);
        } else if (entry.json !== undefined) {
            writeFileSync(
                destination,
                JSON.stringify(replaceTokens(entry.json, tokens), null, 2),
                'utf8'
            );
        } else {
            writeFileSync(
                destination,
                replaceTokens(entry.content ?? '', tokens) as string,
                'utf8'
            );
        }
        if (entry.mode && process.platform !== 'win32') {
            chmodSync(destination, Number.parseInt(entry.mode, 8));
        }
    }
}

function observedJson(caseRoot: string, paths: string[]): JsonObject {
    return Object.fromEntries(paths.map(relative => {
        const filepath = path.join(caseRoot, relative);
        try {
            return [relative, JSON.parse(readFileSync(filepath, 'utf8'))];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [relative, null];
            throw error;
        }
    }));
}

function observedText(caseRoot: string, paths: string[]): JsonObject {
    return Object.fromEntries(paths.map(relative => {
        const filepath = path.join(caseRoot, relative);
        try {
            return [relative, readFileSync(filepath, 'utf8')];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [relative, null];
            throw error;
        }
    }));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTokenizedPathTails(value: string, token: string): string {
    const pattern = new RegExp(`${escapeRegExp(token)}(/[^"'\\s:,)\\]}]*)`, 'g');
    return value.replace(pattern, (_match, tail: string) => (
        token + tail.replace(/\\\\/g, '/').replace(/\\/g, '/')
    ));
}

function normalize(value: unknown, replacements: Array<[string, string]>): unknown {
    if (typeof value === 'string') {
        let result = value;
        for (const [source, replacement] of replacements) {
            const encodedReplacement = JSON.stringify(replacement).slice(1, -1);
            const variants = [
                source,
                source.replace(/\\/g, '/'),
                source.replace(/\//g, '\\'),
            ];
            for (const variant of new Set(variants)) {
                const encodedVariant = JSON.stringify(variant).slice(1, -1);
                const forms: Array<[string, string, string[]]> = [
                    [encodedVariant, encodedReplacement, ['/', '\\\\']],
                    [variant, replacement, ['/', '\\']],
                ];
                for (const [candidate, normalized, separators] of forms) {
                    for (const separator of separators) {
                        result = result
                            .split(candidate + separator)
                            .join(`${normalized}/`);
                    }
                    const boundary = new RegExp(
                        `${escapeRegExp(candidate)}(?=$|[\\s"',)\\]}])`,
                        'g'
                    );
                    result = result.replace(boundary, normalized);
                }
            }
            result = normalizeTokenizedPathTails(result, replacement);
            result = normalizeTokenizedPathTails(result, encodedReplacement);
        }
        return result;
    }
    if (Array.isArray(value)) return value.map(item => normalize(item, replacements));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(
            ([key, item]) => [key, normalize(item, replacements)]
        ));
    }
    return value;
}

function successfulExecution(
    backendId: string,
    stdout = 'PASS\n',
    commands: SimulationExecution['commands'] = {}
): SimulationExecution {
    return {
        success: true,
        exitCode: 0,
        stdout,
        stderr: '',
        logEntries: [],
        waveFile: null,
        elapsedTime: 0.01,
        backendId,
        stage: 'run',
        timings: { compile: 0.004, run: 0.006 },
        commands,
        artifacts: [],
    };
}

function dependencyResult(topModule: string, files: string[]): DependencyResult {
    return {
        topModule,
        topDefinitionKey: topModule,
        files,
        missingModules: [],
        ambiguousModules: {},
        moduleMap: {},
        depGraph: {},
    };
}

function writeProject(filepath: string, project: JsonObject): void {
    mkdirSync(path.dirname(filepath), { recursive: true });
    writeFileSync(filepath, JSON.stringify(project, null, 2), 'utf8');
}

test('contract normalization handles Windows separators without replacing lookalikes', () => {
    const value = {
        stdout: 'Root: C:\\contract\\workspace\\libs\\project\n',
        observedText: '"lib_dirs": ["C:\\\\contract\\\\workspace\\\\libs\\\\project"]',
        metadata: String.raw`pattern=\d+\w; source=rtl\top.v`,
        lookalike: String.raw`C:\contract\workspace-old`,
        diagnostic: (
            'C:\\contract\\workspace\\libs\\project: '
            + String.raw`escaped=\signal regex=\d+\w`
        ),
    };

    assert.deepEqual(normalize(value, [[String.raw`C:\contract\workspace`, '<CWD>']]), {
        stdout: 'Root: <CWD>/libs/project\n',
        observedText: '"lib_dirs": ["<CWD>/libs/project"]',
        metadata: String.raw`pattern=\d+\w; source=rtl\top.v`,
        lookalike: String.raw`C:\contract\workspace-old`,
        diagnostic: String.raw`<CWD>/libs/project: escaped=\signal regex=\d+\w`,
    });
});

test('project new persists builtin simulation defaults', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-node-cli-project-new-'));
    const cwd = path.join(caseRoot, 'workspace');
    const homeDir = path.join(caseRoot, 'home');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    try {
        let stdout = '';
        let stderr = '';
        const exitCode = await runCli(
            ['project', 'new', '--name', 'builtin-demo'],
            {
                cwd,
                homeDir,
                stdout: text => { stdout += text; },
                stderr: text => { stderr += text; },
            }
        );
        const project = JSON.parse(readFileSync(
            path.join(cwd, 'builtin-demo.json'),
            'utf8'
        ));

        assert.equal(exitCode, 0);
        assert.equal(stdout, 'Project created: builtin-demo.json\n');
        assert.equal(stderr, '');
        assert.equal(project.simulator, 'builtin');
        assert.equal(project.wave_viewer, 'builtin');
        assert.deepEqual(project.defines, {});
        assert.deepEqual(project.simulation_files, []);
        assert.deepEqual(Object.keys(project.simulators), ['custom']);
        assert.deepEqual(Object.keys(project.wave_viewers), ['builtin', 'custom']);
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('simulation help exposes builtin and custom with external tool examples', async () => {
    let stdout = '';
    const exitCode = await runCli(['sim', '--help'], {
        cwd: process.cwd(),
        homeDir: os.homedir(),
        stdout: text => { stdout += text; },
        stderr: () => undefined,
    });

    assert.equal(exitCode, 0);
    assert.match(stdout, /simulator \(builtin\/custom; auto-saved\)/);
    assert.match(stdout, /wave viewer \(builtin\/custom; auto-saved\)/);
    assert.doesNotMatch(stdout, /default: builtin/);
    assert.match(stdout, /Icarus: .*iverilog -g2005.*vvp/);
    assert.match(stdout, /VCS: .*vcs -full64/);
    assert.match(stdout, /XSim: .*xvlog.*xelab.*xsim/);
    assert.match(stdout, /Surfer: surfer/);
    assert.match(stdout, /GTKWave: gtkwave/);
    assert.doesNotMatch(stdout, /experimental-ts|native-iverilog/);
});

test('builtin simulation receives the complete normalized request without command logging', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-request-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const libraryDir = path.join(cwd, 'library');
    const runtimeFile = path.join(cwd, 'vectors', 'input.hex');
    const topFile = path.join(rootDir, 'top.v');
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(libraryDir, { recursive: true });
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    writeFileSync(topFile, 'module top; endmodule\n', 'utf8');
    writeFileSync(runtimeFile, '00\n', 'utf8');
    writeProject(path.join(cwd, 'project.json'), {
        project_name: 'request-contract',
        project_root: 'rtl',
        lib_dirs: ['library'],
        top_module: 'top',
        simulator: 'builtin',
        wave_file_template: 'waves/top.vcd',
        defines: { WIDTH: 8, TRACE: true },
        simulation_files: ['vectors/input.hex'],
    });

    let capturedRequest: SimulationRequest | undefined;
    let scanSignal: AbortSignal | undefined;
    let scanDefines: Record<string, string | true> | undefined;
    let stdout = '';
    const backend: SimulatorBackend = {
        compileAndRun(request): Promise<SimulationExecution> {
            capturedRequest = request;
            return Promise.resolve(successfulExecution(
                'builtin',
                'PASS\n',
                { compile: 'not-a-native-command', run: 'not-a-native-command' },
            ));
        },
    };
    const environment = {
        cwd,
        homeDir: path.join(caseRoot, 'home'),
        stdout: (text: string) => { stdout += text; },
        stderr: () => undefined,
        simulationBackendOptions: {
            builtinProvider: () => backend,
        },
        dependencySessionFactory: (_searchDirectories, defines) => {
            scanDefines = defines;
            return {
                scan(_topModule: string, signal: AbortSignal) {
                    scanSignal = signal;
                    return Promise.resolve(dependencyResult('top', [topFile]));
                },
                dispose: () => Promise.resolve(),
            };
        },
    } satisfies CliEnvironment;

    try {
        const exitCode = await runCli(['sim', '--project', 'project.json'], environment);

        assert.equal(exitCode, 0);
        assert.ok(capturedRequest);
        assert.deepEqual(capturedRequest.files, [topFile]);
        assert.deepEqual(capturedRequest.runtimeFiles, [runtimeFile]);
        assert.deepEqual(capturedRequest.includeDirs, [rootDir, libraryDir]);
        assert.deepEqual(capturedRequest.defines, { WIDTH: 8, TRACE: true });
        assert.deepEqual(scanDefines, { WIDTH: '8', TRACE: true });
        assert.deepEqual(capturedRequest.plusargs, []);
        assert.equal(capturedRequest.timeoutMs, 300_000);
        assert.equal(capturedRequest.output, path.join(rootDir, 'top.out'));
        assert.equal(capturedRequest.cwd, rootDir);
        assert.equal(capturedRequest.topModule, 'top');
        assert.equal(capturedRequest.signal, scanSignal);
        assert.deepEqual(capturedRequest.artifacts, [{
            kind: 'vcd',
            path: 'waves/top.vcd',
            destination: path.join(rootDir, 'waves', 'top.vcd'),
            required: false,
        }]);
        assert.doesNotMatch(stdout, /\[CMD\]/);
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('native-iverilog and legacy iverilog remain explicit native command backends', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-native-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const topFile = path.join(rootDir, 'top.v');
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(topFile, 'module top; endmodule\n', 'utf8');
    writeProject(path.join(cwd, 'project.json'), {
        project_name: 'native-contract',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
    });

    const commands: string[] = [];
    const commandExecutor: CommandExecutor = {
        execute(command): Promise<ProcessExecution> {
            commands.push(command);
            return Promise.resolve({
                exitCode: 0,
                stdout: commands.length % 2 === 0 ? 'PASS\n' : '',
                stderr: '',
                elapsedTime: 0.01,
            });
        },
    };
    const environment = {
        cwd,
        homeDir: path.join(caseRoot, 'home'),
        stdout: () => undefined,
        stderr: () => undefined,
        commandExecutor,
        dependencySessionFactory: () => ({
            scan: () => Promise.resolve(dependencyResult('top', [topFile])),
            dispose: () => Promise.resolve(),
        }),
    } satisfies CliEnvironment;

    try {
        assert.equal(await runCli([
            'sim', '--project', 'project.json', '--sim', 'native-iverilog',
        ], environment), 0);
        assert.match(commands[0], /^iverilog -g2005 /);
        assert.equal(commands.length, 2);

        commands.length = 0;
        assert.equal(await runCli([
            'sim', '--project', 'project.json', '--sim', 'iverilog',
        ], environment), 0);
        assert.match(commands[0], /^iverilog -o /);
        assert.doesNotMatch(commands[0], /-g2005/);
        assert.equal(commands.length, 2);
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('unknown and experimental backends fail explicitly without fallback', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-unavailable-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const topFile = path.join(rootDir, 'top.v');
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(topFile, 'module top; endmodule\n', 'utf8');
    writeProject(path.join(cwd, 'project.json'), {
        project_name: 'unavailable-contract',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
    });

    let builtinCalls = 0;
    let nativeCalls = 0;
    let stderr = '';
    const environment = {
        cwd,
        homeDir: path.join(caseRoot, 'home'),
        stdout: () => undefined,
        stderr: (text: string) => { stderr += text; },
        simulationBackendOptions: {
            builtinProvider: () => {
                builtinCalls += 1;
                return { compileAndRun: () => Promise.resolve(successfulExecution('builtin')) };
            },
            nativeBackendFactory: (): SimulatorBackend => {
                nativeCalls += 1;
                return { compileAndRun: () => Promise.resolve(successfulExecution('native')) };
            },
        },
        dependencySessionFactory: () => ({
            scan: () => Promise.resolve(dependencyResult('top', [topFile])),
            dispose: () => Promise.resolve(),
        }),
    } satisfies CliEnvironment;

    try {
        assert.equal(await runCli([
            'sim', '--project', 'project.json', '--sim', 'unknown-engine',
        ], environment), 1);
        assert.equal(stderr, 'Error: Unknown simulation backend: unknown-engine\n');
        assert.equal(builtinCalls, 0);
        assert.equal(nativeCalls, 0);

        stderr = '';
        assert.equal(await runCli([
            'sim', '--project', 'project.json', '--sim', 'experimental-ts',
        ], environment), 1);
        assert.equal(
            stderr,
            'Error: experimental-ts is not available in this build; '
            + 'no fallback was attempted\n'
        );
        assert.equal(builtinCalls, 0);
        assert.equal(nativeCalls, 0);
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('SIGINT uses one signal for dependency scan and simulation through host disposal', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-sigint-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const topFile = path.join(rootDir, 'top.v');
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(topFile, 'module top; endmodule\n', 'utf8');
    writeProject(path.join(cwd, 'project.json'), {
        project_name: 'sigint-contract',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
    });

    const originalListeners = process.listeners('SIGINT');
    let existingListenerCalls = 0;
    const existingListener = (): void => { existingListenerCalls += 1; };
    process.on('SIGINT', existingListener);
    const baselineListenerCount = process.listenerCount('SIGINT');
    let scanSignal: AbortSignal | undefined;
    let simulationSignal: AbortSignal | undefined;
    let listenerPresentDuringDispose = false;
    const backend: SimulatorBackend = {
        compileAndRun(request): Promise<SimulationExecution> {
            simulationSignal = request.signal;
            assert.equal(process.listenerCount('SIGINT'), baselineListenerCount + 1);
            process.emit('SIGINT');
            assert.equal(request.signal?.aborted, true);
            return Promise.resolve(successfulExecution('builtin'));
        },
    };
    const environment = {
        cwd,
        homeDir: path.join(caseRoot, 'home'),
        stdout: () => undefined,
        stderr: () => undefined,
        simulationBackendOptions: { builtinProvider: () => backend },
        dependencySessionFactory: () => ({
            scan(_topModule: string, signal: AbortSignal) {
                scanSignal = signal;
                return Promise.resolve(dependencyResult('top', [topFile]));
            },
            dispose() {
                listenerPresentDuringDispose = (
                    process.listenerCount('SIGINT') === baselineListenerCount + 1
                );
                return Promise.resolve();
            },
        }),
    } satisfies CliEnvironment;

    try {
        assert.equal(await runCli(['sim', '--project', 'project.json'], environment), 0);
        assert.equal(scanSignal, simulationSignal);
        assert.equal(scanSignal?.aborted, true);
        assert.equal(listenerPresentDuringDispose, true);
        assert.equal(existingListenerCalls, 1);
        assert.equal(process.listenerCount('SIGINT'), baselineListenerCount);
    } finally {
        process.off('SIGINT', existingListener);
        assert.deepEqual(process.listeners('SIGINT'), originalListeners);
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('SIGINT listener survives simulation rejection through dependency disposal', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-sigint-reject-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const topFile = path.join(rootDir, 'top.v');
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(topFile, 'module top; endmodule\n', 'utf8');
    writeProject(path.join(cwd, 'project.json'), {
        project_name: 'sigint-reject',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
    });

    const originalListeners = process.listeners('SIGINT');
    const baselineListenerCount = process.listenerCount('SIGINT');
    let listenerPresentDuringDispose = false;
    let stderr = '';
    const backend: SimulatorBackend = {
        compileAndRun(request): Promise<SimulationExecution> {
            process.emit('SIGINT');
            assert.equal(request.signal?.aborted, true);
            return Promise.reject(new Error('simulation rejected'));
        },
    };
    const environment = {
        cwd,
        homeDir: path.join(caseRoot, 'home'),
        stdout: () => undefined,
        stderr: (text: string) => { stderr += text; },
        simulationBackendOptions: { builtinProvider: () => backend },
        dependencySessionFactory: () => ({
            scan: () => Promise.resolve(dependencyResult('top', [topFile])),
            dispose() {
                listenerPresentDuringDispose = (
                    process.listenerCount('SIGINT') === baselineListenerCount + 1
                );
                return Promise.resolve();
            },
        }),
    } satisfies CliEnvironment;

    try {
        assert.equal(await runCli(['sim', '--project', 'project.json'], environment), 1);
        assert.equal(stderr, 'Error: simulation rejected\n');
        assert.equal(listenerPresentDuringDispose, true);
        assert.deepEqual(process.listeners('SIGINT'), originalListeners);
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

test('concurrent simulations abort independently and remove only their own listeners', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-sigint-concurrent-'));
    const cwd = path.join(caseRoot, 'workspace');
    const rootDir = path.join(cwd, 'rtl');
    const topFile = path.join(rootDir, 'top.v');
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(topFile, 'module top; endmodule\n', 'utf8');
    writeProject(path.join(cwd, 'project.json'), {
        project_name: 'sigint-concurrent',
        project_root: 'rtl',
        top_module: 'top',
        simulator: 'builtin',
    });

    const originalListeners = process.listeners('SIGINT');
    const baselineListenerCount = process.listenerCount('SIGINT');
    const signals: AbortSignal[] = [];
    const listenerCountsDuringDispose: number[] = [];
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>(resolve => { markBothStarted = resolve; });
    let releaseBackends: (() => void) | undefined;
    const released = new Promise<void>(resolve => { releaseBackends = resolve; });
    const backend: SimulatorBackend = {
        async compileAndRun(request): Promise<SimulationExecution> {
            assert.ok(request.signal);
            signals.push(request.signal);
            if (signals.length === 2) markBothStarted?.();
            await released;
            return successfulExecution('builtin');
        },
    };
    const environment = {
        cwd,
        homeDir: path.join(caseRoot, 'home'),
        stdout: () => undefined,
        stderr: () => undefined,
        simulationBackendOptions: { builtinProvider: () => backend },
        dependencySessionFactory: () => ({
            scan: () => Promise.resolve(dependencyResult('top', [topFile])),
            dispose() {
                listenerCountsDuringDispose.push(process.listenerCount('SIGINT'));
                return Promise.resolve();
            },
        }),
    } satisfies CliEnvironment;

    try {
        const runs = [
            runCli(['sim', '--project', 'project.json'], environment),
            runCli(['sim', '--project', 'project.json'], environment),
        ];
        await bothStarted;
        assert.equal(process.listenerCount('SIGINT'), baselineListenerCount + 2);
        process.emit('SIGINT');
        assert.deepEqual(signals.map(signal => signal.aborted), [true, true]);
        releaseBackends?.();
        assert.deepEqual(await Promise.all(runs), [0, 0]);
        assert.ok(listenerCountsDuringDispose.every(count => (
            count > baselineListenerCount
        )));
        assert.deepEqual(process.listeners('SIGINT'), originalListeners);
    } finally {
        releaseBackends?.();
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

assert.equal(configurationCases.length, 78);

for (const contractCase of configurationCases) {
    test(contractCase.id, async () => {
        const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-node-cli-'));
        const cwd = path.join(caseRoot, contractCase.cwd || 'workspace');
        const homeDir = path.join(caseRoot, 'home');
        mkdirSync(cwd, { recursive: true });
        mkdirSync(homeDir, { recursive: true });
        const tokens = {
            '<CASE_ROOT>': caseRoot,
            '<CWD>': cwd,
            '<HOME>': homeDir,
        };
        try {
            writeInitialFiles(caseRoot, contractCase.initial_files ?? [], tokens);
            let stdout = '';
            let stderr = '';
            const processCalls: Array<{
                cmd: string;
                cwd: string;
                timeout: number;
            }> = [];
            const processResults = [...(contractCase.process_results ?? [])];
            const popenCalls: Array<{
                cmd: string;
                shell: boolean;
                kwargs: Record<string, unknown>;
            }> = [];
            const commandExecutor: CommandExecutor = {
                execute(command, processCwd, timeoutSeconds): Promise<ProcessExecution> {
                    processCalls.push({
                        cmd: command,
                        cwd: processCwd,
                        timeout: timeoutSeconds,
                    });
                    const result = processResults.shift();
                    if (!result) {
                        throw new Error(`Unexpected process call: ${command}`);
                    }
                    return Promise.resolve({
                        exitCode: result.exit_code,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        elapsedTime: result.elapsed,
                    });
                },
            };
            const waveViewerLauncher: WaveViewerLauncher = {
                openBuiltin(): Promise<void> {
                    popenCalls.push({ cmd: '', shell: true, kwargs: {} });
                    return Promise.resolve();
                },
                openExternal(command): Promise<void> {
                    popenCalls.push({ cmd: command, shell: true, kwargs: {} });
                    return Promise.resolve();
                },
            };
            const environment: CliEnvironment = {
                cwd,
                homeDir,
                stdout: text => { stdout += text; },
                stderr: text => { stderr += text; },
                commandExecutor,
                waveViewerLauncher,
            };
            const exitCode = await runCli(
                replaceTokens(contractCase.argv, tokens) as string[],
                environment
            );
            const actual = normalize({
                exit_code: exitCode,
                stdout,
                stderr,
                observed_json: observedJson(caseRoot, contractCase.observe_json ?? []),
                observed_text: observedText(caseRoot, contractCase.observe_json ?? []),
                process_calls: processCalls,
                popen_calls: popenCalls,
            }, [
                [cwd, '<CWD>'],
                [homeDir, '<HOME>'],
                [caseRoot, '<CASE_ROOT>'],
            ]);
            assert.deepEqual(actual, contractCase.expected);
        } finally {
            rmSync(caseRoot, { recursive: true, force: true });
        }
    });
}
