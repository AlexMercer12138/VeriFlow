import { existsSync } from 'node:fs';
import path from 'node:path';

import { GlobalConfigStore, Project, ProjectStore } from '@veriflow/flow-core';

export interface CommandEnvironment {
    cwd: string;
    homeDir: string;
    stdout(text: string): void;
    stderr(text: string): void;
}

export type CommandOptions = Record<string, string | undefined>;

function projectPath(environment: CommandEnvironment, filepath: string): string {
    return path.resolve(environment.cwd, filepath);
}

function openProject(
    store: ProjectStore,
    environment: CommandEnvironment,
    filepath: string
): Project {
    const resolved = projectPath(environment, filepath);
    if (!existsSync(resolved)) {
        throw new Error(`Project file not found: ${filepath}`);
    }
    return store.open(resolved);
}

function writeLine(environment: CommandEnvironment, text: string): void {
    environment.stdout(`${text}\n`);
}

export function projectNew(
    options: CommandOptions,
    environment: CommandEnvironment
): number {
    const store = new ProjectStore();
    const name = options.name!;
    const project = store.create(name, path.resolve(environment.cwd, options.root ?? '.'));

    if (options.top !== undefined) project.topModule = options.top;
    if (options.lib !== undefined) {
        project.libDirs = options.lib.split(',').map(directory => (
            path.resolve(environment.cwd, directory)
        ));
    }
    if (options.sim !== undefined) project.simulator = options.sim;
    if (options.wave !== undefined) project.waveViewer = options.wave;

    const output = options.output ?? `${project.name}.json`;
    store.save(project, projectPath(environment, output));
    writeLine(environment, `Project created: ${output}`);
    return 0;
}

export function projectOpen(
    options: CommandOptions,
    environment: CommandEnvironment
): number {
    const project = openProject(new ProjectStore(), environment, options.project!);
    writeLine(environment, `Project: ${project.name}`);
    writeLine(environment, `Root: ${project.rootDir}`);
    writeLine(environment, `Top: ${project.topModule || '(not set)'}`);
    writeLine(environment, `Simulator: ${project.simulator}`);
    writeLine(environment, `Wave viewer: ${project.waveViewer}`);
    writeLine(environment, `Lib dirs: ${project.libDirs.join(', ') || '(none)'}`);
    return 0;
}

function addSearchDirectory(
    entries: Array<[string, string]>,
    seen: Set<string>,
    directory: string,
    label: string
): void {
    const resolved = path.resolve(directory);
    if (!existsSync(resolved) || seen.has(resolved)) return;
    seen.add(resolved);
    entries.push([resolved, label]);
}

export function projectShow(
    options: CommandOptions,
    environment: CommandEnvironment
): number {
    const project = openProject(new ProjectStore(), environment, options.project!);
    const globalLibs = new GlobalConfigStore({ homeDir: environment.homeDir }).getLibDirs();

    writeLine(environment, `=== Project: ${project.name} ===`);
    writeLine(environment, `Root: ${project.rootDir}`);
    writeLine(environment, `Top module: ${project.topModule || '(not set)'}`);
    writeLine(environment, `Simulator: ${project.simulator}`);
    writeLine(environment, `Wave viewer: ${project.waveViewer}`);

    writeLine(environment, `\nGlobal lib dirs (${globalLibs.length}):`);
    if (globalLibs.length === 0) {
        writeLine(environment, '  (none)');
    } else {
        for (const directory of globalLibs) writeLine(environment, `  - ${directory}`);
    }

    writeLine(environment, `\nProject lib dirs (${project.libDirs.length}):`);
    if (project.libDirs.length === 0) {
        writeLine(environment, '  (none)');
    } else {
        for (const directory of project.libDirs) writeLine(environment, `  - ${directory}`);
    }

    const searchDirectories: Array<[string, string]> = [];
    const seen = new Set<string>();
    addSearchDirectory(searchDirectories, seen, project.rootDir, 'Project Root');
    for (const directory of globalLibs) {
        addSearchDirectory(
            searchDirectories,
            seen,
            path.resolve(environment.cwd, directory),
            `Global: ${directory}`
        );
    }
    for (const directory of project.libDirs) {
        addSearchDirectory(searchDirectories, seen, directory, `Project: ${directory}`);
    }

    writeLine(environment, '\nSearch dirs (all):');
    for (const [directory, label] of searchDirectories) {
        writeLine(environment, `  [${label}] ${directory}`);
    }
    return 0;
}
