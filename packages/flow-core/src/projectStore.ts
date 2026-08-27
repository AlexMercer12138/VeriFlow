import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_SIMULATORS, DEFAULT_WAVE_VIEWERS } from './defaults';
import { JsonObject, Project } from './project';
import { SimulatorConfig, WaveViewerConfig } from './types';

const PROJECT_KEYS = new Set([
    'project_name',
    'project_root',
    'lib_dirs',
    'top_module',
    'simulator',
    'wave_viewer',
    'wave_file_template',
    'testbench_output_dir',
    'simulators',
    'wave_viewers',
    'file_order',
    'defines',
    'simulation_files',
    'dependency_result',
    'analyze_status',
    'simulate_status',
    'schematic',
]);

export interface ProjectSaveOptions {
    preserveUnknown?: boolean;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, field: string): JsonObject {
    if (!isObject(value)) {
        throw new TypeError(`${field} must be an object`);
    }
    return value;
}

function stringField(data: JsonObject, field: string, fallback: string): string {
    const value = data[field];
    if (value === undefined) return fallback;
    if (typeof value !== 'string') {
        throw new TypeError(`${field} must be a string`);
    }
    return value;
}

function requiredStringField(data: JsonObject, field: string, owner: string): string {
    const value = data[field];
    if (typeof value !== 'string') {
        throw new TypeError(`${owner}.${field} must be a string`);
    }
    return value;
}

function stringArrayField(data: JsonObject, field: string): string[] {
    const value = data[field];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new TypeError(`${field} must be an array of strings`);
    }
    return [...value];
}

function parseDefines(value: unknown): Record<string, string | number | boolean> {
    if (value === undefined) return {};
    const source = requireObject(value, 'defines');
    return Object.fromEntries(Object.entries(source).map(([name, candidate]) => {
        if (!['string', 'number', 'boolean'].includes(typeof candidate)) {
            throw new TypeError(`defines.${name} must be a string, number, or boolean`);
        }
        return [name, candidate as string | number | boolean];
    }));
}

function parseSimulators(value: unknown): Record<string, SimulatorConfig> {
    if (value === undefined) return {};
    const source = requireObject(value, 'simulators');
    return Object.fromEntries(Object.entries(source).map(([name, candidate]) => {
        const config = requireObject(candidate, `simulators.${name}`);
        return [name, {
            name,
            compileCmd: requiredStringField(config, 'compile_cmd', `simulators.${name}`),
            runCmd: requiredStringField(config, 'run_cmd', `simulators.${name}`),
        }];
    }));
}

function parseWaveViewers(value: unknown): Record<string, WaveViewerConfig> {
    if (value === undefined) return {};
    const source = requireObject(value, 'wave_viewers');
    return Object.fromEntries(Object.entries(source).map(([name, candidate]) => {
        if (typeof candidate === 'string') {
            return [name, { name, launchCmd: candidate }];
        }
        const config = requireObject(candidate, `wave_viewers.${name}`);
        return [name, {
            name,
            launchCmd: requiredStringField(config, 'launch_cmd', `wave_viewers.${name}`),
        }];
    }));
}

function parseInterfaceProtocolFiles(value: unknown): string[] {
    if (value === undefined) return [];
    const schematic = requireObject(value, 'schematic');
    return stringArrayField(schematic, 'interface_protocols');
}

function parseSchematicExtra(value: unknown): JsonObject {
    if (value === undefined) return {};
    const schematic = requireObject(value, 'schematic');
    return Object.fromEntries(Object.entries(schematic).filter(
        ([key]) => key !== 'interface_protocols'
    ));
}

function withDefaults<T extends { name: string }>(
    configured: Record<string, T>,
    defaults: Readonly<Record<string, T>>
): Record<string, T> {
    const result = Object.fromEntries(Object.entries(configured).map(
        ([name, value]) => [name, { ...value }]
    )) as Record<string, T>;
    for (const [name, value] of Object.entries(defaults)) {
        if (!(name in result)) result[name] = { ...value };
    }
    return result;
}

function absolutePath(value: string, base: string): string {
    return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function storedPath(value: string, base: string): string {
    const absolute = path.resolve(value);
    const relative = path.relative(base, absolute);
    if (!relative) return '.';
    if (path.isAbsolute(relative)) return value;
    return relative.split(path.sep).join('/');
}

function serializeProject(project: Project, base: string): JsonObject {
    const serialized: JsonObject = {
        project_name: project.name,
        project_root: storedPath(project.rootDir, base),
        lib_dirs: project.libDirs.map(directory => storedPath(directory, base)),
        top_module: project.topModule,
        simulator: project.simulator,
        wave_viewer: project.waveViewer,
        wave_file_template: project.waveFileTemplate,
        testbench_output_dir: project.testbenchOutputDir,
        simulators: Object.fromEntries(Object.entries(project.simulators).map(
            ([name, config]) => [name, {
                compile_cmd: config.compileCmd,
                run_cmd: config.runCmd,
            }]
        )),
        wave_viewers: Object.fromEntries(Object.entries(project.waveViewers).map(
            ([name, config]) => [name, config.launchCmd]
        )),
        file_order: [...project.fileOrder],
        defines: { ...project.defines },
        simulation_files: project.simulationFiles.map(filepath => storedPath(filepath, base)),
        analyze_status: project.analyzeStatus,
        simulate_status: project.simulateStatus,
    };
    if (project.dependencyResult !== undefined && project.dependencyResult !== null) {
        serialized.dependency_result = project.dependencyResult;
    }
    if (project.interfaceProtocolFiles.length > 0
        || Object.keys(project.schematicExtra).length > 0) {
        serialized.schematic = {
            ...project.schematicExtra,
            interface_protocols: project.interfaceProtocolFiles.map(filepath =>
                storedPath(filepath, base)
            ),
        };
        if (project.interfaceProtocolFiles.length === 0) {
            delete (serialized.schematic as JsonObject).interface_protocols;
        }
    }
    return serialized;
}

export class ProjectStore {
    create(name: string, rootDir: string): Project {
        return {
            name,
            rootDir,
            libDirs: [],
            topModule: '',
            simulator: 'builtin',
            waveViewer: 'builtin',
            waveFileTemplate: '{top_module}.vcd',
            testbenchOutputDir: '.',
            fileOrder: [],
            defines: {},
            simulationFiles: [],
            simulators: withDefaults({}, {
                custom: DEFAULT_SIMULATORS.custom,
            }),
            waveViewers: withDefaults({}, {
                builtin: DEFAULT_WAVE_VIEWERS.builtin,
                custom: DEFAULT_WAVE_VIEWERS.custom,
            }),
            interfaceProtocolFiles: [],
            schematicExtra: {},
            analyzeStatus: 'idle',
            simulateStatus: 'idle',
            extra: {},
        };
    }

    open(filepath: string): Project {
        let raw: string;
        try {
            raw = readFileSync(filepath, 'utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') throw new Error(`Project file not found: ${filepath}`);
            throw error;
        }
        const data = requireObject(JSON.parse(raw), 'project');
        const base = path.dirname(path.resolve(filepath));
        const simulators = withDefaults(
            parseSimulators(data.simulators),
            DEFAULT_SIMULATORS
        );
        const waveViewers = withDefaults(
            parseWaveViewers(data.wave_viewers),
            DEFAULT_WAVE_VIEWERS
        );
        const extra = Object.fromEntries(
            Object.entries(data).filter(([key]) => !PROJECT_KEYS.has(key))
        );
        return {
            name: stringField(data, 'project_name', 'untitled'),
            rootDir: absolutePath(stringField(data, 'project_root', '.'), base),
            libDirs: stringArrayField(data, 'lib_dirs').map(value => absolutePath(value, base)),
            topModule: stringField(data, 'top_module', ''),
            simulator: stringField(data, 'simulator', 'iverilog'),
            waveViewer: stringField(data, 'wave_viewer', 'builtin'),
            waveFileTemplate: stringField(data, 'wave_file_template', '{top_module}.vcd'),
            testbenchOutputDir: stringField(data, 'testbench_output_dir', '.'),
            fileOrder: stringArrayField(data, 'file_order'),
            defines: parseDefines(data.defines),
            simulationFiles: stringArrayField(data, 'simulation_files').map(value =>
                absolutePath(value, base)
            ),
            simulators,
            waveViewers,
            interfaceProtocolFiles: parseInterfaceProtocolFiles(data.schematic).map(value =>
                absolutePath(value, base)
            ),
            schematicExtra: parseSchematicExtra(data.schematic),
            dependencyResult: data.dependency_result,
            analyzeStatus: stringField(data, 'analyze_status', 'idle'),
            simulateStatus: stringField(data, 'simulate_status', 'idle'),
            extra,
        };
    }

    save(project: Project, filepath: string, options: ProjectSaveOptions = {}): void {
        const base = path.dirname(path.resolve(filepath));
        const serialized = serializeProject(project, base);
        const data = options.preserveUnknown === false
            ? serialized
            : { ...serialized, ...project.extra };
        mkdirSync(base, { recursive: true });
        writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    }
}
