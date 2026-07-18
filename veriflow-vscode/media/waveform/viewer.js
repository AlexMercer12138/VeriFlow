const bootstrap = ${stateJson};
const vscode = acquireVsCodeApi();
const waveCore = globalThis.VeriflowWaveCore;
const isVsCodeHost = typeof vscode.getState === 'function' && typeof vscode.setState === 'function';
const canvas = document.getElementById('waveCanvas');
const ctx = canvas.getContext('2d');
const waveWrap = document.getElementById('waveWrap');
const waveCanvasPane = document.getElementById('waveCanvasPane');
const waveNameList = document.getElementById('waveNameList');
const signalList = document.getElementById('signalList');
const fileTitle = document.getElementById('fileTitle');
const emptyState = document.getElementById('emptyState');
const statusText = document.getElementById('statusText');
const cursorText = document.getElementById('cursorMeasureText');
const rangeText = document.getElementById('rangeText');
const searchInput = document.getElementById('searchInput');
const scopeSelect = document.getElementById('scopeSelect');
const timeInput = document.getElementById('timeInput');
const goToTimeButton = document.getElementById('goToTime');
const contextMenu = document.getElementById('contextMenu');
const selectionBox = document.getElementById('selectionBox');
const mainResize = document.getElementById('mainResize');
const waveNameResize = document.getElementById('waveNameResize');

const DEFAULT_WAVE_COLOR = '#22e36d';
const COLORS = [
    { name: 'Green', hex: '#22e36d' },
    { name: 'Cyan', hex: '#19e6c8' },
    { name: 'Yellow', hex: '#fad84a' },
    { name: 'White', hex: '#f4f7f8' },
    { name: 'Red', hex: '#ff5c5c' },
    { name: 'Orange', hex: '#ff9e3d' },
    { name: 'Blue', hex: '#4cb3ff' },
    { name: 'Purple', hex: '#b98cff' },
    { name: 'Pink', hex: '#ff79c6' },
];
const RADIXES = [
    { key: 'default', label: 'Default' },
    { key: 'hex', label: 'Hexadecimal' },
    { key: 'binary', label: 'Binary' },
    { key: 'signed', label: 'Signed Decimal' },
    { key: 'unsigned', label: 'Unsigned Decimal' },
    { key: 'octal', label: 'Octal' },
];
const STYLE = {
    background: getCss('--vscode-editor-background', '#111318'),
    foreground: getCss('--vscode-editor-foreground', '#d6dde8'),
    muted: getCss('--vscode-descriptionForeground', '#8b949e'),
    border: getCss('--vscode-panel-border', '#30363d'),
    unknown: '#ff5c5c',
    highZ: '#4cb3ff',
    busText: '#ffffff',
    cursor: '#f6c177',
    selection: 'rgba(96,165,250,0.20)',
};

let vcd = null;
let currentFileName = '';
let allSignals = [];
let filteredSignals = [];
let waveSignals = [];
let selectedLibraryIndex = 0;
let selectedWaveIndex = -1;
let selectedWaveIndices = new Set();
let listFirstRow = 0;
let listRenderedCount = 0;
let waveFirstRow = 0;
let waveScrollTop = 0;
let startTime = 0;
let endTime = 1;
let cursorTime = 0;
let dragging = false;
let dragMode = 'none';
let lastMouseX = 0;
let boxStart = null;
let boxCurrent = null;
let nextGroupId = 1;
let layoutReady = false;
let layoutSaveTimer = null;
let lastSavedLayoutJson = '';
let layoutStorageWarningShown = false;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 38;
const TIME_UNITS = ['fs', 'ps', 'ns', 'us', 'ms', 's'];
const LAYOUT_STORAGE_PREFIX = 'veriflow.waveform.layout.v1:';

function getCss(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function stableSignalKey(signal) {
    return signal.fullName + '|' + signal.id;
}

function cssPixelValue(name, fallback) {
    const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
}

function captureLayout() {
    if (!vcd || !waveCore) return null;
    const rows = waveSignals.map(item => {
        if (isGroupRow(item)) {
            return {
                kind: 'group',
                id: item.id,
                name: displayName(item),
                expanded: item.expanded !== false,
            };
        }
        return {
            kind: 'signal',
            signal: waveCore.describeSignal(item, allSignals),
            groupId: item.groupId || '',
            color: item.color || DEFAULT_WAVE_COLOR,
            radix: item.radix || 'default',
            nameMode: item.nameMode || 'short',
            displayName: item.displayName || '',
            busExpanded: !!item.busExpanded,
        };
    });
    return {
        version: 1,
        rows,
        view: {
            startTime,
            endTime,
            waveScrollTop,
            libraryWidth: cssPixelValue('--library-width', 300),
            waveNameWidth: cssPixelValue('--wave-name-width', 150),
        },
        cursors: {
            a: cursorTime,
            b: null,
            active: 'a',
        },
    };
}

function localLayoutKey() {
    return LAYOUT_STORAGE_PREFIX + currentFileName;
}

function showLayoutStorageWarning(message) {
    if (layoutStorageWarningShown) return;
    layoutStorageWarningShown = true;
    statusText.textContent = message;
}

function loadHostLayout(messageLayout) {
    if (messageLayout && typeof messageLayout === 'object') return messageLayout;
    try {
        if (isVsCodeHost) {
            return vscode.getState()?.layout || null;
        }
        const stored = localStorage.getItem(localLayoutKey());
        return stored ? JSON.parse(stored) : null;
    } catch (_error) {
        showLayoutStorageWarning('Waveform layout restore is unavailable.');
        return null;
    }
}

function persistLayoutNow() {
    layoutSaveTimer = null;
    if (!layoutReady || !vcd) return;
    const layout = captureLayout();
    if (!layout) return;
    const serialized = JSON.stringify(layout);
    if (serialized === lastSavedLayoutJson) return;
    try {
        if (isVsCodeHost) {
            vscode.setState({ layout });
            vscode.postMessage({ type: 'saveLayout', layout });
        } else {
            localStorage.setItem(localLayoutKey(), serialized);
        }
        lastSavedLayoutJson = serialized;
    } catch (_error) {
        showLayoutStorageWarning('Waveform layout save is unavailable.');
    }
}

function scheduleLayoutSave() {
    if (!layoutReady || !vcd) return;
    if (layoutSaveTimer !== null) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(persistLayoutNow, 250);
}

function groupRowFromLayout(row, id) {
    const name = typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : 'Group';
    return {
        kind: 'group',
        id,
        key: '__group__' + id,
        name,
        displayName: name,
        expanded: row.expanded !== false,
        color: '#888888',
    };
}

function restoreLayout(layout, renderAfter = true) {
    if (!vcd || !waveCore) return false;
    const validated = waveCore.validateLayout(layout);
    if (!validated) return false;

    const signalRows = validated.rows.filter(row => row.kind === 'signal' && row.signal && typeof row.signal === 'object');
    const signalIndices = waveCore.matchSignalDescriptors(
        signalRows.map(row => row.signal),
        allSignals
    );
    let matchedSignalIndex = 0;
    const groupIdMap = new Map();
    let restoredGroupIndex = 1;
    validated.rows.forEach(row => {
        if (row.kind !== 'group') return;
        const sourceId = typeof row.id === 'string' ? row.id : '__group_' + restoredGroupIndex;
        if (!groupIdMap.has(sourceId)) {
            groupIdMap.set(sourceId, 'group-' + restoredGroupIndex++);
        }
    });

    const restored = [];
    validated.rows.forEach(row => {
        if (row.kind === 'group') {
            const sourceId = typeof row.id === 'string' ? row.id : '__group_' + (restored.length + 1);
            const restoredId = groupIdMap.get(sourceId);
            if (restoredId) restored.push(groupRowFromLayout(row, restoredId));
            return;
        }
        if (row.kind !== 'signal' || !row.signal || typeof row.signal !== 'object') return;
        const allSignalIndex = signalIndices[matchedSignalIndex++];
        if (allSignalIndex === null || allSignalIndex === undefined) return;
        const source = allSignals[allSignalIndex];
        const groupId = typeof row.groupId === 'string'
            ? groupIdMap.get(row.groupId) || ''
            : '';
        const item = makeWaveSignal(source, groupId);
        if (typeof row.color === 'string' && /^#[0-9a-f]{6}$/i.test(row.color)) {
            item.color = row.color;
        }
        if (RADIXES.some(radix => radix.key === row.radix)) item.radix = row.radix;
        if (row.nameMode === 'full' || row.nameMode === 'short') item.nameMode = row.nameMode;
        if (typeof row.displayName === 'string') item.displayName = row.displayName.slice(0, 256);
        item.busExpanded = !!row.busExpanded && item.width > 1;
        restored.push(item);
        syncLibrarySignal(item);
    });
    waveSignals = restored;
    nextGroupId = Math.max(1, restoredGroupIndex);
    selectedWaveIndex = waveSignals.findIndex(isBaseWaveSignal);
    selectedWaveIndices = selectedWaveIndex >= 0 ? new Set([selectedWaveIndex]) : new Set();

    const minTime = Number(vcd.startTime) || 0;
    const maxTime = Math.max(minTime + 1, Number(vcd.endTime) || 1);
    const view = validated.view || {};
    const restoredStart = Number(view.startTime);
    const restoredEnd = Number(view.endTime);
    startTime = Number.isFinite(restoredStart)
        ? clamp(restoredStart, minTime, maxTime - 1)
        : minTime;
    endTime = Number.isFinite(restoredEnd)
        ? clamp(restoredEnd, startTime + 1, maxTime)
        : maxTime;
    waveScrollTop = Number.isFinite(Number(view.waveScrollTop))
        ? Math.max(0, Number(view.waveScrollTop))
        : 0;

    const mainWidth = document.querySelector('.main')?.getBoundingClientRect().width || 1000;
    const waveWidth = waveWrap.getBoundingClientRect().width || 700;
    if (Number.isFinite(Number(view.libraryWidth))) {
        setCssPx('--library-width', clamp(Number(view.libraryWidth), 160, Math.max(180, mainWidth - 220)));
    }
    if (Number.isFinite(Number(view.waveNameWidth))) {
        setCssPx('--wave-name-width', clamp(Number(view.waveNameWidth), 86, Math.max(96, waveWidth - 180)));
    }

    const cursorA = Number(validated.cursors?.a);
    cursorTime = Number.isFinite(cursorA) ? clamp(cursorA, minTime, maxTime) : minTime;
    renderSignalList();
    if (renderAfter) render();
    return true;
}

function resizeCanvas() {
    const rect = waveCanvasPane.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
}

function setEmptyState() {
    layoutReady = false;
    if (layoutSaveTimer !== null) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
    lastSavedLayoutJson = '';
    vcd = null;
    currentFileName = '';
    allSignals = [];
    filteredSignals = [];
    waveSignals = [];
    selectedLibraryIndex = 0;
    selectedWaveIndex = -1;
    selectedWaveIndices = new Set();
    listFirstRow = 0;
    listRenderedCount = 0;
    waveFirstRow = 0;
    waveScrollTop = 0;
    nextGroupId = 1;
    startTime = 0;
    endTime = 1;
    cursorTime = 0;
    fileTitle.textContent = 'No waveform file opened';
    searchInput.value = '';
    scopeSelect.innerHTML = '<option value="">No waveform file</option>';
    signalList.scrollTop = 0;
    renderSignalList();
    statusText.textContent = 'No waveform file opened';
    cursorText.textContent = 'Cursor: -';
    rangeText.textContent = 'Range: -';
    render();
}

function setData(fileName, data, messageLayout = null) {
    layoutReady = false;
    if (layoutSaveTimer !== null) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
    lastSavedLayoutJson = '';
    layoutStorageWarningShown = false;
    vcd = data;
    currentFileName = String(fileName || '');
    fileTitle.textContent = fileName;
    allSignals = (data.signals || []).map((signal, index) => ({
        ...signal,
        key: stableSignalKey(signal) + '|' + index,
        color: DEFAULT_WAVE_COLOR,
        radix: 'default',
        displayName: '',
    }));
    filteredSignals = [];
    waveSignals = [];
    selectedLibraryIndex = 0;
    selectedWaveIndex = -1;
    selectedWaveIndices = new Set();
    waveScrollTop = 0;
    nextGroupId = 1;
    startTime = data.startTime || 0;
    endTime = Math.max(1, data.endTime || 1);
    cursorTime = startTime;
    renderScopeSelect();
    applyFilter();
    const restoredLayout = restoreLayout(loadHostLayout(messageLayout), false);
    updateEmptyState();
    const warningText = data.warnings && data.warnings.length
        ? ', ' + data.warnings.length + ' parser warning' + (data.warnings.length === 1 ? '' : 's')
        : '';
    statusText.textContent = data.timescale
        ? allSignals.length + ' signals, 0 waveforms, timescale ' + data.timescale + warningText
        : allSignals.length + ' signals, 0 waveforms' + warningText;
    layoutReady = true;
    const currentLayout = captureLayout();
    lastSavedLayoutJson = currentLayout ? JSON.stringify(currentLayout) : '';
    render();
    if (restoredLayout) {
        setStatus('Restored saved waveform layout.');
    }
}

function applyFilter() {
    const query = searchInput.value.trim().toLowerCase();
    const selectedScope = scopeSelect.value;
    filteredSignals = allSignals.filter(signal => {
        const matchesScope = !selectedScope || signal.scope === selectedScope || signal.scope.startsWith(selectedScope + '.');
        const matchesQuery = !query || signal.fullName.toLowerCase().includes(query) || signal.reference.toLowerCase().includes(query);
        return matchesScope && matchesQuery;
    });
    selectedLibraryIndex = clamp(selectedLibraryIndex, 0, Math.max(0, filteredSignals.length - 1));
    signalList.scrollTop = 0;
    renderSignalList();
    render();
}

function renderScopeSelect() {
    const scopes = Array.from(new Set(allSignals.map(signal => signal.scope).filter(Boolean))).sort();
    scopeSelect.innerHTML = '<option value="">All scopes</option>' + scopes
        .map(scope => '<option value="' + escapeHtml(scope) + '">' + escapeHtml(scope) + '</option>')
        .join('');
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function dataTransferHas(dataTransfer, type) {
    return Array.from(dataTransfer?.types || []).includes(type);
}

function parseTimescaleUnit(timescale) {
    const match = String(timescale || '').trim().match(/(?:\d+\s*)?(fs|ps|ns|us|ms|s)\b/i);
    return match ? match[1].toLowerCase() : '';
}

function compactTimeUnit(maxAbsTime) {
    const baseUnit = parseTimescaleUnit(vcd?.timescale) || '';
    const baseIndex = TIME_UNITS.indexOf(baseUnit);
    if (baseIndex < 0) {
        return { factor: 1, unit: baseUnit };
    }

    let factor = 1;
    let unitIndex = baseIndex;
    let scaled = Math.abs(maxAbsTime);
    while (scaled >= 1000 && unitIndex < TIME_UNITS.length - 1) {
        scaled /= 1000;
        factor *= 1000;
        unitIndex++;
    }
    return { factor, unit: TIME_UNITS[unitIndex] };
}

function formatScaledNumber(value) {
    if (!Number.isFinite(value)) return '0';
    const abs = Math.abs(value);
    if (abs >= 100) return String(Math.round(value));
    if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
    if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/, '');
    return value.toFixed(3).replace(/\.?0+$/, '');
}

function formatTime(time, scale = null) {
    const resolved = scale || compactTimeUnit(Math.max(Math.abs(startTime), Math.abs(endTime), Math.abs(time)));
    const scaled = time / resolved.factor;
    return formatScaledNumber(scaled) + (resolved.unit ? ' ' + resolved.unit : '');
}

function formatRange(start, end) {
    const scale = compactTimeUnit(Math.max(Math.abs(start), Math.abs(end)));
    return formatTime(start, scale) + ' - ' + formatTime(end, scale);
}

function signalTypeText(signal) {
    return signal.width > 1 ? signal.type + '[' + signal.width + ']' : signal.type;
}

function isGroupRow(item) {
    return item?.kind === 'group';
}

function isBusBitRow(item) {
    return item?.kind === 'bus-bit';
}

function isBaseWaveSignal(item) {
    return item && !isGroupRow(item) && !isBusBitRow(item);
}

function isExpandableBus(item) {
    return isBaseWaveSignal(item) && item.width > 1;
}

function selectedScopeName() {
    return scopeSelect.value || '';
}

function scopeLabel(scope) {
    return scope || 'All scopes';
}

function renderSignalList() {
    const savedScrollTop = signalList.scrollTop;
    signalList.innerHTML = '';
    if (!vcd) {
        const placeholder = document.createElement('div');
        placeholder.className = 'signal-list-placeholder';
        placeholder.textContent = 'No waveform file opened.';
        signalList.appendChild(placeholder);
        return;
    }
    const totalHeight = filteredSignals.length * ROW_HEIGHT;
    const viewportHeight = signalList.clientHeight || ROW_HEIGHT * 16;
    const overscan = 4;
    listFirstRow = clamp(
        Math.floor(signalList.scrollTop / ROW_HEIGHT) - overscan,
        0,
        Math.max(0, filteredSignals.length - 1)
    );
    listRenderedCount = Math.min(
        filteredSignals.length - listFirstRow,
        Math.ceil(viewportHeight / ROW_HEIGHT) + overscan * 2
    );

    const spacer = document.createElement('div');
    spacer.className = 'signal-list-spacer';
    spacer.style.height = totalHeight + 'px';

    const windowEl = document.createElement('div');
    windowEl.className = 'signal-list-window';
    windowEl.style.transform = 'translateY(' + (listFirstRow * ROW_HEIGHT) + 'px)';

    for (let offset = 0; offset < listRenderedCount; offset++) {
        const index = listFirstRow + offset;
        const signal = filteredSignals[index];
        const row = document.createElement('div');
        row.className = 'signal-row' + (index === selectedLibraryIndex ? ' selected' : '') + (isWaveVisible(signal) ? ' visible' : '');
        row.dataset.index = String(index);
        row.draggable = true;
        row.title = signal.fullName + '\nDrag into the waveform area or right-click to add.';
        row.onclick = () => {
            selectedLibraryIndex = index;
            renderSignalList();
        };
        row.ondblclick = () => addSignalToWaveform(signal);
        row.oncontextmenu = (event) => {
            event.preventDefault();
            selectedLibraryIndex = index;
            renderSignalList();
            showLibrarySignalMenu(event.clientX, event.clientY, signal);
        };
        row.ondragstart = (event) => {
            event.dataTransfer.setData('text/plain', signal.key);
            event.dataTransfer.effectAllowed = 'copy';
            row.classList.add('dragging');
        };
        row.ondragend = () => row.classList.remove('dragging');

        const color = document.createElement('div');
        color.className = 'signal-color';
        color.style.background = isWaveVisible(signal) ? DEFAULT_WAVE_COLOR : 'transparent';

        const title = document.createElement('div');
        title.className = 'signal-title';

        const name = document.createElement('div');
        name.className = 'signal-name';
        name.textContent = signal.reference;

        const scope = document.createElement('div');
        scope.className = 'signal-scope';
        scope.textContent = signal.scope || '(root)';

        const meta = document.createElement('div');
        meta.className = 'signal-meta';
        const value = document.createElement('div');
        value.className = 'signal-value';
        value.textContent = currentValueText(signal);
        const width = document.createElement('div');
        width.textContent = signalTypeText(signal);

        title.appendChild(name);
        title.appendChild(scope);
        meta.appendChild(value);
        meta.appendChild(width);
        row.appendChild(color);
        row.appendChild(title);
        row.appendChild(meta);
        windowEl.appendChild(row);
    }

    signalList.appendChild(spacer);
    signalList.appendChild(windowEl);
    if (Math.abs(signalList.scrollTop - savedScrollTop) > 0.5) {
        signalList.scrollTop = savedScrollTop;
    }
}

function renderWaveNameList() {
    waveNameList.innerHTML = '';
    const displayItems = displayedWaveItems();
    const totalHeight = displayItems.length * ROW_HEIGHT;
    const viewportHeight = waveNameList.clientHeight || ROW_HEIGHT * 16;
    const maxRows = Math.max(1, Math.ceil(viewportHeight / ROW_HEIGHT) + 1);
    const maxFirstRow = Math.max(0, displayItems.length - maxRows);
    waveScrollTop = clamp(waveScrollTop, 0, Math.max(0, totalHeight - viewportHeight));
    waveFirstRow = Math.max(0, Math.min(Math.floor(waveScrollTop / ROW_HEIGHT), maxFirstRow));
    const rowOffset = -(waveScrollTop % ROW_HEIGHT);
    const rows = displayItems.slice(waveFirstRow, waveFirstRow + maxRows);

    const spacer = document.createElement('div');
    spacer.className = 'signal-list-spacer';
    spacer.style.height = totalHeight + 'px';

    const windowEl = document.createElement('div');
    windowEl.className = 'wave-name-list-window';
    windowEl.style.transform = 'translateY(' + rowOffset + 'px)';

    rows.forEach((signal, offset) => {
        const displayIndex = waveFirstRow + offset;
        const index = signal.waveIndex;
        const isSelectedRow = !isBusBitRow(signal) && (index === selectedWaveIndex || selectedWaveIndices.has(index));
        const row = document.createElement('div');
        row.className = 'wave-name-row'
            + (isGroupRow(signal) ? ' group-row' : '')
            + (isBusBitRow(signal) ? ' bus-bit-row' : '')
            + (index === selectedWaveIndex && !isBusBitRow(signal) ? ' selected' : '')
            + (isSelectedRow && selectedWaveIndices.has(index) ? ' multi-selected' : '');
        row.dataset.index = String(index);
        row.draggable = !isBusBitRow(signal) && isBaseWaveSignal(waveSignals[index]);
        row.title = signal.fullName;
        row.onclick = (event) => {
            if (isGroupRow(signal)) {
                selectWaveSignal(index, false);
                toggleGroup(index);
            } else {
                selectWaveSignal(index, event.ctrlKey || event.metaKey);
            }
        };
        row.oncontextmenu = (event) => {
            event.preventDefault();
            if (!selectedWaveIndices.has(index)) {
                selectWaveSignal(index, false);
            }
            showWaveSignalMenu(event.clientX, event.clientY, signal, index);
        };
        row.ondragstart = (event) => {
            if (isBusBitRow(signal) || !isBaseWaveSignal(waveSignals[index])) {
                event.preventDefault();
                return;
            }
            const dragIndices = baseWaveIndicesForAction(index);
            event.dataTransfer.setData('text/wave-index', String(index));
            event.dataTransfer.setData('text/wave-indices', JSON.stringify(dragIndices));
            event.dataTransfer.effectAllowed = 'move';
        };
        row.ondragover = (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        };
        row.ondrop = (event) => {
            event.preventDefault();
            const from = Number.parseInt(event.dataTransfer.getData('text/wave-index'), 10);
            if (!Number.isNaN(from)) {
                let indices = [from];
                try {
                    const parsed = JSON.parse(event.dataTransfer.getData('text/wave-indices') || '[]');
                    if (Array.isArray(parsed) && parsed.length) {
                        indices = parsed;
                    }
                } catch {
                    indices = [from];
                }
                moveWaveSignalsToIndex(indices, index);
            }
        };

        if (isGroupRow(signal)) {
            const group = document.createElement('div');
            group.className = 'wave-name-group';
            group.textContent = (signal.expanded ? 'v ' : '> ') + waveNameText(signal);
            row.appendChild(group);
        } else {
            const color = document.createElement('div');
            color.className = 'signal-color';
            color.style.background = signal.color;

            const title = document.createElement('div');
            title.className = 'wave-name-title';
            const name = document.createElement('div');
            name.className = 'wave-name-text';
            if (!isBusBitRow(signal) && isExpandableBus(waveSignals[index])) {
                const toggle = document.createElement('button');
                toggle.className = 'bus-toggle';
                toggle.type = 'button';
                toggle.textContent = waveSignals[index].busExpanded ? '-' : '+';
                toggle.title = waveSignals[index].busExpanded ? 'Collapse bus bits' : 'Expand bus bits';
                toggle.onclick = (event) => {
                    event.stopPropagation();
                    toggleBusExpanded(index);
                };
                name.appendChild(toggle);
            }
            const label = document.createElement('span');
            label.textContent = waveNameText(signal);
            name.appendChild(label);

            title.appendChild(name);
            row.appendChild(color);
            row.appendChild(title);
        }
        windowEl.appendChild(row);
    });

    waveNameList.appendChild(spacer);
    waveNameList.appendChild(windowEl);
}

function displayedWaveItems() {
    const collapsedGroups = new Set(waveSignals.filter(isGroupRow).filter(item => !item.expanded).map(item => item.id));
    const items = [];
    waveSignals.forEach((item, waveIndex) => {
        if (!isGroupRow(item) && item.groupId && collapsedGroups.has(item.groupId)) {
            return;
        }

        items.push({ ...item, waveIndex });
        if (isExpandableBus(item) && item.busExpanded) {
            for (let bit = item.width - 1; bit >= 0; bit--) {
                items.push(makeBusBitRow(item, waveIndex, bit));
            }
        }
    });
    return items;
}

function displayName(signal) {
    return signal.displayName || signal.reference;
}

function signalShortName(signal) {
    return signal.displayName || signal.reference;
}

function signalFullName(signal) {
    return signal.fullName || signal.reference;
}

function waveNameText(signal) {
    if (isGroupRow(signal)) return displayName(signal);
    return signal.nameMode === 'full' ? signalFullName(signal) : signalShortName(signal);
}

function isWaveVisible(signal) {
    return waveSignals.some(item => isBaseWaveSignal(item) && item.key === signal.key);
}

function makeWaveSignal(signal, groupId = '') {
    return {
        ...signal,
        color: signal.color || DEFAULT_WAVE_COLOR,
        radix: signal.radix || 'default',
        nameMode: signal.nameMode || 'short',
        groupId,
        busExpanded: false,
    };
}

function makeBusBitRow(signal, waveIndex, bitIndex) {
    return {
        ...signal,
        kind: 'bus-bit',
        key: signal.key + '__bit_' + bitIndex,
        reference: '[' + bitIndex + ']',
        displayName: '[' + bitIndex + ']',
        fullName: signal.fullName + '[' + bitIndex + ']',
        width: 1,
        parentWidth: signal.width,
        parentKey: signal.key,
        parentWaveIndex: waveIndex,
        bitIndex,
        waveIndex,
    };
}

function createGroupRow(name) {
    const id = 'group-' + nextGroupId++;
    return {
        kind: 'group',
        id,
        key: '__group__' + id,
        name,
        displayName: name,
        expanded: true,
        color: '#888888',
    };
}

function signalMatchesScope(signal, scope, includeSubScopes) {
    if (!scope) return true;
    return includeSubScopes
        ? signal.scope === scope || signal.scope.startsWith(scope + '.')
        : signal.scope === scope;
}

function scopeSignals(scope, includeSubScopes) {
    return allSignals.filter(signal => signalMatchesScope(signal, scope, includeSubScopes));
}

function addSignalToWaveform(signal, targetIndex = waveSignals.length) {
    if (!vcd || !signal || isWaveVisible(signal)) {
        setStatus(signal ? displayName(signal) + ' is already in the waveform.' : 'No signal selected.');
        return;
    }
    const item = makeWaveSignal(signal);
    const index = clamp(targetIndex, 0, waveSignals.length);
    waveSignals.splice(index, 0, item);
    selectedWaveIndex = index;
    selectedWaveIndices = new Set([index]);
    syncLibrarySignal(item);
    renderSignalList();
    render();
    setStatus('Added ' + displayName(item) + ' to waveform.');
}

function addFilteredSignalsToWaveform() {
    let count = 0;
    filteredSignals.forEach(signal => {
        if (!isWaveVisible(signal)) {
            waveSignals.push(makeWaveSignal(signal));
            count++;
        }
    });
    if (count > 0) {
        selectedWaveIndex = waveSignals.length - 1;
        selectedWaveIndices = new Set([selectedWaveIndex]);
        renderSignalList();
        render();
    }
    setStatus(count + ' signal' + (count === 1 ? '' : 's') + ' added from current list.');
}

function addScopeSignalsToWaveform(scope, includeSubScopes, grouped) {
    if (!vcd) return;
    const candidates = scopeSignals(scope, includeSubScopes);
    if (!candidates.length) {
        setStatus('No signals found in ' + scopeLabel(scope) + '.');
        return;
    }

    let count = 0;
    let group = null;
    if (grouped) {
        group = createGroupRow(scopeLabel(scope));
        waveSignals.push(group);
    }

    candidates.forEach(signal => {
        if (!isWaveVisible(signal)) {
            waveSignals.push(makeWaveSignal(signal, group?.id || ''));
            count++;
        }
    });

    if (group && count === 0) {
        waveSignals = waveSignals.filter(item => item !== group);
    }

    if (count > 0) {
        selectedWaveIndex = grouped ? waveSignals.findIndex(item => item === group) : waveSignals.length - 1;
        selectedWaveIndices = new Set([selectedWaveIndex]);
        renderSignalList();
        render();
    }

    const suffix = includeSubScopes ? ' including subscopes' : '';
    const grouping = grouped ? ' as group' : '';
    setStatus('Added ' + count + ' signal' + (count === 1 ? '' : 's') + ' from ' + scopeLabel(scope) + suffix + grouping + '.');
}

function removeWaveSignals(indices) {
    const targets = new Set();
    Array.from(indices)
        .filter(index => index >= 0 && index < waveSignals.length)
        .forEach(index => {
            targets.add(index);
            const item = waveSignals[index];
            if (isGroupRow(item)) {
                waveSignals.forEach((candidate, candidateIndex) => {
                    if (isBaseWaveSignal(candidate) && candidate.groupId === item.id) {
                        targets.add(candidateIndex);
                    }
                });
            }
        });
    const sorted = Array.from(targets).sort((a, b) => b - a);
    if (!sorted.length) return;
    const removedSignals = sorted.filter(index => isBaseWaveSignal(waveSignals[index])).length;
    const removedGroups = sorted.length - removedSignals;
    sorted.forEach(index => waveSignals.splice(index, 1));
    selectedWaveIndex = clamp(Math.min(...sorted), -1, waveSignals.length - 1);
    selectedWaveIndices = selectedWaveIndex >= 0 ? new Set([selectedWaveIndex]) : new Set();
    renderSignalList();
    render();
    const groupText = removedGroups ? ', ' + removedGroups + ' group' + (removedGroups === 1 ? '' : 's') : '';
    setStatus('Removed ' + removedSignals + ' waveform signal' + (removedSignals === 1 ? '' : 's') + groupText + '.');
}

function selectedBaseWaveIndices(fallbackIndex = selectedWaveIndex) {
    const indices = selectedWaveIndices.size ? Array.from(selectedWaveIndices) : [fallbackIndex];
    const result = [];
    const seen = new Set();
    indices
        .filter(index => index >= 0 && index < waveSignals.length)
        .sort((a, b) => a - b)
        .forEach(index => {
            if (isBaseWaveSignal(waveSignals[index]) && !seen.has(index)) {
                seen.add(index);
                result.push(index);
            }
        });
    return result;
}

function baseWaveIndicesForAction(fallbackIndex = selectedWaveIndex) {
    if (fallbackIndex >= 0 && selectedWaveIndices.has(fallbackIndex)) {
        return selectedBaseWaveIndices(fallbackIndex);
    }
    return isBaseWaveSignal(waveSignals[fallbackIndex]) ? [fallbackIndex] : [];
}

function baseWaveIndicesFromIndices(indices) {
    return Array.from(new Set(indices || []))
        .filter(index => index >= 0 && index < waveSignals.length && isBaseWaveSignal(waveSignals[index]))
        .sort((a, b) => a - b);
}

function selectedWaveCount(fallbackIndex = selectedWaveIndex) {
    return baseWaveIndicesForAction(fallbackIndex).length;
}

function setSelection(indices) {
    const normalized = indices
        .filter(index => index >= 0 && index < waveSignals.length && isBaseWaveSignal(waveSignals[index]))
        .sort((a, b) => a - b);
    selectedWaveIndices = new Set(normalized);
    selectedWaveIndex = normalized.length ? normalized[0] : -1;
}

function removeSignalFromWaveform(signal) {
    const index = waveSignals.findIndex(item => item.key === signal.key);
    if (index >= 0) {
        removeWaveSignals(new Set([index]));
    }
}

function clearWaveforms() {
    if (!waveSignals.length) return;
    waveSignals = [];
    selectedWaveIndex = -1;
    selectedWaveIndices = new Set();
    waveScrollTop = 0;
    renderSignalList();
    render();
    setStatus('Cleared waveform list.');
}

function waveformCount() {
    return waveSignals.filter(isBaseWaveSignal).length;
}

function displayIndexForWaveIndex(waveIndex) {
    return displayedWaveItems().findIndex(item => item.waveIndex === waveIndex);
}

function waveIndexForDisplayIndex(displayIndex) {
    const item = displayedWaveItems()[displayIndex];
    return item ? item.waveIndex : -1;
}

function waveInsertIndexForDisplayIndex(displayIndex) {
    const item = displayedWaveItems()[displayIndex];
    if (!item) return waveSignals.length;
    if (isGroupRow(item)) {
        let index = item.waveIndex + 1;
        while (index < waveSignals.length && !isGroupRow(waveSignals[index]) && waveSignals[index].groupId === item.id) {
            index++;
        }
        return index;
    }
    if (isBusBitRow(item)) return item.waveIndex + 1;
    return item.waveIndex;
}

function toggleGroup(index) {
    const group = waveSignals[index];
    if (!isGroupRow(group)) return;
    group.expanded = !group.expanded;
    render();
}

function toggleBusExpanded(index) {
    const signal = waveSignals[index];
    if (!isExpandableBus(signal)) return;
    signal.busExpanded = !signal.busExpanded;
    render();
}

function moveWaveSignal(from, to) {
    if (from === to || from < 0 || to < 0 || from >= waveSignals.length || to >= waveSignals.length) return;
    if (!isBaseWaveSignal(waveSignals[from]) || !isBaseWaveSignal(waveSignals[to])) return;
    const [item] = waveSignals.splice(from, 1);
    waveSignals.splice(to, 0, item);
    selectedWaveIndex = to;
    selectedWaveIndices = new Set([to]);
    render();
}

function moveWaveSignalsToIndex(indices, targetIndex) {
    const movingIndices = Array.from(new Set(indices))
        .filter(index => index >= 0 && index < waveSignals.length && isBaseWaveSignal(waveSignals[index]))
        .sort((a, b) => a - b);
    if (!movingIndices.length || movingIndices.includes(targetIndex)) return;
    if (targetIndex < 0 || targetIndex >= waveSignals.length || !isBaseWaveSignal(waveSignals[targetIndex])) return;

    const movingSet = new Set(movingIndices);
    const movingItems = movingIndices.map(index => waveSignals[index]);
    const targetItem = waveSignals[targetIndex] || null;
    const remaining = waveSignals.filter((_, index) => !movingSet.has(index));
    const targetRemainingIndex = targetItem ? remaining.indexOf(targetItem) : -1;
    let insertIndex = targetRemainingIndex < 0
        ? remaining.length
        : targetIndex > movingIndices[0] ? targetRemainingIndex + 1 : targetRemainingIndex;
    remaining.splice(clamp(insertIndex, 0, remaining.length), 0, ...movingItems);
    waveSignals = remaining;
    setSelection(movingItems.map(item => waveSignals.indexOf(item)));
    render();
    setStatus('Moved ' + movingItems.length + ' waveform signal' + (movingItems.length === 1 ? '' : 's') + '.');
}

function moveSelectedWaves(delta, fallbackIndex = selectedWaveIndex) {
    const selected = baseWaveIndicesForAction(fallbackIndex);
    if (!selected.length) return;
    if (selected.length <= 1) {
        moveWaveSignalByDelta(selected[0], delta);
        return;
    }

    const movingItems = selected.map(index => waveSignals[index]);
    const movingSet = new Set(movingItems);
    let moved = false;
    if (delta < 0) {
        movingItems.forEach(item => {
            const index = waveSignals.indexOf(item);
            if (index > 0 && isBaseWaveSignal(waveSignals[index - 1]) && !movingSet.has(waveSignals[index - 1])) {
                [waveSignals[index - 1], waveSignals[index]] = [waveSignals[index], waveSignals[index - 1]];
                moved = true;
            }
        });
    } else {
        [...movingItems].reverse().forEach(item => {
            const index = waveSignals.indexOf(item);
            if (index >= 0 && index < waveSignals.length - 1 && isBaseWaveSignal(waveSignals[index + 1]) && !movingSet.has(waveSignals[index + 1])) {
                [waveSignals[index + 1], waveSignals[index]] = [waveSignals[index], waveSignals[index + 1]];
                moved = true;
            }
        });
    }
    if (!moved) return;
    setSelection(movingItems.map(item => waveSignals.indexOf(item)));
    render();
    setStatus('Moved ' + movingItems.length + ' waveform signal' + (movingItems.length === 1 ? '' : 's') + '.');
}

function moveWaveSignalByDelta(index, delta) {
    if (index < 0) return;
    if (!isBaseWaveSignal(waveSignals[index])) return;
    const target = clamp(index + delta, 0, waveSignals.length - 1);
    if (!isBaseWaveSignal(waveSignals[target])) return;
    moveWaveSignal(index, target);
}

function moveSelectedWave(delta) {
    moveWaveSignalByDelta(selectedWaveIndex, delta);
}

function canMoveWaveSignal(index, delta) {
    const selected = baseWaveIndicesForAction(index);
    if (selected.length > 1) {
        const selectedSet = new Set(selected);
        if (delta < 0) {
            return selected.some(selectedIndex => selectedIndex > 0 && isBaseWaveSignal(waveSignals[selectedIndex - 1]) && !selectedSet.has(selectedIndex - 1));
        }
        return selected.some(selectedIndex => selectedIndex < waveSignals.length - 1 && isBaseWaveSignal(waveSignals[selectedIndex + 1]) && !selectedSet.has(selectedIndex + 1));
    }
    if (!selected.length) {
        return false;
    }
    const source = selected[0];
    const target = clamp(source + delta, 0, waveSignals.length - 1);
    return source !== target && isBaseWaveSignal(waveSignals[source]) && isBaseWaveSignal(waveSignals[target]);
}

function syncLibrarySignal(signal) {
    if (!isBaseWaveSignal(signal)) return;
    const original = allSignals.find(item => item.key === signal.key);
    if (original) {
        original.color = signal.color;
        original.radix = signal.radix;
        original.displayName = signal.displayName;
        original.nameMode = signal.nameMode;
    }
}

function updateEmptyState() {
    if (!vcd) {
        emptyState.style.display = 'flex';
        emptyState.textContent = 'No waveform file opened.';
    } else if (!allSignals.length) {
        emptyState.style.display = 'flex';
        emptyState.textContent = 'No signals found in this VCD file.';
    } else if (!waveformCount()) {
        emptyState.style.display = 'flex';
        emptyState.textContent = 'Add signals by dragging from the left list or using the right-click menu.';
    } else {
        emptyState.style.display = 'none';
        emptyState.textContent = '';
    }
}

function setStatus(text) {
    if (!vcd) {
        statusText.textContent = text;
        return;
    }
    const warningText = vcd.warnings && vcd.warnings.length
        ? ', ' + vcd.warnings.length + ' warning' + (vcd.warnings.length === 1 ? '' : 's')
        : '';
    statusText.textContent = allSignals.length + ' signals, ' + waveformCount() + ' waveforms'
        + (vcd.timescale ? ', timescale ' + vcd.timescale : '')
        + warningText
        + (text ? ' - ' + text : '');
}

function timeToX(time, width) {
    const range = Math.max(1, endTime - startTime);
    return ((time - startTime) / range) * width;
}

function xToTime(x, width) {
    const range = Math.max(1, endTime - startTime);
    return Math.round(startTime + (x / Math.max(1, width)) * range);
}

function snap(value) {
    return Math.round(value) + 0.5;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function setCssPx(name, value) {
    document.documentElement.style.setProperty(name, Math.round(value) + 'px');
}

function startColumnResize(handle, onMove) {
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        hideContextMenu();
        const startX = event.clientX;
        const cleanup = () => {
            handle.classList.remove('dragging');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', cleanup);
            window.removeEventListener('pointercancel', cleanup);
            resizeCanvas();
        };
        const move = (moveEvent) => {
            onMove(moveEvent.clientX, startX);
            resizeCanvas();
        };
        handle.classList.add('dragging');
        handle.setPointerCapture?.(event.pointerId);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', cleanup);
        window.addEventListener('pointercancel', cleanup);
    });
}

function installResizers() {
    startColumnResize(mainResize, (clientX) => {
        const mainRect = document.querySelector('.main')?.getBoundingClientRect();
        if (!mainRect) return;
        const maxWidth = Math.max(180, mainRect.width - 220);
        setCssPx('--library-width', clamp(clientX - mainRect.left, 160, maxWidth));
    });
    startColumnResize(waveNameResize, (clientX) => {
        const rect = waveWrap.getBoundingClientRect();
        const maxWidth = Math.max(96, rect.width - 180);
        setCssPx('--wave-name-width', clamp(clientX - rect.left, 86, maxWidth));
    });
}

function visibleRange(changes, start, end) {
    if (!changes.length) return [0, 0];
    let lo = 0;
    let hi = changes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (changes[mid].time < start) lo = mid + 1;
        else hi = mid;
    }
    let startIndex = Math.max(0, lo - 1);
    lo = 0;
    hi = changes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (changes[mid].time <= end) lo = mid + 1;
        else hi = mid;
    }
    let endIndex = Math.min(changes.length, Math.max(lo, startIndex + 1));
    return [startIndex, endIndex];
}

function isUnknown(value) {
    return /x/i.test(value);
}

function isHighZ(value) {
    return /z/i.test(value);
}

function signalPen(signal, value) {
    if (isUnknown(value)) return STYLE.unknown;
    if (isHighZ(value)) return STYLE.highZ;
    return signal.color || DEFAULT_WAVE_COLOR;
}

function valueY(value, highY, lowY) {
    if (value === '1') return highY;
    if (value === '0' || value === 'z') return lowY;
    if (value.length > 1) return value.includes('1') ? highY : lowY;
    return (highY + lowY) / 2;
}

function normalizeBits(value) {
    return value.startsWith('b') ? value.slice(1) : value;
}

function bitValue(value, bitIndex, width) {
    const bits = normalizeBits(value || '').toLowerCase();
    if (!bits) return 'x';
    if (bits.length === 1) return bits;
    if (bitIndex < 0) return 'x';
    if (bitIndex >= bits.length) return '0';
    return bits[bits.length - 1 - bitIndex] || 'x';
}

function padLeftToWidth(bits, width) {
    const target = width > 0 ? width : bits.length;
    return bits.length >= target ? bits : '0'.repeat(target - bits.length) + bits;
}

function groupFromRight(value, groupSize) {
    if (value.length <= groupSize) return value;
    let first = value.length % groupSize;
    if (first === 0) first = groupSize;
    const groups = [value.slice(0, first)];
    for (let i = first; i < value.length; i += groupSize) {
        groups.push(value.slice(i, i + groupSize));
    }
    return groups.join(' ');
}

function formatBinary(bits, width) {
    return groupFromRight(padLeftToWidth(bits, width), 4);
}

function nibbleToHex(nibble) {
    let value = 0;
    for (const bit of nibble) {
        value = (value << 1) | (bit === '1' ? 1 : 0);
    }
    return value < 10 ? String(value) : String.fromCharCode('A'.charCodeAt(0) + value - 10);
}

function formatHex(bits, width) {
    let normalized = padLeftToWidth(bits, width);
    const pad = (4 - normalized.length % 4) % 4;
    if (pad > 0) normalized = '0'.repeat(pad) + normalized;
    let text = '';
    for (let i = 0; i < normalized.length; i += 4) {
        text += nibbleToHex(normalized.slice(i, i + 4));
    }
    return groupFromRight(text, 4);
}

function hexWithUnknowns(bits, unknownChar) {
    const pad = (4 - bits.length % 4) % 4;
    const padded = '0'.repeat(pad) + bits;
    let text = '';
    for (let i = 0; i < padded.length; i += 4) {
        const nibble = padded.slice(i, i + 4);
        if (/x|z/i.test(nibble)) {
            text += unknownChar;
        } else {
            text += nibbleToHex(nibble);
        }
    }
    return text;
}

function bitsToBigInt(bits, width = bits.length) {
    const normalized = padLeftToWidth(bits, width);
    if (!normalized || /x|z/i.test(normalized)) return null;
    try {
        return BigInt('0b' + normalized);
    } catch {
        return null;
    }
}

function busText(value, width, radix = 'default') {
    const bits = normalizeBits(value);
    if (!bits) return '?';
    const hasX = /x/i.test(bits);
    const hasZ = /z/i.test(bits);
    if (hasX && hasZ) return 'XZ';
    if (/x/i.test(bits) && /^x+$/i.test(bits)) return 'X';
    if (hasX) return hexWithUnknowns(bits, 'X');
    if (/z/i.test(bits) && /^z+$/i.test(bits)) return 'Z';
    if (hasZ) return hexWithUnknowns(bits, 'Z');

    const resolvedRadix = radix === 'default'
        ? (width <= 4 ? 'binary' : 'hex')
        : radix;
    const unsigned = bitsToBigInt(bits, width);
    if (unsigned === null) return bits;
    switch (resolvedRadix) {
        case 'binary':
            return formatBinary(bits, width);
        case 'signed':
            return unsigned.toString(10);
        case 'unsigned':
            return unsigned.toString(10);
        case 'octal':
            return unsigned.toString(8).toUpperCase();
        case 'hex':
            return formatHex(bits, width);
        default:
            return formatHex(bits, width);
    }
}

function valueAt(signal, time) {
    const changes = signal.changes || [];
    if (!changes.length) return '';
    let lo = 0;
    let hi = changes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (changes[mid].time <= time) lo = mid + 1;
        else hi = mid;
    }
    return changes[Math.max(0, lo - 1)].value;
}

function currentValueText(signal) {
    const value = valueAt(signal, cursorTime);
    if (!value) return '-';
    return signal.width > 1 ? busText(value, signal.width, signal.radix).toUpperCase() : value.toUpperCase();
}

function drawGrid(width, height) {
    const range = Math.max(1, endTime - startTime);
    const raw = range / 8;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const majorTick = Math.max(1, norm <= 1 ? mag : norm <= 2 ? 2 * mag : norm <= 5 ? 5 * mag : 10 * mag);
    const minorTick = Math.max(1, Math.floor(majorTick / 5));
    const firstMajor = Math.ceil(startTime / majorTick) * majorTick;
    const firstMinor = Math.ceil(startTime / minorTick) * minorTick;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(127,127,127,0.08)';
    for (let t = firstMinor; t <= endTime; t += minorTick) {
        if (t % majorTick === 0) continue;
        const x = snap(timeToX(t, width));
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(127,127,127,0.20)';
    ctx.fillStyle = STYLE.muted;
    ctx.font = '11px ' + getCss('--vscode-editor-font-family', 'monospace');
    const labelScale = compactTimeUnit(Math.max(Math.abs(startTime), Math.abs(endTime)));
    for (let t = firstMajor; t <= endTime; t += majorTick) {
        const x = snap(timeToX(t, width));
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillText(formatTime(Math.round(t), labelScale), x + 4, 14);
    }
    ctx.restore();
}

function drawHighFill(x1, x2, highY, lowY, color) {
    if (x2 - x1 <= 0.5) return;
    ctx.fillStyle = hexAlpha(color, 0.16);
    ctx.fillRect(x1, highY, x2 - x1, lowY - highY);
}

function hexAlpha(hex, alpha) {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function drawDenseBlock(signal, x1, x2, highY, lowY) {
    ctx.fillStyle = hexAlpha(signal.color, 0.38);
    ctx.strokeStyle = signal.color;
    ctx.lineWidth = 1.5;
    ctx.fillRect(x1, highY, Math.max(1, x2 - x1), lowY - highY);
    ctx.strokeRect(snap(x1), snap(highY), Math.max(1, x2 - x1), lowY - highY);
}

function drawSingleBit(signal, y, rowHeight, width) {
    const changes = signal.changes || [];
    if (!changes.length) return;
    const [startIdx, endIdx] = visibleRange(changes, startTime, endTime);
    const visibleCount = Math.max(0, endIdx - startIdx - 1);
    if (visibleCount > Math.max(64, width / 3)) {
        drawDenseBlock(signal, 0, width, y + rowHeight * 0.30, y + rowHeight * 0.70);
        return;
    }

    const highY = y + rowHeight * 0.30;
    const lowY = y + rowHeight * 0.70;
    let prev = changes[startIdx];
    let prevX = timeToX(prev.time, width);
    let prevY = valueY(prev.value, highY, lowY);
    ctx.lineWidth = 1.5;

    for (let i = startIdx + 1; i < endIdx; i++) {
        const cur = changes[i];
        const curX = timeToX(cur.time, width);
        const curY = valueY(cur.value, highY, lowY);
        const x1 = clamp(prevX, 0, width);
        const x2 = clamp(curX, 0, width);
        if (x2 > x1) {
            if (prev.value === '1') drawHighFill(x1, x2, highY, lowY, signal.color);
            ctx.strokeStyle = signalPen(signal, prev.value);
            ctx.beginPath();
            ctx.moveTo(snap(x1), snap(prevY));
            ctx.lineTo(snap(x2), snap(prevY));
            ctx.stroke();
        }
        if (curX >= 0 && curX <= width && Math.abs(curY - prevY) > 0.1) {
            ctx.strokeStyle = signalPen(signal, prev.value);
            ctx.beginPath();
            ctx.moveTo(snap(curX), snap(prevY));
            ctx.lineTo(snap(curX), snap(curY));
            ctx.stroke();
        }
        prev = cur;
        prevX = curX;
        prevY = curY;
    }

    const finalX = timeToX(endTime, width);
    const x1 = clamp(prevX, 0, width);
    const x2 = clamp(finalX, 0, width);
    if (x2 > x1) {
        if (prev.value === '1') drawHighFill(x1, x2, highY, lowY, signal.color);
        ctx.strokeStyle = signalPen(signal, prev.value);
        ctx.beginPath();
        ctx.moveTo(snap(x1), snap(prevY));
        ctx.lineTo(snap(x2), snap(prevY));
        ctx.stroke();
    }
}

function drawBusBit(signal, y, rowHeight, width) {
    const changes = signal.changes || [];
    if (!changes.length) return;
    const [startIdx, endIdx] = visibleRange(changes, startTime, endTime);
    const visibleCount = Math.max(0, endIdx - startIdx - 1);
    if (visibleCount > Math.max(64, width / 3)) {
        drawDenseBlock(signal, 0, width, y + rowHeight * 0.30, y + rowHeight * 0.70);
        return;
    }

    const highY = y + rowHeight * 0.30;
    const lowY = y + rowHeight * 0.70;
    let prev = changes[startIdx];
    let prevX = timeToX(prev.time, width);
    let prevValue = bitValue(prev.value, signal.bitIndex, signal.parentWidth || signal.width);
    let prevY = valueY(prevValue, highY, lowY);
    ctx.lineWidth = 1.5;

    for (let i = startIdx + 1; i < endIdx; i++) {
        const cur = changes[i];
        const curX = timeToX(cur.time, width);
        const curValue = bitValue(cur.value, signal.bitIndex, signal.parentWidth || signal.width);
        const curY = valueY(curValue, highY, lowY);
        const x1 = clamp(prevX, 0, width);
        const x2 = clamp(curX, 0, width);
        if (x2 > x1) {
            if (prevValue === '1') drawHighFill(x1, x2, highY, lowY, signal.color);
            ctx.strokeStyle = signalPen(signal, prevValue);
            ctx.beginPath();
            ctx.moveTo(snap(x1), snap(prevY));
            ctx.lineTo(snap(x2), snap(prevY));
            ctx.stroke();
        }
        if (curX >= 0 && curX <= width && Math.abs(curY - prevY) > 0.1) {
            ctx.strokeStyle = signalPen(signal, prevValue);
            ctx.beginPath();
            ctx.moveTo(snap(curX), snap(prevY));
            ctx.lineTo(snap(curX), snap(curY));
            ctx.stroke();
        }
        prev = cur;
        prevX = curX;
        prevValue = curValue;
        prevY = curY;
    }

    const finalX = timeToX(endTime, width);
    const x1 = clamp(prevX, 0, width);
    const x2 = clamp(finalX, 0, width);
    if (x2 > x1) {
        if (prevValue === '1') drawHighFill(x1, x2, highY, lowY, signal.color);
        ctx.strokeStyle = signalPen(signal, prevValue);
        ctx.beginPath();
        ctx.moveTo(snap(x1), snap(prevY));
        ctx.lineTo(snap(x2), snap(prevY));
        ctx.stroke();
    }
}

function busPath(x1, x2, highY, lowY) {
    const width = x2 - x1;
    const height = lowY - highY;
    const slant = Math.min(8, height * 0.20, Math.max(0.5, (width - 1) / 2));
    const midY = (highY + lowY) / 2;
    ctx.beginPath();
    ctx.moveTo(snap(x1 + slant), snap(highY));
    ctx.lineTo(snap(x2 - slant), snap(highY));
    ctx.lineTo(snap(x2), snap(midY));
    ctx.lineTo(snap(x2 - slant), snap(lowY));
    ctx.lineTo(snap(x1 + slant), snap(lowY));
    ctx.lineTo(snap(x1), snap(midY));
    ctx.closePath();
}

function drawBusSegment(signal, x1, x2, highY, lowY, value) {
    if (x2 - x1 <= 0.5) return;
    let drawX1 = clamp(x1, 0, canvas.clientWidth);
    let drawX2 = clamp(x2, 0, canvas.clientWidth);
    if (drawX2 - drawX1 > 0 && drawX2 - drawX1 < 5) {
        const center = (drawX1 + drawX2) / 2;
        drawX1 = clamp(center - 3, 0, canvas.clientWidth);
        drawX2 = clamp(center + 3, 0, canvas.clientWidth);
    }
    const segWidth = drawX2 - drawX1;
    if (segWidth <= 0.5) return;
    ctx.fillStyle = hexAlpha(signal.color, isUnknown(value) || isHighZ(value) ? 0.16 : 0.08);
    ctx.strokeStyle = signalPen(signal, value);
    ctx.lineWidth = 1.5;
    busPath(drawX1, drawX2, highY, lowY);
    ctx.fill();
    ctx.stroke();

    const text = busText(value, signal.width, signal.radix);
    if (segWidth > 30) {
        ctx.font = '11px ' + getCss('--vscode-editor-font-family', 'monospace');
        const tw = ctx.measureText(text).width;
        if (segWidth > tw + 12) {
            ctx.fillStyle = STYLE.busText;
            ctx.fillText(text, drawX1 + (segWidth - tw) / 2, highY + (lowY - highY) / 2 + 4);
        }
    }
}

function drawBus(signal, y, rowHeight, width) {
    const changes = signal.changes || [];
    if (!changes.length) return;
    const [startIdx, endIdx] = visibleRange(changes, startTime, endTime);
    const visibleCount = Math.max(0, endIdx - startIdx - 1);
    if (visibleCount > 0 && width / visibleCount < 8) {
        drawDenseBlock(signal, 0, width, y + rowHeight * 0.30, y + rowHeight * 0.70);
        return;
    }

    const highY = y + rowHeight * 0.28;
    const lowY = y + rowHeight * 0.72;
    let prev = changes[startIdx];
    let prevX = timeToX(prev.time, width);
    for (let i = startIdx + 1; i < endIdx; i++) {
        const cur = changes[i];
        const curX = timeToX(cur.time, width);
        drawBusSegment(signal, prevX, curX, highY, lowY, prev.value);
        prev = cur;
        prevX = curX;
    }
    drawBusSegment(signal, prevX, timeToX(endTime, width), highY, lowY, prev.value);
}

function drawRows(width, height) {
    const displayItems = displayedWaveItems();
    const maxRows = Math.max(1, Math.ceil((height - HEADER_HEIGHT) / ROW_HEIGHT) + 1);
    const maxFirstRow = Math.max(0, displayItems.length - maxRows);
    waveScrollTop = clamp(waveScrollTop, 0, Math.max(0, displayItems.length * ROW_HEIGHT - (height - HEADER_HEIGHT)));
    const firstRow = Math.max(0, Math.min(Math.floor(waveScrollTop / ROW_HEIGHT), maxFirstRow));
    const rowOffset = -(waveScrollTop % ROW_HEIGHT);
    const rows = displayItems.slice(firstRow, firstRow + maxRows);

    ctx.save();
    ctx.translate(0, HEADER_HEIGHT + rowOffset);
    rows.forEach((signal, index) => {
        const displayIndex = firstRow + index;
        const globalIndex = signal.waveIndex;
        const y = index * ROW_HEIGHT;
        if (displayIndex % 2 === 1) {
            ctx.fillStyle = 'rgba(102,168,119,0.06)';
            ctx.fillRect(0, y, width, ROW_HEIGHT);
        }
        if (isGroupRow(signal)) {
            ctx.fillStyle = 'rgba(127,127,127,0.11)';
            ctx.fillRect(0, y, width, ROW_HEIGHT);
            ctx.strokeStyle = 'rgba(127,127,127,0.20)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, snap(y + ROW_HEIGHT));
            ctx.lineTo(width, snap(y + ROW_HEIGHT));
            ctx.stroke();
            return;
        }
        if (!isBusBitRow(signal) && (globalIndex === selectedWaveIndex || selectedWaveIndices.has(globalIndex))) {
            ctx.fillStyle = STYLE.selection;
            ctx.fillRect(0, y, width, ROW_HEIGHT);
        }
        ctx.strokeStyle = 'rgba(127,127,127,0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, snap(y + ROW_HEIGHT));
        ctx.lineTo(width, snap(y + ROW_HEIGHT));
        ctx.stroke();

        if (isBusBitRow(signal)) drawBusBit(signal, y, ROW_HEIGHT, width);
        else if (signal.width > 1) drawBus(signal, y, ROW_HEIGHT, width);
        else drawSingleBit(signal, y, ROW_HEIGHT, width);
    });
    ctx.restore();
}

function drawCursor(width, height) {
    const x = timeToX(cursorTime, width);
    if (x < 0 || x > width) return;
    ctx.save();
    ctx.strokeStyle = STYLE.cursor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(snap(x), 0);
    ctx.lineTo(snap(x), height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = STYLE.cursor;
    ctx.font = '11px ' + getCss('--vscode-editor-font-family', 'monospace');
    ctx.fillText(formatTime(cursorTime), x + 5, 28);
    ctx.restore();
}

function render() {
    if (!ctx) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = STYLE.background;
    ctx.fillRect(0, 0, width, height);
    updateEmptyState();
    renderWaveNameList();
    updateToolbarState();
    if (!vcd) return;
    ctx.fillStyle = getCss('--vscode-sideBar-background', STYLE.background);
    ctx.fillRect(0, 0, width, HEADER_HEIGHT);
    drawGrid(width, height);
    if (waveSignals.length) {
        drawRows(width, height);
    }
    drawCursor(width, height);
    updateVisibleSignalValues();
    cursorText.textContent = 'Cursor: ' + formatTime(cursorTime);
    rangeText.textContent = 'Range: ' + formatRange(Math.round(startTime), Math.round(endTime));
    scheduleLayoutSave();
}

function updateVisibleSignalValues() {
    const rows = signalList.querySelectorAll('.signal-row');
    rows.forEach((row) => {
        const index = Number(row.dataset.index);
        const signal = filteredSignals[index];
        const value = row.querySelector('.signal-value');
        if (signal && value) {
            value.textContent = currentValueText(signal);
        }
    });
}

function updateToolbarState() {
    const disabled = !vcd;
    ['goStart', 'goEnd', 'prevPage', 'nextPage', 'prevChange', 'nextChange', 'zoomOut', 'zoomIn', 'fit'].forEach(id => {
        document.getElementById(id).disabled = disabled;
    });
}

function zoom(factor, anchorX) {
    if (!vcd) return;
    const width = canvas.clientWidth;
    const anchorTime = xToTime(anchorX ?? width / 2, width);
    const range = Math.max(1, endTime - startTime);
    const nextRange = clamp(range * factor, 1, Math.max(1, vcd.endTime || 1));
    const ratio = (anchorTime - startTime) / range;
    startTime = clamp(Math.round(anchorTime - nextRange * ratio), 0, Math.max(0, vcd.endTime - 1));
    endTime = clamp(Math.round(startTime + nextRange), startTime + 1, Math.max(1, vcd.endTime || 1));
    if (endTime - startTime < nextRange) {
        startTime = Math.max(0, endTime - nextRange);
    }
    render();
}

function fit() {
    if (!vcd) return;
    startTime = vcd.startTime || 0;
    endTime = Math.max(1, vcd.endTime || 1);
    cursorTime = startTime;
    render();
}

function goToStart() {
    if (!vcd) return;
    cursorTime = vcd.startTime || 0;
    const range = Math.max(1, endTime - startTime);
    startTime = cursorTime;
    endTime = Math.min(Math.max(1, vcd.endTime || 1), startTime + range);
    render();
}

function goToEnd() {
    if (!vcd) return;
    cursorTime = Math.max(1, vcd.endTime || 1);
    const range = Math.max(1, endTime - startTime);
    endTime = cursorTime;
    startTime = Math.max(0, endTime - range);
    render();
}

function panPage(direction) {
    if (!vcd) return;
    const range = Math.max(1, endTime - startTime);
    const delta = Math.max(1, Math.round(range * 0.85)) * direction;
    startTime = clamp(startTime + delta, 0, Math.max(0, vcd.endTime - range));
    endTime = startTime + range;
    cursorTime = clamp(cursorTime + delta, 0, Math.max(1, vcd.endTime || 1));
    render();
}

function panFraction(fraction) {
    if (!vcd) return;
    const range = Math.max(1, endTime - startTime);
    const delta = Math.round(range * fraction);
    startTime = clamp(startTime + delta, 0, Math.max(0, vcd.endTime - range));
    endTime = startTime + range;
    render();
}

function selectedSignal() {
    const signal = waveSignals[selectedWaveIndex] || null;
    return isBaseWaveSignal(signal) ? signal : null;
}

function editableSignalIndex(index, displayItem = null) {
    if (displayItem && isBusBitRow(displayItem)) {
        return displayItem.parentWaveIndex;
    }
    return index;
}

function selectWaveSignal(index, toggle = false) {
    if (index < 0 || index >= waveSignals.length) {
        selectedWaveIndex = -1;
        selectedWaveIndices = new Set();
        render();
        return;
    }
    selectedWaveIndex = index;
    if (toggle) {
        const next = new Set(selectedWaveIndices);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        selectedWaveIndices = next.size ? next : new Set([index]);
    } else {
        selectedWaveIndices = new Set([index]);
    }
    render();
}

function moveWaveSelection(delta) {
    const displayItems = displayedWaveItems();
    if (!displayItems.length) return;
    const currentDisplayIndex = displayIndexForWaveIndex(selectedWaveIndex);
    let nextDisplayIndex = currentDisplayIndex < 0
        ? 0
        : clamp(currentDisplayIndex + delta, 0, displayItems.length - 1);
    while (nextDisplayIndex >= 0 && nextDisplayIndex < displayItems.length && isBusBitRow(displayItems[nextDisplayIndex])) {
        const candidate = nextDisplayIndex + (delta >= 0 ? 1 : -1);
        if (candidate < 0 || candidate >= displayItems.length) break;
        nextDisplayIndex = candidate;
    }
    const next = displayItems[nextDisplayIndex]?.waveIndex ?? -1;
    selectWaveSignal(next, false);
    ensureWaveRowVisible(next);
    render();
}

function ensureWaveRowVisible(index) {
    const displayIndex = displayIndexForWaveIndex(index);
    if (displayIndex < 0) return;
    const top = displayIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < waveScrollTop) {
        waveScrollTop = top;
    } else if (bottom > waveScrollTop + waveNameList.clientHeight) {
        waveScrollTop = bottom - waveNameList.clientHeight;
    }
}

function jumpToChange(direction) {
    const signal = selectedSignal();
    if (!signal || !signal.changes || !signal.changes.length) {
        setStatus('Select a waveform signal first.');
        return;
    }
    let target = null;
    if (direction > 0) {
        target = signal.changes.find(change => change.time > cursorTime);
    } else {
        for (let i = signal.changes.length - 1; i >= 0; i--) {
            if (signal.changes[i].time < cursorTime) {
                target = signal.changes[i];
                break;
            }
        }
    }
    if (!target) return;
    cursorTime = target.time;
    const range = Math.max(1, endTime - startTime);
    if (cursorTime < startTime || cursorTime > endTime) {
        startTime = clamp(Math.round(cursorTime - range / 2), 0, Math.max(0, (vcd.endTime || 1) - range));
        endTime = Math.min(Math.max(1, vcd.endTime || 1), startTime + range);
    }
    renderSignalList();
    render();
}

function goToTime() {
    if (!vcd) return;
    const t = Number.parseInt(timeInput.value.trim(), 10);
    if (Number.isNaN(t)) return;
    cursorTime = clamp(t, 0, Math.max(1, vcd.endTime || 1));
    const range = Math.max(1, endTime - startTime);
    startTime = clamp(Math.round(cursorTime - range / 2), 0, Math.max(0, vcd.endTime - range));
    endTime = Math.min(Math.max(1, vcd.endTime || 1), startTime + range);
    render();
}

function showLibrarySignalMenu(x, y, signal) {
    const scope = selectedScopeName();
    const items = [
        menuItem('Add to Waveform', '', () => addSignalToWaveform(signal), isWaveVisible(signal)),
        menuItem('Remove from Waveform', '', () => removeSignalFromWaveform(signal), !isWaveVisible(signal)),
        separator(),
        menuItem('Add Filtered Signals', '', addFilteredSignalsToWaveform, !filteredSignals.length),
        menuItem('Add Scope Signals', '', () => addScopeSignalsToWaveform(scope, false, false), !scope),
        menuItem('Add Scope Signals as Group', '', () => addScopeSignalsToWaveform(scope, false, true), !scope),
        menuItem('Add Scope + Subscopes', '', () => addScopeSignalsToWaveform(scope, true, false)),
        menuItem('Add Scope + Subscopes as Group', '', () => addScopeSignalsToWaveform(scope, true, true)),
        separator(),
        menuItem('Signal Info', '', () => showSignalInfo(signal)),
    ];
    showContextMenu(x, y, items);
}

function showScopeMenu(x, y) {
    const scope = selectedScopeName();
    const items = [
        menuItem('Add Scope Signals', '', () => addScopeSignalsToWaveform(scope, false, false), !vcd || !scope),
        menuItem('Add Scope Signals as Group', '', () => addScopeSignalsToWaveform(scope, false, true), !vcd || !scope),
        menuItem('Add Scope + Subscopes', '', () => addScopeSignalsToWaveform(scope, true, false), !vcd),
        menuItem('Add Scope + Subscopes as Group', '', () => addScopeSignalsToWaveform(scope, true, true), !vcd),
    ];
    showContextMenu(x, y, items);
}

function renameWaveSignal(index) {
    const signal = waveSignals[index];
    if (!signal || isBusBitRow(signal)) return;
    const next = window.prompt(isGroupRow(signal) ? 'Group name:' : 'Display name:', displayName(signal));
    if (next === null) return;
    signal.displayName = next.trim();
    if (!isGroupRow(signal)) {
        syncLibrarySignal(signal);
    }
    render();
}

function setWaveSignalNameMode(index, mode) {
    const signal = waveSignals[index];
    if (!isBaseWaveSignal(signal)) return;
    signal.nameMode = mode;
    syncLibrarySignal(signal);
    render();
}

function setWaveSignalNameModeForIndices(indices, mode) {
    const targets = baseWaveIndicesFromIndices(indices);
    targets.forEach(index => {
        waveSignals[index].nameMode = mode;
        syncLibrarySignal(waveSignals[index]);
    });
    if (targets.length) {
        render();
        setStatus('Updated name mode for ' + targets.length + ' waveform signal' + (targets.length === 1 ? '' : 's') + '.');
    }
}

function showWaveSignalMenu(x, y, signal, index) {
    if (isGroupRow(signal)) {
        const items = [
            menuItem('Group: ' + displayName(signal), '', () => renameWaveSignal(index)),
            separator(),
            menuItem(signal.expanded ? 'Collapse Group' : 'Expand Group', '', () => toggleGroup(index)),
            menuItem('Remove Group', 'Delete', () => removeWaveSignals(new Set([index]))),
            menuItem('Clear All', '', clearWaveforms, !waveSignals.length),
        ];
        showContextMenu(x, y, items);
        return;
    }
    const editIndex = editableSignalIndex(index, signal);
    const baseSignal = waveSignals[editIndex];
    const canEditSignal = isBaseWaveSignal(baseSignal);
    const canToggleBus = isExpandableBus(baseSignal);
    const actionIndices = baseWaveIndicesForAction(editIndex);
    const actionSet = new Set(actionIndices);
    const actionCount = actionIndices.length;
    const colorTarget = canEditSignal && actionCount > 1 ? actionIndices : [editIndex];
    const sameColor = color => actionIndices.length > 0 && actionIndices.every(targetIndex => waveSignals[targetIndex].color === color.hex);
    const sameNameMode = mode => actionIndices.length > 0 && actionIndices.every(targetIndex => waveSignals[targetIndex].nameMode === mode);
    const targetLabel = actionCount > 1 ? 'Selected Signals (' + actionCount + ')' : 'Signal Name: ' + waveNameText(signal);
    const items = [
        menuItem(targetLabel, '', () => renameWaveSignal(editIndex), !canEditSignal || isBusBitRow(signal) || actionCount > 1),
        menuItem('Short name', sameNameMode('short') ? 'check' : '', () => setWaveSignalNameModeForIndices(actionIndices, 'short'), !canEditSignal),
        menuItem('Full name', sameNameMode('full') ? 'check' : '', () => setWaveSignalNameModeForIndices(actionIndices, 'full'), !canEditSignal),
        separator(),
        menuItem(baseSignal?.busExpanded ? 'Collapse Bus Bits' : 'Expand Bus Bits', '', () => toggleBusExpanded(editIndex), !canToggleBus),
        separator(),
        menuItem('Radix', '', null, true),
        ...RADIXES.map(option => menuItem(option.label, baseSignal?.radix === option.key ? 'check' : '', () => setWaveSignalRadix(editIndex, option.key), !canEditSignal)),
        separator(),
        menuItem(actionCount > 1 ? 'Waveform Color (' + actionCount + ')' : 'Waveform Color', '', null, true),
        ...COLORS.map(color => menuItem(color.name, sameColor(color) ? 'check' : 'swatch:' + color.hex, () => setWaveSignalColorForIndices(colorTarget, color.hex), !canEditSignal)),
        separator(),
        menuItem(actionCount > 1 ? 'Move Selected Up' : 'Move Up', 'Up', () => moveSelectedWaves(-1, editIndex), !canMoveWaveSignal(editIndex, -1)),
        menuItem(actionCount > 1 ? 'Move Selected Down' : 'Move Down', 'Down', () => moveSelectedWaves(1, editIndex), !canMoveWaveSignal(editIndex, 1)),
        menuItem(actionCount > 1 ? 'Remove Selected' : 'Remove', 'Delete', () => removeWaveSignals(actionSet), !canEditSignal),
        menuItem('Clear All', '', clearWaveforms, !waveSignals.length),
    ];
    showContextMenu(x, y, items);
}

function menuItem(label, marker, action, disabled = false) {
    return { type: 'item', label, marker, action, disabled };
}

function separator() {
    return { type: 'separator' };
}

function showContextMenu(x, y, items) {
    contextMenu.innerHTML = '';
    items.forEach(item => {
        if (item.type === 'separator') {
            const sep = document.createElement('div');
            sep.className = 'menu-separator';
            contextMenu.appendChild(sep);
            return;
        }
        const row = document.createElement('div');
        row.className = 'menu-item' + (item.disabled ? ' disabled' : '');
        const marker = document.createElement('div');
        if (item.marker === 'check') {
            marker.className = 'menu-check';
            marker.textContent = '*';
        } else if (item.marker && item.marker.startsWith('swatch:')) {
            marker.className = 'menu-swatch';
            marker.style.background = item.marker.slice('swatch:'.length);
        }
        const label = document.createElement('div');
        label.textContent = item.label;
        const shortcut = document.createElement('div');
        shortcut.className = 'menu-shortcut';
        shortcut.textContent = item.marker && !item.marker.startsWith('swatch:') && item.marker !== 'check' ? item.marker : '';
        row.appendChild(marker);
        row.appendChild(label);
        row.appendChild(shortcut);
        if (!item.disabled && item.action) {
            row.onclick = () => {
                hideContextMenu();
                item.action();
            };
        }
        contextMenu.appendChild(row);
    });

    contextMenu.style.display = 'block';
    const rect = contextMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    contextMenu.style.left = Math.max(4, left) + 'px';
    contextMenu.style.top = Math.max(4, top) + 'px';
}

function hideContextMenu() {
    contextMenu.style.display = 'none';
}

function showSignalInfo(signal) {
    const initial = signal.changes && signal.changes.length ? currentValueText(signal) : '-';
    setStatus('Signal ' + signal.fullName + ', type ' + signal.type + ', width ' + signal.width + ', current ' + initial + ', changes ' + (signal.changes?.length || 0) + '.');
}

function setWaveSignalRadix(index, radix) {
    const signal = waveSignals[index];
    if (!signal) return;
    signal.radix = radix;
    syncLibrarySignal(signal);
    render();
}

function setWaveSignalColor(index, color) {
    const signal = waveSignals[index];
    if (!signal) return;
    signal.color = color;
    syncLibrarySignal(signal);
    renderSignalList();
    render();
}

function setWaveSignalColorForIndices(indices, color) {
    const targets = baseWaveIndicesFromIndices(indices);
    targets.forEach(index => {
        waveSignals[index].color = color;
        syncLibrarySignal(waveSignals[index]);
    });
    if (targets.length) {
        renderSignalList();
        render();
        setStatus('Updated color for ' + targets.length + ' waveform signal' + (targets.length === 1 ? '' : 's') + '.');
    }
}

function waveIndexFromOffsetY(offsetY) {
    return waveIndexForDisplayIndex(Math.floor((offsetY - HEADER_HEIGHT + waveScrollTop) / ROW_HEIGHT));
}

function updateSelectionBox(event) {
    if (!boxStart) return;
    const rect = waveCanvasPane.getBoundingClientRect();
    const x1 = boxStart.x;
    const y1 = boxStart.y;
    const x2 = clamp(event.clientX - rect.left, 0, rect.width);
    const rawY = event.clientY - rect.top;
    const y2 = dragMode === 'timeRange'
        ? rect.height
        : clamp(rawY, HEADER_HEIGHT, rect.height);
    const top = dragMode === 'timeRange' ? 0 : Math.min(y1, y2);
    const height = dragMode === 'timeRange' ? rect.height : Math.abs(y2 - y1);
    boxCurrent = { x: x2, y: y2 };
    selectionBox.style.display = 'block';
    selectionBox.style.left = Math.min(x1, x2) + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.width = Math.abs(x2 - x1) + 'px';
    selectionBox.style.height = height + 'px';
}

function finishBoxSelection(event) {
    if (!boxStart) return;
    const rect = waveCanvasPane.getBoundingClientRect();
    const y1 = boxStart.y;
    const y2 = clamp(event.clientY - rect.top, HEADER_HEIGHT, rect.height);
    const a = Math.floor((Math.min(y1, y2) - HEADER_HEIGHT + waveScrollTop) / ROW_HEIGHT);
    const b = Math.floor((Math.max(y1, y2) - HEADER_HEIGHT + waveScrollTop) / ROW_HEIGHT);
    const next = new Set();
    const displayItems = displayedWaveItems();
    for (let i = Math.max(0, a); i <= Math.min(displayItems.length - 1, b); i++) {
        const waveIndex = displayItems[i].waveIndex;
        if (!isGroupRow(waveSignals[waveIndex])) {
            next.add(waveIndex);
        }
    }
    if (next.size) {
        selectedWaveIndices = next;
        selectedWaveIndex = Math.min(...next);
    }
    boxStart = null;
    boxCurrent = null;
    selectionBox.style.display = 'none';
    render();
}

function finishTimeRangeSelection(event) {
    if (!boxStart) return;
    const rect = waveCanvasPane.getBoundingClientRect();
    const x2 = clamp(event.clientX - rect.left, 0, rect.width);
    const minX = Math.min(boxStart.x, x2);
    const maxX = Math.max(boxStart.x, x2);
    boxStart = null;
    boxCurrent = null;
    selectionBox.style.display = 'none';
    if (maxX - minX < 6 || !vcd) {
        render();
        return;
    }
    const nextStart = xToTime(minX, canvas.clientWidth);
    const nextEnd = xToTime(maxX, canvas.clientWidth);
    startTime = clamp(Math.min(nextStart, nextEnd), 0, Math.max(0, vcd.endTime - 1));
    endTime = clamp(Math.max(nextStart, nextEnd), startTime + 1, Math.max(1, vcd.endTime || 1));
    cursorTime = startTime;
    render();
}

document.getElementById('goStart').onclick = goToStart;
document.getElementById('goEnd').onclick = goToEnd;
document.getElementById('prevPage').onclick = () => panPage(-1);
document.getElementById('nextPage').onclick = () => panPage(1);
document.getElementById('zoomIn').onclick = () => zoom(0.5);
document.getElementById('zoomOut').onclick = () => zoom(2);
document.getElementById('prevChange').onclick = () => jumpToChange(-1);
document.getElementById('nextChange').onclick = () => jumpToChange(1);
document.getElementById('fit').onclick = fit;
goToTimeButton.onclick = goToTime;
searchInput.oninput = applyFilter;
scopeSelect.onchange = applyFilter;
scopeSelect.oncontextmenu = (event) => {
    event.preventDefault();
    showScopeMenu(event.clientX, event.clientY);
};
timeInput.onkeydown = (event) => {
    if (event.key === 'Enter') goToTime();
};

waveCanvasPane.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    hideContextMenu();
    if (!vcd) return;
    dragging = true;
    lastMouseX = event.clientX;
    const rowIndex = waveIndexFromOffsetY(event.offsetY);
    if (event.offsetY < HEADER_HEIGHT) {
        dragMode = 'timeRange';
        boxStart = { x: clamp(event.offsetX, 0, canvas.clientWidth), y: 0 };
        updateSelectionBox(event);
        return;
    }
    dragMode = 'box';
    boxStart = { x: clamp(event.offsetX, 0, canvas.clientWidth), y: clamp(event.offsetY, HEADER_HEIGHT, canvas.clientHeight) };
    cursorTime = xToTime(event.offsetX, canvas.clientWidth);
    if (rowIndex >= 0 && rowIndex < waveSignals.length) {
        selectWaveSignal(rowIndex, event.ctrlKey || event.metaKey);
    } else if (!event.ctrlKey && !event.metaKey) {
        selectedWaveIndex = -1;
        selectedWaveIndices = new Set();
    }
    render();
});

window.addEventListener('mouseup', (event) => {
    if (dragMode === 'timeRange') finishTimeRangeSelection(event);
    else if (dragMode === 'box') finishBoxSelection(event);
    dragging = false;
    dragMode = 'none';
});

window.addEventListener('mousemove', (event) => {
    if (!dragging || !vcd) return;
    if (dragMode === 'box' || dragMode === 'timeRange') {
        updateSelectionBox(event);
        return;
    }
});

waveCanvasPane.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (!vcd) return;
    if (event.altKey) {
        waveScrollTop += (event.deltaY > 0 ? 3 : -3) * ROW_HEIGHT;
        render();
    } else if (event.ctrlKey || event.metaKey) {
        zoom(event.deltaY < 0 ? 0.8 : 1.25, event.offsetX);
    } else {
        panFraction(event.deltaY > 0 ? -0.12 : 0.12);
    }
}, { passive: false });

waveWrap.addEventListener('dragover', (event) => {
    if (dataTransferHas(event.dataTransfer, 'text/plain')) {
        event.preventDefault();
        waveWrap.classList.add('drop-target');
        event.dataTransfer.dropEffect = 'copy';
    }
});

waveWrap.addEventListener('dragleave', () => {
    waveWrap.classList.remove('drop-target');
});

waveWrap.addEventListener('drop', (event) => {
    event.preventDefault();
    waveWrap.classList.remove('drop-target');
    const key = event.dataTransfer.getData('text/plain');
    const signal = allSignals.find(item => item.key === key);
    if (!signal) return;
    const rect = waveWrap.getBoundingClientRect();
    const displayIndex = Math.floor((event.clientY - rect.top - HEADER_HEIGHT + waveScrollTop) / ROW_HEIGHT);
    const targetIndex = waveInsertIndexForDisplayIndex(displayIndex);
    addSignalToWaveform(signal, targetIndex >= 0 ? targetIndex : waveSignals.length);
});

signalList.addEventListener('scroll', () => {
    renderSignalList();
});

signalList.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.signal-row')) return;
    event.preventDefault();
    showScopeMenu(event.clientX, event.clientY);
});

signalList.addEventListener('wheel', (event) => {
    event.preventDefault();
    signalList.scrollTop += event.deltaY;
    renderSignalList();
}, { passive: false });

waveNameList.addEventListener('wheel', (event) => {
    event.preventDefault();
    waveScrollTop += event.deltaY;
    render();
}, { passive: false });

document.addEventListener('click', (event) => {
    if (!contextMenu.contains(event.target)) {
        hideContextMenu();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) {
        return;
    }
    let handled = true;
    switch (event.key) {
        case 'Delete':
            removeWaveSignals(selectedWaveIndices.size ? selectedWaveIndices : new Set([selectedWaveIndex]));
            break;
        case 'ArrowUp':
            moveWaveSelection(-1);
            break;
        case 'ArrowDown':
            moveWaveSelection(1);
            break;
        case 'Home':
            goToStart();
            break;
        case 'End':
            goToEnd();
            break;
        case 'PageUp':
            panPage(-1);
            break;
        case 'PageDown':
            panPage(1);
            break;
        case 'ArrowLeft':
            jumpToChange(-1);
            break;
        case 'ArrowRight':
            jumpToChange(1);
            break;
        case 'i':
        case 'I':
        case '+':
        case '=':
            zoom(0.5);
            break;
        case 'o':
        case 'O':
        case '-':
        case '_':
            zoom(2);
            break;
        case 'f':
        case 'F':
        case ' ':
            fit();
            break;
        case 'Escape':
            hideContextMenu();
            handled = false;
            break;
        default:
            handled = false;
    }
    if (handled) {
        event.preventDefault();
    }
});

window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'vcd') {
        setData(msg.fileName, msg.data, msg.layout);
    } else if (msg.type === 'empty') {
        setEmptyState();
    } else if (msg.type === 'error') {
        emptyState.style.display = 'flex';
        emptyState.textContent = 'Failed to load VCD: ' + msg.message;
        statusText.textContent = 'Error';
    }
});

installResizers();
new ResizeObserver(resizeCanvas).observe(waveCanvasPane);
new ResizeObserver(() => {
    renderSignalList();
    render();
}).observe(signalList);
setEmptyState();
window.__veriflowWaveViewer = {
    addFirstSignals(count = 8) {
        allSignals.slice(0, count).forEach(signal => {
            if (!isWaveVisible(signal)) {
                waveSignals.push(makeWaveSignal(signal));
            }
        });
        if (waveSignals.length && selectedWaveIndex < 0) {
            selectedWaveIndex = 0;
            selectedWaveIndices = new Set([0]);
        }
        renderSignalList();
        render();
        return waveformCount();
    },
    addScope(scope = '', includeSubScopes = true, grouped = true) {
        addScopeSignalsToWaveform(scope, includeSubScopes, grouped);
        return this.state();
    },
    expandFirstBus() {
        const index = waveSignals.findIndex(isExpandableBus);
        if (index >= 0) {
            waveSignals[index].busExpanded = true;
            render();
        }
        return this.state();
    },
    setFirstSignalNameMode(mode = 'full') {
        const index = waveSignals.findIndex(isBaseWaveSignal);
        if (index >= 0) {
            setWaveSignalNameMode(index, mode);
        }
        const displayItems = displayedWaveItems();
        return {
            mode: index >= 0 ? waveSignals[index].nameMode : '',
            firstName: displayItems.find(item => isBaseWaveSignal(waveSignals[item.waveIndex])) ? waveNameText(displayItems.find(item => isBaseWaveSignal(waveSignals[item.waveIndex]))) : '',
            hasMainResize: !!mainResize,
            hasWaveNameResize: !!waveNameResize,
        };
    },
    multiSelectSamples() {
        waveSignals = [];
        selectedWaveIndex = -1;
        selectedWaveIndices = new Set();
        allSignals.slice(0, 6).forEach(signal => {
            waveSignals.push(makeWaveSignal(signal));
        });
        setSelection([1, 2, 3]);
        const selectedKeys = selectedBaseWaveIndices().map(index => waveSignals[index].key);
        const initialOrder = waveSignals.map(signal => signal.key);
        setWaveSignalColorForIndices(selectedBaseWaveIndices(), '#ff5c5c');
        const colored = selectedKeys.every(key => {
            const signal = waveSignals.find(item => item.key === key);
            return signal && signal.color === '#ff5c5c';
        });
        moveSelectedWaves(1);
        const movedDownOrder = waveSignals.map(signal => signal.key);
        const movedDownSelected = selectedKeys.map(key => waveSignals.findIndex(signal => signal.key === key));
        moveSelectedWaves(-1);
        const movedUpOrder = waveSignals.map(signal => signal.key);
        const movedUpSelected = selectedKeys.map(key => waveSignals.findIndex(signal => signal.key === key));
        removeWaveSignals(new Set(selectedBaseWaveIndices()));
        const remainingOrder = waveSignals.map(signal => signal.key);
        const selectedStillVisible = selectedKeys.some(key => waveSignals.some(signal => signal.key === key));
        return {
            initialCount: initialOrder.length,
            selectedCount: selectedKeys.length,
            colored,
            movedDownSelected,
            movedUpSelected,
            movedDownChanged: movedDownOrder.join('|') !== initialOrder.join('|'),
            movedUpRestored: movedUpOrder.join('|') === initialOrder.join('|'),
            remainingCount: remainingOrder.length,
            selectedStillVisible,
        };
    },
    formatSamples() {
        return {
            default4: busText('b1010', 4, 'default'),
            default8: busText('b10101010', 8, 'default'),
            signed8: busText('b10101010', 8, 'signed'),
            octal8: busText('b10101010', 8, 'octal'),
            unknown4: busText('bxxxx', 4, 'hex'),
            mixed4: busText('b10xz', 4, 'hex'),
            binary8: busText('b101011', 8, 'binary'),
            hex8: busText('b101011', 8, 'hex'),
            hex32: busText('b101100010', 32, 'hex'),
            bit0: bitValue('b1010', 0, 4),
            bit1: bitValue('b1010', 1, 4),
            bit3: bitValue('b1010', 3, 4),
            bit8: bitValue('b1010', 8, 4),
        };
    },
    captureLayout() {
        return captureLayout();
    },
    restoreLayout(layout) {
        return restoreLayout(layout);
    },
    layoutRoundTripSamples() {
        const layout = captureLayout();
        const before = this.state();
        waveSignals = [];
        selectedWaveIndex = -1;
        selectedWaveIndices = new Set();
        const restored = restoreLayout(layout);
        const after = this.state();
        return {
            version: layout?.version || 0,
            restored,
            beforeWaveforms: before.waveforms,
            afterWaveforms: after.waveforms,
            beforeGroups: before.groups,
            afterGroups: after.groups,
            beforeBusBits: before.busBits,
            afterBusBits: after.busBits,
        };
    },
    state() {
        const displayItems = displayedWaveItems();
        return {
            signals: allSignals.length,
            scopes: Array.from(new Set(allSignals.map(signal => signal.scope).filter(Boolean))).sort(),
            waveforms: waveformCount(),
            groups: waveSignals.filter(isGroupRow).length,
            displayRows: displayItems.length,
            busBits: displayItems.filter(isBusBitRow).length,
            startTime,
            endTime,
            cursorTime,
        };
    },
};
resizeCanvas();
vscode.postMessage({ type: 'ready' });
