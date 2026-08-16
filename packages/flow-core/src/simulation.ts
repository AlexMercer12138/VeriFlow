import type { SimulationResult, SimulatorConfig } from './types';

const DEFAULT_SIMULATION_TIMEOUT_MS = 300_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ProcessExecution {
    exitCode: number;
    stdout: string;
    stderr: string;
    elapsedTime: number;
}

export interface CommandExecutor {
    execute(command: string, cwd: string, timeoutSeconds: number): Promise<ProcessExecution>;
}

export type SimulationStage = 'input' | 'compile' | 'run' | 'infrastructure';

export interface SimulationArtifactRequest {
    kind: 'vcd' | 'file';
    path: string;
    destination: string;
    required?: boolean;
}

export interface SimulationRequest {
    files: string[];
    runtimeFiles: string[];
    includeDirs: string[];
    defines: Record<string, string | number | boolean>;
    plusargs: string[];
    artifacts: SimulationArtifactRequest[];
    output: string;
    cwd: string;
    topModule?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface SimulationRequestInput {
    files: readonly string[];
    runtimeFiles?: readonly string[];
    includeDirs?: readonly string[];
    defines?: Readonly<Record<string, string | number | boolean>>;
    plusargs?: readonly string[];
    artifacts?: readonly Readonly<SimulationArtifactRequest>[];
    output: string;
    cwd: string;
    topModule?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface SimulationArtifactResult extends SimulationArtifactRequest {
    written: boolean;
    size: number;
}

export interface SimulationExecution extends SimulationResult {
    backendId: string;
    stage: SimulationStage;
    timings: Partial<Record<'preprocess' | 'compile' | 'run' | 'artifact', number>>;
    commands: { compile?: string; run?: string };
    artifacts: SimulationArtifactResult[];
}

/** @deprecated Temporary CLI request compatibility; remove in Task 9. */
export interface LegacyNativeSimulationRequest {
    files: string[];
    output: string;
    simulator: SimulatorConfig;
    cwd: string;
    topModule?: string;
}

/** @deprecated Temporary CLI result compatibility; remove in Task 9. */
export interface LegacySimulationExecution extends SimulationResult {
    compileCommand: string;
    runCommand: string;
}

export interface SimulatorBackend {
    compileAndRun(request: SimulationRequest): Promise<SimulationExecution>;
}

export function createSimulationRequest(input: SimulationRequestInput): SimulationRequest {
    const timeoutMs = input.timeoutMs ?? DEFAULT_SIMULATION_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new RangeError(
            `timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`
        );
    }

    return {
        files: [...input.files],
        runtimeFiles: [...(input.runtimeFiles ?? [])],
        includeDirs: [...(input.includeDirs ?? [])],
        defines: { ...(input.defines ?? {}) },
        plusargs: [...(input.plusargs ?? [])],
        artifacts: (input.artifacts ?? []).map(artifact => ({ ...artifact })),
        output: input.output,
        cwd: input.cwd,
        ...(input.topModule === undefined ? {} : { topModule: input.topModule }),
        timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
}
