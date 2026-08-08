import { existsSync } from 'node:fs';
import path from 'node:path';

import {
    ProjectStore,
    resolveWaveFile,
    TemplateEngine,
} from '@veriflow/flow-core';

import type { CliEnvironment } from '../main';
import type { CommandOptions } from './project';

export interface WaveViewerLauncher {
    openBuiltin(waveFile: string): Promise<void>;
    openExternal(command: string, cwd: string): Promise<void>;
}

export async function openWaveform(
    options: CommandOptions,
    environment: CliEnvironment
): Promise<number> {
    const projectPath = path.resolve(environment.cwd, options.project!);
    if (!existsSync(projectPath)) {
        throw new Error(`Project file not found: ${options.project}`);
    }
    const project = new ProjectStore().open(projectPath);
    if (!project.topModule) throw new Error('Top module not set in project.');

    const waveFile = resolveWaveFile(project);
    if (!existsSync(waveFile)) throw new Error(`Wave file not found: ${waveFile}`);

    const viewer = project.waveViewers[project.waveViewer];
    if (!viewer) throw new Error(`Wave viewer '${project.waveViewer}' not configured`);
    if (!environment.waveViewerLauncher) {
        throw new Error('Wave viewer launcher is unavailable');
    }

    environment.stdout(`Opening wave file: ${waveFile}\n`);
    if (project.waveViewer === 'builtin') {
        await environment.waveViewerLauncher.openBuiltin(waveFile);
    } else {
        await environment.waveViewerLauncher.openExternal(
            TemplateEngine.renderWave(viewer.launchCmd, waveFile),
            environment.cwd
        );
    }
    environment.stdout(`Wave viewer launched: ${project.waveViewer}\n`);
    return 0;
}
