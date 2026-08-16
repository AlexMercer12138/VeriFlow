import type {
    CompileRequest,
    CompileResult,
    RunRequest,
    RunResult,
    SimulateRequest,
} from '@veriflow/iverilog-wasm';

export type {
    CompileRequest,
    CompileResult,
    Generation,
    RunRequest,
    RunResult,
    SimulateRequest,
    SimulationStage,
    StageResult,
    VirtualFile,
} from '@veriflow/iverilog-wasm';

export interface IverilogApi {
    compile(request: CompileRequest): Promise<CompileResult>;
    run(request: RunRequest): Promise<RunResult>;
    simulate(request: SimulateRequest): Promise<RunResult>;
}
