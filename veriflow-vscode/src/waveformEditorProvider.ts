import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VcdData, VcdParser } from './core/vcdParser';

export class WaveformEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'veriflow.waveformEditor';

    private readonly _parser = new VcdParser();

    constructor(private readonly _context: vscode.ExtensionContext) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => undefined };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };
        webviewPanel.webview.html = this._getHtml(webviewPanel.webview);
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'openText') {
                await vscode.commands.executeCommand(
                    'vscode.openWith',
                    document.uri,
                    'default'
                );
            } else if (message.type === 'ready') {
                await this._loadVcd(document.uri, webviewPanel.webview);
            }
        });
    }

    private async _loadVcd(uri: vscode.Uri, webview: vscode.Webview): Promise<void> {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(bytes).toString('utf-8');
            const data = this._parser.parse(content);
            webview.postMessage({
                type: 'vcd',
                fileName: uri.fsPath,
                data,
            });
        } catch (err: any) {
            webview.postMessage({
                type: 'error',
                message: err?.message || String(err),
            });
        }
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const assetsDir = path.join(this._context.extensionPath, 'media', 'waveform');
        const css = fs.readFileSync(path.join(assetsDir, 'viewer.css'), 'utf-8');
        const body = fs.readFileSync(path.join(assetsDir, 'viewer.html'), 'utf-8');
        const script = fs.readFileSync(path.join(assetsDir, 'viewer.js'), 'utf-8')
            .replace('const bootstrap = ${stateJson};', 'const bootstrap = { nonce: "' + nonce + '" };');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VeriFlow Waveform</title>
<style>
${css}
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
${script}
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
