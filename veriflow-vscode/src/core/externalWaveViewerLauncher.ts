import * as childProcess from 'child_process';

import type { WaveViewerConfig } from './types';
import { TemplateEngine } from './templateEngine';

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 500;

export interface WaveViewerChildProcess {
    once(event: 'spawn', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(
        event: 'exit' | 'close',
        listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): this;
    removeListener(event: 'spawn', listener: () => void): this;
    removeListener(event: 'error', listener: (error: Error) => void): this;
    removeListener(
        event: 'exit' | 'close',
        listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): this;
}

export interface WaveViewerLaunchScheduler<Handle = NodeJS.Timeout> {
    schedule(callback: () => void, delayMs: number): Handle;
    cancel(handle: Handle): void;
}

export interface ExternalWaveViewerLauncherOptions<Handle = NodeJS.Timeout> {
    launchCommand?: (
        command: string,
        options: childProcess.ExecOptions
    ) => WaveViewerChildProcess;
    confirmationTimeoutMs?: number;
    scheduler?: WaveViewerLaunchScheduler<Handle>;
}

export class ExternalWaveViewerLauncher<Handle = NodeJS.Timeout> {
    private readonly launchCommand: (
        command: string,
        options: childProcess.ExecOptions
    ) => WaveViewerChildProcess;
    private readonly confirmationTimeoutMs: number;
    private readonly scheduler: WaveViewerLaunchScheduler<Handle>;

    constructor(options: ExternalWaveViewerLauncherOptions<Handle> = {}) {
        this.launchCommand = options.launchCommand ?? ((command, execOptions) => {
            return childProcess.exec(command, execOptions);
        });
        this.confirmationTimeoutMs = options.confirmationTimeoutMs
            ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
        this.scheduler = options.scheduler ?? {
            schedule: (callback, delayMs) => setTimeout(callback, delayMs) as Handle,
            cancel: handle => clearTimeout(handle as NodeJS.Timeout),
        };
    }

    async launch(waveFile: string, viewer: WaveViewerConfig): Promise<void> {
        const command = TemplateEngine.renderWave(viewer.launchCmd, waveFile);
        const child = this.launchCommand(command, { windowsHide: false });
        await new Promise<void>((resolve, reject) => {
            let confirmation: Handle | undefined;
            let settled = false;
            const cleanup = (): void => {
                child.removeListener('spawn', onSpawn);
                child.removeListener('error', onError);
                child.removeListener('exit', onExit);
                child.removeListener('close', onClose);
                if (confirmation !== undefined) {
                    this.scheduler.cancel(confirmation);
                    confirmation = undefined;
                }
            };
            const settle = (error?: Error): void => {
                if (settled) { return; }
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            const onSpawn = (): void => {
                confirmation = this.scheduler.schedule(
                    () => {
                        confirmation = undefined;
                        settle();
                    },
                    this.confirmationTimeoutMs
                );
            };
            const onError = (error: Error): void => {
                settle(error);
            };
            const onTermination = (
                code: number | null,
                signal: NodeJS.Signals | null
            ): void => {
                if (code === 0 && signal === null) {
                    settle();
                    return;
                }
                const detail = code === null
                    ? `with signal ${signal ?? 'unknown'}`
                    : `with code ${code}`;
                settle(new Error(`Wave viewer exited ${detail}`));
            };
            const onExit = onTermination;
            const onClose = onTermination;
            child.once('spawn', onSpawn);
            child.once('error', onError);
            child.once('exit', onExit);
            child.once('close', onClose);
        });
    }
}
