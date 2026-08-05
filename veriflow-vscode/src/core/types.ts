export interface DependencyResult {
    topModule: string;
    topDefinitionKey: string;
    files: string[];
    missingModules: string[];
    ambiguousModules: Record<string, string[]>;
    moduleMap: Record<string, string>;
    depGraph: Record<string, string[]>;
}

export interface SimulationResult {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    logEntries: LogEntry[];
    waveFile: string | null;
    elapsedTime: number;
}

export interface LogEntry {
    level: 'ERROR' | 'WARNING' | 'INFO';
    message: string;
    fileRef?: string;
    lineNo?: number;
}

export interface Port {
    name: string;
    direction: 'input' | 'output' | 'inout';
    width?: string;
    widthMsb?: number;
    widthLsb?: number;
}

export interface Parameter {
    name: string;
    value: string;
}

export interface ModuleInfo {
    name: string;
    parameters: Parameter[];
    ports: Port[];
    filename: string;
    filepath: string;
    dependencies: string[];
    isTB: boolean;
}

export interface SimulatorConfig {
    name: string;
    compileCmd: string;
    runCmd: string;
}

export interface WaveViewerConfig {
    name: string;
    launchCmd: string;
}

export interface SimulatorSpec {
    compileCmd: string;
    runCmd: string;
}

export interface DuplicateEntry {
    file: string;
    line: number;
}

export interface ModuleDefinitionEntry {
    key: string;
    name: string;
    uri: string;
    filepath: string;
    line: number;
    workspace: boolean;
}

export interface ModuleScanResult {
    root: string;
    libDirs: string[];
    totalModules: number;
    modules: string[];
    workspaceModules: string[];
    definitions: ModuleDefinitionEntry[];
    duplicates: Record<string, string[]>;
    modulesByDir: Record<string, string[]>;
    moduleFiles: Record<string, string>;
    /** Retained until the module instantiation picker migrates to exact definitions. */
    duplicatesWithLines: Record<string, DuplicateEntry[]>;
}

export type DuplicateSummaryInput = {
    name: string;
    definitions: Array<{
        uri: string;
        declarationLine: number;
    }>;
};

export type DuplicatePresentationSummary = {
    outputLines: string[];
    statusText: string;
    popupMessage: undefined;
};

export function formatDuplicateSummary(
    groups: DuplicateSummaryInput[]
): DuplicatePresentationSummary {
    const sortedGroups = [...groups]
        .map(group => ({
            name: group.name,
            definitions: [...group.definitions].sort((left, right) =>
                left.uri.localeCompare(right.uri)
                || left.declarationLine - right.declarationLine
            ),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    const count = sortedGroups.length;
    return {
        outputLines: sortedGroups.flatMap(group => group.definitions.map(
            definition => `  ${group.name}: ${definition.uri}:${definition.declarationLine}`
        )),
        statusText: count === 0
            ? '$(circuit-board) VeriFlow'
            : `$(warning) VeriFlow: ${count} duplicate module name${count === 1 ? '' : 's'}`,
        popupMessage: undefined,
    };
}
