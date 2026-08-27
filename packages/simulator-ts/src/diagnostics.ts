export const EXPERIMENTAL_TS_UNAVAILABLE = (
    'experimental-ts is not available in this build; no fallback was attempted'
);

export type SimulatorTsDiagnosticCode =
    | 'SIM_TS_INVALID_VALUE'
    | 'SIM_TS_INVALID_WIDTH'
    | 'SIM_TS_WIDTH_MISMATCH'
    | 'SIM_TS_INVALID_RANGE';

export class SimulatorTsError extends Error {
    constructor(
        public readonly code: SimulatorTsDiagnosticCode,
        message: string,
    ) {
        super(message);
        this.name = 'SimulatorTsError';
    }
}
