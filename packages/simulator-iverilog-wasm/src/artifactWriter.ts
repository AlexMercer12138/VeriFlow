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
    const protectedVirtualPaths = new Set(
        (options.protectedVirtualPaths ?? []).map(validateArtifactPath),
    );
    const protectedHostPaths = new Set(
        (options.protectedHostPaths ?? []).map(
            hostPath => normalizeDestination(hostPath, options.cwd),
        ),
    );
    const artifactPaths = new Set<string>();
    const destinations = new Set<string>();

    const validated = requests.map(request => {
        const artifactPath = validateArtifactPath(request.path);
        const destination = normalizeDestination(request.destination, options.cwd);
        if (artifactPaths.has(artifactPath)) {
            throw new Error(`Duplicate artifact path: ${artifactPath}`);
        }
        if (destinations.has(destination)) {
            throw new Error(`Duplicate artifact destination: ${request.destination}`);
        }
        for (const sourcePath of protectedVirtualPaths) {
            if (pathsConflict(artifactPath, sourcePath)) {
                throw new Error(`Artifact path aliases a source path: ${artifactPath}`);
            }
        }
        if (protectedHostPaths.has(destination)) {
            throw new Error(
                `Artifact destination aliases a source destination: ${request.destination}`,
            );
        }
        artifactPaths.add(artifactPath);
        destinations.add(destination);
        return { request, artifactPath, destination };
    });

    throwIfAborted(options.signal);

    const produced = validated.filter(entry => artifacts.has(entry.artifactPath));
    const canonicalProtectedPaths = new Set(await Promise.all(
        [...protectedHostPaths].map(hostPath => canonicalExistingPath(
            hostPath,
            canonicalizePath,
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
            } finally {
                if (!closed) await handle.close().catch(() => {});
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
            await movePath(artifact.tempPath, artifact.destination);
        }
    } catch (error) {
        await Promise.all(temporaryPaths.map(tempPath => (
            removePath(tempPath).catch(() => {})
        )));
        throw error;
    }

    const resultByPath = new Map(
        staged.map(artifact => [artifact.request.path, artifact]),
    );
    return requests.map(request => {
        const artifact = resultByPath.get(request.path);
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
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
): Promise<string> {
    try {
        return destinationKey(await canonicalizePath(hostPath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return destinationKey(hostPath);
        }
        throw error;
    }
}

async function canonicalArtifactDestination(
    destination: string,
    exists: boolean,
    canonicalizePath: (hostPath: string) => Promise<string>,
): Promise<string> {
    if (exists) return destinationKey(await canonicalizePath(destination));
    const parent = await canonicalizePath(path.dirname(destination));
    return destinationKey(path.join(parent, path.basename(destination)));
}

function destinationKey(hostPath: string): string {
    const normalized = path.normalize(hostPath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const error = new Error('Artifact writing aborted');
    error.name = 'AbortError';
    throw error;
}
