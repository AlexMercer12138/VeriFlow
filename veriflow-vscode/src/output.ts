import * as vscode from 'vscode';

const CHANNEL_NAME = 'VeriFlow';

let _channel: vscode.OutputChannel | null = null;

function getChannel(): vscode.OutputChannel {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel(CHANNEL_NAME);
    }
    return _channel;
}

export function show(preserveFocus?: boolean): void {
    getChannel().show(preserveFocus);
}

export function clear(): void {
    getChannel().clear();
}

export function appendLine(text: string): void {
    getChannel().appendLine(text);
}

export function appendInfo(text: string): void {
    getChannel().appendLine(`[INFO] ${text}`);
}

export function appendSuccess(text: string): void {
    getChannel().appendLine(`[OK] ${text}`);
}

export function appendWarning(text: string): void {
    getChannel().appendLine(`[WARN] ${text}`);
}

export function appendError(text: string): void {
    getChannel().appendLine(`[ERROR] ${text}`);
}

export function dispose(): void {
    if (_channel) {
        _channel.dispose();
        _channel = null;
    }
}
