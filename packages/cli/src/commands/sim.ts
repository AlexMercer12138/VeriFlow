import { existsSync } from 'node:fs';
import path from 'node:path';

import {
    createSimulationRequest,
    GlobalConfigStore,
    ProjectStore,
    resolveWaveFile,
    type DependencyResult,
    type LogEntry,
    type NormalizedSimulationExecution,
    type Project,
} from '@veriflow/flow-core';
import { DependencyAnalyzer } from '@veriflow/hdl-runtime/dependencyAnalyzer';

import { type CliEnvironment } from '../main';
import { NodeWorkspaceHost } from '../runtime/nodeWorkspaceHost';
import { createCliSimulationBackends } from '../runtime/simulationBackends';
import { type CommandOptions } from './project';

export interface CliDependencySession {
    scan(topModule: string, signal: AbortSignal): Promise<DependencyResult>;
    dispose(): Promise<void>;
}

export type CliDependencySessionFactory = (
    searchDirectories: string[],
    defines: Record<string, string | true>,
) => CliDependencySession;

function createDependencySession(
    searchDirectories: string[],
    defines: Record<string, string | true>,
): CliDependencySession {
    const host = new NodeWorkspaceHost(searchDirectories, defines);
    return {
        async scan(topModule, signal) {
            await host.scan(signal);
            return new DependencyAnalyzer(host.index).resolve(topModule);
        },
        dispose: () => host.dispose(),
    };
}

function applyOverrides(
    project: Project,
    options: CommandOptions,
    environment: CliEnvironment
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
    return directories.flatMap(directory => {
        const resolved = path.resolve(directory);
        if (!existsSync(resolved) || seen.has(resolved)) return [];
        seen.add(resolved);
        return [resolved];
    });
}

function failure(
    stderr: string,
    logEntries: LogEntry[],
    backendId: string,
): NormalizedSimulationExecution {
    return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr,
        logEntries,
        waveFile: null,
        elapsedTime: 0,
        backendId,
        stage: 'input',
        timings: {},
        commands: {},
        artifacts: [],
    };
}

function printNonEmptyLines(
    text: string,
    environment: CliEnvironment,
    prefix = ''
): void {
    for (const line of text.split(/\r?\n/)) {
        if (line.trim()) environment.stdout(`${prefix}${line}\n`);
    }
}

function printResult(
    result: NormalizedSimulationExecution,
    environment: CliEnvironment,
    logCommands = false,
): number {
    if (logCommands && result.commands.compile) {
        environment.stdout(`[CMD] Compile: ${result.commands.compile}\n`);
    }
    if (result.stdout) printNonEmptyLines(result.stdout, environment);
    if (logCommands && result.success && result.commands.run) {
        environment.stdout(`[CMD] Run: ${result.commands.run}\n`);
    }
    if (result.stderr && !result.success) {
        printNonEmptyLines(result.stderr, environment, '  ');
    }
    if (result.success) {
        environment.stdout(`\nSimulation: OK (${result.elapsedTime.toFixed(2)}s)\n`);
        return 0;
    }

    environment.stdout(`\nSimulation: FAILED (exit=${result.exitCode})\n`);
    const errors = result.logEntries.filter(entry => entry.level === 'ERROR');
    if (errors.length > 0) {
        environment.stdout('Errors:\n');
        for (const entry of errors) {
            const location = entry.fileRef ? `${entry.fileRef}:${entry.lineNo}` : '';
            environment.stdout(`  [${entry.level}] ${location} ${entry.message}\n`);
        }
    }
    return 1;
}

function parserDefines(
    defines: Project['defines'],
): Record<string, string | true> {
    return Object.fromEntries(Object.entries(defines).map(([name, value]) => [
        name,
        value === true ? true : String(value),
    ]));
}

function workspaceRelativePath(root: string, filepath: string): string {
    return path.relative(root, filepath).split(path.sep).join('/');
}

export async function simulate(
    options: CommandOptions,
    environment: CliEnvironment
): Promise<number> {
    const filepath = path.resolve(environment.cwd, options.project!);
    if (!existsSync(filepath)) {
        throw new Error(`Project file not found: ${options.project}`);
    }
    const store = new ProjectStore();
    const project = store.open(filepath);
    if (applyOverrides(project, options, environment)) {
        store.save(project, filepath, { preserveUnknown: false });
    }
    if (!project.topModule) throw new Error('Top module not set in project.');

    environment.stdout(`Simulating: ${project.topModule}\n`);
    environment.stdout(`Simulator: ${project.simulator}\n`);
    environment.stdout(`Wave viewer: ${project.waveViewer}\n`);

    const globalLibraries = new GlobalConfigStore({
        homeDir: environment.homeDir,
    }).getLibDirs();
    const searchDirectories = existingDirectories([
        project.rootDir,
        ...globalLibraries.map(directory => path.resolve(environment.cwd, directory)),
        ...project.libDirs,
    ]);
    const dependencySession = (
        environment.dependencySessionFactory ?? createDependencySession
    )(searchDirectories, parserDefines(project.defines));
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.on('SIGINT', interrupt);
    try {
        const dependencies = await dependencySession.scan(
            project.topModule,
            controller.signal,
        );
        if (dependencies.missingModules.length > 0) {
            return printResult(failure(
                `Missing modules: ${dependencies.missingModules.join(', ')}`,
                dependencies.missingModules.map(moduleName => ({
                    level: 'ERROR',
                    message: `Module not found: ${moduleName}`,
                })),
                project.simulator,
            ), environment);
        }

        const waveFile = resolveWaveFile(project);
        const request = createSimulationRequest({
            files: dependencies.files,
            runtimeFiles: project.simulationFiles,
            includeDirs: searchDirectories,
            defines: project.defines,
            plusargs: [],
            artifacts: [{
                kind: 'vcd',
                path: workspaceRelativePath(project.rootDir, waveFile),
                destination: waveFile,
                required: false,
            }],
            output: path.join(project.rootDir, `${project.topModule}.out`),
            cwd: project.rootDir,
            topModule: project.topModule,
            timeoutMs: 300_000,
            signal: controller.signal,
        });
        const registry = createCliSimulationBackends(project, {
            ...environment.simulationBackendOptions,
            commandExecutor: environment.commandExecutor,
        });
        const result = await registry.run(project.simulator, request);
        return printResult(
            result,
            environment,
            project.simulator !== 'builtin' && project.simulator !== 'experimental-ts',
        );
    } finally {
        try {
            await dependencySession.dispose();
        } finally {
            process.off('SIGINT', interrupt);
        }
    }
}
