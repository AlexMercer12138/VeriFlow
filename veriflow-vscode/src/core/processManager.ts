import * as cp from 'child_process';

export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    elapsedTime: number;
}

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

export function runSync(
    cmd: string,
    cwd?: string,
    timeout: number = 300000
): ProcessResult {
    const start = Date.now();
    try {
        const result = cp.execSync(cmd, {
            cwd: cwd || undefined,
            timeout,
            encoding: 'utf-8',
            maxBuffer: 50 * 1024 * 1024,
            windowsHide: true,
        });
        const elapsed = (Date.now() - start) / 1000;
        return {
            exitCode: 0,
            stdout: result || '',
            stderr: '',
            elapsedTime: elapsed,
        };
    } catch (error: unknown) {
        const failure = asExecSyncFailure(error);
        const elapsed = (Date.now() - start) / 1000;
        return {
            exitCode: failure.status ?? -1,
            stdout: failure.stdout || '',
            stderr: failure.stderr || failure.message,
            elapsedTime: elapsed,
        };
    }
}

export function spawnStreaming(
    cmd: string,
    cwd: string,
    onData: (line: string) => void,
    onError: (line: string) => void,
    onDone: (exitCode: number) => void
): cp.ChildProcess {
    const proc = cp.spawn(cmd, [], {
        cwd,
        shell: true,
        env: { ...process.env },
        windowsHide: true,
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
            onData(line);
        }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() || '';
        for (const line of lines) {
            onError(line);
        }
    });

    proc.on('close', (code) => {
        if (stdoutBuf.trim()) { onData(stdoutBuf); }
        if (stderrBuf.trim()) { onError(stderrBuf); }
        onDone(code ?? -1);
    });

    proc.on('error', (err) => {
        onError(`Process error: ${err.message}`);
        onDone(-1);
    });

    return proc;
}
