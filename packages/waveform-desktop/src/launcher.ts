import { spawn } from 'node:child_process';
import path from 'node:path';

export interface WaveformElectronInvocation {
    executable: string;
    appEntry: string;
    args: string[];
}

export function waveformElectronInvocation(source: string): WaveformElectronInvocation {
    const electronPath = require('electron') as unknown as string;
    const appEntry = path.join(__dirname, 'main.js');
    return {
        executable: electronPath as unknown as string,
        appEntry,
        args: [appEntry, '--waveform', path.resolve(source)],
    };
}

export function launchWaveformWindow(source: string): Promise<void> {
    const invocation = waveformElectronInvocation(source);
    return new Promise((resolve, reject) => {
        const child = spawn(invocation.executable, invocation.args, {
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
