import { randomBytes } from 'node:crypto';
import {
    link,
    mkdir,
    open,
    readFile,
    rename,
    unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { parseArchDesignRtlMarker } from '@veriflow/schematic-core/arch-design';

export type AtomicGeneratedFileOperations = Readonly<{
    readFile(filepath: string): Promise<string>;
    makeDirectory(directory: string): Promise<void>;
    writeTemporary(filepath: string, text: string): Promise<void>;
    link(source: string, target: string): Promise<void>;
    rename(source: string, target: string): Promise<void>;
    remove(filepath: string): Promise<void>;
}>;

export class GeneratedFileConflictError extends Error {
    readonly code = 'GENERATED_FILE_CONFLICT';
    readonly targetPath: string;

    constructor(targetPath: string) {
        super(`Generated file conflict: ${targetPath}`);
        this.name = 'GeneratedFileConflictError';
        this.targetPath = targetPath;
    }
}

async function writeTemporary(filepath: string, text: string): Promise<void> {
    const handle = await open(filepath, 'wx');
    let failed = false;
    try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        try {
            await handle.close();
        } catch (error) {
            if (!failed) throw error;
        }
    }
}

const DEFAULT_OPERATIONS: AtomicGeneratedFileOperations = Object.freeze({
    readFile: filepath => readFile(filepath, 'utf8'),
    makeDirectory: directory => mkdir(directory, { recursive: true }).then(() => undefined),
    writeTemporary,
    link,
    rename,
    remove: unlink,
});

type TargetInspection =
    | Readonly<{ exists: false }>
    | Readonly<{ exists: true; text: string }>;

function hasErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException).code === code;
}

async function inspectTarget(
    targetPath: string,
    operations: AtomicGeneratedFileOperations
): Promise<TargetInspection> {
    try {
        return { exists: true, text: await operations.readFile(targetPath) };
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { exists: false };
        throw error;
    }
}

function assertGeneratedOwnership(targetPath: string, text: string): void {
    if (parseArchDesignRtlMarker(text) === undefined) {
        throw new GeneratedFileConflictError(targetPath);
    }
}

async function publishWithoutClobber(
    temporaryPath: string,
    targetPath: string,
    operations: AtomicGeneratedFileOperations
): Promise<void> {
    try {
        await operations.link(temporaryPath, targetPath);
    } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) {
            throw new GeneratedFileConflictError(targetPath);
        }
        throw error;
    }
}

function temporaryPathFor(targetPath: string): string {
    const basename = path.basename(targetPath);
    const suffix = randomBytes(16).toString('hex');
    return path.join(path.dirname(targetPath), `${basename}.${process.pid}.${suffix}.tmp`);
}

export async function publishGeneratedFileAtomic(
    targetPath: string,
    text: string,
    operationOverrides: Partial<AtomicGeneratedFileOperations> = {}
): Promise<void> {
    const operations: AtomicGeneratedFileOperations = {
        ...DEFAULT_OPERATIONS,
        ...operationOverrides,
    };
    const initial = await inspectTarget(targetPath, operations);
    if (initial.exists) assertGeneratedOwnership(targetPath, initial.text);

    await operations.makeDirectory(path.dirname(targetPath));
    const temporaryPath = temporaryPathFor(targetPath);
    let temporaryMayExist = false;
    let failed = false;
    try {
        try {
            await operations.writeTemporary(temporaryPath, text);
            temporaryMayExist = true;
        } catch (error) {
            temporaryMayExist = !hasErrorCode(error, 'EEXIST');
            throw error;
        }

        if (!initial.exists) {
            await publishWithoutClobber(temporaryPath, targetPath, operations);
            return;
        }

        const current = await inspectTarget(targetPath, operations);
        if (!current.exists) {
            await publishWithoutClobber(temporaryPath, targetPath, operations);
            return;
        }
        assertGeneratedOwnership(targetPath, current.text);
        await operations.rename(temporaryPath, targetPath);
        temporaryMayExist = false;
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        if (temporaryMayExist) {
            try {
                await operations.remove(temporaryPath);
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT') && !failed) throw error;
            }
        }
    }
}
