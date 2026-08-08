import { existsSync } from 'node:fs';
import path from 'node:path';

import {
    GlobalConfigStore,
    ProjectStore,
    type Project,
} from '@veriflow/flow-core';
import { DependencyAnalyzer } from '@veriflow/hdl-runtime/dependencyAnalyzer';

import { type CommandEnvironment, type CommandOptions } from './project';
import { NodeWorkspaceHost } from '../runtime/nodeWorkspaceHost';

type AnalysisInput = {
    topModule: string;
    searchDirectories: string[];
    displayRelativeToCwd: boolean;
};

function applyOverrides(
    project: Project,
    options: CommandOptions,
    environment: CommandEnvironment
): boolean {
    let changed = false;
    if (options.top !== undefined) {
        project.topModule = options.top;
        changed = true;
    }
    if (options.lib !== undefined) {
        project.libDirs = options.lib.split(',').map(directory => (
            path.resolve(environment.cwd, directory)
        ));
        changed = true;
    }
    if (options.sim !== undefined) {
        project.simulator = options.sim;
        changed = true;
    }
    if (options.wave !== undefined) {
        project.waveViewer = options.wave;
        changed = true;
    }
    return changed;
}

function existingDirectories(directories: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const directory of directories) {
        const resolved = path.resolve(directory);
        if (existsSync(resolved) && !seen.has(resolved)) {
            seen.add(resolved);
            result.push(resolved);
        }
    }
    return result;
}

function prepareInput(
    options: CommandOptions,
    environment: CommandEnvironment
): AnalysisInput {
    const globalLibraries = new GlobalConfigStore({
        homeDir: environment.homeDir,
    }).getLibDirs();
    if (options.project !== undefined) {
        const filepath = path.resolve(environment.cwd, options.project);
        if (!existsSync(filepath)) {
            throw new Error(`Project file not found: ${options.project}`);
        }
        const store = new ProjectStore();
        const project = store.open(filepath);
        if (applyOverrides(project, options, environment)) {
            store.save(project, filepath, { preserveUnknown: false });
        }
        if (!project.topModule) {
            throw new Error('Top module not set. Use --top or set in project file.');
        }
        return {
            topModule: project.topModule,
            searchDirectories: existingDirectories([
                ...globalLibraries.map(directory => path.resolve(environment.cwd, directory)),
                project.rootDir,
                ...project.libDirs,
            ]),
            displayRelativeToCwd: false,
        };
    }

    if (!options.top) {
        throw new Error('Either --project or --top is required');
    }
    const configuredRoot = options.root ?? '.';
    return {
        topModule: options.top,
        searchDirectories: existingDirectories([
            path.resolve(environment.cwd, configuredRoot),
            ...globalLibraries.map(directory => path.resolve(environment.cwd, directory)),
            ...((options.lib ?? '').split(',').filter(Boolean).map(directory => (
                path.resolve(environment.cwd, directory)
            ))),
        ]),
        displayRelativeToCwd: !path.isAbsolute(configuredRoot),
    };
}

function displayFile(filepath: string, input: AnalysisInput, cwd: string): string {
    if (!input.displayRelativeToCwd || !path.isAbsolute(filepath)) return filepath;
    const relative = path.relative(cwd, filepath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : filepath;
}

export async function analyze(
    options: CommandOptions,
    environment: CommandEnvironment
): Promise<number> {
    const input = prepareInput(options, environment);
    const host = new NodeWorkspaceHost(input.searchDirectories);
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.once('SIGINT', interrupt);
    try {
        await host.scan(controller.signal);
        const result = new DependencyAnalyzer(host.index).resolve(input.topModule);

        environment.stdout(`Top module: ${input.topModule}\n`);
        environment.stdout(`Files (${result.files.length}):\n`);
        for (const filepath of result.files) {
            environment.stdout(`  ${displayFile(filepath, input, environment.cwd)}\n`);
        }
        if (result.missingModules.length > 0) {
            environment.stdout(`\nMissing modules: ${result.missingModules.join(', ')}\n`);
            return 1;
        }
        environment.stdout('\nAnalysis: OK\n');
        return 0;
    } finally {
        process.off('SIGINT', interrupt);
        await host.dispose();
    }
}
