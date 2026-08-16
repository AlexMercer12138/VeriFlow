export type Generation =
    | '2005'
    | '2005-sv'
    | '2009'
    | '2012'
    | '2017'
    | '2023';

export interface VirtualFile {
    path: string;
    data: string | Uint8Array;
}

export interface CompileRequest {
    files: VirtualFile[];
    sources: string[];
    top?: string;
    generation?: Generation;
    defines?: Record<string, string | number | boolean>;
    includeDirs?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface RunRequest {
    program: Uint8Array;
    files?: VirtualFile[];
    plusargs?: string[];
    artifacts?: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface SimulateRequest extends CompileRequest {
    plusargs?: string[];
    artifacts?: string[];
}

export type SimulationStage = 'preprocess' | 'compile' | 'run';

export interface StageResult {
    success: boolean;
    stage: SimulationStage;
    exitCode: number;
    stdout: string;
    stderr: string;
    timings: Partial<Record<SimulationStage, number>>;
}

export interface CompileResult extends StageResult {
    program?: Uint8Array;
}

export interface RunResult extends StageResult {
    artifacts: Map<string, Uint8Array>;
}

export interface IverilogApi {
    compile(request: CompileRequest): Promise<CompileResult>;
    run(request: RunRequest): Promise<RunResult>;
    simulate(request: SimulateRequest): Promise<RunResult>;
}
