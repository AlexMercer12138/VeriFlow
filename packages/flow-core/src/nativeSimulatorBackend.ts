import { exec, execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { LogParser } from './logParser';
import type {
    CommandExecutor,
    LegacyNativeSimulationRequest,
    LegacySimulationExecution,
    ProcessExecution,
    SimulationExecution,
    SimulationRequest,
    SimulatorBackend,
} from './simulation';
import { createSimulationRequest } from './simulation';
import { TemplateEngine } from './templateEngine';
import type { SimulatorConfig } from './types';

type ExecFailure = Error & {
    code?: number | string;
};

function descendantProcessIds(processId: number): number[] {
    if (process.platform === 'win32') return [];
    try {
        const children = new Map<number, number[]>();
        const processes = execFileSync('ps', ['-eo', 'pid=,ppid='], {
            encoding: 'utf8',
            windowsHide: true,
        });
        for (const line of processes.split('\n')) {
            const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
            if (match === null) continue;
            const child = Number(match[1]);
            const parent = Number(match[2]);
            const siblings = children.get(parent);
            if (siblings === undefined) children.set(parent, [child]);
            else siblings.push(child);
        }
        const descendants: number[] = [];
        const visit = (parent: number): void => {
            for (const child of children.get(parent) ?? []) {
                visit(child);
                descendants.push(child);
            }
        };
        visit(processId);
        return descendants;
    } catch {
        return [];
    }
}

function killProcessTree(processId: number | undefined): void {
    if (processId === undefined) return;
    for (const descendant of descendantProcessIds(processId)) {
        try {
            process.kill(descendant, 'SIGTERM');
        } catch {
        }
    }
}

function hasOwnProperty(value: object, property: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, property);
}

function ownLegacySimulator(
    request: LegacyNativeSimulationRequest
): SimulatorConfig {
    if (!hasOwnProperty(request, 'simulator')) {
        throw new Error('Native simulator configuration is required');
    }
    const simulator = (request as LegacyNativeSimulationRequest).simulator;
    if (simulator === undefined) {
        throw new Error('Native simulator configuration is required');
    }
    return simulator;
}

function normalizeLegacyRequest(request: LegacyNativeSimulationRequest): SimulationRequest {
    if (!hasOwnProperty(request, 'files')
        || !hasOwnProperty(request, 'output')
        || !hasOwnProperty(request, 'cwd')) {
        throw new Error('Legacy native simulation request fields must be own properties');
    }
    const topModule = hasOwnProperty(request, 'topModule')
        ? request.topModule
        : undefined;
    return createSimulationRequest({
        files: request.files,
        output: request.output,
        cwd: request.cwd,
        ...(topModule === undefined ? {} : { topModule }),
    });
}

export class NodeCommandExecutor implements CommandExecutor {
    execute(
        command: string,
        cwd: string,
        timeoutSeconds: number,
        signal?: AbortSignal
    ): Promise<ProcessExecution> {
        const started = performance.now();
        return new Promise(resolve => {
            let termination: ProcessExecution['termination'] = signal?.aborted
                ? 'abort'
                : undefined;
            const commandController = new AbortController();
            const child = exec(command, {
                cwd,
                encoding: 'utf8',
                maxBuffer: 50 * 1024 * 1024,
                signal: commandController.signal,
                windowsHide: true,
            }, (error, stdout, stderr) => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                const failure = error as ExecFailure | null;
                const terminationMessage = termination === 'abort'
                    ? 'Simulation aborted'
                    : termination === 'timeout'
                        ? `Simulation timed out after ${timeoutSeconds} seconds`
                        : '';
                resolve({
                    exitCode: failure === null
                        ? 0
                        : typeof failure.code === 'number' ? failure.code : -1,
                    stdout,
                    stderr: [stderr, terminationMessage].filter(Boolean).join(
                        stderr.endsWith('\n') || !stderr ? '' : '\n'
                    ),
                    elapsedTime: (performance.now() - started) / 1_000,
                    ...(termination === undefined ? {} : { termination }),
                });
            });
            const terminate = (): void => {
                killProcessTree(child.pid);
                commandController.abort();
            };
            const onAbort = (): void => {
                termination ??= 'abort';
                terminate();
            };
            const timeout = setTimeout(() => {
                termination ??= 'timeout';
                terminate();
            }, timeoutSeconds * 1_000);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (termination === 'abort') terminate();
        });
    }
}

function executionPath(filepath: string, cwd: string): string {
    const absolute = path.resolve(filepath);
    const relative = path.relative(path.resolve(cwd), absolute);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : relative === '' ? path.basename(absolute) : absolute;
}

async function inspectArtifacts(
    request: SimulationRequest
): Promise<{ artifacts: SimulationExecution['artifacts']; elapsedTime: number }> {
    const started = performance.now();
    const artifacts = await Promise.all(request.artifacts.map(async artifact => {
        try {
            const metadata = await stat(path.resolve(request.cwd, artifact.path));
            return { ...artifact, written: metadata.isFile(), size: metadata.size };
        } catch {
            return { ...artifact, written: false, size: 0 };
        }
    }));
    return {
        artifacts,
        elapsedTime: (performance.now() - started) / 1_000,
    };
}

async function executeNativeSimulation(
    backendId: string,
    simulator: SimulatorConfig,
    executor: CommandExecutor,
    request: SimulationRequest
): Promise<SimulationExecution> {
    const logParser = new LogParser();
    const initialArtifacts = request.artifacts.map(artifact => ({
        ...artifact,
        written: false,
        size: 0,
    }));
    const files = request.files.map(filepath => (
        executionPath(filepath, request.cwd)
    ));
    const output = executionPath(request.output, request.cwd);
    const compileCommand = TemplateEngine.renderCompile(
        simulator.compileCmd,
        output,
        files,
        request.topModule ?? '',
        request.defines,
        request.includeDirs
    );
    const compile = await executor.execute(
        compileCommand,
        request.cwd,
        request.timeoutMs / 1_000,
        request.signal
    );
    const compileEntries = logParser.parse(`${compile.stdout}\n${compile.stderr}`);
    const compileResult: SimulationExecution = {
        success: compile.termination === undefined
            && compile.exitCode === 0
            && !logParser.hasErrors(compile.stderr),
        exitCode: compile.exitCode,
        stdout: compile.stdout,
        stderr: compile.stderr,
        logEntries: compileEntries,
        waveFile: null,
        elapsedTime: compile.elapsedTime,
        backendId,
        stage: compile.termination === undefined ? 'compile' : 'infrastructure',
        timings: { compile: compile.elapsedTime },
        commands: { compile: compileCommand },
        artifacts: initialArtifacts,
    };
    if (!compileResult.success) {
        return compileResult;
    }

    const runCommand = TemplateEngine.renderRun(simulator.runCmd, output);
    const run = await executor.execute(
        runCommand,
        request.cwd,
        request.timeoutMs / 1_000,
        request.signal
    );
    const inspected = await inspectArtifacts(request);
    const artifactTiming = request.artifacts.length === 0
        ? {}
        : { artifact: inspected.elapsedTime };
    const runResult: SimulationExecution = {
        success: run.termination === undefined && run.exitCode === 0,
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
        logEntries: [
            ...compileEntries,
            ...logParser.parse(`${run.stdout}\n${run.stderr}`),
        ],
        waveFile: null,
        elapsedTime: compile.elapsedTime + run.elapsedTime,
        backendId,
        stage: run.termination === undefined ? 'run' : 'infrastructure',
        timings: {
            compile: compile.elapsedTime,
            run: run.elapsedTime,
            ...artifactTiming,
        },
        commands: { compile: compileCommand, run: runCommand },
        artifacts: inspected.artifacts,
    };
    return runResult;
}

export class NativeSimulatorBackend implements SimulatorBackend {
    constructor(
        private readonly backendId: string,
        private readonly simulator: SimulatorConfig,
        private readonly executor: CommandExecutor = new NodeCommandExecutor()
    ) {}

    async compileAndRun(request: SimulationRequest): Promise<SimulationExecution> {
        return executeNativeSimulation(
            this.backendId,
            this.simulator,
            this.executor,
            createSimulationRequest(request)
        );
    }
}

/** @deprecated Pass normalized requests to NativeSimulatorBackend; remove in Task 9. */
export class LegacyNativeSimulatorBackend {
    constructor(
        private readonly executor: CommandExecutor = new NodeCommandExecutor()
    ) {}

    async compileAndRun(
        request: LegacyNativeSimulationRequest
    ): Promise<LegacySimulationExecution> {
        const simulator = ownLegacySimulator(request);
        const execution = await executeNativeSimulation(
            simulator.name,
            simulator,
            this.executor,
            normalizeLegacyRequest(request)
        );
        return {
            ...execution,
            compileCommand: execution.commands.compile ?? '',
            runCommand: execution.commands.run ?? '',
        };
    }
}
