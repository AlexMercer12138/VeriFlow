import { exec } from 'node:child_process';
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

const PROCESS_TIMEOUT_SECONDS = 300;

type ExecFailure = Error & {
    code?: number | string;
    killed?: boolean;
};

type LegacyCompatibleSimulationExecution = SimulationExecution & LegacySimulationExecution;

const LEGACY_REQUEST_FIELDS = ['files', 'output', 'simulator', 'cwd'] as const;
const NORMALIZED_ONLY_REQUEST_FIELDS = [
    'runtimeFiles',
    'includeDirs',
    'defines',
    'plusargs',
    'artifacts',
    'timeoutMs',
    'signal',
] as const;

function hasOwnProperty(value: object, property: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, property);
}

function isLegacyNativeSimulationRequest(
    request: SimulationRequest | LegacyNativeSimulationRequest
): request is LegacyNativeSimulationRequest {
    // Hybrid objects are normalized; the adapter accepts only the isolated old shape.
    return LEGACY_REQUEST_FIELDS.every(field => hasOwnProperty(request, field))
        && NORMALIZED_ONLY_REQUEST_FIELDS.every(field => !hasOwnProperty(request, field));
}

function withLegacyCommandAliases(
    execution: SimulationExecution,
    legacyRequest: LegacyNativeSimulationRequest | undefined,
    compileCommand: string,
    runCommand: string
): SimulationExecution | LegacyCompatibleSimulationExecution {
    if (legacyRequest === undefined) return execution;
    return { ...execution, compileCommand, runCommand };
}

export class NodeCommandExecutor implements CommandExecutor {
    execute(command: string, cwd: string, timeoutSeconds: number): Promise<ProcessExecution> {
        const started = performance.now();
        return new Promise(resolve => {
            exec(command, {
                cwd,
                encoding: 'utf8',
                maxBuffer: 50 * 1024 * 1024,
                timeout: timeoutSeconds * 1_000,
                windowsHide: true,
            }, (error, stdout, stderr) => {
                const failure = error as ExecFailure | null;
                resolve({
                    exitCode: failure === null
                        ? 0
                        : typeof failure.code === 'number' ? failure.code : -1,
                    stdout,
                    stderr,
                    elapsedTime: (performance.now() - started) / 1_000,
                });
            });
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

export class NativeSimulatorBackend implements SimulatorBackend {
    private readonly logParser = new LogParser();
    private readonly backendId: string | undefined;
    private readonly simulator: SimulatorConfig | undefined;
    private readonly executor: CommandExecutor;

    constructor(backendId: string, simulator: SimulatorConfig, executor?: CommandExecutor);
    /** @deprecated Pass backend ID and simulator configuration; remove in Task 9. */
    constructor(executor?: CommandExecutor);
    constructor(
        backendIdOrExecutor?: string | CommandExecutor,
        simulator?: SimulatorConfig,
        executor: CommandExecutor = new NodeCommandExecutor()
    ) {
        if (typeof backendIdOrExecutor === 'string') {
            this.backendId = backendIdOrExecutor;
            this.simulator = simulator;
            this.executor = executor;
            return;
        }

        this.backendId = undefined;
        this.simulator = undefined;
        this.executor = backendIdOrExecutor ?? new NodeCommandExecutor();
    }

    async compileAndRun(request: SimulationRequest): Promise<SimulationExecution>;
    /** @deprecated Pass a normalized request; remove in Task 9. */
    async compileAndRun(
        request: LegacyNativeSimulationRequest
    ): Promise<LegacyCompatibleSimulationExecution>;
    async compileAndRun(
        request: SimulationRequest | LegacyNativeSimulationRequest
    ): Promise<SimulationExecution | LegacyCompatibleSimulationExecution> {
        let legacyRequest: LegacyNativeSimulationRequest | undefined;
        let normalizedRequest: SimulationRequest;
        if (isLegacyNativeSimulationRequest(request)) {
            legacyRequest = request;
            normalizedRequest = createSimulationRequest(request);
        } else {
            normalizedRequest = request;
        }
        const simulator = this.simulator ?? legacyRequest?.simulator;
        if (simulator === undefined) {
            throw new Error('Native simulator configuration is required');
        }

        const backendId = this.backendId ?? simulator.name;
        const artifacts = normalizedRequest.artifacts.map(artifact => ({
            ...artifact,
            written: false,
            size: 0,
        }));
        const files = normalizedRequest.files.map(filepath => (
            executionPath(filepath, normalizedRequest.cwd)
        ));
        const output = executionPath(normalizedRequest.output, normalizedRequest.cwd);
        const compileCommand = TemplateEngine.renderCompile(
            simulator.compileCmd,
            output,
            files,
            normalizedRequest.topModule ?? ''
        );
        const compile = await this.executor.execute(
            compileCommand,
            normalizedRequest.cwd,
            PROCESS_TIMEOUT_SECONDS
        );
        const compileEntries = this.logParser.parse(`${compile.stdout}\n${compile.stderr}`);
        const compileResult: SimulationExecution = {
            success: compile.exitCode === 0 && !this.logParser.hasErrors(compile.stderr),
            exitCode: compile.exitCode,
            stdout: compile.stdout,
            stderr: compile.stderr,
            logEntries: compileEntries,
            waveFile: null,
            elapsedTime: compile.elapsedTime,
            backendId,
            stage: 'compile',
            timings: {},
            commands: { compile: compileCommand },
            artifacts,
        };
        if (!compileResult.success) {
            return withLegacyCommandAliases(
                compileResult,
                legacyRequest,
                compileCommand,
                ''
            );
        }

        const runCommand = TemplateEngine.renderRun(simulator.runCmd, output);
        const run = await this.executor.execute(
            runCommand,
            normalizedRequest.cwd,
            PROCESS_TIMEOUT_SECONDS
        );
        const runResult: SimulationExecution = {
            success: run.exitCode === 0,
            exitCode: run.exitCode,
            stdout: run.stdout,
            stderr: run.stderr,
            logEntries: [
                ...compileEntries,
                ...this.logParser.parse(`${run.stdout}\n${run.stderr}`),
            ],
            waveFile: null,
            elapsedTime: compile.elapsedTime + run.elapsedTime,
            backendId,
            stage: 'run',
            timings: {},
            commands: { compile: compileCommand, run: runCommand },
            artifacts,
        };
        return withLegacyCommandAliases(
            runResult,
            legacyRequest,
            compileCommand,
            runCommand
        );
    }
}
