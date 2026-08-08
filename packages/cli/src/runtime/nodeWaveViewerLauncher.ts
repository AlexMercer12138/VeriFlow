import { spawn } from 'node:child_process';

import { launchWaveformWindow } from '@veriflow/waveform-desktop';

import type { WaveViewerLauncher } from '../commands/wave';

export class NodeWaveViewerLauncher implements WaveViewerLauncher {
    openBuiltin(waveFile: string): Promise<void> {
        return launchWaveformWindow(waveFile);
    }

    openExternal(command: string, cwd: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, {
                cwd,
                shell: true,
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.once('error', reject);
            child.once('spawn', () => {
                child.unref();
                resolve();
            });
        });
    }
}
