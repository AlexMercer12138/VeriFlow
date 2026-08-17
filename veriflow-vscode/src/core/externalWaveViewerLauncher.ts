import * as childProcess from 'child_process';

import type { WaveViewerConfig } from './types';
import { TemplateEngine } from './templateEngine';

export interface ExternalWaveViewerLauncherOptions {
    launchCommand?: (
        command: string,
        options: childProcess.ExecOptions
    ) => void;
}

export class ExternalWaveViewerLauncher {
    private readonly launchCommand: (
        command: string,
        options: childProcess.ExecOptions
    ) => void;

    constructor(options: ExternalWaveViewerLauncherOptions = {}) {
        this.launchCommand = options.launchCommand ?? ((command, execOptions) => {
            childProcess.exec(command, execOptions);
        });
    }

    async launch(waveFile: string, viewer: WaveViewerConfig): Promise<void> {
        const command = TemplateEngine.renderWave(viewer.launchCmd, waveFile);
        this.launchCommand(command, { windowsHide: false });
    }
}
