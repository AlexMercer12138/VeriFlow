import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { GlobalConfigStore, ProjectStore } from '@veriflow/flow-core';
import {
    parseArchDesignText,
    validateArchDesign,
    type ArchDesign,
    type ArchDesignDiagnostic,
} from '@veriflow/schematic-core/arch-design';

import type { CommandEnvironment, CommandOptions } from './project';
import { NodeWorkspaceHost } from '../runtime/nodeWorkspaceHost';

type LoadedArchDesign = {
    filepath: string;
    displayPath: string;
    design: ArchDesign;
};

function normalizePathSeparators(filepath: string): string {
    return filepath.replace(/\\/g, '/');
}

function displayPath(filepath: string, cwd: string): string {
    const relative = path.relative(cwd, filepath);
    const isInsideCwd = relative === '' || (
        relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
    );
    return normalizePathSeparators(isInsideCwd ? relative || '.' : filepath);
}

function printDiagnostics(
    environment: CommandEnvironment,
    designPath: string,
    diagnostics: readonly ArchDesignDiagnostic[]
): void {
    for (const diagnostic of diagnostics) {
        environment.stderr(
            `${designPath}:${diagnostic.path} [${diagnostic.code}] ${diagnostic.message}\n`
        );
    }
}

async function loadArchDesign(
    options: CommandOptions,
    environment: CommandEnvironment
): Promise<LoadedArchDesign | undefined> {
    const filepath = path.resolve(environment.cwd, options.design!);
    const shownPath = displayPath(filepath, environment.cwd);
    let source: string;
    try {
        source = await readFile(filepath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`Arch Design file not found: ${shownPath}`);
        }
        throw error;
    }

    const parsed = parseArchDesignText(source);
    if (parsed.status === 'invalid') {
        printDiagnostics(environment, shownPath, parsed.diagnostics);
        return undefined;
    }
    if (parsed.status === 'unsupported') {
        printDiagnostics(environment, shownPath, [{
            path: '$.schemaVersion',
            code: 'AD_SCHEMA_UNSUPPORTED',
            message: `Arch Design schema version ${parsed.schemaVersion} is not supported`,
        }]);
        return undefined;
    }
    return { filepath, displayPath: shownPath, design: parsed.design };
}

function isDirectory(filepath: string): boolean {
    try {
        return statSync(filepath).isDirectory();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
    }
}

function existingDirectories(candidates: readonly string[]): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved) || !isDirectory(resolved)) continue;
        seen.add(resolved);
        roots.push(resolved);
    }
    return roots;
}

function moduleCatalogRoots(
    loaded: LoadedArchDesign,
    options: CommandOptions,
    environment: CommandEnvironment
): string[] {
    const globalLibraries = new GlobalConfigStore({
        homeDir: environment.homeDir,
    }).getLibDirs().map(directory => path.resolve(environment.cwd, directory));
    const commandLibraries = (options.lib ?? '').split(',').filter(Boolean).map(directory => (
        path.resolve(environment.cwd, directory)
    ));

    if (options.project !== undefined) {
        const projectPath = path.resolve(environment.cwd, options.project);
        if (!existsSync(projectPath)) {
            throw new Error(`Project file not found: ${options.project}`);
        }
        const project = new ProjectStore().open(projectPath);
        return existingDirectories([
            project.rootDir,
            ...project.libDirs,
            ...globalLibraries,
            ...commandLibraries,
        ]);
    }

    return existingDirectories([
        path.dirname(loaded.filepath),
        ...globalLibraries,
        ...commandLibraries,
    ]);
}

async function scanModuleDefinitions(roots: string[]) {
    const host = new NodeWorkspaceHost(roots);
    try {
        const controller = new AbortController();
        const interrupt = (): void => controller.abort();
        process.once('SIGINT', interrupt);
        try {
            await host.scan(controller.signal);
        } finally {
            process.off('SIGINT', interrupt);
        }
        return host.index.getAllDefinitions('module');
    } finally {
        await host.dispose();
    }
}

export async function adValidate(
    options: CommandOptions,
    environment: CommandEnvironment
): Promise<number> {
    const loaded = await loadArchDesign(options, environment);
    if (!loaded) return 1;

    const definitions = await scanModuleDefinitions(
        moduleCatalogRoots(loaded, options, environment)
    );
    const validation = validateArchDesign(loaded.design, definitions);
    if (!validation.valid) {
        printDiagnostics(environment, loaded.displayPath, validation.diagnostics);
        return 1;
    }
    environment.stdout('Arch Design: OK\n');
    return 0;
}

export function adExport(
    _options: CommandOptions,
    _environment: CommandEnvironment
): never {
    throw new Error('Arch Design command is not implemented');
}
