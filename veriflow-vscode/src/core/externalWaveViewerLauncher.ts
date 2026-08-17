import * as childProcess from 'child_process';

import type { WaveViewerConfig } from './types';
import { TemplateEngine } from './templateEngine';

export interface WaveViewerChildProcess {
    once(event: 'spawn', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    removeListener(event: 'spawn', listener: () => void): this;
    removeListener(event: 'error', listener: (error: Error) => void): this;
}

export interface ExternalWaveViewerLauncherOptions {
    launchCommand?: (
        command: string,
        options: childProcess.ExecOptions
    ) => WaveViewerChildProcess;
}

export class ExternalWaveViewerLauncher {
    private readonly launchCommand: (
        command: string,
        options: childProcess.ExecOptions
    ) => WaveViewerChildProcess;

    constructor(options: ExternalWaveViewerLauncherOptions = {}) {
        this.launchCommand = options.launchCommand ?? ((command, execOptions) => {
            return childProcess.exec(command, execOptions);
        });
    }

    async launch(waveFile: string, viewer: WaveViewerConfig): Promise<void> {
        const command = TemplateEngine.renderWave(viewer.launchCmd, waveFile);
        const child = this.launchCommand(command, { windowsHide: false });
        await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
                child.removeListener('spawn', onSpawn);
                child.removeListener('error', onError);
            };
            const onSpawn = (): void => {
                cleanup();
                resolve();
            };
            const onError = (error: Error): void => {
                cleanup();
                reject(error);
            };
            child.once('spawn', onSpawn);
            child.once('error', onError);
        });
    }
}
