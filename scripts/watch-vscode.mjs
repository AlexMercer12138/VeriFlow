import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWeb } from './build-web.mjs';
import { syncVscodeWebAssets } from './build-vscode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childExitTimeoutMs = 5_000;
const sourceDirectories = [
    'packages/waveform-webview/src',
    'packages/schematic-webview/src',
    'packages/schematic-core/src',
];

function createSignalStop() {
    let resolveStop;
    const promise = new Promise(resolve => { resolveStop = resolve; });
    const handleSignal = () => resolveStop();
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    return {
        promise,
        dispose() {
            process.off('SIGINT', handleSignal);
            process.off('SIGTERM', handleSignal);
        },
    };
}

function createBuildQueue(action) {
    let requested = false;
    let running;
    let stopped = false;
    let error;
    let resolveFailure;
    const failure = new Promise(resolve => { resolveFailure = resolve; });

    const drain = async () => {
        while (requested && !stopped && !error) {
            requested = false;
            try {
                await action();
            } catch (buildError) {
                error = buildError;
                resolveFailure(buildError);
            }
        }
    };

    return {
        get error() {
            return error;
        },
        failure,
        request() {
            if (stopped || error) return running ?? Promise.resolve();
            requested = true;
            if (!running) {
                running = drain().finally(() => { running = undefined; });
            }
            return running;
        },
        async stop() {
            stopped = true;
            requested = false;
            await running;
        },
    };
}

function childOutcome(child) {
    return new Promise(resolve => {
        child.once('error', error => resolve({ kind: 'child-error', error }));
        child.once('exit', (code, signal) => resolve({
            kind: 'child-exit',
            code,
            signal,
        }));
    });
}

async function waitForChildExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            child.off('exit', handleExit);
        };
        const handleExit = () => {
            cleanup();
            resolve();
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out stopping child process ${child.pid}`));
        }, timeoutMs);
        child.once('exit', handleExit);
    });
}

async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    child.kill();
    try {
        await waitForChildExit(child, childExitTimeoutMs);
    } catch (error) {
        child.kill('SIGKILL');
        try {
            await waitForChildExit(child, childExitTimeoutMs);
        } catch {
            throw error;
        }
    }
}

export async function watchVscode({
    repositoryRoot = root,
    buildWebAssets = buildWeb,
    extensionWatch,
    stopRequested,
    watchDirectory = watch,
    spawnProcess = spawn,
} = {}) {
    const extensionRoot = path.join(repositoryRoot, 'veriflow-vscode');
    const extensionCommand = extensionWatch ?? {
        command: process.execPath,
        args: [path.join(extensionRoot, 'scripts', 'build.mjs'), '--watch'],
        cwd: extensionRoot,
        stdio: 'inherit',
    };
    const signalStop = stopRequested ? undefined : createSignalStop();
    const shutdown = stopRequested ?? signalStop.promise;
    const rebuilds = createBuildQueue(async () => {
        await buildWebAssets();
        await syncVscodeWebAssets(repositoryRoot);
    });
    const sourceWatchers = [];
    let extensionProcess;
    let resolveWatchFailure;
    const watchFailure = new Promise(resolve => { resolveWatchFailure = resolve; });

    try {
        for (const sourceDirectory of sourceDirectories) {
            const sourceWatcher = watchDirectory(
                path.join(repositoryRoot, sourceDirectory),
                { recursive: true },
                () => { void rebuilds.request(); }
            );
            sourceWatcher.once('error', resolveWatchFailure);
            sourceWatchers.push(sourceWatcher);
        }

        await rebuilds.request();
        if (rebuilds.error) throw rebuilds.error;

        extensionProcess = spawnProcess(
            extensionCommand.command,
            extensionCommand.args,
            {
                cwd: extensionCommand.cwd,
                env: extensionCommand.env,
                stdio: extensionCommand.stdio ?? 'inherit',
            }
        );
        const outcome = await Promise.race([
            shutdown.then(
                () => ({ kind: 'stop' }),
                error => ({ kind: 'stop-error', error })
            ),
            rebuilds.failure.then(error => ({ kind: 'build-error', error })),
            watchFailure.then(error => ({ kind: 'watch-error', error })),
            childOutcome(extensionProcess),
        ]);

        if (outcome.kind === 'stop') return;
        if (outcome.kind === 'child-exit') {
            if (outcome.code === 0
                || outcome.signal === 'SIGINT'
                || outcome.signal === 'SIGTERM') {
                return;
            }
            throw new Error(
                `Extension watcher exited with code ${outcome.code ?? 'null'}`
                + ` and signal ${outcome.signal ?? 'null'}`
            );
        }
        throw outcome.error;
    } finally {
        for (const sourceWatcher of sourceWatchers) sourceWatcher.close();
        await rebuilds.stop();
        if (extensionProcess) await stopChild(extensionProcess);
        signalStop?.dispose();
    }
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    await watchVscode();
}
