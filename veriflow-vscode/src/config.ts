import * as vscode from 'vscode';
import { ModuleTreeProvider } from './moduleTreeProvider';
import { DependencyResult } from './core';

export function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0].uri.fsPath;
}

export function getTopModule(context: vscode.ExtensionContext): string {
    return context.workspaceState.get<string>('veriflow.topModule', '');
}

export async function setTopModule(context: vscode.ExtensionContext, moduleName: string): Promise<void> {
    await context.workspaceState.update('veriflow.topModule', moduleName);
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
    simulator: string;
    waveViewer: string;
    simulatorCompileCmd: string;
    simulatorRunCmd: string;
    waveViewerCmd: string;
    waveFileTemplate: string;
    testbenchOutputDir: string;
}

export function getSettings(): ExtensionSettings {
    const config = vscode.workspace.getConfiguration('veriflow');
    return {
        libDirs: config.get<string[]>('libDirs', []),
        simulator: config.get<string>('simulator', 'iverilog'),
        waveViewer: config.get<string>('waveViewer', 'builtin'),
        simulatorCompileCmd: config.get<string>('simulatorCompileCmd', ''),
        simulatorRunCmd: config.get<string>('simulatorRunCmd', ''),
        waveViewerCmd: config.get<string>('waveViewerCmd', ''),
        waveFileTemplate: config.get<string>('waveFileTemplate', '{top_module}.vcd'),
        testbenchOutputDir: config.get<string>('testbenchOutputDir', '.'),
    };
}
