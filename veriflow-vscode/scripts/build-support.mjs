import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { build, context } from 'esbuild';

const childExitTimeoutMs = 5_000;

const nodeModulesSegment = /(?:^|[\\/])node_modules(?:[\\/]|$)/;
const licenseFileName = /^(?:licen[cs]e|copying)(?:[._-].*)?$/i;

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function resolveMetafileInput(input, sourceRoot) {
    const nativePath = input.replace(/[\\/]/g, path.sep);
    return path.isAbsolute(nativePath)
        ? path.normalize(nativePath)
        : path.resolve(sourceRoot, nativePath);
}

async function findPackageManifest(inputPath) {
    let directory = path.dirname(inputPath);
    while (true) {
        const manifestPath = path.join(directory, 'package.json');
        try {
            return {
                directory,
                manifestPath,
                manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
            };
        } catch (error) {
            if (error instanceof SyntaxError) {
                throw new Error(`Invalid package manifest ${manifestPath}: ${error.message}`);
            }
            if (error?.code !== 'ENOENT') throw error;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            throw new Error(`No package manifest found for bundled input ${inputPath}`);
        }
        directory = parent;
    }
}

async function readLicenseText(packageDirectory, identity) {
    const candidates = (await readdir(packageDirectory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && licenseFileName.test(entry.name))
        .map(entry => entry.name)
        .sort(compareText);
    for (const candidate of candidates) {
        const text = await readFile(path.join(packageDirectory, candidate), 'utf8');
        if (text.trim().length > 0) {
            return { licenseFile: candidate, licenseText: text.trim() };
        }
    }
    throw new Error(`${identity} contributes to the schematic bundle but has no license text`);
}

export async function collectBundledPackageLicenses(metafile, sourceRoot) {
    const packageInputs = Object.keys(metafile?.inputs ?? {})
        .filter(input => nodeModulesSegment.test(input))
        .sort(compareText);
    const packages = new Map();
    for (const input of packageInputs) {
        const packageInfo = await findPackageManifest(resolveMetafileInput(input, sourceRoot));
        const { name, version, license } = packageInfo.manifest;
        const manifestIdentity = `${name ?? '<unnamed>'}@${version ?? '<unversioned>'}`;
        if (typeof name !== 'string' || name.length === 0
            || typeof version !== 'string' || version.length === 0) {
            throw new Error(`Bundled package ${packageInfo.manifestPath} lacks name or version`);
        }
        if (typeof license !== 'string' || license.trim().length === 0) {
            throw new Error(`${manifestIdentity} contributes to the schematic bundle but lacks a declared license`);
        }
        const identity = `${name}\0${version}`;
        if (packages.has(identity)) continue;
        packages.set(identity, {
            name,
            version,
            license: license.trim(),
            ...await readLicenseText(packageInfo.directory, manifestIdentity),
        });
    }
    return [...packages.values()].sort((left, right) =>
        compareText(left.name, right.name)
        || compareText(left.version, right.version)
    );
}

function packageIdentity(packageNotice) {
    return `${packageNotice.name}\0${packageNotice.version}`;
}

function normalizeLineEndings(text) {
    return text.replace(/\r\n?/g, '\n');
}

export function formatThirdPartyNotices(parserPackages, frontendPackages) {
    const frontendByIdentity = new Map();
    for (const packageNotice of frontendPackages) {
        frontendByIdentity.set(packageIdentity(packageNotice), packageNotice);
    }
    const sortedFrontend = [...frontendByIdentity.values()].sort((left, right) =>
        compareText(left.name, right.name)
        || compareText(left.version, right.version)
    );
    const sections = [...parserPackages, ...sortedFrontend].map(packageNotice => {
        const declaredLicense = packageNotice.license?.trim();
        const declaration = declaredLicense
            ? `Declared license: ${declaredLicense}\n\n`
            : '';
        return `## ${packageNotice.name} ${packageNotice.version}\n\n`
            + declaration
            + `${normalizeLineEndings(packageNotice.licenseText).trim()}\n`;
    });
    return `# Third-Party Notices\n\n${sections.join('\n')}`;
}

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
    return Promise.all(bundleOptions.map(options => build(options)));
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
