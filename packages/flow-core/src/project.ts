import path from 'node:path';

import { SimulatorConfig, WaveViewerConfig } from './types';

export type JsonObject = Record<string, unknown>;

export interface Project {
    name: string;
    rootDir: string;
    libDirs: string[];
    topModule: string;
    simulator: string;
    waveViewer: string;
    waveFileTemplate: string;
    testbenchOutputDir: string;
    fileOrder: string[];
    simulators: Record<string, SimulatorConfig>;
    waveViewers: Record<string, WaveViewerConfig>;
    interfaceProtocolFiles: string[];
    schematicExtra: JsonObject;
    dependencyResult?: unknown;
    analyzeStatus: string;
    simulateStatus: string;
    extra: JsonObject;
}

export function resolveWaveFile(project: Project): string {
    const configured = project.waveFileTemplate.replace('{top_module}', project.topModule);
    return path.isAbsolute(configured)
        ? configured
        : path.join(project.rootDir, configured);
}

export function resolveTestbenchOutputDir(project: Project): string {
    const configured = project.testbenchOutputDir.trim() || '.';
    return path.isAbsolute(configured)
        ? configured
        : path.join(project.rootDir, configured);
}
