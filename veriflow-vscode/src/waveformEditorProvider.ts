import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WaveformLayoutStore } from './core/waveformLayoutStore';
import { WaveformWorkerClient } from './core/waveformWorkerClient';
import { StableFileReloader } from './core/stableFileReload';

export class WaveformEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'veriflow.waveformEditor';

    private readonly _layoutStore: WaveformLayoutStore;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._layoutStore = new WaveformLayoutStore(_context.workspaceState);
    }

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
        const worker = new WaveformWorkerClient({
            workerPath: path.join(
                this._context.extensionPath,
                'dist',
                'workers',
                'waveformWorker.js'
            ),
        });
        const stableReloader = new StableFileReloader(document.uri.fsPath, {
            delayMs: 750,
            confirmationMs: 100,
            onChanging: () => worker.cancelLoad(),
            onStable: () => worker.open(document.uri.fsPath),
            onUnavailable: error => {
                void webviewPanel.webview.postMessage({
                    type: 'reloadFailed',
                    generation: worker.currentLoadingGeneration || worker.currentGeneration,
                    message: error.message,
                });
            },
        });
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                path.dirname(document.uri.fsPath),
                path.basename(document.uri.fsPath)
            )
        );
        const notifyChanged = (): void => stableReloader.notify();
        const watcherSubscriptions = [
            watcher.onDidChange(notifyChanged),
            watcher.onDidCreate(notifyChanged),
            watcher.onDidDelete(notifyChanged),
        ];
        const stopForwarding = worker.onMessage(message => {
            const payload = message.type === 'waveformMetadata'
                ? { ...message, layout: this._layoutStore.load(document.uri.toString()) }
                : message;
            void webviewPanel.webview.postMessage(payload);
        });
        const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'openText') {
                await vscode.commands.executeCommand(
                    'vscode.openWith',
                    document.uri,
                    'default'
                );
            } else if (message.type === 'saveLayout') {
                await this._layoutStore.save(document.uri.toString(), message.layout);
            } else if (message.type === 'ready') {
                worker.open(document.uri.fsPath);
            } else if (message.type === 'cancelRequest') {
                worker.cancelRequest(String(message.requestId));
            } else if (message.type === 'cancelLoad') {
                worker.cancelLoad();
            } else if (message.type === 'retryLoad') {
                worker.open(document.uri.fsPath);
            } else if (['windowRequest', 'valueRequest', 'searchRequest'].includes(message.type)) {
                worker.forward(message);
            }
        });
        const panelSubscription = webviewPanel.onDidDispose(() => {
            stopForwarding();
            messageSubscription.dispose();
            stableReloader.dispose();
            watcherSubscriptions.forEach(subscription => subscription.dispose());
            watcher.dispose();
            void worker.dispose();
            panelSubscription.dispose();
        });
    }

    private _getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const assetsDir = path.join(this._context.extensionPath, 'media', 'waveform');
        const css = fs.readFileSync(path.join(assetsDir, 'index.css'), 'utf-8');
        const body = fs.readFileSync(path.join(assetsDir, 'index.html'), 'utf-8');
        const coreScript = fs.readFileSync(path.join(assetsDir, 'viewer-core.js'), 'utf-8');
        const transportScript = fs.readFileSync(path.join(assetsDir, 'viewer-transport.js'), 'utf-8');
        const script = fs.readFileSync(path.join(assetsDir, 'index.js'), 'utf-8')
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
${transportScript}
${coreScript}
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
