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
    parentIdentity: ArtifactParentIdentity;
    tempPath: string;
    size: number;
}

interface PreparedArtifact<T extends ArtifactWriteRequest> {
    request: T;
    artifactPath: string;
    destination: string;
    parentIdentity?: ArtifactParentIdentity;
}

interface ArtifactParentIdentity {
    lexicalPath: string;
    canonicalPath: string;
    canonicalKey: string;
    device?: number;
    inode?: number;
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
    const producedPaths = new Set(artifacts.keys());
    const validated = await prepareRequestedArtifacts(
        requests,
        options,
        producedPaths,
    );
    const produced = validated.filter(entry => artifacts.has(entry.artifactPath));

    const staged: StagedArtifact[] = [];
    const committed = new Map<string, StagedArtifact>();
    const temporaryPaths: string[] = [];
    try {
        for (const entry of produced) {
            throwIfAborted(options.signal);
            if (entry.parentIdentity === undefined) {
                throw new Error(
                    `Artifact destination was not prepared: ${entry.request.destination}`,
                );
            }
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
                parentIdentity: entry.parentIdentity,
                tempPath,
                size: data.byteLength,
            });
        }

        throwIfAborted(options.signal);
        for (const artifact of staged) {
            throwIfAborted(options.signal);
            await assertStableArtifactParent(
                artifact.parentIdentity,
                artifact.request.destination,
                inspectPath,
                canonicalizePath,
                comparePath,
            );
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

export async function preflightRequestedArtifacts<T extends ArtifactWriteRequest>(
    requests: readonly T[],
    options: ArtifactWriterOptions,
): Promise<void> {
    await prepareRequestedArtifacts(requests, options);
}

async function prepareRequestedArtifacts<T extends ArtifactWriteRequest>(
    requests: readonly T[],
    options: ArtifactWriterOptions,
    inspectedArtifactPaths?: ReadonlySet<string>,
): Promise<Array<PreparedArtifact<T>>> {
    const fileSystem = options.fileSystem ?? {};
    const inspectPath = fileSystem.lstat ?? lstat;
    const canonicalizePath = fileSystem.realpath ?? realpath;
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

    const validated: Array<PreparedArtifact<T>> = requests.map(request => {
        const artifactPath = validateLogicalArtifactPath(request.path);
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

    const inspected = inspectedArtifactPaths === undefined
        ? validated
        : validated.filter(entry => inspectedArtifactPaths.has(entry.artifactPath));
    if (inspected.length === 0) return validated;
    const canonicalProtectedPaths = new Set(await Promise.all(
        protectedHostPaths.map(hostPath => canonicalExistingPath(
            hostPath,
            canonicalizePath,
            comparePath,
        )),
    ));
    const canonicalDestinations = new Set<string>();
    for (const entry of inspected) {
        const { destination } = entry;
        const metadata = await optionalLstat(destination, inspectPath);
        if (metadata?.isSymbolicLink()) {
            throw new Error(`Artifact destination must not be a symbolic link: ${destination}`);
        }
        const preparedDestination = await prepareArtifactDestination(
            destination,
            metadata !== undefined,
            inspectPath,
            canonicalizePath,
            comparePath,
        );
        if (canonicalProtectedPaths.has(preparedDestination.destinationKey)) {
            throw new Error(
                `Artifact destination aliases a source destination: ${destination}`,
            );
        }
        if (canonicalDestinations.has(preparedDestination.destinationKey)) {
            throw new Error(`Duplicate artifact destination: ${destination}`);
        }
        canonicalDestinations.add(preparedDestination.destinationKey);
        entry.destination = preparedDestination.destination;
        entry.parentIdentity = preparedDestination.parentIdentity;
    }
    return validated;
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
    validateArtifactPathPrefix(value);
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

export function validateLogicalArtifactPath(value: string): string {
    validateArtifactPathPrefix(value);
    if (path.posix.normalize(value) !== value) {
        throw new TypeError('Artifact path must be normalized');
    }
    const components = value.split('/');
    const firstPathComponent = components.findIndex(component => component !== '..');
    if (firstPathComponent === -1
        || components.slice(firstPathComponent).some(component => (
            component === '' || component === '.' || component === '..'
        ))) {
        throw new TypeError('Artifact path contains an invalid component');
    }
    const relativePath = components.slice(firstPathComponent).join('/');
    if (relativePath === '.iverilog' || relativePath.startsWith('.iverilog/')) {
        throw new TypeError('Artifact path uses the reserved .iverilog prefix');
    }
    return value;
}

function validateArtifactPathPrefix(value: string): void {
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

async function prepareArtifactDestination(
    destination: string,
    exists: boolean,
    inspectPath: (hostPath: string) => Promise<Stats>,
    canonicalizePath: (hostPath: string) => Promise<string>,
    comparePath: (hostPath: string) => string,
): Promise<{
    destination: string;
    destinationKey: string;
    parentIdentity: ArtifactParentIdentity;
}> {
    const lexicalParent = path.dirname(destination);
    const canonicalParent = await canonicalizePath(lexicalParent);
    const canonicalParentKey = comparePath(canonicalParent);
    const parentMetadata = await optionalLstat(canonicalParent, inspectPath);
    const stableMetadata = stableDirectoryIdentity(parentMetadata);
    const parentIsAliased = comparePath(lexicalParent) !== canonicalParentKey;
    if (parentIsAliased && stableMetadata === undefined) {
        throw new Error(
            `Artifact destination parent symbolic link identity cannot be verified: ${destination}`,
        );
    }

    const canonicalDestination = exists
        ? await canonicalizePath(destination)
        : path.join(canonicalParent, path.basename(destination));
    if (comparePath(path.dirname(canonicalDestination)) !== canonicalParentKey) {
        throw new Error(
            `Artifact destination parent changed during validation: ${destination}`,
        );
    }
    return {
        destination: canonicalDestination,
        destinationKey: comparePath(canonicalDestination),
        parentIdentity: {
            lexicalPath: lexicalParent,
            canonicalPath: canonicalParent,
            canonicalKey: canonicalParentKey,
            ...(stableMetadata === undefined ? {} : stableMetadata),
        },
    };
}

async function assertStableArtifactParent(
    identity: ArtifactParentIdentity,
    requestedDestination: string,
    inspectPath: (hostPath: string) => Promise<Stats>,
    canonicalizePath: (hostPath: string) => Promise<string>,
    comparePath: (hostPath: string) => string,
): Promise<void> {
    let lexicalParent: string;
    let canonicalParent: string;
    try {
        [lexicalParent, canonicalParent] = await Promise.all([
            canonicalizePath(identity.lexicalPath),
            canonicalizePath(identity.canonicalPath),
        ]);
    } catch (error) {
        throw parentVerificationError(requestedDestination, error);
    }
    if (comparePath(lexicalParent) !== identity.canonicalKey
        || comparePath(canonicalParent) !== identity.canonicalKey) {
        throw parentVerificationError(requestedDestination);
    }

    if (identity.device === undefined || identity.inode === undefined) return;
    let metadata: Stats | undefined;
    try {
        metadata = await optionalLstat(identity.canonicalPath, inspectPath);
    } catch (error) {
        throw parentVerificationError(requestedDestination, error);
    }
    const currentIdentity = stableDirectoryIdentity(metadata);
    if (currentIdentity?.device !== identity.device
        || currentIdentity.inode !== identity.inode) {
        throw parentVerificationError(requestedDestination);
    }
}

function stableDirectoryIdentity(
    metadata: Stats | undefined,
): { device: number; inode: number } | undefined {
    if (metadata === undefined || !metadata.isDirectory()) return undefined;
    if (!Number.isSafeInteger(metadata.dev)
        || !Number.isSafeInteger(metadata.ino)
        || (metadata.dev === 0 && metadata.ino === 0)) {
        return undefined;
    }
    return { device: metadata.dev, inode: metadata.ino };
}

function parentVerificationError(
    destination: string,
    cause?: unknown,
): Error {
    const error = new Error(
        `Artifact destination parent changed after validation: ${destination}`,
    ) as Error & { cause?: unknown };
    if (cause !== undefined) error.cause = cause;
    return error;
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
