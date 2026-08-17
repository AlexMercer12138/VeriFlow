import * as path from 'path';

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
}

type ActiveRun = {
    runId: number;
    controller: AbortController;
    promise: Promise<NormalizedSimulationExecution>;
};

export class SimulationService {
    private readonly registryFactory: (
        settings: SimulationBackendSettings
    ) => SimulatorBackendRegistry;
    private activeRun: ActiveRun | undefined;
    private latestRunId = 0;
    private disposed = false;

    constructor(options: SimulationServiceOptions = {}) {
        this.registryFactory = options.registryFactory ?? (settings => (
            createSimulationBackendRegistry(settings, options)
        ));
    }

    get activeRunId(): number | undefined {
        return this.activeRun?.runId;
    }

    isCurrentRun(runId: number): boolean {
        return !this.disposed && runId === this.latestRunId;
    }

    async run(
        input: SimulationServiceRunInput,
        token?: CancellationTokenLike
    ): Promise<SimulationServiceRunResult> {
        if (this.disposed) {
            throw new Error('Simulation service is disposed');
        }

        const runId = ++this.latestRunId;
        this.activeRun?.controller.abort();
        const controller = new AbortController();
        if (token?.isCancellationRequested) {
            controller.abort();
        }
        const request = createSimulationRequest({
            files: input.files,
            runtimeFiles: [],
            includeDirs: resolveIncludeDirs(input.workspaceRoot, input.libDirs),
            defines: input.defines,
            plusargs: [],
            artifacts: input.waveFile === undefined ? [] : [{
                kind: 'vcd',
                path: input.backendId === 'builtin'
                    ? toWorkspaceRelativePosixPath(input.workspaceRoot, input.waveFile)
                    : input.waveFile,
                destination: input.waveFile,
                required: false,
            }],
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
        const cancellationListener = token?.onCancellationRequested(
            () => controller.abort()
        );
        const promise = registry.run(input.backendId, request);
        const owner: ActiveRun = { runId, controller, promise };
        this.activeRun = owner;

        try {
            return { runId, execution: await promise };
        } finally {
            cancellationListener?.dispose();
            if (this.activeRun === owner) {
                this.activeRun = undefined;
            }
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.latestRunId++;
        const active = this.activeRun;
        active?.controller.abort();
        try {
            await active?.promise;
        } catch {
            // The command owner observes backend failures; disposal only drains it.
        }
    }
}

export function toWorkspaceRelativePosixPath(
    workspaceRoot: string,
    targetPath: string
): string {
    const root = path.resolve(workspaceRoot);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    if (relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        throw new Error(`Waveform artifact is outside the workspace: ${targetPath}`);
    }
    return relative.replace(/\\/g, '/');
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
