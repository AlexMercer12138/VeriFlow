import * as vscode from 'vscode';
import { DependencyResult, ModuleDefinitionEntry } from './core';

export function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0].uri.fsPath;
}

export type TopModuleSelection = { definitionKey: string; name: string };

export function getTopModule(
    context: vscode.ExtensionContext
): TopModuleSelection | undefined {
    const stored = context.workspaceState.get<unknown>('veriflow.topModule');
    if (typeof stored === 'string') {
        return stored ? { definitionKey: '', name: stored } : undefined;
    }
    if (!stored || typeof stored !== 'object') {
        return undefined;
    }
    const selection = stored as Partial<TopModuleSelection>;
    return typeof selection.definitionKey === 'string'
        && typeof selection.name === 'string'
        && selection.name.length > 0
        ? { definitionKey: selection.definitionKey, name: selection.name }
        : undefined;
}

export async function setTopModule(
    context: vscode.ExtensionContext,
    selection: TopModuleSelection | undefined
): Promise<void> {
    await context.workspaceState.update('veriflow.topModule', selection);
}

export function resolveTopModuleSelection(
    stored: TopModuleSelection | undefined,
    definitions: ModuleDefinitionEntry[]
): TopModuleSelection | undefined {
    if (!stored) {
        return undefined;
    }
    const workspaceDefinitions = definitions.filter(definition => definition.workspace);
    if (stored.definitionKey) {
        const exact = workspaceDefinitions.find(
            definition => definition.key === stored.definitionKey
        );
        return exact
            ? { definitionKey: exact.key, name: exact.name }
            : undefined;
    }
    const matching = workspaceDefinitions.filter(
        definition => definition.name === stored.name
    );
    return matching.length === 1
        ? { definitionKey: matching[0].key, name: matching[0].name }
        : undefined;
}

// 状态管理: 'idle' | 'completed' | 'error' | 'outdated'
export function getAnalyzeStatus(context: vscode.ExtensionContext): string {
    return context.workspaceState.get<string>('veriflow.analyzeStatus', 'idle');
}

export async function setAnalyzeStatus(context: vscode.ExtensionContext, status: string): Promise<void> {
    await context.workspaceState.update('veriflow.analyzeStatus', status);
}

export function getSimulateStatus(context: vscode.ExtensionContext): string {
    return context.workspaceState.get<string>('veriflow.simulateStatus', 'idle');
}

export async function setSimulateStatus(context: vscode.ExtensionContext, status: string): Promise<void> {
    await context.workspaceState.update('veriflow.simulateStatus', status);
}

// 依赖分析结果持久化
export function getDependencyResult(context: vscode.ExtensionContext): DependencyResult | null {
    return context.workspaceState.get<DependencyResult | null>('veriflow.dependencyResult', null);
}

export async function setDependencyResult(context: vscode.ExtensionContext, result: DependencyResult | null): Promise<void> {
    await context.workspaceState.update('veriflow.dependencyResult', result);
}

export interface ExtensionSettings {
    libDirs: string[];
    defines: Record<string, string | boolean>;
    simulator: string;
    waveViewer: string;
    simulatorCompileCmd: string;
    simulatorRunCmd: string;
    waveViewerCmd: string;
    waveFileTemplate: string;
    testbenchOutputDir: string;
}

function normalizeDefines(value: unknown): Record<string, string | boolean> {
    const defines: Record<string, string | boolean> = {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return defines;
    }
    for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            continue;
        }
        const defineValue = (value as Record<string, unknown>)[key];
        if (typeof defineValue === 'string' || typeof defineValue === 'boolean') {
            defines[key] = defineValue;
        }
    }
    return defines;
}

export function getSettings(resource?: vscode.Uri): ExtensionSettings {
    const config = vscode.workspace.getConfiguration('veriflow', resource);
    return {
        libDirs: config.get<string[]>('libDirs', []),
        defines: normalizeDefines(config.get<unknown>('defines', {})),
        simulator: config.get<string>('simulator', 'iverilog'),
        waveViewer: config.get<string>('waveViewer', 'builtin'),
        simulatorCompileCmd: config.get<string>('simulatorCompileCmd', ''),
        simulatorRunCmd: config.get<string>('simulatorRunCmd', ''),
        waveViewerCmd: config.get<string>('waveViewerCmd', ''),
        waveFileTemplate: config.get<string>('waveFileTemplate', '{top_module}.vcd'),
        testbenchOutputDir: config.get<string>('testbenchOutputDir', '.'),
    };
}
