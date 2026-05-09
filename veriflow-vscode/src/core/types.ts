export interface DependencyResult {
    topModule: string;
    files: string[];
    missingModules: string[];
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

export interface ModuleScanResult {
    root: string;
    libDirs: string[];
    totalModules: number;
    modules: string[];
    modulesByDir: Record<string, string[]>;
    moduleFiles: Record<string, string>;
    duplicates: Record<string, string[]>;
}
