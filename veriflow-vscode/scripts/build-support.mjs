import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build, context } from 'esbuild';

const childExitTimeoutMs = 5_000;

async function verifyParserAssets(assets) {
    await Promise.all(assets.map(async asset => {
        const digest = createHash('sha256')
            .update(await readFile(asset.source))
            .digest('hex');
        if (digest !== asset.sha256) {
            throw new Error(
                `${asset.name} WASM SHA256 mismatch: expected ${asset.sha256}, received ${digest}`
            );
        }
    }));
}

export async function verifyAndCopyParserAssets(assets) {
    await verifyParserAssets(assets);
    await Promise.all(assets.map(asset => (
        mkdir(path.dirname(asset.destination), { recursive: true })
    )));
    await Promise.all(assets.map(asset => copyFile(asset.source, asset.destination)));
}

export async function buildBundles(bundleOptions) {
    await Promise.all(bundleOptions.map(options => build(options)));
}

function contextualError(label, reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    return new Error(`${label}: ${detail}`, { cause: reason });
}

async function runCleanupActions(actions, message) {
    const results = await Promise.allSettled(
        actions.map(action => Promise.resolve().then(action.run))
    );
    const errors = results.flatMap((result, index) => (
        result.status === 'rejected'
            ? [contextualError(actions[index].label, result.reason)]
            : []
    ));
    if (errors.length > 0) {
        throw new AggregateError(errors, message);
    }
}

function mergeOperationAndCleanupErrors(operationError, cleanupError, message) {
    const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [contextualError('cleanup', cleanupError)];
    return new AggregateError([
        contextualError('operation', operationError),
        ...cleanupErrors,
    ], message);
}

export async function cleanupBundleContexts(contexts) {
    await runCleanupActions(
        contexts.map((bundleContext, index) => ({
            label: `bundle context ${index}`,
            run: () => bundleContext.dispose(),
        })),
        'Failed to dispose bundle contexts'
    );
}

export async function startBundleWatchers(bundleOptions, createContext = context) {
    const contexts = [];
    try {
        for (const options of bundleOptions) {
            contexts.push(await createContext(options));
        }
        await Promise.all(contexts.map(bundleContext => bundleContext.watch()));
        return contexts;
    } catch (operationError) {
        try {
            await cleanupBundleContexts(contexts);
        } catch (cleanupError) {
            throw mergeOperationAndCleanupErrors(
                operationError,
                cleanupError,
                'Bundle watcher startup and cleanup failed'
            );
        }
        throw operationError;
    }
}

function waitForWatchStop(typecheck, stopRequested) {
    return new Promise((resolve, reject) => {
        let stopped = false;

        const cleanup = () => {
            process.off('SIGINT', handleSignal);
            process.off('SIGTERM', handleSignal);
            typecheck.off('error', handleError);
            typecheck.off('exit', handleExit);
        };
        const finish = exitCode => {
            if (stopped) return;
            stopped = true;
            cleanup();
            resolve(exitCode);
        };
        const handleSignal = () => finish(0);
        const handleError = error => {
            if (stopped) return;
            stopped = true;
            cleanup();
            reject(error);
        };
        const handleExit = (code, signal) => {
            finish(code ?? (signal ? 1 : 0));
        };

        process.once('SIGINT', handleSignal);
        process.once('SIGTERM', handleSignal);
        typecheck.once('error', handleError);
        typecheck.once('exit', handleExit);
        stopRequested?.then(() => finish(0), handleError);
    });
}

async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;

    let timeout;
    const exited = new Promise(resolve => child.once('exit', resolve));
    const timedOut = new Promise((_, reject) => {
        timeout = setTimeout(
            () => reject(new Error(`Timed out stopping child process ${child.pid}`)),
            childExitTimeoutMs
        );
    });
    child.kill();
    try {
        await Promise.race([exited, timedOut]);
    } finally {
        clearTimeout(timeout);
    }
}

export async function cleanupWatchResources(
    typecheckProcess,
    contexts,
    stopTypecheck = stopChild
) {
    const actions = contexts.map((bundleContext, index) => ({
        label: `bundle context ${index}`,
        run: () => bundleContext.dispose(),
    }));
    if (typecheckProcess) {
        actions.unshift({
            label: 'typecheck process',
            run: () => stopTypecheck(typecheckProcess),
        });
    }
    await runCleanupActions(actions, 'Failed to clean up watch resources');
}

export async function runWatch({
    bundleOptions,
    cwd,
    typecheck,
    stopRequested,
    createContext = context,
    spawnProcess = spawn,
    stopTypecheck = stopChild,
}) {
    const contexts = await startBundleWatchers(bundleOptions, createContext);
    let typecheckProcess;
    let result;
    let operationFailed = false;
    let operationError;

    try {
        typecheckProcess = spawnProcess(typecheck.command, typecheck.args, {
            cwd,
            env: typecheck.env,
            stdio: typecheck.stdio ?? 'inherit',
        });
        result = await waitForWatchStop(typecheckProcess, stopRequested);
    } catch (error) {
        operationFailed = true;
        operationError = error;
    }

    let cleanupFailed = false;
    let cleanupError;
    try {
        await cleanupWatchResources(typecheckProcess, contexts, stopTypecheck);
    } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
    }

    if (operationFailed && cleanupFailed) {
        throw mergeOperationAndCleanupErrors(
            operationError,
            cleanupError,
            'Watch operation and cleanup failed'
        );
    }
    if (operationFailed) throw operationError;
    if (cleanupFailed) throw cleanupError;
    return result;
}
