import * as vscode from 'vscode';
import {
    buildModuleInstantiationChoices,
    formatModuleInstantiation,
    ModuleInfo,
    ModuleInstantiationChoice,
    ModuleScanResult,
    PortParser,
} from './core';

type ModuleQuickPickItem = vscode.QuickPickItem & ModuleInstantiationChoice;
type ActionQuickPickItem = vscode.QuickPickItem & { action: 'insert' | 'copy' };

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function insertAtCursor(
    editor: vscode.TextEditor,
    moduleName: string,
    instanceName: string,
    parameters: Array<{ name: string; value: string }>,
    ports: Array<{ name: string; value: string }>
): Promise<void> {
    const range = editor.selection;
    const startLine = editor.document.lineAt(range.start.line);
    const prefix = startLine.text.substring(0, range.start.character);
    const leadingWhitespace = /^\s*/.exec(startLine.text)?.[0] ?? '';
    const baseIndent = /^\s*$/.test(prefix) ? prefix : leadingWhitespace;
    const formatted = formatModuleInstantiation({
        moduleName,
        instanceName,
        parameters,
        ports,
        baseIndent,
    });
    const text = baseIndent && formatted.startsWith(baseIndent)
        ? formatted.substring(baseIndent.length)
        : formatted;

    try {
        const applied = await editor.edit(editBuilder => editBuilder.replace(range, text));
        if (!applied) {
            vscode.window.showErrorMessage('Failed to insert module instantiation.');
        }
    } catch (error) {
        vscode.window.showErrorMessage(
            `Failed to insert module instantiation: ${errorMessage(error)}`
        );
    }
}

export async function showModuleInstantiationPicker(result: ModuleScanResult): Promise<void> {
    const choices = buildModuleInstantiationChoices(result) as ModuleQuickPickItem[];
    if (choices.length === 0) {
        vscode.window.showWarningMessage('No Verilog/SystemVerilog modules found.');
        return;
    }

    const selected = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select a module to instantiate',
        matchOnDescription: true,
    });
    if (!selected) { return; }

    let moduleInfo: ModuleInfo;
    try {
        moduleInfo = new PortParser().parseFile(selected.filepath, selected.moduleName);
    } catch (error) {
        vscode.window.showErrorMessage(
            `Failed to read ${selected.filepath}: ${errorMessage(error)}`
        );
        return;
    }
    if (moduleInfo.name !== selected.moduleName) {
        vscode.window.showErrorMessage(
            `Module ${selected.moduleName} could not be parsed from ${selected.filepath}.`
        );
        return;
    }

    const action = await vscode.window.showQuickPick<ActionQuickPickItem>([
        { label: '$(insert) Insert at Cursor', action: 'insert' },
        { label: '$(clippy) Copy to Clipboard', action: 'copy' },
    ], {
        placeHolder: 'Choose where to place the module instantiation',
    });
    if (!action) { return; }

    const instanceName = `u_${selected.moduleName}`;
    const parameters = moduleInfo.parameters.map(parameter => ({
        name: parameter.name,
        value: parameter.name,
    }));
    const ports = moduleInfo.ports.map(port => ({
        name: port.name,
        value: port.name,
    }));

    if (action.action === 'copy') {
        const text = formatModuleInstantiation({
            moduleName: selected.moduleName,
            instanceName,
            parameters,
            ports,
        });
        try {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage('Module instantiation copied to clipboard.');
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to copy module instantiation: ${errorMessage(error)}`
            );
        }
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor for module instantiation.');
        return;
    }
    await insertAtCursor(editor, selected.moduleName, instanceName, parameters, ports);
}
