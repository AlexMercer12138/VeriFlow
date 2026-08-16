import type {
    SimulationExecution,
    SimulationRequest,
    SimulatorBackend,
} from './simulation';

export type SimulatorBackendProvider = () => SimulatorBackend | Promise<SimulatorBackend>;

export class SimulatorBackendRegistry {
    private readonly providers = new Map<string, SimulatorBackendProvider>();

    register(id: string, provider: SimulatorBackendProvider): void {
        if (!id || this.providers.has(id)) {
            throw new Error(`Simulation backend already registered: ${id}`);
        }
        this.providers.set(id, provider);
    }

    async resolve(id: string): Promise<SimulatorBackend> {
        const provider = this.providers.get(id);
        if (!provider) {
            throw new Error(`Unknown simulation backend: ${id}`);
        }
        return provider();
    }

    async run(id: string, request: SimulationRequest): Promise<SimulationExecution> {
        return (await this.resolve(id)).compileAndRun(request);
    }
}
