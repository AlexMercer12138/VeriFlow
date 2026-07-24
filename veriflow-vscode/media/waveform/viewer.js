const bootstrap = ${stateJson};
const waveformTransport = globalThis.waveformTransport;
const vscode = {
    postMessage(message) { waveformTransport.send(message); },
    getState() { return waveformTransport.getState(); },
    setState(value) { waveformTransport.setState(value); },
};
const waveCore = globalThis.VeriflowWaveCore;
const isVsCodeHost = waveformTransport.kind === 'vscode';
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
const changeSearchMode = document.getElementById('changeSearchMode');
const changeSearchValue = document.getElementById('changeSearchValue');
const contextMenu = document.getElementById('contextMenu');
const selectionBox = document.getElementById('selectionBox');
const mainResize = document.getElementById('mainResize');
const waveNameResize = document.getElementById('waveNameResize');
const indexOverlay = document.getElementById('indexOverlay');
const indexOverlayText = document.getElementById('indexOverlayText');
const indexProgress = document.getElementById('indexProgress');
const indexProgressText = document.getElementById('indexProgressText');
const indexProgressTrack = indexProgress.querySelector('[role="progressbar"]');
const indexProgressFill = document.getElementById('indexProgressFill');
const cancelIndex = document.getElementById('cancelIndex');
const retryIndex = document.getElementById('retryIndex');

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
    cursorA: '#f6c177',
    cursorB: '#4cb3ff',
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
let selectedBusBit = null;
let listFirstRow = 0;
let listRenderedCount = 0;
let waveFirstRow = 0;
let waveScrollTop = 0;
let startTime = 0;
let endTime = 1;
let cursorA = 0;
let cursorB = null;
let activeCursor = 'a';
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
let indexedMode = false;
let indexReady = false;
let currentGeneration = 0;
let loadingGeneration = 0;
const windowCache = new waveCore.WaveWindowCache(192);
const requestTracker = new waveCore.RequestTracker();
const renderScheduler = new waveCore.FrameScheduler(callback => requestAnimationFrame(callback));
let pendingWaveNameRender = false;
const cursorValues = new Map();
let windowRequestTimer = null;
let valueRequestTimer = null;
let pendingWindowRequest = null;
let pendingValueRequest = null;
let pendingSearchRequest = null;
let pendingReloadMetadata = null;
let lastValueRequestKey = '';
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

function activeCursorTime() {
    return activeCursor === 'b' && cursorB !== null ? cursorB : cursorA;
}

function setActiveCursorTime(time) {
    if (!vcd) return;
    const minTime = Number(vcd.startTime) || 0;
    const maxTime = Math.max(minTime, Number(vcd.endTime) || 1);
    const next = clamp(Number(time), minTime, maxTime);
    if (indexedMode && next !== activeCursorTime()) {
        cursorValues.clear();
        lastValueRequestKey = '';
    }
    if (activeCursor === 'b') cursorB = next;
    else cursorA = next;
}

function activateCursor(name) {
    activeCursor = name === 'b' ? 'b' : 'a';
    if (activeCursor === 'b' && cursorB === null) cursorB = cursorA;
    render();
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
            a: cursorA,
            b: cursorB,
            active: activeCursor,
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
    selectedBusBit = null;

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

    const restoredCursorA = Number(validated.cursors?.a);
    const restoredCursorB = validated.cursors?.b === null || validated.cursors?.b === undefined
        ? null
        : Number(validated.cursors.b);
    cursorA = Number.isFinite(restoredCursorA) ? clamp(restoredCursorA, minTime, maxTime) : minTime;
    cursorB = Number.isFinite(restoredCursorB) ? clamp(restoredCursorB, minTime, maxTime) : null;
    activeCursor = validated.cursors?.active === 'b' ? 'b' : 'a';
    if (activeCursor === 'b' && cursorB === null) activeCursor = 'a';
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
    indexedMode = false;
    indexReady = false;
    currentGeneration = 0;
    loadingGeneration = 0;
    requestTracker.setGeneration(0);
    windowCache.clear();
    cursorValues.clear();
    pendingWindowRequest = null;
    pendingValueRequest = null;
    pendingSearchRequest = null;
    pendingReloadMetadata = null;
    lastValueRequestKey = '';
    if (windowRequestTimer !== null) clearTimeout(windowRequestTimer);
    if (valueRequestTimer !== null) clearTimeout(valueRequestTimer);
    windowRequestTimer = null;
    valueRequestTimer = null;
    vcd = null;
    currentFileName = '';
    allSignals = [];
    filteredSignals = [];
    waveSignals = [];
    selectedLibraryIndex = 0;
    selectedWaveIndex = -1;
    selectedWaveIndices = new Set();
    selectedBusBit = null;
    listFirstRow = 0;
    listRenderedCount = 0;
    waveFirstRow = 0;
    waveScrollTop = 0;
    nextGroupId = 1;
    startTime = 0;
    endTime = 1;
    cursorA = 0;
    cursorB = null;
    activeCursor = 'a';
    fileTitle.textContent = 'No waveform file opened';
    searchInput.value = '';
    changeSearchMode.value = 'change';
    changeSearchValue.value = '';
    scopeSelect.innerHTML = '<option value="">No waveform file</option>';
    signalList.scrollTop = 0;
    renderSignalList();
    statusText.textContent = 'No waveform file opened';
    cursorText.textContent = 'A: - | B: - | Delta: - | Frequency: -';
    rangeText.textContent = 'Range: -';
    indexOverlay.hidden = true;
    indexProgress.hidden = true;
    retryIndex.hidden = true;
    render();
}

function setData(fileName, data, messageLayout = null) {
    layoutReady = false;
    if (layoutSaveTimer !== null) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
    lastSavedLayoutJson = '';
    layoutStorageWarningShown = false;
    indexedMode = false;
    indexReady = true;
    vcd = data;
    currentFileName = String(fileName || '');
    fileTitle.textContent = fileName;
    changeSearchMode.value = 'change';
    changeSearchValue.value = '';
    allSignals = (data.signals || []).map((signal, index) => ({
        ...signal,
        changes: Array.isArray(signal.changes) ? signal.changes : [],
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
    selectedBusBit = null;
    waveScrollTop = 0;
    nextGroupId = 1;
    startTime = data.startTime || 0;
    endTime = Math.max(1, data.endTime || 1);
    cursorA = startTime;
    cursorB = null;
    activeCursor = 'a';
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

function setIndexLoading(loading, text = 'Preparing waveform') {
    indexOverlay.hidden = !loading;
    indexOverlayText.textContent = text;
    if (loading) {
        indexProgress.hidden = false;
        cancelIndex.hidden = false;
        retryIndex.hidden = true;
    }
}

function activateIndexedMetadata(message, layout = message.layout) {
    loadingGeneration = Number(message.generation) || 0;
    setData(message.fileName, message.data || {}, layout);
    indexedMode = true;
    indexReady = false;
    currentGeneration = loadingGeneration;
    requestTracker.setGeneration(currentGeneration);
    windowCache.clear();
    cursorValues.clear();
    lastValueRequestKey = '';
    pendingWindowRequest = null;
    pendingValueRequest = null;
    pendingSearchRequest = null;
    allSignals.forEach(signal => { signal.changes = []; });
    waveSignals.forEach(signal => {
        if (!isGroupRow(signal)) signal.changes = [];
    });
    setIndexLoading(true, 'Indexing waveform');
    updateToolbarState();
    render();
}

function setIndexedMetadata(message) {
    const generation = Number(message.generation) || 0;
    if (indexedMode && indexReady && generation > currentGeneration) {
        loadingGeneration = generation;
        pendingReloadMetadata = message;
        indexOverlay.hidden = true;
        indexProgress.hidden = false;
        cancelIndex.hidden = false;
        retryIndex.hidden = true;
        return;
    }
    activateIndexedMetadata(message);
}

function convertedReloadLayout(layout, oldTimescale, newTimescale) {
    if (!layout) return null;
    const oldScale = waveCore.parseTimescale(oldTimescale);
    const newScale = waveCore.parseTimescale(newTimescale);
    if (!oldScale || !newScale) return layout;
    const converted = JSON.parse(JSON.stringify(layout));
    const factor = oldScale.secondsPerTick / newScale.secondsPerTick;
    if (converted.view) {
        if (Number.isFinite(Number(converted.view.startTime))) {
            converted.view.startTime = Number(converted.view.startTime) * factor;
        }
        if (Number.isFinite(Number(converted.view.endTime))) {
            converted.view.endTime = Number(converted.view.endTime) * factor;
        }
    }
    if (converted.cursors) {
        if (Number.isFinite(Number(converted.cursors.a))) {
            converted.cursors.a = Number(converted.cursors.a) * factor;
        }
        if (converted.cursors.b !== null && Number.isFinite(Number(converted.cursors.b))) {
            converted.cursors.b = Number(converted.cursors.b) * factor;
        }
    }
    return converted;
}

function progressText(progress) {
    const phase = String(progress.phase || 'indexing');
    const percent = Number.isFinite(Number(progress.percent))
        ? Math.max(0, Math.min(100, Math.round(Number(progress.percent))))
        : null;
    const completed = Number(progress.completed || 0);
    const total = Number(progress.total || 0);
    let work = '';
    if (phase === 'scan' && total > 0) {
        work = ' ' + (completed / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MiB';
    } else if (total > 0) {
        work = ' ' + completed + '/' + total;
    }
    return phase + (percent === null ? '' : ' ' + percent + '%') + work;
}

function handleIndexProgress(message) {
    const generation = Number(message.generation) || 0;
    if (generation < currentGeneration) return;
    loadingGeneration = generation;
    const progress = message.progress || {};
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    indexProgress.hidden = false;
    cancelIndex.hidden = false;
    retryIndex.hidden = true;
    indexProgressText.textContent = progressText(progress);
    indexProgressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
    indexProgressFill.style.width = percent + '%';
    if (!indexReady) {
        setIndexLoading(true, 'Indexing waveform');
    } else if (generation > currentGeneration) {
        indexOverlay.hidden = true;
    }
}

function handleIndexReady(message) {
    const generation = Number(message.generation) || 0;
    if (generation !== currentGeneration) {
        if (generation !== loadingGeneration || !pendingReloadMetadata || !indexReady) return;
        const previousLayout = captureLayout();
        const previousTimescale = vcd?.timescale || '';
        const finalData = message.data || pendingReloadMetadata.data || {};
        const layout = convertedReloadLayout(
            previousLayout,
            previousTimescale,
            finalData.timescale || previousTimescale
        );
        activateIndexedMetadata(
            { ...pendingReloadMetadata, generation, data: finalData },
            layout
        );
        pendingReloadMetadata = null;
    }
    if (generation !== currentGeneration) return;
    if (message.data && vcd) {
        vcd = {
            ...vcd,
            ...message.data,
            signals: vcd.signals,
        };
        const minimum = Number(vcd.startTime) || 0;
        const maximum = Math.max(minimum + 1, Number(vcd.endTime) || 1);
        startTime = clamp(startTime, minimum, maximum - 1);
        endTime = clamp(
            endTime <= minimum + 1 ? maximum : endTime,
            startTime + 1,
            maximum
        );
        cursorA = clamp(cursorA, minimum, maximum);
        if (cursorB !== null) cursorB = clamp(cursorB, minimum, maximum);
    }
    indexReady = true;
    loadingGeneration = currentGeneration;
    indexOverlay.hidden = true;
    indexProgress.hidden = true;
    retryIndex.hidden = true;
    updateToolbarState();
    setStatus('Waveform index ready.');
    render();
}

function handleIndexFailure(message, cancelled = false) {
    if (Number(message.generation) !== loadingGeneration) return;
    if (indexReady) {
        pendingReloadMetadata = null;
        loadingGeneration = currentGeneration;
        indexOverlay.hidden = true;
        indexProgress.hidden = true;
        cancelIndex.hidden = true;
        retryIndex.hidden = true;
        setStatus(cancelled ? 'Waveform reload cancelled.' : 'Waveform reload failed: ' + String(message.message || 'unknown error'));
        return;
    }
    indexReady = false;
    setIndexLoading(true, cancelled ? 'Indexing cancelled' : 'Indexing failed');
    indexProgressText.textContent = cancelled ? 'cancelled' : String(message.message || 'failed');
    cancelIndex.hidden = true;
    retryIndex.hidden = false;
    updateToolbarState();
}

function applyFilter() {
    const query = searchInput.value.trim().toLowerCase();
    const selectedScope = scopeSelect.value;
    filteredSignals = allSignals.filter(signal => {
        const matchesScope = waveCore.signalMatchesSelectedScope(signal.scope, selectedScope);
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
    if (waveCore && vcd?.timescale) {
        return waveCore.formatTicks(time, vcd.timescale);
    }
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

function isSelectedBusBit(item) {
    return isBusBitRow(item)
        && selectedBusBit !== null
        && selectedBusBit.parentWaveIndex === item.parentWaveIndex
        && selectedBusBit.bitIndex === item.bitIndex;
}

function selectBusBit(item) {
    if (!isBusBitRow(item)) return;
    selectedBusBit = {
        parentWaveIndex: item.parentWaveIndex,
        bitIndex: item.bitIndex,
    };
    selectedWaveIndex = item.parentWaveIndex;
    selectedWaveIndices = new Set([item.parentWaveIndex]);
    render();
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
    const viewportHeight = signalList.clientHeight || ROW_HEIGHT * 16;
    const virtualWindow = waveCore.calculateVirtualWindow(
        filteredSignals.length,
        viewportHeight,
        savedScrollTop,
        ROW_HEIGHT,
        4
    );
    const restoredScrollTop = clamp(
        savedScrollTop,
        0,
        Math.max(0, virtualWindow.totalHeight - viewportHeight)
    );
    listFirstRow = virtualWindow.firstRow;
    listRenderedCount = virtualWindow.renderedCount;

    const spacer = document.createElement('div');
    spacer.className = 'signal-list-spacer';
    spacer.style.height = virtualWindow.totalHeight + 'px';

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
    signalList.scrollTop = restoredScrollTop;
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
        const isSelectedBit = isSelectedBusBit(signal);
        const row = document.createElement('div');
        row.className = 'wave-name-row'
            + (isGroupRow(signal) ? ' group-row' : '')
            + (isBusBitRow(signal) ? ' bus-bit-row' : '')
            + (isSelectedBit ? ' selected' : '')
            + (index === selectedWaveIndex && !isBusBitRow(signal) ? ' selected' : '')
            + (isSelectedRow && selectedWaveIndices.has(index) ? ' multi-selected' : '');
        row.dataset.index = String(index);
        row.draggable = !isBusBitRow(signal) && isBaseWaveSignal(waveSignals[index]);
        row.title = signal.fullName;
        row.onclick = (event) => {
            if (isBusBitRow(signal)) {
                selectBusBit(signal);
            } else if (isGroupRow(signal)) {
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
    selectedBusBit = null;
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
        selectedBusBit = null;
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
        selectedBusBit = null;
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
    selectedBusBit = null;
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
    selectedBusBit = null;
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
    selectedBusBit = null;
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
    if (!signal.busExpanded && selectedBusBit?.parentWaveIndex === index) {
        selectedBusBit = null;
    }
    render();
}

function moveWaveSignal(from, to) {
    if (from === to || from < 0 || to < 0 || from >= waveSignals.length || to >= waveSignals.length) return;
    if (!isBaseWaveSignal(waveSignals[from]) || !isBaseWaveSignal(waveSignals[to])) return;
    const [item] = waveSignals.splice(from, 1);
    waveSignals.splice(to, 0, item);
    selectedWaveIndex = to;
    selectedWaveIndices = new Set([to]);
    selectedBusBit = null;
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

function visibleWaveSignals() {
    const items = displayedWaveItems();
    const height = Math.max(1, canvas.clientHeight - HEADER_HEIGHT);
    const first = Math.max(0, Math.floor(waveScrollTop / ROW_HEIGHT));
    const count = Math.max(1, Math.ceil(height / ROW_HEIGHT) + 1);
    return items.slice(first, first + count).filter(item => !isGroupRow(item));
}

function visibleWindowDescriptor() {
    if (!vcd) return null;
    const start = Math.floor(startTime);
    const end = Math.max(start, Math.ceil(endTime));
    const pixelWidth = Math.max(1, Math.round(canvas.clientWidth || 1));
    return {
        start,
        end,
        pixelWidth,
        ticksPerPixel: Math.max(Number.EPSILON, (end - start) / pixelWidth),
    };
}

function requestWindowDescriptor() {
    const viewport = visibleWindowDescriptor();
    if (!viewport || !vcd) return null;
    const range = waveCore.prefetchRange(
        startTime,
        endTime,
        Number(vcd.startTime) || 0,
        Math.max(Number(vcd.startTime) || 0, Number(vcd.endTime) || 1)
    );
    return {
        start: Math.floor(range.start),
        end: Math.ceil(range.end),
        pixelWidth: viewport.pixelWidth,
        ticksPerPixel: viewport.ticksPerPixel,
    };
}

function cachedWindowEntry(reference, descriptor = visibleWindowDescriptor()) {
    if (!descriptor || !reference) return null;
    return windowCache.find({
        generation: currentGeneration,
        reference,
        start: descriptor.start,
        end: descriptor.end,
        ticksPerPixel: descriptor.ticksPerPixel,
    }) || null;
}

function seriesForSignal(signal) {
    if (!indexedMode) {
        return { kind: 'raw', width: Number(signal.width), changes: signal.changes || [] };
    }
    return cachedWindowEntry(signal.reference)?.series || null;
}

function cancelPendingRequest(pending) {
    if (!pending) return;
    requestTracker.cancel(pending.requestId);
    waveformTransport.send({
        type: 'cancelRequest',
        generation: currentGeneration,
        requestId: pending.requestId,
    });
}

function scheduleWindowRequest() {
    if (!indexedMode || !indexReady || !vcd || !waveSignals.length) return;
    if (windowRequestTimer !== null) clearTimeout(windowRequestTimer);
    windowRequestTimer = setTimeout(() => {
        windowRequestTimer = null;
        const viewport = visibleWindowDescriptor();
        const descriptor = requestWindowDescriptor();
        if (!viewport || !descriptor) return;
        const references = Array.from(new Set(
            visibleWaveSignals().map(signal => signal.reference).filter(Boolean)
        ));
        const needed = references.filter(reference => {
            const entry = cachedWindowEntry(reference, viewport);
            return waveCore.windowNeedsRefresh(entry, viewport, 0.25, {
                start: Number(vcd.startTime) || 0,
                end: Math.max(Number(vcd.startTime) || 0, Number(vcd.endTime) || 1),
            });
        });
        if (!needed.length) return;
        if (
            pendingWindowRequest
            && pendingWindowRequest.descriptor.start === descriptor.start
            && pendingWindowRequest.descriptor.end === descriptor.end
            && pendingWindowRequest.descriptor.pixelWidth === descriptor.pixelWidth
            && pendingWindowRequest.descriptor.ticksPerPixel === descriptor.ticksPerPixel
            && needed.every(reference => pendingWindowRequest.references.includes(reference))
        ) return;
        cancelPendingRequest(pendingWindowRequest);
        const requestId = requestTracker.next('window');
        pendingWindowRequest = { requestId, descriptor, references: needed };
        waveformTransport.send({
            type: 'windowRequest',
            generation: currentGeneration,
            requestId,
            references: needed,
            start: descriptor.start,
            end: descriptor.end,
            pixelWidth: descriptor.pixelWidth,
            prefetch: 0.5,
        });
    }, 50);
}

function handleWindowData(message) {
    if (!requestTracker.accepts(message)) return;
    if (!pendingWindowRequest || message.requestId !== pendingWindowRequest.requestId) return;
    const descriptor = pendingWindowRequest.descriptor;
    try {
        (message.series || []).forEach(series => {
            windowCache.set({
                generation: currentGeneration,
                reference: series.reference,
                start: descriptor.start,
                end: descriptor.end,
                ticksPerPixel: descriptor.ticksPerPixel,
                series: waveCore.decodeWindowPayload(series),
            });
        });
    } catch (error) {
        setStatus('Waveform window decode failed: ' + String(error));
    }
    pendingWindowRequest = null;
    renderCanvas();
}

function visibleValueReferences() {
    const library = filteredSignals.slice(
        listFirstRow,
        listFirstRow + Math.max(1, listRenderedCount)
    );
    return Array.from(new Set(
        [...library, ...visibleWaveSignals()].map(signal => signal.reference).filter(Boolean)
    )).sort();
}

function scheduleValueRequest() {
    if (!indexedMode || !indexReady || !vcd) return;
    if (valueRequestTimer !== null) clearTimeout(valueRequestTimer);
    valueRequestTimer = setTimeout(() => {
        valueRequestTimer = null;
        const references = visibleValueReferences();
        if (!references.length) return;
        const time = Math.round(activeCursorTime());
        const key = currentGeneration + '|' + time + '|' + references.join('\u0000');
        if (key === lastValueRequestKey && references.every(reference => cursorValues.has(reference))) {
            return;
        }
        if (pendingValueRequest?.key === key) return;
        cancelPendingRequest(pendingValueRequest);
        const requestId = requestTracker.next('values');
        pendingValueRequest = { requestId, key, references, time };
        waveformTransport.send({
            type: 'valueRequest',
            generation: currentGeneration,
            requestId,
            references,
            time,
        });
    }, 50);
}

function handleCursorValues(message) {
    if (!requestTracker.accepts(message)) return;
    if (!pendingValueRequest || message.requestId !== pendingValueRequest.requestId) return;
    cursorValues.clear();
    Object.entries(message.values || {}).forEach(([reference, value]) => {
        cursorValues.set(reference, String(value));
    });
    lastValueRequestKey = pendingValueRequest.key;
    pendingValueRequest = null;
    renderSignalList();
    render();
}

function valueAt(signal, time) {
    if (indexedMode) {
        const fullValue = cursorValues.get(signal.reference) || '';
        if (!fullValue) return '';
        return Number.isInteger(signal.bitIndex)
            ? bitValue(fullValue, signal.bitIndex, signal.parentWidth || fullValue.length)
            : fullValue;
    }
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
    const value = valueAt(signal, activeCursorTime());
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

function drawSummarySeries(signal, series, y, rowHeight, width, mode) {
    const highY = y + rowHeight * (mode === 'bus' ? 0.28 : 0.30);
    const lowY = y + rowHeight * (mode === 'bus' ? 0.72 : 0.70);
    (series.records || []).forEach(record => {
        const x1 = clamp(timeToX(record.firstTime, width), 0, width);
        const x2 = clamp(timeToX(Math.max(record.firstTime, record.lastTime), width), 0, width);
        if (x2 <= x1) return;
        let firstValue = record.firstValue;
        let lastValue = record.lastValue;
        if (mode === 'bit') {
            firstValue = bitValue(firstValue, signal.bitIndex, signal.parentWidth || firstValue.length);
            lastValue = bitValue(lastValue, signal.bitIndex, signal.parentWidth || lastValue.length);
        }
        if (record.flags & 1) {
            drawDenseBlock(signal, x1, x2, highY, lowY);
            if (record.flags & 2) {
                ctx.fillStyle = hexAlpha(STYLE.unknown, 0.22);
                ctx.fillRect(x1, highY, x2 - x1, lowY - highY);
            } else if (record.flags & 4) {
                ctx.fillStyle = hexAlpha(STYLE.highZ, 0.20);
                ctx.fillRect(x1, highY, x2 - x1, lowY - highY);
            }
            return;
        }
        if (mode === 'bus') {
            drawBusSegment(signal, x1, x2, highY, lowY, firstValue);
            return;
        }
        const firstY = valueY(firstValue, highY, lowY);
        const lastY = valueY(lastValue, highY, lowY);
        if (firstValue === '1') drawHighFill(x1, x2, highY, lowY, signal.color);
        ctx.strokeStyle = signalPen(signal, firstValue);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(snap(x1), snap(firstY));
        ctx.lineTo(snap(x2), snap(firstY));
        if (Math.abs(firstY - lastY) > 0.1) ctx.lineTo(snap(x2), snap(lastY));
        ctx.stroke();
    });
}

function drawLoadingRow(signal, y, rowHeight, width) {
    ctx.save();
    ctx.strokeStyle = hexAlpha(signal.color, 0.28);
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(0, snap(y + rowHeight / 2));
    ctx.lineTo(width, snap(y + rowHeight / 2));
    ctx.stroke();
    ctx.restore();
}

function drawSingleBit(signal, y, rowHeight, width) {
    const series = seriesForSignal(signal);
    if (!series) {
        drawLoadingRow(signal, y, rowHeight, width);
        return;
    }
    if (series.kind === 'summary') {
        drawSummarySeries(signal, series, y, rowHeight, width, 'scalar');
        return;
    }
    const changes = series.changes || [];
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
    const series = seriesForSignal(signal);
    if (!series) {
        drawLoadingRow(signal, y, rowHeight, width);
        return;
    }
    if (series.kind === 'summary') {
        drawSummarySeries(signal, series, y, rowHeight, width, 'bit');
        return;
    }
    const changes = series.changes || [];
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
    const series = seriesForSignal(signal);
    if (!series) {
        drawLoadingRow(signal, y, rowHeight, width);
        return;
    }
    if (series.kind === 'summary') {
        drawSummarySeries(signal, series, y, rowHeight, width, 'bus');
        return;
    }
    const changes = series.changes || [];
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
        if (isSelectedBusBit(signal)
            || (!isBusBitRow(signal) && (globalIndex === selectedWaveIndex || selectedWaveIndices.has(globalIndex)))) {
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

function drawCursorLine(name, time, color, labelY, width, height) {
    if (time === null) return;
    const x = timeToX(time, width);
    if (x < 0 || x > width) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(snap(x), 0);
    ctx.lineTo(snap(x), height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '11px ' + getCss('--vscode-editor-font-family', 'monospace');
    ctx.fillText(name + ' ' + formatTime(time), x + 5, labelY);
    ctx.restore();
}

function drawCursors(width, height) {
    drawCursorLine('A', cursorA, STYLE.cursorA, 26, width, height);
    drawCursorLine('B', cursorB, STYLE.cursorB, 36, width, height);
}

function renderNow(renderWaveNames = true) {
    if (!ctx) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    updateEmptyState();
    if (renderWaveNames) renderWaveNameList();
    updateToolbarState();
    if (!vcd) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = STYLE.background;
        ctx.fillRect(0, 0, width, height);
        return;
    }
    const visibleSignals = visibleWaveSignals();
    scheduleWindowRequest();
    scheduleValueRequest();
    if (indexedMode && indexReady && visibleSignals.some(signal => !seriesForSignal(signal))) {
        updateVisibleSignalValues();
        scheduleLayoutSave();
        return;
    }
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = STYLE.background;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = getCss('--vscode-sideBar-background', STYLE.background);
    ctx.fillRect(0, 0, width, HEADER_HEIGHT);
    drawGrid(width, height);
    if (waveSignals.length) {
        drawRows(width, height);
    }
    drawCursors(width, height);
    updateVisibleSignalValues();
    document.getElementById('cursorA').setAttribute('aria-pressed', String(activeCursor === 'a'));
    document.getElementById('cursorB').setAttribute('aria-pressed', String(activeCursor === 'b'));
    const measurement = waveCore.measureCursors(cursorA, cursorB, vcd.timescale || '');
    cursorText.textContent = 'A: ' + formatTime(cursorA)
        + ' | B: ' + (cursorB === null ? '-' : formatTime(cursorB))
        + ' | Delta: ' + measurement.deltaText
        + ' | Frequency: ' + measurement.frequencyText;
    rangeText.textContent = 'Range: ' + formatRange(Math.round(startTime), Math.round(endTime));
    scheduleLayoutSave();
}

function render(renderWaveNames = true) {
    if (renderWaveNames) pendingWaveNameRender = true;
    renderScheduler.schedule(() => {
        const nextRenderWaveNames = pendingWaveNameRender;
        pendingWaveNameRender = false;
        renderNow(nextRenderWaveNames);
    });
}

function renderCanvas() {
    render(false);
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
    const disabled = !vcd || (indexedMode && !indexReady);
    ['goStart', 'goEnd', 'prevPage', 'nextPage', 'prevChange', 'nextChange', 'zoomOut', 'zoomIn', 'fit', 'cursorA', 'cursorB', 'changeSearchMode'].forEach(id => {
        document.getElementById(id).disabled = disabled;
    });
    updateSearchControls();
}

function updateSearchControls() {
    const exactValue = changeSearchMode.value === 'value';
    changeSearchValue.disabled = !vcd || (indexedMode && !indexReady) || !exactValue;
    const condition = changeSearchMode.options[changeSearchMode.selectedIndex]?.text || 'change';
    document.getElementById('prevChange').title = 'Previous ' + condition.toLowerCase() + ' (Left)';
    document.getElementById('nextChange').title = 'Next ' + condition.toLowerCase() + ' (Right)';
}

function zoom(factor, anchorX, renderWaveNames = true) {
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
    render(renderWaveNames);
}

function fit() {
    if (!vcd) return;
    startTime = vcd.startTime || 0;
    endTime = Math.max(1, vcd.endTime || 1);
    setActiveCursorTime(startTime);
    render();
}

function goToStart() {
    if (!vcd) return;
    const cursorTime = vcd.startTime || 0;
    setActiveCursorTime(cursorTime);
    const range = Math.max(1, endTime - startTime);
    startTime = cursorTime;
    endTime = Math.min(Math.max(1, vcd.endTime || 1), startTime + range);
    render();
}

function goToEnd() {
    if (!vcd) return;
    const cursorTime = Math.max(1, vcd.endTime || 1);
    setActiveCursorTime(cursorTime);
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
    setActiveCursorTime(activeCursorTime() + delta);
    render();
}

function panFraction(fraction, renderWaveNames = true) {
    if (!vcd) return;
    const range = Math.max(1, endTime - startTime);
    const delta = Math.round(range * fraction);
    startTime = clamp(startTime + delta, 0, Math.max(0, vcd.endTime - range));
    endTime = startTime + range;
    render(renderWaveNames);
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
    selectedBusBit = null;
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

function makeSearchTarget(signal, waveIndex, order, bitIndex = null) {
    const isBit = Number.isInteger(bitIndex);
    return {
        order,
        name: isBit ? signal.fullName + '[' + bitIndex + ']' : signal.fullName,
        reference: signal.reference,
        width: isBit ? 1 : signal.width,
        changes: signal.changes || [],
        waveIndex,
        bitIndex,
        parentWidth: signal.width,
    };
}

function selectedSearchTargets() {
    if (selectedBusBit !== null) {
        const parent = waveSignals[selectedBusBit.parentWaveIndex];
        if (isBaseWaveSignal(parent) && parent.busExpanded) {
            return [makeSearchTarget(
                parent,
                selectedBusBit.parentWaveIndex,
                selectedBusBit.parentWaveIndex,
                selectedBusBit.bitIndex
            )];
        }
        selectedBusBit = null;
    }

    let indices = selectedBaseWaveIndices();
    if (!indices.length) {
        indices = waveSignals
            .map((signal, index) => isBaseWaveSignal(signal) ? index : -1)
            .filter(index => index >= 0);
    }
    return indices.map(index => makeSearchTarget(waveSignals[index], index, index));
}

function searchErrorMessage(error, direction) {
    if (error === 'no-targets') return 'Add a waveform signal before searching.';
    if (error === 'edge-needs-scalar') return 'Edge search requires a scalar signal or expanded bus bit.';
    if (error === 'invalid-value') return 'Enter a fitting decimal, 0b binary, or 0x hexadecimal value.';
    if (error === 'invalid-mode') return 'Choose a waveform search condition.';
    return direction > 0
        ? 'No later waveform match.'
        : 'No earlier waveform match.';
}

function jumpToCondition(direction) {
    if (!vcd || !waveCore) return { match: null, error: 'no-targets' };
    const mode = changeSearchMode.value || 'change';
    const targets = selectedSearchTargets();
    if (indexedMode) {
        if (!indexReady || !targets.length) {
            const result = { match: null, error: 'no-targets' };
            setStatus(searchErrorMessage(result.error, direction));
            return result;
        }
        if ((mode === 'rising' || mode === 'falling') && !targets.some(target => target.width === 1)) {
            const result = { match: null, error: 'edge-needs-scalar' };
            setStatus(searchErrorMessage(result.error, direction));
            return result;
        }
        if (mode === 'value') {
            const valid = targets.some(target => waveCore.parseSearchValue(
                changeSearchValue.value,
                Number.isInteger(target.bitIndex) ? 1 : target.width
            ).ok);
            if (!valid) {
                const result = { match: null, error: 'invalid-value' };
                setStatus(searchErrorMessage(result.error, direction));
                return result;
            }
        }
        cancelPendingRequest(pendingSearchRequest);
        const requestId = requestTracker.next('search');
        pendingSearchRequest = { requestId, direction, targets };
        waveformTransport.send({
            type: 'searchRequest',
            generation: currentGeneration,
            requestId,
            targets: targets.map(target => ({
                reference: target.reference,
                bitIndex: target.bitIndex,
                waveIndex: target.waveIndex,
                name: target.name,
                order: target.order,
            })),
            cursorTime: activeCursorTime(),
            direction,
            mode,
            query: changeSearchValue.value,
        });
        setStatus('Searching waveform index...');
        return { pending: true, requestId };
    }
    const result = waveCore.findSearchMatch(
        targets,
        activeCursorTime(),
        direction,
        mode,
        changeSearchValue.value
    );
    if (!result.match) {
        setStatus(searchErrorMessage(result.error, direction));
        return result;
    }

    const target = result.target;
    if (Number.isInteger(target.bitIndex)) {
        selectedBusBit = {
            parentWaveIndex: target.waveIndex,
            bitIndex: target.bitIndex,
        };
        selectedWaveIndex = target.waveIndex;
        selectedWaveIndices = new Set([target.waveIndex]);
    } else {
        selectedBusBit = null;
        selectedWaveIndex = target.waveIndex;
        selectedWaveIndices = new Set([target.waveIndex]);
    }
    setActiveCursorTime(result.time);
    const cursorTime = activeCursorTime();
    const range = Math.max(1, endTime - startTime);
    if (cursorTime < startTime || cursorTime > endTime) {
        startTime = clamp(Math.round(cursorTime - range / 2), 0, Math.max(0, (vcd.endTime || 1) - range));
        endTime = Math.min(Math.max(1, vcd.endTime || 1), startTime + range);
    }
    renderSignalList();
    render();
    const condition = changeSearchMode.options[changeSearchMode.selectedIndex]?.text || mode;
    setStatus('Found ' + condition + ' on ' + target.name + ' at ' + formatTime(result.time) + '.');
    return result;
}

function handleSearchResult(message) {
    if (!requestTracker.accepts(message)) return;
    if (!pendingSearchRequest || message.requestId !== pendingSearchRequest.requestId) return;
    const pending = pendingSearchRequest;
    pendingSearchRequest = null;
    const result = message.result;
    if (!result) {
        setStatus(searchErrorMessage('no-match', pending.direction));
        return;
    }
    const target = result.target || pending.targets[0];
    if (Number.isInteger(target.bitIndex)) {
        selectedBusBit = {
            parentWaveIndex: target.waveIndex,
            bitIndex: target.bitIndex,
        };
    } else {
        selectedBusBit = null;
    }
    selectedWaveIndex = Number(target.waveIndex);
    selectedWaveIndices = new Set([selectedWaveIndex]);
    setActiveCursorTime(result.time);
    const range = Math.max(1, endTime - startTime);
    if (result.time < startTime || result.time > endTime) {
        startTime = clamp(
            Math.round(result.time - range / 2),
            Number(vcd.startTime) || 0,
            Math.max(Number(vcd.startTime) || 0, (Number(vcd.endTime) || 1) - range)
        );
        endTime = Math.min(Number(vcd.endTime) || 1, startTime + range);
    }
    cursorValues.clear();
    lastValueRequestKey = '';
    renderSignalList();
    render();
    setStatus('Found ' + (target.name || target.reference) + ' at ' + formatTime(result.time) + '.');
}

function goToTime() {
    if (!vcd) return;
    const t = Number.parseInt(timeInput.value.trim(), 10);
    if (Number.isNaN(t)) return;
    setActiveCursorTime(t);
    const cursorTime = activeCursorTime();
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

function displayItemFromOffsetY(offsetY) {
    const displayIndex = Math.floor((offsetY - HEADER_HEIGHT + waveScrollTop) / ROW_HEIGHT);
    return displayedWaveItems()[displayIndex] || null;
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
    const localX = clamp(event.clientX - rect.left, 0, rect.width);
    const localY = clamp(event.clientY - rect.top, HEADER_HEIGHT, rect.height);
    const clickDistance = Math.max(
        Math.abs(localX - boxStart.x),
        Math.abs(localY - boxStart.y)
    );
    if (selectedBusBit !== null && clickDistance < 6) {
        boxStart = null;
        boxCurrent = null;
        selectionBox.style.display = 'none';
        render();
        return;
    }
    const y1 = boxStart.y;
    const y2 = localY;
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
        selectedBusBit = null;
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
    setActiveCursorTime(startTime);
    render();
}

document.getElementById('goStart').onclick = goToStart;
document.getElementById('goEnd').onclick = goToEnd;
document.getElementById('prevPage').onclick = () => panPage(-1);
document.getElementById('nextPage').onclick = () => panPage(1);
document.getElementById('zoomIn').onclick = () => zoom(0.5);
document.getElementById('zoomOut').onclick = () => zoom(2);
document.getElementById('prevChange').onclick = () => jumpToCondition(-1);
document.getElementById('nextChange').onclick = () => jumpToCondition(1);
document.getElementById('fit').onclick = fit;
document.getElementById('cursorA').onclick = () => activateCursor('a');
document.getElementById('cursorB').onclick = () => activateCursor('b');
goToTimeButton.onclick = goToTime;
searchInput.oninput = applyFilter;
scopeSelect.onchange = applyFilter;
changeSearchMode.onchange = () => {
    updateSearchControls();
    if (changeSearchMode.value === 'value') changeSearchValue.focus();
};
changeSearchValue.onkeydown = (event) => {
    if (event.key === 'Enter') jumpToCondition(event.shiftKey ? -1 : 1);
};
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
    const displayItem = displayItemFromOffsetY(event.offsetY);
    const rowIndex = displayItem?.waveIndex ?? -1;
    if (event.offsetY < HEADER_HEIGHT) {
        dragMode = 'timeRange';
        boxStart = { x: clamp(event.offsetX, 0, canvas.clientWidth), y: 0 };
        updateSelectionBox(event);
        return;
    }
    dragMode = 'box';
    boxStart = { x: clamp(event.offsetX, 0, canvas.clientWidth), y: clamp(event.offsetY, HEADER_HEIGHT, canvas.clientHeight) };
    setActiveCursorTime(xToTime(event.offsetX, canvas.clientWidth));
    if (isBusBitRow(displayItem)) {
        selectBusBit(displayItem);
    } else if (rowIndex >= 0 && rowIndex < waveSignals.length) {
        selectWaveSignal(rowIndex, event.ctrlKey || event.metaKey);
    } else if (!event.ctrlKey && !event.metaKey) {
        selectedWaveIndex = -1;
        selectedWaveIndices = new Set();
        selectedBusBit = null;
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
        zoom(event.deltaY < 0 ? 0.8 : 1.25, event.offsetX, false);
    } else {
        panFraction(event.deltaY > 0 ? -0.12 : 0.12, false);
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
            jumpToCondition(-1);
            break;
        case 'ArrowRight':
            jumpToCondition(1);
            break;
        case 'a':
        case 'A':
            activateCursor('a');
            break;
        case 'b':
        case 'B':
            activateCursor('b');
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

cancelIndex.addEventListener('click', () => {
    waveformTransport.send({
        type: 'cancelLoad',
        generation: loadingGeneration || currentGeneration,
    });
    cancelIndex.disabled = true;
    indexProgressText.textContent = 'cancelling';
});

retryIndex.addEventListener('click', () => {
    waveformTransport.send({
        type: 'retryLoad',
        generation: loadingGeneration || currentGeneration,
    });
    retryIndex.hidden = true;
    cancelIndex.hidden = false;
    cancelIndex.disabled = false;
    indexProgressText.textContent = 'retrying';
});

window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type === 'vcd') {
        setData(msg.fileName, msg.data, msg.layout);
    } else if (msg.type === 'waveformMetadata') {
        setIndexedMetadata(msg);
    } else if (msg.type === 'indexProgress') {
        handleIndexProgress(msg);
    } else if (msg.type === 'indexReady') {
        handleIndexReady(msg);
    } else if (msg.type === 'windowData') {
        handleWindowData(msg);
    } else if (msg.type === 'cursorValues') {
        handleCursorValues(msg);
    } else if (msg.type === 'searchResult') {
        handleSearchResult(msg);
    } else if (msg.type === 'indexCancelled') {
        handleIndexFailure(msg, true);
    } else if (msg.type === 'reloadFailed') {
        handleIndexFailure(msg, false);
    } else if (msg.type === 'requestError' || msg.type === 'bridgeError') {
        if (Number(msg.generation) >= currentGeneration) {
            setStatus('Waveform request failed: ' + String(msg.message || 'unknown error'));
        }
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
    setCursorSamples(a, b, active = 'a') {
        const minTime = Number(vcd?.startTime) || 0;
        const maxTime = Math.max(minTime, Number(vcd?.endTime) || 1);
        cursorA = clamp(Number(a), minTime, maxTime);
        cursorB = b === null || b === undefined
            ? null
            : clamp(Number(b), minTime, maxTime);
        activeCursor = active === 'b' && cursorB !== null ? 'b' : 'a';
        render();
        const measurement = waveCore.measureCursors(cursorA, cursorB, vcd?.timescale || '');
        return {
            cursorA,
            cursorB,
            activeCursor,
            deltaText: measurement.deltaText,
            frequencyText: measurement.frequencyText,
        };
    },
    conditionalSearchSamples() {
        const clk = allSignals.find(signal => signal.reference === 'clk');
        const data = allSignals.find(signal => String(signal.reference).startsWith('data'));
        if (!clk || !data) return { error: 'fixture-signals-missing' };

        waveSignals = [makeWaveSignal(clk), makeWaveSignal(data)];
        waveSignals[1].busExpanded = true;
        selectedWaveIndex = 0;
        selectedWaveIndices = new Set([0]);
        selectedBusBit = null;
        cursorA = 0;
        activeCursor = 'a';

        changeSearchMode.value = 'rising';
        changeSearchValue.value = '';
        let result = jumpToCondition(1);
        const rising = result.time;

        changeSearchMode.value = 'falling';
        result = jumpToCondition(1);
        const falling = result.time;

        cursorA = 0;
        selectedWaveIndex = 1;
        selectedWaveIndices = new Set([1]);
        selectedBusBit = null;
        changeSearchMode.value = 'value';
        changeSearchValue.value = '0xA';
        result = jumpToCondition(1);
        const exact = result.time;

        changeSearchMode.value = 'xz';
        changeSearchValue.value = '';
        result = jumpToCondition(1);
        const xz = result.time;

        cursorA = 0;
        selectedBusBit = { parentWaveIndex: 1, bitIndex: 1 };
        changeSearchMode.value = 'rising';
        result = jumpToCondition(1);
        const bitRising = result.time;

        cursorA = 0;
        selectedBusBit = null;
        selectedWaveIndex = 1;
        selectedWaveIndices = new Set([1]);
        changeSearchMode.value = 'value';
        changeSearchValue.value = '0x10';
        const beforeInvalid = activeCursorTime();
        result = jumpToCondition(1);
        const invalidStayed = result.error === 'invalid-value' && activeCursorTime() === beforeInvalid;

        cursorA = Math.max(1, Number(vcd.endTime) || 1);
        selectedWaveIndex = 0;
        selectedWaveIndices = new Set([0]);
        changeSearchMode.value = 'change';
        changeSearchValue.value = '';
        const beforeBoundary = activeCursorTime();
        result = jumpToCondition(1);
        const boundaryStayed = result.error === 'no-match' && activeCursorTime() === beforeBoundary;
        updateSearchControls();
        render();

        return {
            rising,
            falling,
            exact,
            xz,
            bitRising,
            invalidStayed,
            boundaryStayed,
        };
    },
    busBitClickSelectionSample() {
        const data = allSignals.find(signal => Number(signal.width) > 1);
        if (!data) return { selected: false, error: 'bus-missing' };
        waveSignals = [makeWaveSignal(data)];
        waveSignals[0].busExpanded = true;
        const bitRow = makeBusBitRow(waveSignals[0], 0, 0);
        selectBusBit(bitRow);
        const displayIndex = displayedWaveItems().findIndex(item => isSelectedBusBit(item));
        const rect = waveCanvasPane.getBoundingClientRect();
        const localY = HEADER_HEIGHT + displayIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
        boxStart = { x: 20, y: localY };
        boxCurrent = null;
        finishBoxSelection({ clientX: rect.left + 20, clientY: rect.top + localY });
        return {
            selected: selectedBusBit?.parentWaveIndex === 0 && selectedBusBit?.bitIndex === 0,
        };
    },
    flushLayoutSave() {
        lastSavedLayoutJson = '';
        persistLayoutNow();
        const layout = captureLayout();
        const snapshot = this.state();
        return {
            saved: !!layout && lastSavedLayoutJson === JSON.stringify(layout),
            ...snapshot,
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
            cursorTime: activeCursorTime(),
            cursorA,
            cursorB,
            activeCursor,
        };
    },
    libraryState() {
        return {
            selectedScope: scopeSelect.value || '',
            filteredCount: filteredSignals.length,
            renderedIndices: Array.from(signalList.querySelectorAll('.signal-row'))
                .map(row => Number(row.dataset.index)),
            scrollTop: signalList.scrollTop,
            scrollHeight: signalList.scrollHeight,
            clientHeight: signalList.clientHeight,
            references: filteredSignals.map(signal => signal.reference),
        };
    },
};
resizeCanvas();
waveformTransport.send({ type: 'ready' });
