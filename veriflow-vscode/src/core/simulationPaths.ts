import * as path from 'path';
import { DependencyResult } from './types';

export interface SimulationPaths {
    cwd: string;
    outputFile: string;
    waveFile: string;
}

function resolveTopModuleDir(root: string, topModule: string, depResult?: DependencyResult | null): string {
    const topFile = depResult?.moduleMap?.[topModule];
    return topFile ? path.dirname(topFile) : root;
}

function resolveFromDir(baseDir: string, filepath: string): string {
    return path.isAbsolute(filepath) ? filepath : path.join(baseDir, filepath);
}

export function resolveSimulationPaths(
    root: string,
    topModule: string,
    depResult: DependencyResult | null | undefined,
    waveFileTemplate: string
): SimulationPaths {
    const cwd = resolveTopModuleDir(root, topModule, depResult);
    const wavePath = (waveFileTemplate || '{top_module}.vcd').replace('{top_module}', topModule);
    return {
        cwd,
        outputFile: path.join(cwd, `${topModule}.out`),
        waveFile: resolveFromDir(cwd, wavePath),
    };
}
