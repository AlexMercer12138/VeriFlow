import * as path from 'path';
import * as cp from 'child_process';
import { SimulatorConfig, WaveViewerConfig, SimulationResult } from './types';
import { TemplateEngine } from './templateEngine';
import { LogParser } from './logParser';

type ExecSyncFailure = Error & {
    status?: number;
    stdout?: string;
    stderr?: string;
};

function asExecSyncFailure(error: unknown): ExecSyncFailure {
    return error instanceof Error
        ? error as ExecSyncFailure
        : new Error(String(error));
}

export class SimulationRunner {
    private _lastCompileCmd = '';
    private _lastRunCmd = '';
    private _lastWaveCmd = '';
    private _logParser = new LogParser();

    get lastCompileCmd(): string { return this._lastCompileCmd; }
    get lastRunCmd(): string { return this._lastRunCmd; }
    get lastWaveCmd(): string { return this._lastWaveCmd; }

    compile(
        files: string[],
        output: string,
        simulator: SimulatorConfig,
        cwd: string,
        topModule: string = ''
    ): SimulationResult {
        const fileArgs = this._resolveFilePaths(files, cwd);
        const cmd = TemplateEngine.renderCompile(
            simulator.compileCmd, output, fileArgs, topModule
        );
        this._lastCompileCmd = cmd;

        const start = Date.now();
        let exitCode = 0;
        let stdout = '';
        let stderr = '';

        try {
            const result = cp.execSync(cmd, {
                cwd,
                encoding: 'utf-8',
                maxBuffer: 50 * 1024 * 1024,
                windowsHide: true,
            });
            stdout = result || '';
        } catch (error: unknown) {
            const failure = asExecSyncFailure(error);
            exitCode = failure.status ?? -1;
            stdout = failure.stdout || '';
            stderr = failure.stderr || '';
        }

        const elapsed = (Date.now() - start) / 1000;
        const combined = stdout + '\n' + stderr;
        const logEntries = this._logParser.parse(combined);
        const hasErrors = this._logParser.hasErrors(stderr);

        return {
            success: exitCode === 0 && !hasErrors,
            exitCode,
            stdout,
            stderr,
            logEntries,
            waveFile: null,
            elapsedTime: elapsed,
        };
    }

    run(output: string, simulator: SimulatorConfig, cwd: string): SimulationResult {
        const cmd = TemplateEngine.renderRun(simulator.runCmd, output);
        this._lastRunCmd = cmd;

        const start = Date.now();
        let exitCode = 0;
        let stdout = '';
        let stderr = '';

        try {
            const result = cp.execSync(cmd, {
                cwd,
                encoding: 'utf-8',
                maxBuffer: 50 * 1024 * 1024,
                windowsHide: true,
            });
            stdout = result || '';
        } catch (error: unknown) {
            const failure = asExecSyncFailure(error);
            exitCode = failure.status ?? -1;
            stdout = failure.stdout || '';
            stderr = failure.stderr || '';
        }

        const elapsed = (Date.now() - start) / 1000;
        const combined = stdout + '\n' + stderr;
        const logEntries = this._logParser.parse(combined);

        return {
            success: exitCode === 0,
            exitCode,
            stdout,
            stderr,
            logEntries,
            waveFile: null,
            elapsedTime: elapsed,
        };
    }

    compileAndRun(
        files: string[],
        output: string,
        simulator: SimulatorConfig,
        cwd: string,
        topModule: string = ''
    ): SimulationResult {
        const compileResult = this.compile(files, output, simulator, cwd, topModule);
        compileResult.stdout = `[CMD] Compile: ${this._lastCompileCmd}\n${compileResult.stdout}`;
        if (!compileResult.success) {
            return compileResult;
        }

        const runResult = this.run(output, simulator, cwd);
        runResult.elapsedTime += compileResult.elapsedTime;
        runResult.logEntries = [...compileResult.logEntries, ...runResult.logEntries];
        runResult.stdout = (
            `[CMD] Compile: ${this._lastCompileCmd}\n`
            + runResult.stdout
            + `\n[CMD] Run: ${this._lastRunCmd}\n`
        );
        return runResult;
    }

    openWave(waveFile: string, viewer: WaveViewerConfig): void {
        const cmd = TemplateEngine.renderWave(viewer.launchCmd, waveFile);
        this._lastWaveCmd = cmd;
        cp.exec(cmd, { windowsHide: false });
    }

    private _resolveFilePaths(files: string[], cwd: string): string[] {
        const result: string[] = [];
        const cwdResolved = path.resolve(cwd);
        for (const f of files) {
            const abs = path.resolve(f);
            try {
                const rel = path.relative(cwdResolved, abs);
                if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                    result.push(rel);
                } else if (!rel) {
                    result.push(path.basename(abs));
                } else {
                    result.push(abs);
                }
            } catch {
                result.push(abs);
            }
        }
        return result;
    }
}
