import * as vscode from 'vscode';
import {
    buildModuleInstantiationChoices,
    formatModuleInstantiation,
    HdlDefinitionSummary,
    ModuleInstantiationChoice,
    toModuleInfo,
    WorkspaceHdlIndex,
} from './core';
import { defaultModuleInstanceIdentifier } from './core/moduleInstantiationIdentifier';

type ModuleQuickPickItem = vscode.QuickPickItem & ModuleInstantiationChoice;
type ActionQuickPickItem = vscode.QuickPickItem & { action: 'insert' | 'copy' };
type ModuleInstantiationIndex = Pick<
    WorkspaceHdlIndex,
    'getAllDefinitions' | 'getDefinition'
>;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isHdlEditor(editor: vscode.TextEditor): boolean {
    return editor.document.languageId === 'verilog'
        || editor.document.languageId === 'systemverilog';
}

async function insertAtCursor(
    editor: vscode.TextEditor,
    moduleName: string,
    instanceName: string,
    parameters: Array<{ name: string; value: string }>,
    ports: Array<{ name: string; value: string }>,
    isCurrent: () => boolean
): Promise<void> {
    if (!isCurrent()) { return; }
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
        if (!isCurrent()) { return; }
        if (!applied) {
            vscode.window.showErrorMessage('Failed to insert module instantiation.');
        }
    } catch (error) {
        if (!isCurrent()) { return; }
        vscode.window.showErrorMessage(
            `Failed to insert module instantiation: ${errorMessage(error)}`
        );
    }
}

function getSelectedDefinition(
    getCurrentIndex: () => ModuleInstantiationIndex | undefined,
    initialIndex: ModuleInstantiationIndex,
    selected: ModuleInstantiationChoice,
    isCurrent: () => boolean
): HdlDefinitionSummary | undefined {
    if (!isCurrent() || getCurrentIndex() !== initialIndex) {
        return undefined;
    }
    const definition = initialIndex.getDefinition(selected.definitionKey);
    return definition?.kind === 'module'
        && definition.modelFingerprint === selected.modelFingerprint
        ? definition
        : undefined;
}

export async function showModuleInstantiationPicker(
    getCurrentIndex: () => ModuleInstantiationIndex | undefined,
    isCurrent: () => boolean = () => true,
    workspaceRoot: string = process.cwd()
): Promise<void> {
    const initialIndex = getCurrentIndex();
    if (!isCurrent() || !initialIndex) { return; }
    const invocationEditor = vscode.window.activeTextEditor;
    const choices = buildModuleInstantiationChoices(
        initialIndex.getAllDefinitions('module'),
        workspaceRoot
    ) as ModuleQuickPickItem[];
    if (choices.length === 0) {
        vscode.window.showWarningMessage('No Verilog/SystemVerilog modules found.');
        return;
    }

    const selected = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select a module to instantiate',
        matchOnDescription: true,
    });
    if (!selected || !getSelectedDefinition(
        getCurrentIndex,
        initialIndex,
        selected,
        isCurrent
    )) {
        return;
    }

    const action = await vscode.window.showQuickPick<ActionQuickPickItem>([
        { label: '$(insert) Insert at Cursor', action: 'insert' },
        { label: '$(clippy) Copy to Clipboard', action: 'copy' },
    ], {
        placeHolder: 'Choose where to place the module instantiation',
    });
    if (!action) { return; }
    const definition = getSelectedDefinition(
        getCurrentIndex,
        initialIndex,
        selected,
        isCurrent
    );
    if (!definition) { return; }

    const moduleInfo = toModuleInfo(definition);
    const instanceName = defaultModuleInstanceIdentifier(moduleInfo.name);
    const ports = moduleInfo.ports.map(port => ({
        name: port.name,
        value: port.name,
    }));
    const ownsInvocation = (): boolean => isCurrent()
        && getCurrentIndex() === initialIndex
        && getSelectedDefinition(
            getCurrentIndex,
            initialIndex,
            selected,
            isCurrent
        ) !== undefined;

    if (action.action === 'copy') {
        if (!ownsInvocation()) { return; }
        const text = formatModuleInstantiation({
            moduleName: moduleInfo.name,
            instanceName,
            parameters: moduleInfo.parameters,
            ports,
        });
        try {
            await vscode.env.clipboard.writeText(text);
            if (!ownsInvocation()) { return; }
            vscode.window.showInformationMessage('Module instantiation copied to clipboard.');
        } catch (error) {
            if (!ownsInvocation()) { return; }
            vscode.window.showErrorMessage(
                `Failed to copy module instantiation: ${errorMessage(error)}`
            );
        }
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor !== invocationEditor || !isHdlEditor(editor)) {
        return;
    }
    await insertAtCursor(
        editor,
        moduleInfo.name,
        instanceName,
        moduleInfo.parameters,
        ports,
        () => ownsInvocation()
            && vscode.window.activeTextEditor === editor
            && isHdlEditor(editor)
    );
}
