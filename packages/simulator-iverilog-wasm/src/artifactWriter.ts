import {
    lstat,
    open,
    realpath,
    rename,
    unlink,
    type FileHandle,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ArtifactWriteRequest {
    path: string;
    destination: string;
}

export interface ArtifactWriteResult extends ArtifactWriteRequest {
    written: boolean;
    size: number;
}

export class ArtifactWriteError extends Error {
    readonly cause: unknown;
    readonly cleanupErrors: readonly unknown[];
    readonly errors: readonly unknown[];
    readonly results: readonly ArtifactWriteResult[];

    constructor(
        cause: unknown,
        results: readonly ArtifactWriteResult[],
        cleanupErrors: readonly unknown[] = [],
    ) {
        super(cause instanceof Error ? cause.message : 'Artifact writing failed');
        this.name = 'ArtifactWriteError';
        this.cause = cause;
        this.cleanupErrors = [...cleanupErrors];
        this.errors = [cause, ...this.cleanupErrors];
        this.results = results;
    }
}

export interface ArtifactTempFile {
    writeFile(data: Uint8Array): Promise<unknown>;
    sync(): Promise<void>;
    close(): Promise<void>;
}

export interface ArtifactWriterFileSystem {
    openExclusive?(tempPath: string): Promise<ArtifactTempFile>;
    lstat?(hostPath: string): Promise<Stats>;
    realpath?(hostPath: string): Promise<string>;
    rename?(oldPath: string, newPath: string): Promise<void>;
    unlink?(hostPath: string): Promise<void>;
    pathComparisonKey?(hostPath: string): string;
}

export interface ArtifactWriterOptions {
    cwd: string;
    signal?: AbortSignal;
    protectedVirtualPaths?: readonly string[];
    protectedHostPaths?: readonly string[];
    fileSystem?: ArtifactWriterFileSystem;
}

interface StagedArtifact {
    request: ArtifactWriteRequest;
    destination: string;
    tempPath: string;
    size: number;
}

class ArtifactCleanupError extends Error {
    readonly cleanupErrors: readonly unknown[];
    readonly cause: unknown;

    constructor(cleanupErrors: readonly unknown[], cause: unknown) {
        super('Artifact operation failed and cleanup also failed');
        this.name = 'ArtifactCleanupError';
        this.cleanupErrors = cleanupErrors;
        this.cause = cause;
    }
}

const defaultOpenExclusive = async (tempPath: string): Promise<FileHandle> => (
    open(tempPath, 'wx', 0o600)
);

export async function writeRequestedArtifacts<T extends ArtifactWriteRequest>(
    artifacts: ReadonlyMap<string, Uint8Array>,
    requests: readonly T[],
    options: ArtifactWriterOptions,
): Promise<Array<T & { written: boolean; size: number }>> {
    const fileSystem = options.fileSystem ?? {};
    const openExclusive = fileSystem.openExclusive ?? defaultOpenExclusive;
    const inspectPath = fileSystem.lstat ?? lstat;
    const canonicalizePath = fileSystem.realpath ?? realpath;
    const movePath = fileSystem.rename ?? rename;
    const removePath = fileSystem.unlink ?? unlink;
    const pathComparisonKey = fileSystem.pathComparisonKey
        ?? nativePathComparisonKey;
    const comparePath = (hostPath: string): string => (
        pathComparisonKey(path.normalize(hostPath))
    );
    const protectedVirtualPaths = new Set(
        (options.protectedVirtualPaths ?? []).map(validateArtifactPath),
    );
    const protectedHostPaths = (options.protectedHostPaths ?? []).map(
        hostPath => normalizeDestination(hostPath, options.cwd),
    );
    const protectedHostPathKeys = new Set(protectedHostPaths.map(comparePath));
    const artifactPaths = new Set<string>();
    const destinations = new Set<string>();

    const validated = requests.map(request => {
        const artifactPath = validateArtifactPath(request.path);
        const destination = normalizeDestination(request.destination, options.cwd);
        const destinationKey = comparePath(destination);
        if (artifactPaths.has(artifactPath)) {
            throw new Error(`Duplicate artifact path: ${artifactPath}`);
        }
        if (destinations.has(destinationKey)) {
            throw new Error(`Duplicate artifact destination: ${request.destination}`);
        }
        for (const sourcePath of protectedVirtualPaths) {
            if (pathsConflict(artifactPath, sourcePath)) {
                throw new Error(`Artifact path aliases a source path: ${artifactPath}`);
            }
        }
        if (protectedHostPathKeys.has(destinationKey)) {
            throw new Error(
                `Artifact destination aliases a source destination: ${request.destination}`,
            );
        }
        artifactPaths.add(artifactPath);
        destinations.add(destinationKey);
        return { request, artifactPath, destination };
    });

    throwIfAborted(options.signal);

    const produced = validated.filter(entry => artifacts.has(entry.artifactPath));
    const canonicalProtectedPaths = new Set(await Promise.all(
        protectedHostPaths.map(hostPath => canonicalExistingPath(
            hostPath,
            canonicalizePath,
            comparePath,
        )),
    ));
    const canonicalDestinations = new Set<string>();
    for (const { destination } of produced) {
        const metadata = await optionalLstat(destination, inspectPath);
        if (metadata?.isSymbolicLink()) {
            throw new Error(`Artifact destination must not be a symbolic link: ${destination}`);
        }
        const canonicalDestination = await canonicalArtifactDestination(
            destination,
            metadata !== undefined,
            canonicalizePath,
            comparePath,
        );
        if (canonicalProtectedPaths.has(canonicalDestination)) {
            throw new Error(
                `Artifact destination aliases a source destination: ${destination}`,
            );
        }
        if (canonicalDestinations.has(canonicalDestination)) {
            throw new Error(`Duplicate artifact destination: ${destination}`);
        }
        canonicalDestinations.add(canonicalDestination);
    }

    const staged: StagedArtifact[] = [];
    const committed = new Map<string, StagedArtifact>();
    const temporaryPaths: string[] = [];
    try {
        for (const entry of produced) {
            throwIfAborted(options.signal);
            const data = artifacts.get(entry.artifactPath)!;
            const tempPath = temporarySibling(entry.destination);
            temporaryPaths.push(tempPath);
            const handle = await openExclusive(tempPath);
            let closed = false;
            try {
                await handle.writeFile(data);
                await handle.sync();
                await handle.close();
                closed = true;
            } catch (operationError) {
                const closeErrors: unknown[] = [];
                if (!closed) {
                    try {
                        await handle.close();
                        closed = true;
                    } catch (closeError) {
                        closeErrors.push(closeError);
                    }
                }
                throw combineErrors(operationError, closeErrors);
            }
            staged.push({
                request: entry.request,
                destination: entry.destination,
                tempPath,
                size: data.byteLength,
            });
        }

        throwIfAborted(options.signal);
        for (const artifact of staged) {
            throwIfAborted(options.signal);
            await movePath(artifact.tempPath, artifact.destination);
            committed.set(artifact.request.path, artifact);
        }
    } catch (error) {
        const cleanupErrors = await cleanupTemporaryPaths(
            temporaryPaths,
            removePath,
        );
        const combined = combineErrors(error, cleanupErrors);
        const operationError = combined instanceof ArtifactCleanupError
            ? combined.cause
            : combined;
        const cleanupFailures = combined instanceof ArtifactCleanupError
            ? combined.cleanupErrors
            : [];
        if (committed.size > 0 || cleanupFailures.length > 0) {
            throw new ArtifactWriteError(
                operationError,
                artifactResults(requests, committed),
                cleanupFailures,
            );
        }
        throw operationError;
    }

    return artifactResults(requests, committed);
}

function artifactResults<T extends ArtifactWriteRequest>(
    requests: readonly T[],
    committed: ReadonlyMap<string, StagedArtifact>,
): Array<T & { written: boolean; size: number }> {
    return requests.map(request => {
        const artifact = committed.get(request.path);
        return {
            ...request,
            written: artifact !== undefined,
            size: artifact?.size ?? 0,
        };
    });
}

export function validateArtifactPath(value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('Artifact path must be a non-empty string');
    }
    if (value.includes('\0')) {
        throw new TypeError('Artifact path must not contain NUL bytes');
    }
    if (value.includes('\\')) {
        throw new TypeError('Artifact path must use POSIX separators');
    }
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
        throw new TypeError('Artifact path must be relative');
    }
    const components = value.split('/');
    if (components.some(component => (
        component === '' || component === '.' || component === '..'
    ))) {
        throw new TypeError('Artifact path contains an invalid component');
    }
    if (value === '.iverilog' || value.startsWith('.iverilog/')) {
        throw new TypeError('Artifact path uses the reserved .iverilog prefix');
    }
    return value;
}

function normalizeDestination(destination: string, cwd = process.cwd()): string {
    if (typeof destination !== 'string' || destination.length === 0) {
        throw new TypeError('Artifact destination must be a non-empty string');
    }
    if (destination.includes('\0')) {
        throw new TypeError('Artifact destination must not contain NUL bytes');
    }
    const normalized = path.resolve(cwd, destination);
    return normalized;
}

function pathsConflict(left: string, right: string): boolean {
    return left === right
        || left.startsWith(`${right}/`)
        || right.startsWith(`${left}/`);
}

function temporarySibling(destination: string): string {
    return path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
    );
}

async function optionalLstat(
    hostPath: string,
    inspectPath: (hostPath: string) => Promise<Stats>,
): Promise<Stats | undefined> {
    try {
        return await inspectPath(hostPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function canonicalExistingPath(
    hostPath: string,
    canonicalizePath: (hostPath: string) => Promise<string>,
    comparePath: (hostPath: string) => string,
): Promise<string> {
    try {
        return comparePath(await canonicalizePath(hostPath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return comparePath(hostPath);
        }
        throw error;
    }
}

async function canonicalArtifactDestination(
    destination: string,
    exists: boolean,
    canonicalizePath: (hostPath: string) => Promise<string>,
    comparePath: (hostPath: string) => string,
): Promise<string> {
    if (exists) return comparePath(await canonicalizePath(destination));
    const parent = await canonicalizePath(path.dirname(destination));
    return comparePath(path.join(parent, path.basename(destination)));
}

function nativePathComparisonKey(hostPath: string): string {
    return process.platform === 'win32' ? hostPath.toLowerCase() : hostPath;
}

async function cleanupTemporaryPaths(
    tempPaths: readonly string[],
    removePath: (hostPath: string) => Promise<void>,
): Promise<unknown[]> {
    const outcomes = await Promise.all(tempPaths.map(async tempPath => {
        try {
            await removePath(tempPath);
            return { failed: false as const };
        } catch (error) {
            return isMissingPathError(error)
                ? { failed: false as const }
                : { failed: true as const, error };
        }
    }));
    return outcomes.flatMap(outcome => outcome.failed ? [outcome.error] : []);
}

function isMissingPathError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT';
}

function combineErrors(
    original: unknown,
    cleanupErrors: readonly unknown[],
): unknown {
    if (cleanupErrors.length === 0) return original;
    if (original instanceof ArtifactCleanupError) {
        return new ArtifactCleanupError(
            [...original.cleanupErrors, ...cleanupErrors],
            original.cause,
        );
    }
    return new ArtifactCleanupError(
        cleanupErrors,
        original,
    );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const error = new Error('Artifact writing aborted');
    error.name = 'AbortError';
    throw error;
}
