import { exec, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

type ExecFileRunner = (
    executable: string,
    args: readonly string[]
) => string;

export interface ProcessTreeTerminator {
    terminate(processId: number | undefined): Promise<void> | void;
}

type PosixProcessIdentity = {
    processId: number;
    parentId: number;
    state: string;
    fallback: string;
    identity: string;
};

type PosixProcessSnapshot = Omit<PosixProcessIdentity, 'identity'>;

type SignalProcess = (
    processId: number,
    signal: NodeJS.Signals
) => void;

export interface ProcessIdentityProvider {
    readonly supportsForcedTermination: boolean;
    identity(processId: number, fallback: string): string | undefined;
}

export class LinuxProcessIdentityProvider implements ProcessIdentityProvider {
    readonly supportsForcedTermination = true;

    constructor(
        private readonly readFile: (filepath: string) => string = filepath =>
            readFileSync(filepath, 'utf8')
    ) {}

    identity(processId: number, _fallback: string): string | undefined {
        try {
            const stat = this.readFile(`/proc/${processId}/stat`);
            const openingParenthesis = stat.indexOf('(');
            const closingParenthesis = stat.lastIndexOf(')');
            if (openingParenthesis < 0
                || closingParenthesis <= openingParenthesis
                || stat.slice(0, openingParenthesis).trim() !== String(processId)) {
                return undefined;
            }
            const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/);
            const starttime = fields[19];
            return starttime !== undefined && /^\d+$/.test(starttime)
                ? `linux:${starttime}`
                : undefined;
        } catch {
            return undefined;
        }
    }
}

class PosixCompositeIdentityProvider implements ProcessIdentityProvider {
    readonly supportsForcedTermination = false;

    identity(_processId: number, fallback: string): string {
        return `posix:${fallback}`;
    }
}

function defaultProcessIdentityProvider(
    platform: NodeJS.Platform
): ProcessIdentityProvider {
    return platform === 'linux'
        ? new LinuxProcessIdentityProvider()
        : new PosixCompositeIdentityProvider();
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function nodeExecFileRunner(executable: string, args: readonly string[]): string {
    return execFileSync(executable, args, {
        encoding: 'utf8',
        windowsHide: true,
    });
}

export class NodeProcessTreeTerminator implements ProcessTreeTerminator {
    constructor(
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly execFileRunner: ExecFileRunner = nodeExecFileRunner,
        private readonly identityProvider: ProcessIdentityProvider =
            defaultProcessIdentityProvider(platform),
        private readonly signalProcess: SignalProcess = process.kill
    ) {}

    async terminate(processId: number | undefined): Promise<void> {
        if (processId === undefined) return;
        try {
            if (this.platform === 'win32') {
                this.execFileRunner('taskkill', [
                    '/PID',
                    String(processId),
                    '/T',
                    '/F',
                ]);
                return;
            }

            const descendants = this.posixDescendants(processId);
            this.signalMatchingProcesses(descendants, 'SIGTERM');
            if (!this.identityProvider.supportsForcedTermination) return;
            let running = await this.waitForExit(descendants, 50);
            if (running.length > 0) {
                this.signalMatchingProcesses(running, 'SIGKILL');
                running = await this.waitForExit(running, 500);
            }
            if (running.length > 0) {
                this.signalMatchingProcesses(running, 'SIGKILL');
                await this.waitForExit(running, 500);
            }
        } catch {
        }
    }

    private posixProcessSnapshot(): Map<number, PosixProcessSnapshot> {
        const snapshot = new Map<number, PosixProcessSnapshot>();
        const processes = this.execFileRunner('ps', [
            '-eo',
            'pid=,ppid=,stat=,lstart=,command=',
        ]);
        for (const line of processes.split('\n')) {
            const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(.*?))?\s*$/.exec(line);
            if (match === null) continue;
            const processId = Number(match[1]);
            snapshot.set(processId, {
                processId,
                parentId: Number(match[2]),
                state: match[3],
                fallback: `${match[4]} ${match[5] ?? ''}`.trim(),
            });
        }
        return snapshot;
    }

    private posixDescendants(processId: number): PosixProcessIdentity[] {
        const snapshot = this.posixProcessSnapshot();
        const children = new Map<number, PosixProcessSnapshot[]>();
        for (const process of snapshot.values()) {
            const siblings = children.get(process.parentId);
            if (siblings === undefined) children.set(process.parentId, [process]);
            else siblings.push(process);
        }
        const descendants: PosixProcessIdentity[] = [];
        const visit = (parent: number): void => {
            for (const child of children.get(parent) ?? []) {
                visit(child.processId);
                const identity = this.identityProvider.identity(
                    child.processId,
                    child.fallback
                );
                if (identity !== undefined) descendants.push({ ...child, identity });
            }
        };
        visit(processId);
        return descendants;
    }

    private runningProcesses(
        identities: readonly PosixProcessIdentity[]
    ): PosixProcessIdentity[] {
        const snapshot = this.posixProcessSnapshot();
        return identities.filter(identity => {
            const current = snapshot.get(identity.processId);
            return current !== undefined
                && !current.state.startsWith('Z')
                && this.identityProvider.identity(
                    current.processId,
                    current.fallback
                ) === identity.identity;
        });
    }

    private signalMatchingProcesses(
        identities: readonly PosixProcessIdentity[],
        signal: NodeJS.Signals
    ): void {
        for (const identity of this.runningProcesses(identities)) {
            try {
                this.signalProcess(identity.processId, signal);
            } catch {
            }
        }
    }

    private async waitForExit(
        identities: readonly PosixProcessIdentity[],
        timeoutMs: number
    ): Promise<PosixProcessIdentity[]> {
        const deadline = performance.now() + timeoutMs;
        let running = this.runningProcesses(identities);
        while (running.length > 0 && performance.now() < deadline) {
            await delay(10);
            running = this.runningProcesses(running);
        }
        return running;
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
    constructor(
        private readonly processTreeTerminator: ProcessTreeTerminator =
            new NodeProcessTreeTerminator()
    ) {}

    execute(
        command: string,
        cwd: string,
        timeoutSeconds: number,
        signal?: AbortSignal
    ): Promise<ProcessExecution> {
        const started = performance.now();
        if (signal?.aborted) {
            return Promise.resolve({
                exitCode: -1,
                stdout: '',
                stderr: 'Simulation aborted',
                elapsedTime: (performance.now() - started) / 1_000,
                termination: 'abort',
            });
        }
        return new Promise(resolve => {
            let termination: ProcessExecution['termination'];
            let terminationPromise: Promise<void> | undefined;
            const commandController = new AbortController();
            const child = exec(command, {
                cwd,
                encoding: 'utf8',
                maxBuffer: 50 * 1024 * 1024,
                signal: commandController.signal,
                windowsHide: true,
            }, async (error, stdout, stderr) => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                await terminationPromise;
                const failure = error as ExecFailure | null;
                const shellExitCode = failure !== null
                    && (failure.code === 126 || failure.code === 127)
                    ? failure.code
                    : undefined;
                if (failure !== null
                    && (typeof failure.code !== 'number'
                        || shellExitCode !== undefined)
                    && termination === undefined) {
                    termination = 'infrastructure';
                }
                const terminationMessage = termination === 'abort'
                    ? 'Simulation aborted'
                    : termination === 'timeout'
                        ? `Simulation timed out after ${timeoutSeconds} seconds`
                        : '';
                const cause = termination === 'infrastructure' && failure !== null
                    ? {
                        ...(shellExitCode !== undefined
                            ? { code: `SHELL_EXIT_${shellExitCode}` }
                            : typeof failure.code === 'string'
                            ? { code: failure.code }
                            : {}),
                        message: failure.message,
                    }
                    : undefined;
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
                    ...(cause === undefined ? {} : { cause }),
                });
            });
            const terminate = (): Promise<void> => {
                terminationPromise ??= Promise.resolve()
                    .then(() => this.processTreeTerminator.terminate(child.pid))
                    .catch(() => {})
                    .then(() => commandController.abort());
                return terminationPromise;
            };
            const onAbort = (): void => {
                termination ??= 'abort';
                void terminate();
            };
            const timeout = setTimeout(() => {
                termination ??= 'timeout';
                void terminate();
            }, timeoutSeconds * 1_000);
            signal?.addEventListener('abort', onAbort, { once: true });
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
        ...(compile.cause === undefined ? {} : { cause: compile.cause }),
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
        ...(run.cause === undefined ? {} : { cause: run.cause }),
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
