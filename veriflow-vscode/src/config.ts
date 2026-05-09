import * as vscode from 'vscode';
import { ModuleTreeProvider } from './moduleTreeProvider';

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

export interface ExtensionSettings {
    libDirs: string[];
    simulator: string;
    waveViewer: string;
    simulatorCompileCmd: string;
    simulatorRunCmd: string;
    waveViewerCmd: string;
    waveFileTemplate: string;
}

export function getSettings(): ExtensionSettings {
    const config = vscode.workspace.getConfiguration('veriflow');
    return {
        libDirs: config.get<string[]>('libDirs', []),
        simulator: config.get<string>('simulator', 'iverilog'),
        waveViewer: config.get<string>('waveViewer', 'surfer'),
        simulatorCompileCmd: config.get<string>('simulatorCompileCmd', ''),
        simulatorRunCmd: config.get<string>('simulatorRunCmd', ''),
        waveViewerCmd: config.get<string>('waveViewerCmd', ''),
        waveFileTemplate: config.get<string>('waveFileTemplate', '{top_module}.vcd'),
    };
}
