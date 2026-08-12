import { randomBytes } from 'crypto';
import {
    link,
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    unlink,
} from 'fs/promises';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
    exportArchDesignRtl,
    parseArchDesignRtlMarker,
    type ArchDesign,
    type ArchDesignDiagnostic,
    type ArchDesignLanguage,
} from '@veriflow/schematic-core/arch-design';
import type { InterfaceProtocolCatalog } from '@veriflow/schematic-core/interfaces';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import { canonicalizeSourceUri } from '../core/hdl/preprocessor';
import { toArchDesignModuleDefinitions } from './editorSupport';

export type ArchDesignExportFileOperations = Readonly<{
    readFile(filepath: string): Promise<string>;
    makeDirectory(directory: string): Promise<void>;
    writeTemporary(filepath: string, text: string): Promise<void>;
    link(source: string, target: string): Promise<void>;
    rename(source: string, target: string): Promise<void>;
    remove(filepath: string): Promise<void>;
}>;

export type ArchDesignFileExportOptions = Partial<ArchDesignExportFileOperations> & Readonly<{
    interfaceCatalog?: InterfaceProtocolCatalog;
}>;

export type ArchDesignFileExportResult =
    | Readonly<{
        status: 'published';
        outputPath: string;
        language: ArchDesignLanguage;
    }>
    | Readonly<{
        status: 'invalid';
        diagnostics: readonly ArchDesignDiagnostic[];
    }>;

export class ArchDesignGeneratedFileConflictError extends Error {
    readonly code = 'AD_GENERATED_FILE_CONFLICT';

    constructor(readonly outputPath: string) {
        super(`Generated file conflict: ${outputPath}`);
        this.name = 'ArchDesignGeneratedFileConflictError';
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

const DEFAULT_FILE_OPERATIONS: ArchDesignExportFileOperations = Object.freeze({
    readFile: filepath => readFile(filepath, 'utf8'),
    makeDirectory: directory => mkdir(directory, { recursive: true }).then(() => undefined),
    writeTemporary,
    link,
    rename,
    remove: unlink,
});

function hasErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException).code === code;
}

async function inspectTarget(
    outputPath: string,
    operations: ArchDesignExportFileOperations
): Promise<{ exists: false } | { exists: true; text: string }> {
    try {
        return { exists: true, text: await operations.readFile(outputPath) };
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { exists: false };
        throw error;
    }
}

function assertGeneratedTarget(outputPath: string, text: string): void {
    if (parseArchDesignRtlMarker(text) === undefined) {
        throw new ArchDesignGeneratedFileConflictError(outputPath);
    }
}

function temporaryPathFor(outputPath: string): string {
    return path.join(
        path.dirname(outputPath),
        `${path.basename(outputPath)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
    );
}

async function publishGeneratedFile(
    outputPath: string,
    text: string,
    operationOverrides: Partial<ArchDesignExportFileOperations>
): Promise<void> {
    const operations: ArchDesignExportFileOperations = {
        ...DEFAULT_FILE_OPERATIONS,
        ...operationOverrides,
    };
    const initial = await inspectTarget(outputPath, operations);
    if (initial.exists) assertGeneratedTarget(outputPath, initial.text);

    await operations.makeDirectory(path.dirname(outputPath));
    const temporaryPath = temporaryPathFor(outputPath);
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

        const publishWithoutClobber = async (): Promise<void> => {
            try {
                await operations.link(temporaryPath, outputPath);
            } catch (error) {
                if (hasErrorCode(error, 'EEXIST')) {
                    throw new ArchDesignGeneratedFileConflictError(outputPath);
                }
                throw error;
            }
        };
        if (!initial.exists) {
            await publishWithoutClobber();
            return;
        }

        const current = await inspectTarget(outputPath, operations);
        if (!current.exists) {
            await publishWithoutClobber();
            return;
        }
        assertGeneratedTarget(outputPath, current.text);
        await operations.rename(temporaryPath, outputPath);
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

function outputPathFor(designPath: string, design: ArchDesign): {
    language: ArchDesignLanguage;
    outputPath: string;
} {
    const language = design.export.language ?? 'verilog';
    const extension = language === 'verilog' ? '.v' : '.sv';
    const outputPath = design.export.output === undefined
        ? path.join(
            path.dirname(designPath),
            `${path.basename(designPath, path.extname(designPath))}${extension}`
        )
        : path.resolve(path.dirname(designPath), design.export.output);
    if (path.extname(outputPath).toLowerCase() !== extension) {
        throw new Error(
            `Output file extension must be ${extension} for ${language}: ${outputPath}`
        );
    }
    return { language, outputPath };
}

function portableSourcePath(designPath: string, outputPath: string): string {
    const relative = path.relative(path.dirname(outputPath), designPath);
    return (path.isAbsolute(relative) ? designPath : relative).replace(/\\/g, '/');
}

function canonicalFileUri(filepath: string): string {
    return canonicalizeSourceUri(pathToFileURL(filepath).toString());
}

async function canonicalPhysicalEntryUri(
    filepath: string
): Promise<string | undefined> {
    try {
        const realParent = await realpath(path.dirname(filepath));
        return canonicalFileUri(path.join(realParent, path.basename(filepath)));
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return undefined;
        throw error;
    }
}

async function excludeOutputDefinitions(
    definitions: readonly HdlDefinitionSummary[],
    outputPath: string
): Promise<HdlDefinitionSummary[]> {
    const outputUri = canonicalFileUri(outputPath);
    let selected = definitions.filter(definition =>
        canonicalizeSourceUri(definition.uri) !== outputUri
    );
    const physicalOutputUri = await canonicalPhysicalEntryUri(outputPath);
    if (physicalOutputUri === undefined) return selected;
    const physicalDefinitionUris = await Promise.all(selected.map(async definition => {
        try {
            return await canonicalPhysicalEntryUri(fileURLToPath(definition.uri));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ERR_INVALID_URL_SCHEME') {
                return undefined;
            }
            throw error;
        }
    }));
    selected = selected.filter(
        (_definition, index) => physicalDefinitionUris[index] !== physicalOutputUri
    );
    return selected;
}

export async function exportArchDesignToFile(
    designPath: string,
    design: ArchDesign,
    definitions: readonly HdlDefinitionSummary[],
    options: ArchDesignFileExportOptions = {}
): Promise<ArchDesignFileExportResult> {
    const { interfaceCatalog, ...operationOverrides } = options;
    const resolvedDesignPath = path.resolve(designPath);
    const { language, outputPath } = outputPathFor(resolvedDesignPath, design);
    const selectedDefinitions = await excludeOutputDefinitions(definitions, outputPath);
    const exportDefinitions = toArchDesignModuleDefinitions(
        selectedDefinitions
    );
    const generated = exportArchDesignRtl(design, exportDefinitions, {
        language,
        sourcePath: portableSourcePath(resolvedDesignPath, outputPath),
        ...(interfaceCatalog === undefined ? {} : { interfaceCatalog }),
    });
    if (generated.status === 'invalid') {
        return Object.freeze({
            status: 'invalid',
            diagnostics: generated.diagnostics,
        });
    }

    await publishGeneratedFile(outputPath, generated.text, operationOverrides);
    return Object.freeze({ status: 'published', outputPath, language });
}
