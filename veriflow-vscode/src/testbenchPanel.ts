import * as vscode from 'vscode';
import * as path from 'path';
import { TestbenchGenerator, TbConfig, TbModuleConfig } from './core/testbenchGenerator';
import { PortParser } from './core/portParser';
import { Port, Parameter } from './core/types';
import { getSettings } from './config';

export class TestbenchPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'veriflow.testbench';

    private _view?: vscode.WebviewView;
    private _moduleMap: Record<string, string> = {};
    private _moduleEntries: TbModuleEntry[] = [];
    private _generator = new TestbenchGenerator();
    private _parser = new PortParser();
    private _beforeGenerate?: () => Promise<void>;
    private _onVisible?: () => Promise<void>;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    setBeforeGenerate(callback: () => Promise<void>): void {
        this._beforeGenerate = callback;
    }

    setOnVisible(callback: () => Promise<void>): void {
        this._onVisible = callback;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };

        webviewView.webview.html = this._getHtml();
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this._onVisible) {
                this._onVisible();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'getModules':
                    this._postModules();
                    break;
                case 'addModule':
                    await this._addModule(message.moduleName);
                    break;
                case 'removeModule':
                    this._removeModule(message.index);
                    break;
                case 'selectModule':
                    this._selectModule(message.index);
                    break;
                case 'updateInstanceName':
                    this._updateInstanceName(message.index, message.value);
                    break;
                case 'updatePortSignal':
                    this._updatePortSignal(message.index, message.portName, message.value);
                    break;
                case 'updateParamValue':
                    this._updateParamValue(message.index, message.paramName, message.value);
                    break;
                case 'addClock':
                    this._postMessage({ type: 'addClockRow' });
                    break;
                case 'removeClock':
                    this._postMessage({ type: 'removeClockRow' });
                    break;
                case 'generate':
                    await this._generate(message.config);
                    break;
            }
        });
    }

    setModuleMap(moduleMap: Record<string, string>): void {
        this._moduleMap = { ...moduleMap };
        this._postModules();
    }

    private _postModules(): void {
        const modules = Object.keys(this._moduleMap).sort();
        this._postMessage({
            type: 'modules',
            modules,
            outputDir: getSettings().testbenchOutputDir || '.',
        });
    }

    private async _addModule(baseName: string): Promise<void> {
        if (this._moduleEntries.length >= 20) { return; }
        if (!baseName || !this._moduleMap[baseName]) { return; }

        const sameCount = this._moduleEntries.filter(e => e.verilogModuleName === baseName).length;
        const displayName = sameCount > 0 ? `${baseName}_${sameCount}` : baseName;

        const filepath = this._moduleMap[baseName];
        const entry = new TbModuleEntry(displayName, filepath);
        entry.verilogModuleName = baseName;

        if (filepath) {
            try {
                const info = this._parser.parseFile(filepath);
                entry.ports = info.ports;
                entry.params = info.parameters;
            } catch {
                // ignore
            }
        }

        this._moduleEntries.push(entry);
        this._postMessage({
            type: 'moduleAdded',
            index: this._moduleEntries.length - 1,
            entry: entry.toJSON(),
        });
    }

    private _removeModule(index: number): void {
        if (index < 0 || index >= this._moduleEntries.length) { return; }
        this._moduleEntries.splice(index, 1);
        this._postMessage({ type: 'moduleRemoved', index });
    }

    private _selectModule(index: number): void {
        if (index < 0 || index >= this._moduleEntries.length) { return; }
        const entry = this._moduleEntries[index];
        this._postMessage({
            type: 'moduleSelected',
            index,
            entry: entry.toJSON(),
        });
    }

    private _updateInstanceName(index: number, value: string): void {
        if (index < 0 || index >= this._moduleEntries.length) { return; }
        this._moduleEntries[index].instanceName = value.trim();
    }

    private _updatePortSignal(index: number, portName: string, value: string): void {
        if (index < 0 || index >= this._moduleEntries.length) { return; }
        this._moduleEntries[index].setPortSignal(portName, value.trim());
    }

    private _updateParamValue(index: number, paramName: string, value: string): void {
        if (index < 0 || index >= this._moduleEntries.length) { return; }
        this._moduleEntries[index].setParamValue(paramName, value.trim());
    }

    private async _generate(config: any): Promise<void> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            vscode.window.showWarningMessage('No workspace folder open.');
            return;
        }

        const name = (config.name || '').trim();
        if (!name) {
            vscode.window.showWarningMessage('Please enter a testbench name.');
            return;
        }

        if (this._beforeGenerate) {
            await this._beforeGenerate();
        }

        if (this._moduleEntries.length === 0) {
            vscode.window.showWarningMessage('Add at least one DUT module before generating a testbench.');
            this._postMessage({ type: 'validation', message: 'Add at least one DUT module before generating.' });
            return;
        }

        const outputDirSetting = (config.output_dir || getSettings().testbenchOutputDir || '.').trim() || '.';
        const outputDir = path.isAbsolute(outputDirSetting)
            ? outputDirSetting
            : path.join(root, outputDirSetting);

        const tbConfig: TbConfig = {
            name,
            time_unit: config.time_unit || '1ns',
            time_precision: config.time_precision || '1ps',
            clocks_mhz: config.clocks_mhz || ['100'],
            reset_active_high: config.reset_active_high === true,
            reset_duration: config.reset_duration || '100',
            modules: this._moduleEntries.map(e => ({
                module_name: e.verilogModuleName,
                instance_name: e.instanceName,
                filepath: e.filepath,
                port_signals: { ...e.portSignalOverrides },
                param_values: { ...e.paramValueOverrides },
            })),
            wave_file: config.wave_file || `${name}.vcd`,
            timeout: config.timeout || '1000000',
        };

        try {
            const filepath = this._generator.generate(tbConfig, outputDir);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filepath));
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Testbench generated: ${path.basename(filepath)}`);
            this._postMessage({ type: 'generated', filepath });
            if (this._beforeGenerate) {
                await this._beforeGenerate();
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to generate testbench: ${err.message}`);
            this._postMessage({ type: 'error', message: err.message });
        }
    }

    private _postMessage(msg: any): void {
        if (this._view) {
            this._view.webview.postMessage(msg);
        }
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Testbench Generator</title>
<style>
* { box-sizing: border-box; }
html, body {
    height: 100%;
}
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    margin: 0; padding: 8px;
    overflow-y: auto;
    min-width: 0;
    width: 100%;
}
.section {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    margin-bottom: 8px;
    padding: 8px;
    min-width: 0;
}
.section-title {
    font-weight: 600;
    margin-bottom: 6px;
    color: var(--vscode-titleBar-activeForeground);
}
.row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    min-width: 0;
}
.row label {
    font-size: 0.9em;
    white-space: nowrap;
    flex: 0 0 64px;
    min-width: 0;
}
input[type="text"], input[type="number"], select {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: inherit;
    flex: 1 1 0;
    min-width: 0;
    max-width: 100%;
}
input::placeholder {
    color: var(--vscode-input-placeholderForeground);
}
button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    padding: 4px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    min-width: 0;
}
button:disabled {
    cursor: default;
    opacity: 0.55;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.small {
    padding: 2px 8px;
    font-size: 1em;
    width: 32px;
    min-width: 32px;
    height: 26px;
    min-height: 26px;
    font-weight: 600;
    flex: 0 0 32px;
}
button.secondary {
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: 1px solid var(--vscode-panel-border);
}
button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
}
.clock-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    min-width: 0;
}
.clock-row label {
    font-size: 0.9em;
    white-space: nowrap;
    flex: 0 0 64px;
    min-width: 0;
}
.clock-row input {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 3px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: inherit;
    flex: 1 1 0;
    min-width: 0;
    max-width: 100%;
}
.module-picker {
    align-items: stretch;
}
.module-picker select {
    min-width: 0;
}
.module-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.module-splitter {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
    min-width: 0;
}
.splitter-left {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.splitter-right {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.module-list {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    flex: 1;
    min-height: 88px;
    min-width: 0;
    overflow-y: auto;
    background: var(--vscode-editor-background);
}
.module-list-item {
    padding: 4px 8px;
    cursor: pointer;
    font-size: 0.9em;
    border-bottom: 1px solid var(--vscode-panel-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.module-list-item:hover {
    background: var(--vscode-list-hoverBackground);
}
.module-list-item.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}
.module-detail {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 6px;
    background: var(--vscode-editor-background);
    flex: 1;
    overflow-y: auto;
    min-width: 0;
    min-height: 120px;
}
.module-detail.empty {
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 92px;
}
.port-row, .param-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 3px;
    min-width: 0;
}
.port-row label, .param-row label {
    font-size: 0.85em;
    flex: 0 1 112px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.port-row input, .param-row input {
    flex: 1 1 0;
    min-width: 0;
}
.hint {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    margin-left: 4px;
}
.empty-hint,
.validation-message {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    line-height: 1.35;
    margin: 2px 0 6px;
}
.validation-message {
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground));
    display: none;
}
.generate-btn {
    width: 100%;
    padding: 10px;
    font-weight: 600;
    font-size: 1.05em;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
}
@media (min-width: 420px) {
    .module-splitter {
        flex-direction: row;
    }
    .splitter-left {
        flex: 0 0 40%;
        width: auto;
    }
    .splitter-right {
        width: auto;
    }
}
@media (max-width: 280px) {
    body { padding: 6px; }
    .section { padding: 6px; }
    .row,
    .clock-row,
    .port-row,
    .param-row {
        flex-wrap: wrap;
    }
    .row label,
    .clock-row label,
    .port-row label,
    .param-row label {
        flex-basis: 100%;
    }
    .module-picker {
        flex-wrap: nowrap;
    }
}
</style>
</head>
<body>

<div class="section">
    <div class="section-title">Properties</div>
    <div class="row">
        <label>Name</label>
        <input type="text" id="tbName" placeholder="e.g. tb_top" />
    </div>
    <div class="row">
        <label>Path</label>
        <input type="text" id="outputDir" placeholder="{root}" />
    </div>
    <div class="row">
        <label>Unit</label>
        <input type="text" id="timeUnit" value="1ns" />
    </div>
    <div class="row">
        <label>Prec</label>
        <input type="text" id="timePrec" value="1ps" />
    </div>
</div>

<div class="section">
    <div class="section-title">Clocks <span class="hint">(MHz)</span></div>
    <div id="clockContainer"></div>
    <div class="row" style="margin-top:4px;">
        <button class="small secondary" id="btnAddClock">+</button>
        <button class="small secondary" id="btnRemoveClock">-</button>
    </div>
</div>

<div class="section">
    <div class="section-title">Reset</div>
    <div class="row">
        <label>Polarity</label>
        <select id="resetPolarity">
            <option value="low" selected>Active Low</option>
            <option value="high">Active High</option>
        </select>
    </div>
    <div class="row">
        <label>Duration</label>
        <input type="text" id="resetDuration" value="100" />
    </div>
</div>

<div class="section" style="display:flex;flex-direction:column;flex:1;min-height:280px;">
    <div class="section-title">DUT Modules</div>
    <div class="row module-picker">
        <select id="moduleSelect" style="flex:1;"></select>
        <button class="small secondary" id="btnAddModule">+</button>
        <button class="small secondary" id="btnRemoveModule">-</button>
    </div>
    <div class="empty-hint" id="moduleEmptyHint">No modules found. Add .v/.sv files to the workspace or configure veriflow.libDirs.</div>
    <div class="module-splitter">
        <div class="splitter-left">
            <div class="module-list" id="moduleList"></div>
        </div>
        <div class="splitter-right">
            <div class="module-detail empty" id="moduleDetail">Select a module to edit ports/parameters</div>
        </div>
    </div>
</div>

<div class="section">
    <div class="section-title">Waveform</div>
    <div class="row">
        <label>File</label>
        <input type="text" id="waveFile" placeholder="{name}.vcd" />
    </div>
</div>

<div class="section">
    <div class="section-title">Timeout</div>
    <div class="row">
        <label>Max</label>
        <input type="text" id="timeout" value="1000000" />
    </div>
</div>

<button class="generate-btn" id="btnGenerate">Generate Testbench</button>
<div class="validation-message" id="validationMessage"></div>

<script>
    const vscode = acquireVsCodeApi();

    let modules = [];
    let moduleEntries = [];
    let selectedModuleIndex = -1;
    let clockCount = 0;

    function post(msg) { vscode.postMessage(msg); }

    function setValidation(message = '') {
        const el = document.getElementById('validationMessage');
        el.textContent = message;
        el.style.display = message ? 'block' : 'none';
    }

    function createClockRow(idx, value = '') {
        const div = document.createElement('div');
        div.className = 'clock-row';
        div.innerHTML = '<label>Clk' + (idx + 1) + ':</label><input type="text" class="clock-freq" placeholder="100" value="' + escapeHtml(value) + '" data-idx="' + idx + '" />';
        return div;
    }

    function addClock(value = '') {
        if (clockCount >= 6) return;
        const container = document.getElementById('clockContainer');
        container.appendChild(createClockRow(clockCount, value));
        clockCount++;
        updateClockButtons();
    }

    function removeClock() {
        if (clockCount <= 1) return;
        const container = document.getElementById('clockContainer');
        container.removeChild(container.lastChild);
        clockCount--;
        updateClockButtons();
    }

    function updateClockButtons() {
        document.getElementById('btnAddClock').disabled = clockCount >= 6;
        document.getElementById('btnRemoveClock').disabled = clockCount <= 1;
    }

    function updateModuleControls() {
        const hasAvailableModules = modules.length > 0;
        document.getElementById('moduleSelect').disabled = !hasAvailableModules;
        document.getElementById('btnAddModule').disabled = !hasAvailableModules || moduleEntries.length >= 20;
        document.getElementById('btnRemoveModule').disabled = selectedModuleIndex < 0;
        document.getElementById('btnGenerate').disabled = moduleEntries.length === 0;
        document.getElementById('moduleEmptyHint').style.display = hasAvailableModules ? 'none' : 'block';
    }

    function renderModuleList() {
        const list = document.getElementById('moduleList');
        list.innerHTML = '';
        if (moduleEntries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'module-list-item';
            empty.textContent = 'No DUT modules added';
            empty.style.color = 'var(--vscode-descriptionForeground)';
            empty.style.cursor = 'default';
            list.appendChild(empty);
            updateModuleControls();
            return;
        }
        moduleEntries.forEach((entry, i) => {
            const div = document.createElement('div');
            div.className = 'module-list-item' + (i === selectedModuleIndex ? ' selected' : '');
            div.textContent = entry.moduleName + ' (' + entry.instanceName + ')';
            div.onclick = () => {
                selectedModuleIndex = i;
                renderModuleList();
                post({ type: 'selectModule', index: i });
            };
            list.appendChild(div);
        });
        updateModuleControls();
    }

    function renderModuleDetail(entry, index) {
        const detail = document.getElementById('moduleDetail');
        if (!entry) {
            detail.className = 'module-detail empty';
            detail.innerHTML = 'Select a module to edit ports/parameters';
            return;
        }
        detail.className = 'module-detail';
        let html = '';

        html += '<div class="row" style="margin-bottom:6px;"><label>Instance:</label><input type="text" id="instName" value="' + escapeHtml(entry.instanceName) + '" /></div>';

        if (entry.params && entry.params.length > 0) {
            html += '<div style="font-weight:600;margin:4px 0;">Parameters</div>';
            entry.params.forEach(p => {
                const val = entry.paramValueOverrides[p.name] !== undefined ? entry.paramValueOverrides[p.name] : p.value;
                html += '<div class="param-row"><label>' + escapeHtml(p.name) + ':</label><input type="text" class="param-input" data-pname="' + escapeHtml(p.name) + '" value="' + escapeHtml(val) + '" /></div>';
            });
        }

        if (entry.ports && entry.ports.length > 0) {
            html += '<div style="font-weight:600;margin:4px 0;">Ports</div>';
            entry.ports.forEach(p => {
                const sig = entry.portSignalOverrides[p.name] !== undefined ? entry.portSignalOverrides[p.name] : p.name;
                const hint = p.direction + (p.width ? ' ' + p.width : '');
                html += '<div class="port-row"><label>' + escapeHtml(p.name) + ' <span class="hint">' + escapeHtml(hint) + '</span>:</label><input type="text" class="port-input" data-pname="' + escapeHtml(p.name) + '" value="' + escapeHtml(sig) + '" /></div>';
            });
        }

        detail.innerHTML = html;

        const instInput = document.getElementById('instName');
        if (instInput) {
            instInput.oninput = (e) => {
                entry.instanceName = e.target.value;
                renderModuleList();
                post({ type: 'updateInstanceName', index, value: e.target.value });
            };
        }

        detail.querySelectorAll('.port-input').forEach(input => {
            input.oninput = (e) => {
                const pname = e.target.dataset.pname;
                entry.portSignalOverrides[pname] = e.target.value;
                post({ type: 'updatePortSignal', index, portName: pname, value: e.target.value });
            };
        });

        detail.querySelectorAll('.param-input').forEach(input => {
            input.oninput = (e) => {
                const pname = e.target.dataset.pname;
                entry.paramValueOverrides[pname] = e.target.value;
                post({ type: 'updateParamValue', index, paramName: pname, value: e.target.value });
            };
        });
    }

    function escapeHtml(text) {
        if (!text) return '';
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    document.getElementById('btnAddClock').onclick = () => post({ type: 'addClock' });
    document.getElementById('btnRemoveClock').onclick = () => post({ type: 'removeClock' });

    document.getElementById('btnAddModule').onclick = () => {
        const sel = document.getElementById('moduleSelect');
        setValidation('');
        if (sel.value) post({ type: 'addModule', moduleName: sel.value });
    };

    document.getElementById('btnRemoveModule').onclick = () => {
        setValidation('');
        if (selectedModuleIndex >= 0) {
            post({ type: 'removeModule', index: selectedModuleIndex });
        }
    };

    document.getElementById('btnGenerate').onclick = () => {
        setValidation('');
        if (moduleEntries.length === 0) {
            setValidation('Add at least one DUT module before generating.');
            return;
        }
        const clocks = [];
        document.querySelectorAll('.clock-freq').forEach(input => {
            clocks.push(input.value.trim());
        });
        const config = {
            name: document.getElementById('tbName').value.trim(),
            output_dir: document.getElementById('outputDir').value.trim(),
            time_unit: document.getElementById('timeUnit').value.trim(),
            time_precision: document.getElementById('timePrec').value.trim(),
            clocks_mhz: clocks,
            reset_active_high: document.getElementById('resetPolarity').value === 'high',
            reset_duration: document.getElementById('resetDuration').value.trim(),
            wave_file: document.getElementById('waveFile').value.trim(),
            timeout: document.getElementById('timeout').value.trim(),
        };
        post({ type: 'generate', config });
    };

    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'modules':
                modules = msg.modules;
                const sel = document.getElementById('moduleSelect');
                sel.innerHTML = modules.map(m => '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>').join('');
                if (msg.outputDir && !document.getElementById('outputDir').value.trim()) {
                    document.getElementById('outputDir').value = msg.outputDir === '.' ? '' : msg.outputDir;
                }
                updateModuleControls();
                renderModuleList();
                break;
            case 'moduleAdded':
                setValidation('');
                moduleEntries.push(msg.entry);
                selectedModuleIndex = moduleEntries.length - 1;
                renderModuleList();
                renderModuleDetail(msg.entry, selectedModuleIndex);
                break;
            case 'moduleRemoved':
                moduleEntries.splice(msg.index, 1);
                if (selectedModuleIndex >= moduleEntries.length) {
                    selectedModuleIndex = moduleEntries.length - 1;
                }
                if (moduleEntries.length === 0) {
                    selectedModuleIndex = -1;
                }
                renderModuleList();
                renderModuleDetail(moduleEntries[selectedModuleIndex] || null, selectedModuleIndex);
                break;
            case 'moduleSelected':
                selectedModuleIndex = msg.index;
                renderModuleList();
                renderModuleDetail(msg.entry, msg.index);
                break;
            case 'addClockRow':
                addClock();
                break;
            case 'removeClockRow':
                removeClock();
                break;
            case 'generated':
                break;
            case 'error':
                break;
            case 'validation':
                setValidation(msg.message || '');
                break;
        }
    });

    // Init
    addClock('100');
    renderModuleList();
    updateModuleControls();
    post({ type: 'getModules' });
</script>

</body>
</html>`;
    }
}

class TbModuleEntry {
    moduleName: string;
    verilogModuleName: string;
    filepath: string;
    instanceName: string;
    ports: Port[] = [];
    params: Parameter[] = [];
    portSignalOverrides: Record<string, string> = {};
    paramValueOverrides: Record<string, string> = {};

    constructor(moduleName: string, filepath: string = '') {
        this.moduleName = moduleName;
        this.verilogModuleName = moduleName;
        this.filepath = filepath;
        this.instanceName = `u_${moduleName}`;
    }

    setPortSignal(portName: string, signal: string): void {
        this.portSignalOverrides[portName] = signal;
    }

    setParamValue(paramName: string, value: string): void {
        this.paramValueOverrides[paramName] = value;
    }

    toJSON() {
        return {
            moduleName: this.moduleName,
            verilogModuleName: this.verilogModuleName,
            filepath: this.filepath,
            instanceName: this.instanceName,
            ports: this.ports,
            params: this.params,
            portSignalOverrides: { ...this.portSignalOverrides },
            paramValueOverrides: { ...this.paramValueOverrides },
        };
    }
}
