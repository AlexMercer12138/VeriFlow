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

async function startBundleWatchers(bundleOptions) {
    const contexts = [];
    try {
        for (const options of bundleOptions) {
            contexts.push(await context(options));
        }
        await Promise.all(contexts.map(bundleContext => bundleContext.watch()));
        return contexts;
    } catch (error) {
        await stopBundleWatchers(contexts);
        throw error;
    }
}

async function stopBundleWatchers(contexts) {
    await Promise.allSettled(
        contexts.map(bundleContext => bundleContext.dispose())
    );
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

export async function runWatch({
    bundleOptions,
    cwd,
    typecheck,
    stopRequested,
}) {
    const contexts = await startBundleWatchers(bundleOptions);
    let typecheckProcess;

    try {
        typecheckProcess = spawn(typecheck.command, typecheck.args, {
            cwd,
            env: typecheck.env,
            stdio: typecheck.stdio ?? 'inherit',
        });
        return await waitForWatchStop(typecheckProcess, stopRequested);
    } finally {
        try {
            if (typecheckProcess) await stopChild(typecheckProcess);
        } finally {
            await stopBundleWatchers(contexts);
        }
    }
}
