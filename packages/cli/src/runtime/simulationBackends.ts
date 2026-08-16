import {
    ConfiguredNativeSimulatorBackend,
    DEFAULT_SIMULATORS,
    SimulatorBackendRegistry,
    type CommandExecutor,
    type Project,
    type SimulatorBackend,
} from '@veriflow/flow-core';
import { IverilogWasmBackend } from '@veriflow/simulator-iverilog-wasm';

import type { SimulatorConfig } from '@veriflow/flow-core/types';

export const EXPERIMENTAL_TS_UNAVAILABLE = (
    'experimental-ts is not available in this build; no fallback was attempted'
);

export interface CliSimulationBackendOptions {
    commandExecutor?: CommandExecutor;
    builtinProvider?: () => SimulatorBackend | Promise<SimulatorBackend>;
    nativeBackendFactory?: (
        id: string,
        simulator: SimulatorConfig,
        commandExecutor?: CommandExecutor,
    ) => SimulatorBackend;
}

export function createCliSimulationBackends(
    project: Project,
    options: CliSimulationBackendOptions = {},
): SimulatorBackendRegistry {
    const registry = new SimulatorBackendRegistry();
    registry.register(
        'builtin',
        options.builtinProvider ?? (() => new IverilogWasmBackend()),
    );
    registry.register('experimental-ts', () => {
        throw new Error(EXPERIMENTAL_TS_UNAVAILABLE);
    });

    const nativeIds = new Set([
        'native-iverilog',
        'iverilog',
        'vcs',
        'xsim',
        'custom',
        ...Object.keys(project.simulators),
    ]);
    for (const id of nativeIds) {
        if (id === 'builtin' || id === 'experimental-ts') continue;
        const simulator = project.simulators[id] ?? DEFAULT_SIMULATORS[id];
        if (simulator === undefined) continue;
        registry.register(id, () => (
            options.nativeBackendFactory?.(
                id,
                simulator,
                options.commandExecutor,
            ) ?? new ConfiguredNativeSimulatorBackend(
                id,
                simulator,
                options.commandExecutor,
            )
        ));
    }
    return registry;
}
