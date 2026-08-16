import {
    LogParser,
    createSimulationRequest,
    type LogEntry,
    type NormalizedSimulationExecution,
    type SimulationArtifactResult,
    type SimulationFailureCause,
    type SimulationRequest,
    type SimulatorBackend,
} from '@veriflow/flow-core';

import { writeRequestedArtifacts } from './artifactWriter';
import type { IverilogApi, RunResult } from './iverilogApi';
import { loadIverilog } from './loadIverilog';
import { buildVirtualWorkspace, type VirtualWorkspace } from './virtualWorkspace';

const BACKEND_ID = 'builtin';

export type IverilogApiProvider = () => Promise<IverilogApi>;

export class IverilogWasmBackend implements SimulatorBackend {
    constructor(
        private readonly loadApi: IverilogApiProvider = loadIverilog,
    ) {}

    async compileAndRun(input: SimulationRequest): Promise<NormalizedSimulationExecution> {
        const request = createSimulationRequest(input);
        const workspace = await buildVirtualWorkspace({
            cwd: request.cwd,
            files: request.files,
            runtimeFiles: request.runtimeFiles,
            includeDirs: request.includeDirs,
        });
        const started = performance.now();
        let result: RunResult;

        try {
            const api = await this.loadApi();
            result = await api.simulate({
                files: workspace.files,
                sources: workspace.sources,
                includeDirs: workspace.includeDirs,
                generation: '2005',
                top: request.topModule,
                defines: request.defines,
                plusargs: request.plusargs,
                artifacts: request.artifacts.map(artifact => artifact.path),
                timeoutMs: request.timeoutMs,
                signal: request.signal,
            });
        } catch (error) {
            if (errorDetails(error).code === 'INVALID_INPUT') throw error;
            return infrastructureFailure(
                request,
                infrastructureCause(error),
                (performance.now() - started) / 1_000,
            );
        }

        const mappedOutput = mapResultOutput(result, workspace);
        const stageTimings = normalizeTimings(result.timings);
        const artifactStarted = performance.now();
        let artifacts: SimulationArtifactResult[];
        try {
            artifacts = await writeRequestedArtifacts(
                result.artifacts,
                request.artifacts,
                {
                    cwd: request.cwd,
                    signal: request.signal,
                    protectedVirtualPaths: workspace.files.map(file => file.path),
                    protectedHostPaths: [
                        ...request.files,
                        ...request.runtimeFiles,
                    ],
                },
            );
        } catch (error) {
            const artifactTime = (performance.now() - artifactStarted) / 1_000;
            return infrastructureFailure(
                request,
                artifactFailureCause(error),
                sumTimings(stageTimings) + artifactTime,
                mappedOutput,
                {
                    ...stageTimings,
                    artifact: artifactTime,
                },
            );
        }

        const artifactTiming = request.artifacts.length === 0
            ? {}
            : { artifact: (performance.now() - artifactStarted) / 1_000 };
        const timings = { ...stageTimings, ...artifactTiming };
        const missingRequired = artifacts.filter(artifact => (
            artifact.required === true && !artifact.written
        ));
        const waveFile = artifacts.find(artifact => (
            artifact.kind === 'vcd' && artifact.written
        ))?.destination ?? null;
        const base: NormalizedSimulationExecution = {
            success: result.success,
            exitCode: result.exitCode,
            stdout: mappedOutput.stdout,
            stderr: mappedOutput.stderr,
            logEntries: mappedOutput.logEntries,
            waveFile,
            elapsedTime: sumTimings(timings),
            backendId: BACKEND_ID,
            stage: result.stage === 'preprocess' ? 'compile' : result.stage,
            timings,
            commands: {},
            artifacts,
        };

        if (!result.success || missingRequired.length === 0) return base;

        const message = `Required artifacts were not produced: ${missingRequired
            .map(artifact => artifact.path)
            .join(', ')}`;
        return {
            ...base,
            success: false,
            exitCode: -1,
            stderr: appendLine(base.stderr, message),
            logEntries: [
                ...base.logEntries,
                { level: 'ERROR', message },
            ],
            stage: 'infrastructure',
            cause: { code: 'ARTIFACT_MISSING', message },
        };
    }
}

interface MappedOutput {
    stdout: string;
    stderr: string;
    logEntries: LogEntry[];
}

function mapResultOutput(
    result: Pick<RunResult, 'stdout' | 'stderr'>,
    workspace: VirtualWorkspace,
): MappedOutput {
    const parser = new LogParser();
    const logEntries = parser.parse(`${result.stdout}\n${result.stderr}`)
        .map(entry => mapLogEntry(entry, workspace.hostPathByVirtualPath));
    return {
        stdout: mapDiagnosticPaths(result.stdout, workspace.hostPathByVirtualPath),
        stderr: mapDiagnosticPaths(result.stderr, workspace.hostPathByVirtualPath),
        logEntries,
    };
}

function mapLogEntry(
    entry: LogEntry,
    hostPathByVirtualPath: ReadonlyMap<string, string>,
): LogEntry {
    if (entry.fileRef === undefined) return entry;
    const hostPath = hostPathForVirtualPath(
        entry.fileRef,
        hostPathByVirtualPath,
    );
    return hostPath === undefined ? entry : { ...entry, fileRef: hostPath };
}

function mapDiagnosticPaths(
    value: string,
    hostPathByVirtualPath: ReadonlyMap<string, string>,
): string {
    const replacements = new Map<string, string>();
    for (const [virtualPath, hostPath] of hostPathByVirtualPath) {
        replacements.set(`/work/${virtualPath}`, hostPath);
        replacements.set(virtualPath, hostPath);
    }
    if (replacements.size === 0) return value;

    const pattern = new RegExp(
        [...replacements.keys()]
            .sort((left, right) => right.length - left.length)
            .map(escapeRegExp)
            .join('|'),
        'g',
    );
    return value.replace(pattern, matched => replacements.get(matched)!);
}

function hostPathForVirtualPath(
    virtualPath: string,
    hostPathByVirtualPath: ReadonlyMap<string, string>,
): string | undefined {
    return hostPathByVirtualPath.get(virtualPath)
        ?? (virtualPath.startsWith('/work/')
            ? hostPathByVirtualPath.get(virtualPath.slice('/work/'.length))
            : undefined);
}

function normalizeTimings(
    timings: RunResult['timings'],
): NormalizedSimulationExecution['timings'] {
    return Object.fromEntries(
        Object.entries(timings).map(([stage, milliseconds]) => [
            stage,
            milliseconds / 1_000,
        ]),
    );
}

function sumTimings(
    timings: NormalizedSimulationExecution['timings'],
): number {
    return Object.values(timings).reduce(
        (total, elapsed) => total + (elapsed ?? 0),
        0,
    );
}

function infrastructureFailure(
    request: SimulationRequest,
    cause: SimulationFailureCause,
    elapsedTime: number,
    output: MappedOutput = { stdout: '', stderr: '', logEntries: [] },
    timings: NormalizedSimulationExecution['timings'] = {},
): NormalizedSimulationExecution {
    return {
        success: false,
        exitCode: -1,
        stdout: output.stdout,
        stderr: appendLine(output.stderr, cause.message),
        logEntries: [
            ...output.logEntries,
            { level: 'ERROR', message: cause.message },
        ],
        waveFile: null,
        elapsedTime,
        backendId: BACKEND_ID,
        stage: 'infrastructure',
        timings,
        commands: {},
        artifacts: initialArtifacts(request),
        cause,
    };
}

function initialArtifacts(
    request: SimulationRequest,
): SimulationArtifactResult[] {
    return request.artifacts.map(artifact => ({
        ...artifact,
        written: false,
        size: 0,
    }));
}

function infrastructureCause(error: unknown): SimulationFailureCause {
    const details = errorDetails(error);
    if (details.name === 'AbortError') {
        return { code: 'ABORTED', message: details.message };
    }
    if (details.name === 'RuntimeError') {
        return { code: 'WASM_TRAP', message: details.message };
    }
    return {
        ...(details.code === undefined ? {} : { code: details.code }),
        message: details.message,
    };
}

function artifactFailureCause(error: unknown): SimulationFailureCause {
    const infrastructure = infrastructureCause(error);
    if (infrastructure.code === 'ABORTED') return infrastructure;
    return {
        code: 'ARTIFACT_WRITE',
        message: infrastructure.message,
    };
}

function errorDetails(error: unknown): {
    name: string;
    message: string;
    code?: string;
} {
    if (error instanceof Error) {
        const code = (error as Error & { code?: unknown }).code;
        return {
            name: error.name,
            message: error.message,
            ...(typeof code === 'string' ? { code } : {}),
        };
    }
    return { name: 'Error', message: String(error) };
}

function appendLine(value: string, line: string): string {
    if (value === '') return `${line}\n`;
    return `${value}${value.endsWith('\n') ? '' : '\n'}${line}\n`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
