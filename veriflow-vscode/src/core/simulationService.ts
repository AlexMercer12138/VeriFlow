import * as path from 'path';
import { lstat } from 'fs/promises';

import {
    ConfiguredNativeSimulatorBackend,
    DEFAULT_SIMULATORS,
    SimulatorBackendRegistry,
    createSimulationRequest,
    type CommandExecutor,
    type NormalizedSimulationExecution,
    type SimulatorBackend,
    type SimulatorBackendProvider,
    type SimulatorConfig,
} from '@veriflow/flow-core';
import { IverilogWasmBackend } from '@veriflow/simulator-iverilog-wasm';

const DEFAULT_TIMEOUT_MS = 300_000;

export const EXPERIMENTAL_TS_UNAVAILABLE = (
    'experimental-ts is not available in this build; no fallback was attempted'
);

export const SIMULATION_BACKEND_IDS = [
    'builtin',
    'native-iverilog',
    'experimental-ts',
    'iverilog',
    'vcs',
    'xsim',
    'custom',
] as const;

export type SimulationBackendId = typeof SIMULATION_BACKEND_IDS[number];

export interface SimulationBackendSettings {
    simulatorCompileCmd: string;
    simulatorRunCmd: string;
}

export interface SimulationBackendRegistryOptions {
    commandExecutor?: CommandExecutor;
    builtinProvider?: SimulatorBackendProvider;
    nativeBackendFactory?: (
        id: string,
        simulator: SimulatorConfig,
        commandExecutor?: CommandExecutor,
    ) => SimulatorBackend;
}

export function createSimulationBackendRegistry(
    settings: SimulationBackendSettings,
    options: SimulationBackendRegistryOptions = {}
): SimulatorBackendRegistry {
    const registry = new SimulatorBackendRegistry();
    registry.register(
        'builtin',
        options.builtinProvider ?? (() => new IverilogWasmBackend())
    );
    registry.register('experimental-ts', () => {
        throw new Error(EXPERIMENTAL_TS_UNAVAILABLE);
    });

    const simulators: Record<'native-iverilog' | 'iverilog' | 'vcs' | 'xsim' | 'custom', SimulatorConfig> = {
        'native-iverilog': DEFAULT_SIMULATORS['native-iverilog'],
        iverilog: DEFAULT_SIMULATORS.iverilog,
        vcs: DEFAULT_SIMULATORS.vcs,
        xsim: DEFAULT_SIMULATORS.xsim,
        custom: {
            name: 'custom',
            compileCmd: settings.simulatorCompileCmd,
            runCmd: settings.simulatorRunCmd,
        },
    };
    for (const [id, simulator] of Object.entries(simulators)) {
        registry.register(id, () => (
            options.nativeBackendFactory?.(
                id,
                simulator,
                options.commandExecutor
            ) ?? new ConfiguredNativeSimulatorBackend(
                id,
                simulator,
                options.commandExecutor
            )
        ));
    }
    return registry;
}

export interface CancellationTokenLike {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface SimulationServiceRunInput {
    backendId: string;
    workspaceRoot: string;
    topModule: string;
    files: readonly string[];
    libDirs: readonly string[];
    defines: Readonly<Record<string, string | number | boolean>>;
    waveFile?: string;
    timeoutMs?: number;
    simulatorCompileCmd?: string;
    simulatorRunCmd?: string;
}

export interface SimulationServiceRunResult {
    runId: number;
    execution: NormalizedSimulationExecution;
}

export interface SimulationServiceOptions extends SimulationBackendRegistryOptions {
    registryFactory?: (
        settings: SimulationBackendSettings
    ) => SimulatorBackendRegistry;
    artifactLstat?: WaveArtifactLstat;
}

export interface WaveArtifactFileStatus {
    isFile(): boolean;
    isSymbolicLink(): boolean;
}

export type WaveArtifactLstat = (
    targetPath: string
) => Promise<WaveArtifactFileStatus>;

type ActiveRun = {
    runId: number;
    controller: AbortController;
    promise: Promise<NormalizedSimulationExecution>;
};

export class SimulationService {
    private readonly registryFactory: (
        settings: SimulationBackendSettings
    ) => SimulatorBackendRegistry;
    private readonly artifactLstat: WaveArtifactLstat;
    private activeRun: ActiveRun | undefined;
    private readonly inFlightRuns = new Set<ActiveRun>();
    private latestRunId = 0;
    private disposed = false;
    private disposePromise: Promise<void> | undefined;

    constructor(options: SimulationServiceOptions = {}) {
        this.registryFactory = options.registryFactory ?? (settings => (
            createSimulationBackendRegistry(settings, options)
        ));
        this.artifactLstat = options.artifactLstat ?? lstat;
    }

    get activeRunId(): number | undefined {
        return this.activeRun?.runId;
    }

    isCurrentRun(runId: number): boolean {
        return !this.disposed && runId === this.latestRunId;
    }

    run(
        input: SimulationServiceRunInput,
        token?: CancellationTokenLike
    ): Promise<SimulationServiceRunResult> {
        if (this.disposed) {
            return Promise.reject(new Error('Simulation service is disposed'));
        }

        const runId = ++this.latestRunId;
        this.activeRun?.controller.abort();
        const controller = new AbortController();
        if (token?.isCancellationRequested) {
            controller.abort();
        }
        let cancellationListener: { dispose(): void } | undefined;
        const executionPromise = Promise.resolve().then(async () => {
            cancellationListener = token?.onCancellationRequested(
                () => controller.abort()
            );
            if (token?.isCancellationRequested) {
                controller.abort();
            }
            const artifact = input.waveFile === undefined ? undefined : {
                kind: 'vcd' as const,
                path: input.backendId === 'builtin'
                    ? toWorkspaceRelativePosixPath(input.workspaceRoot, input.waveFile)
                    : toSimulationArtifactPosixPath(input.workspaceRoot, input.waveFile),
                destination: input.waveFile,
                required: false,
            };
            if (input.waveFile !== undefined) {
                await validateWaveArtifactDestination(input.waveFile, this.artifactLstat);
            }
            const request = createSimulationRequest({
                files: input.files,
                runtimeFiles: [],
                includeDirs: resolveIncludeDirs(input.workspaceRoot, input.libDirs),
                defines: input.defines,
                plusargs: [],
                artifacts: artifact === undefined ? [] : [artifact],
                output: path.join(input.workspaceRoot, `${input.topModule}.out`),
                cwd: input.workspaceRoot,
                topModule: input.topModule,
                timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                signal: controller.signal,
            });
            const registry = this.registryFactory({
                simulatorCompileCmd: input.simulatorCompileCmd ?? '',
                simulatorRunCmd: input.simulatorRunCmd ?? '',
            });
            const execution = await registry.run(input.backendId, request);
            return controller.signal.aborted ? {
                ...execution,
                success: false,
                cause: {
                    code: 'ABORTED',
                    message: execution.cause?.message ?? 'Simulation cancelled',
                },
            } : execution;
        });
        const owner: ActiveRun = { runId, controller, promise: executionPromise };
        const promise = executionPromise.finally(() => {
            try {
                cancellationListener?.dispose();
            } finally {
                this.inFlightRuns.delete(owner);
                if (this.activeRun === owner) {
                    this.activeRun = undefined;
                }
            }
        });
        owner.promise = promise;
        this.activeRun = owner;
        this.inFlightRuns.add(owner);

        return promise.then(execution => ({ runId, execution }));
    }

    dispose(): Promise<void> {
        if (this.disposePromise) {
            return this.disposePromise;
        }
        this.disposed = true;
        this.latestRunId++;
        const runs = [...this.inFlightRuns];
        for (const run of runs) {
            run.controller.abort();
        }
        this.disposePromise = Promise.allSettled(
            runs.map(run => run.promise)
        ).then(() => undefined);
        return this.disposePromise;
    }
}

export async function validateWaveArtifactDestination(
    targetPath: string,
    inspect: WaveArtifactLstat = lstat
): Promise<void> {
    let status: WaveArtifactFileStatus;
    try {
        status = await inspect(targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
    if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(
            `Waveform artifact destination must be a regular file when it exists: ${targetPath}`
        );
    }
}

export function toWorkspaceRelativePosixPath(
    workspaceRoot: string,
    targetPath: string
): string {
    const relative = toSimulationArtifactPosixPath(workspaceRoot, targetPath);
    if (relative === '..'
        || relative.startsWith('../')
        || path.posix.isAbsolute(relative)
        || path.win32.isAbsolute(relative)) {
        throw new Error(`Waveform artifact is outside the workspace: ${targetPath}`);
    }
    return relative;
}

export function toSimulationArtifactPosixPath(
    workspaceRoot: string,
    targetPath: string
): string {
    if (!targetPath.trim()) {
        throw new Error('Waveform artifact must resolve to a file path');
    }
    const implementation = hostPathImplementation(workspaceRoot, targetPath);
    const resolvedRoot = implementation.resolve(workspaceRoot);
    const resolvedTarget = implementation.resolve(targetPath);
    if (implementation === path.win32
        && path.win32.parse(resolvedRoot).root.toLowerCase()
        !== path.win32.parse(resolvedTarget).root.toLowerCase()) {
        return resolvedTarget.replace(/\\/g, '/');
    }
    const relative = implementation.relative(
        resolvedRoot,
        resolvedTarget
    ).replace(/\\/g, '/');
    if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
        throw new Error('Waveform artifact must resolve to a relative file path');
    }
    const basename = path.posix.basename(relative);
    if (!relative || relative === '.' || !basename || basename === '.' || basename === '..') {
        throw new Error('Waveform artifact must resolve to a file path');
    }
    return relative;
}

function hostPathImplementation(
    ...hostPaths: readonly string[]
): typeof path.posix | typeof path.win32 {
    if (process.platform === 'win32' || hostPaths.some(isExplicitWindowsPath)) {
        return path.win32;
    }
    return path.posix;
}

function isExplicitWindowsPath(hostPath: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(hostPath) || /^(?:\\\\|\/\/)[^\\/]/.test(hostPath);
}

function resolveIncludeDirs(
    workspaceRoot: string,
    libDirs: readonly string[]
): string[] {
    const root = path.resolve(workspaceRoot);
    return [...new Set([
        root,
        ...libDirs.map(libDir => path.isAbsolute(libDir)
            ? path.resolve(libDir)
            : path.resolve(root, libDir)),
    ])];
}
