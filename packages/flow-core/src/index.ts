import type { LegacySimulationExecution } from './simulation';

export * from './defaults';
export * from './globalConfigStore';
export * from './logParser';
export {
    NativeSimulatorBackend as ConfiguredNativeSimulatorBackend,
    NodeCommandExecutor,
} from './nativeSimulatorBackend';
/** @deprecated Temporary CLI compatibility alias; remove in Task 9. */
export { LegacyNativeSimulatorBackend as NativeSimulatorBackend } from './nativeSimulatorBackend';
export * from './pathStyle';
export * from './project';
export * from './projectStore';
export { createSimulationRequest } from './simulation';
export type {
    CommandExecutor,
    ProcessExecution,
    SimulationArtifactRequest,
    SimulationArtifactResult,
    SimulationExecution as NormalizedSimulationExecution,
    SimulationRequest,
    SimulationRequestInput,
    SimulationStage,
    SimulatorBackend,
} from './simulation';
export * from './simulatorBackendRegistry';
export * from './templateEngine';
export * from './types';

/** @deprecated Temporary CLI compatibility alias; remove in Task 9. */
export type SimulationExecution = LegacySimulationExecution;
