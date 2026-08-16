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

async function executeNativeSimulation(
    backendId: string,
    simulator: SimulatorConfig,
    executor: CommandExecutor,
    request: SimulationRequest
): Promise<SimulationExecution> {
    const logParser = new LogParser();
    const artifacts = request.artifacts.map(artifact => ({
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
        request.topModule ?? ''
    );
    const compile = await executor.execute(
        compileCommand,
        request.cwd,
        PROCESS_TIMEOUT_SECONDS
    );
    const compileEntries = logParser.parse(`${compile.stdout}\n${compile.stderr}`);
    const compileResult: SimulationExecution = {
        success: compile.exitCode === 0 && !logParser.hasErrors(compile.stderr),
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
        return compileResult;
    }

    const runCommand = TemplateEngine.renderRun(simulator.runCmd, output);
    const run = await executor.execute(
        runCommand,
        request.cwd,
        PROCESS_TIMEOUT_SECONDS
    );
    const runResult: SimulationExecution = {
        success: run.exitCode === 0,
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
        stage: 'run',
        timings: {},
        commands: { compile: compileCommand, run: runCommand },
        artifacts,
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
