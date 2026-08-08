import { existsSync } from 'node:fs';
import path from 'node:path';

import {
    GlobalConfigStore,
    NativeSimulatorBackend,
    ProjectStore,
    type LogEntry,
    type Project,
    type SimulationExecution,
} from '@veriflow/flow-core';
import { DependencyAnalyzer } from '@veriflow/hdl-runtime/dependencyAnalyzer';

import { type CliEnvironment } from '../main';
import { NodeWorkspaceHost } from '../runtime/nodeWorkspaceHost';
import { type CommandOptions } from './project';

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
    logEntries: LogEntry[]
): SimulationExecution {
    return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr,
        logEntries,
        waveFile: null,
        elapsedTime: 0,
        compileCommand: '',
        runCommand: '',
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

function printResult(result: SimulationExecution, environment: CliEnvironment): number {
    if (result.stdout) printNonEmptyLines(result.stdout, environment);
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
    const host = new NodeWorkspaceHost(searchDirectories);
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.once('SIGINT', interrupt);
    try {
        await host.scan(controller.signal);
        const dependencies = new DependencyAnalyzer(host.index).resolve(project.topModule);
        if (dependencies.missingModules.length > 0) {
            return printResult(failure(
                `Missing modules: ${dependencies.missingModules.join(', ')}`,
                dependencies.missingModules.map(moduleName => ({
                    level: 'ERROR',
                    message: `Module not found: ${moduleName}`,
                }))
            ), environment);
        }

        const simulator = project.simulators[project.simulator];
        if (!simulator) {
            return printResult(failure(
                `Simulator '${project.simulator}' not configured`,
                [{ level: 'ERROR', message: `Unknown simulator: ${project.simulator}` }]
            ), environment);
        }

        const result = await new NativeSimulatorBackend(
            environment.commandExecutor
        ).compileAndRun({
            files: dependencies.files,
            output: path.join(project.rootDir, `${project.topModule}.out`),
            simulator,
            cwd: project.rootDir,
            topModule: project.topModule,
        });
        result.stdout = `[CMD] Compile: ${result.compileCommand}\n${result.stdout}`;
        if (result.success && result.runCommand) {
            result.stdout += `\n[CMD] Run: ${result.runCommand}\n`;
        }
        return printResult(result, environment);
    } finally {
        process.off('SIGINT', interrupt);
        await host.dispose();
    }
}
