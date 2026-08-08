import type { SimulationResult, SimulatorConfig } from './types';

export interface ProcessExecution {
    exitCode: number;
    stdout: string;
    stderr: string;
    elapsedTime: number;
}

export interface CommandExecutor {
    execute(command: string, cwd: string, timeoutSeconds: number): Promise<ProcessExecution>;
}

export interface SimulationRequest {
    files: string[];
    output: string;
    simulator: SimulatorConfig;
    cwd: string;
    topModule?: string;
}

export interface SimulationExecution extends SimulationResult {
    compileCommand: string;
    runCommand: string;
}

export interface SimulatorBackend {
    compileAndRun(request: SimulationRequest): Promise<SimulationExecution>;
}
