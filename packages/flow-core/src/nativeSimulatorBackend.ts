import { exec } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { LogParser } from './logParser';
import type {
    CommandExecutor,
    ProcessExecution,
    SimulationExecution,
    SimulationRequest,
    SimulatorBackend,
} from './simulation';
import { TemplateEngine } from './templateEngine';

const PROCESS_TIMEOUT_SECONDS = 300;

type ExecFailure = Error & {
    code?: number | string;
    killed?: boolean;
};

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

    constructor(private readonly executor: CommandExecutor = new NodeCommandExecutor()) {}

    async compileAndRun(request: SimulationRequest): Promise<SimulationExecution> {
        const files = request.files.map(filepath => executionPath(filepath, request.cwd));
        const output = executionPath(request.output, request.cwd);
        const compileCommand = TemplateEngine.renderCompile(
            request.simulator.compileCmd,
            output,
            files,
            request.topModule ?? ''
        );
        const compile = await this.executor.execute(
            compileCommand,
            request.cwd,
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
            compileCommand,
            runCommand: '',
        };
        if (!compileResult.success) return compileResult;

        const runCommand = TemplateEngine.renderRun(request.simulator.runCmd, output);
        const run = await this.executor.execute(
            runCommand,
            request.cwd,
            PROCESS_TIMEOUT_SECONDS
        );
        return {
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
            compileCommand,
            runCommand,
        };
    }
}
