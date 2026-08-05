import {
    Graph,
    MiniMap,
    Selection,
    type Cell,
    type Edge,
    type Node,
} from '@antv/x6';
import {
    ChevronDown,
    ChevronUp,
    createElement,
    Map as MapIcon,
    Maximize2,
    Scan,
    Search as SearchIcon,
    Workflow,
} from 'lucide';

import type {
    GraphNode,
    GraphNodeKind,
    GraphPin,
    NetworkEndpoint,
    SchematicGraph,
    SchematicNetwork,
} from '../../src/schematic/graphModel';
import {
    deriveFeedbackRoutes,
    SCHEMATIC_BASE_NODE_SIZE,
    SCHEMATIC_PIN_LAYOUT,
    SCHEMATIC_PORT_SIZE,
    schematicNodeSize,
    type SchematicLayout,
} from '../../src/schematic/layoutStore';
import type { HostEvent, WebviewCommand } from '../../src/schematic/protocol';
import {
    cloneSchematicLayout,
    DebouncedLayoutSaveScheduler,
    navigationCommandForCell,
    placeSchematicNetworkLabel,
    summarizeSchematicSelection,
} from '../../src/schematic/webviewSupport';

type PersistedWebviewState = { layouts?: Record<string, SchematicLayout> };
type VsCodeApi = {
    postMessage(message: WebviewCommand): void;
    getState(): PersistedWebviewState | undefined;
    setState(state: PersistedWebviewState): void;
};

declare global {
    interface Window {
        acquireVsCodeApi?: () => VsCodeApi;
    }
}

type CellData = {
    objectId: string;
    objectType: 'node' | 'network';
    node?: GraphNode;
    network?: SchematicNetwork;
};

type RenderedNode = {
    model: GraphNode;
    cell: Node;
    width: number;
    height: number;
    pins: Map<string, { x: number; y: number }>;
};

type SearchMatch = { cell: Cell; objectId: string; description: string };

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const SAVE_DELAY_MS = 250;

const shapeNames: Record<GraphNodeKind, string> = {
    port: 'veriflow-port',
    instance: 'veriflow-instance',
    constant: 'veriflow-constant',
    expression: 'veriflow-expression',
    opaque: 'veriflow-opaque',
    generateArray: 'veriflow-generate-array',
};

const shapeAccents: Record<GraphNodeKind, string> = {
    port: 'var(--vscode-charts-green, #16825d)',
    instance: 'var(--vscode-charts-blue, #2472c8)',
    constant: 'var(--vscode-charts-yellow, #b89500)',
    expression: 'var(--vscode-charts-purple, #8b5cf6)',
    opaque: 'var(--vscode-charts-red, #c74e39)',
    generateArray: 'var(--vscode-charts-orange, #c76b29)',
};

const dom = {
    canvas: requiredElement<HTMLDivElement>('canvas'),
    canvasRegion: requiredElement<HTMLElement>('canvas-region'),
    canvasState: requiredElement<HTMLDivElement>('canvas-state'),
    canvasStateMessage: requiredElement<HTMLSpanElement>('canvas-state-message'),
    moduleSelector: requiredElement<HTMLSelectElement>('module-selector'),
    fitButton: requiredElement<HTMLButtonElement>('fit-button'),
    zoomResetButton: requiredElement<HTMLButtonElement>('zoom-reset-button'),
    relayoutButton: requiredElement<HTMLButtonElement>('relayout-button'),
    searchButton: requiredElement<HTMLButtonElement>('search-button'),
    searchControls: requiredElement<HTMLDivElement>('search-controls'),
    searchInput: requiredElement<HTMLInputElement>('search-input'),
    searchPreviousButton: requiredElement<HTMLButtonElement>('search-previous-button'),
    searchNextButton: requiredElement<HTMLButtonElement>('search-next-button'),
    minimapButton: requiredElement<HTMLButtonElement>('minimap-button'),
    minimap: requiredElement<HTMLDivElement>('minimap'),
    errorCount: requiredElement<HTMLSpanElement>('error-count'),
    warningCount: requiredElement<HTMLSpanElement>('warning-count'),
    selectionStatus: requiredElement<HTMLSpanElement>('selection-status'),
    diagnosticStatus: requiredElement<HTMLSpanElement>('diagnostic-status'),
};

function requiredElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing schematic element #${id}`);
    return element as T;
}

function previewApi(): VsCodeApi {
    let state: PersistedWebviewState | undefined;
    return {
        postMessage(message): void {
            window.dispatchEvent(new CustomEvent('veriflow:webview-message', {
                detail: message,
            }));
        },
        getState(): PersistedWebviewState | undefined {
            return state;
        },
        setState(nextState): void {
            state = nextState;
        },
    };
}

const vscode = typeof window.acquireVsCodeApi === 'function'
    ? window.acquireVsCodeApi()
    : previewApi();

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    return limit <= 3 ? value.slice(0, limit) : `${value.slice(0, limit - 3)}...`;
}

function registerShapes(): void {
    for (const [kind, shapeName] of Object.entries(shapeNames) as Array<[
        GraphNodeKind,
        string,
    ]>) {
        Graph.registerNode(shapeName, {
            inherit: 'rect',
            width: kind === 'port'
                ? SCHEMATIC_PORT_SIZE.width
                : SCHEMATIC_BASE_NODE_SIZE.width,
            height: kind === 'port'
                ? SCHEMATIC_PORT_SIZE.height
                : SCHEMATIC_BASE_NODE_SIZE.height,
            markup: [
                { tagName: 'rect', selector: 'body' },
                { tagName: 'rect', selector: 'accent' },
                { tagName: 'text', selector: 'label' },
                { tagName: 'text', selector: 'subtitle' },
            ],
            portMarkup: [{ tagName: 'circle', selector: 'portBody' }],
            portLabelMarkup: [{ tagName: 'text', selector: 'portLabel' }],
            attrs: {
                body: {
                    fill: 'var(--vscode-editor-background, #ffffff)',
                    stroke: 'var(--vscode-editorWidget-border, #8c8c8c)',
                    strokeWidth: 1,
                    rx: 3,
                    ry: 3,
                },
                accent: {
                    x: 0,
                    y: 0,
                    width: 4,
                    height: '100%',
                    fill: shapeAccents[kind],
                    stroke: 'none',
                },
                label: {
                    x: 12,
                    y: kind === 'port' ? 20 : 17,
                    fill: 'var(--vscode-editor-foreground, #202124)',
                    fontFamily: 'var(--vscode-font-family, sans-serif)',
                    fontSize: 12,
                    fontWeight: 600,
                    textAnchor: 'start',
                    textVerticalAnchor: 'middle',
                    pointerEvents: 'none',
                },
                subtitle: {
                    x: 12,
                    y: 33,
                    fill: 'var(--vscode-descriptionForeground, #616161)',
                    fontFamily: 'var(--vscode-font-family, sans-serif)',
                    fontSize: 10,
                    textAnchor: 'start',
                    textVerticalAnchor: 'middle',
                },
            },
        }, true);
    }

    Graph.registerEdge('veriflow-network', {
        inherit: 'edge',
        connector: { name: 'normal' },
        attrs: {
            line: {
                fill: 'none',
                stroke: 'var(--vscode-editor-foreground, #505050)',
                strokeWidth: 1,
                strokeLinejoin: 'round',
                strokeLinecap: 'square',
            },
        },
    }, true);
}

registerShapes();

function portGroups() {
    const body = {
        magnet: false,
        r: 3,
        fill: 'var(--vscode-editor-background, #ffffff)',
        stroke: 'var(--vscode-editor-foreground, #505050)',
        strokeWidth: 1,
    };
    return {
        left: {
            position: { name: 'absolute' },
            attrs: { portBody: body },
            label: { position: { name: 'right', args: { x: 7 } } },
        },
        right: {
            position: { name: 'absolute' },
            attrs: { portBody: body },
            label: { position: { name: 'left', args: { x: -7 } } },
        },
        bottom: {
            position: { name: 'absolute' },
            attrs: { portBody: body },
            label: { position: { name: 'top', args: { y: -6 } } },
        },
    };
}

function pinItems(
    node: GraphNode,
    width: number,
    height: number
): { items: object[]; positions: Map<string, { x: number; y: number }> } {
    const positions = new Map<string, { x: number; y: number }>();
    const bySide = {
        left: node.pins.filter(pin => pin.side === 'left'),
        right: node.pins.filter(pin => pin.side === 'right'),
        bottom: node.pins.filter(pin => pin.side === 'bottom'),
    };
    const items = node.pins.map(pin => {
        const sidePins = bySide[pin.side];
        const index = sidePins.indexOf(pin);
        const position = pin.side === 'bottom'
            ? { x: width * (index + 1) / (sidePins.length + 1), y: height }
            : {
                x: pin.side === 'left' ? 0 : width,
                y: node.kind === 'port'
                    ? height / 2
                    : SCHEMATIC_PIN_LAYOUT.startY
                        + index * SCHEMATIC_PIN_LAYOUT.rowHeight,
            };
        positions.set(pin.id, position);
        const bottomSlotWidth = width / Math.max(1, sidePins.length);
        const bottomLimit = bottomSlotWidth < 7
            ? 0
            : Math.max(1, Math.floor(bottomSlotWidth / 7));
        const labelText = node.kind === 'port'
            ? ''
            : pin.side === 'bottom' && bottomLimit === 0
                ? ''
                : truncate(pin.name, pin.side === 'bottom' ? bottomLimit : 10);
        return {
            id: pin.id,
            group: pin.side,
            args: position,
            attrs: {
                portBody: {
                    strokeDasharray: pin.readOnly ? '2 1' : undefined,
                },
                portLabel: {
                    text: labelText,
                    title: pin.name,
                    fill: 'var(--vscode-editor-foreground, #202124)',
                    fontFamily: 'var(--vscode-font-family, sans-serif)',
                    fontSize: 10,
                    textVerticalAnchor: 'middle',
                    pointerEvents: 'none',
                },
            },
        };
    });
    return { items, positions };
}

function positionFor(layout: SchematicLayout, nodeId: string): { x: number; y: number } {
    return layout.nodes[nodeId] ?? { x: 0, y: 0 };
}

function createRenderedNode(model: GraphNode, layout: SchematicLayout): RenderedNode {
    const { width, height } = schematicNodeSize(model);
    const center = positionFor(layout, model.id);
    const ports = pinItems(model, width, height);
    const subtitle = model.subtitle ?? (model.readOnly ? 'read-only' : '');
    const cell = graph.addNode({
        id: model.id,
        shape: shapeNames[model.kind],
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
        data: {
            objectId: model.id,
            objectType: 'node',
            node: model,
        } satisfies CellData,
        attrs: {
            root: {
                tabindex: 0,
                role: 'link',
                'aria-label': `${model.kind}: ${model.label}`,
                'aria-keyshortcuts': model.definitionKey ? 'Enter Shift+Enter' : 'Enter',
            },
            body: {
                strokeDasharray: model.readOnly ? '4 2' : undefined,
            },
            accent: { height },
            label: {
                text: truncate(model.label, model.kind === 'port' ? 9 : 19),
                title: model.label,
            },
            subtitle: {
                text: truncate(subtitle, 22),
                title: subtitle,
                cursor: model.kind === 'instance' && model.definitionKey
                    ? 'pointer'
                    : 'default',
                textDecoration: model.kind === 'instance' && model.definitionKey
                    ? 'underline'
                    : 'none',
                event: model.kind === 'instance' && model.definitionKey
                    ? 'node:open-definition'
                    : undefined,
            },
        },
        ports: {
            groups: portGroups(),
            items: ports.items,
        },
        zIndex: 2,
    });
    return { model, cell, width, height, pins: ports.positions };
}

function endpointPosition(
    endpoint: NetworkEndpoint,
    renderedNodes: ReadonlyMap<string, RenderedNode>
): { x: number; y: number } | undefined {
    const rendered = renderedNodes.get(endpoint.nodeId);
    const relativePin = rendered?.pins.get(endpoint.pinId);
    if (!rendered || !relativePin) return undefined;
    const topLeft = rendered.cell.getPosition();
    return { x: topLeft.x + relativePin.x, y: topLeft.y + relativePin.y };
}

function endpointTerminal(endpoint: NetworkEndpoint) {
    return { cell: endpoint.nodeId, port: endpoint.pinId };
}

function compareEndpoint(left: NetworkEndpoint, right: NetworkEndpoint): number {
    return left.nodeId.localeCompare(right.nodeId)
        || left.pinId.localeCompare(right.pinId)
        || left.role.localeCompare(right.role);
}

function networkPairs(network: SchematicNetwork): Array<{
    source: NetworkEndpoint;
    target: NetworkEndpoint;
}> {
    const endpoints = [...network.endpoints].sort(compareEndpoint);
    const drivers = endpoints.filter(endpoint => endpoint.role === 'driver');
    const sources = drivers.length > 0 ? drivers : endpoints.slice(0, 1);
    const targets = drivers.length > 0
        ? endpoints.filter(endpoint => endpoint.role !== 'driver')
        : endpoints.slice(1);
    return sources.flatMap(source => targets
        .filter(target => target.nodeId !== source.nodeId || target.pinId !== source.pinId)
        .map(target => ({ source, target }))
    );
}

function networkStrokeWidth(network: SchematicNetwork): number {
    return network.width.kind === 'known' && network.width.bits > 1 ? 2 : 1;
}

function renderNetworks(
    model: SchematicGraph,
    layout: SchematicLayout,
    renderedNodes: ReadonlyMap<string, RenderedNode>
): Edge[] {
    const feedbackRoutes = new Map(
        deriveFeedbackRoutes(model, layout).map(route => [route.networkId, route])
    );
    const nodeBounds = [...renderedNodes.values()].map(rendered => {
        const center = positionFor(layout, rendered.model.id);
        return {
            x: center.x - rendered.width / 2,
            y: center.y - rendered.height / 2,
            width: rendered.width,
            height: rendered.height,
        };
    });
    const edges: Edge[] = [];
    for (const network of model.networks) {
        const pairs = networkPairs(network);
        const feedback = feedbackRoutes.get(network.id);
        const allPositions = network.endpoints.flatMap(endpoint => {
            const position = endpointPosition(endpoint, renderedNodes);
            return position ? [position] : [];
        });
        const trunkX = allPositions.length > 0
            ? (Math.min(...allPositions.map(point => point.x))
                + Math.max(...allPositions.map(point => point.x))) / 2
            : 0;
        pairs.forEach(({ source, target }, index) => {
            const sourcePosition = endpointPosition(source, renderedNodes);
            const targetPosition = endpointPosition(target, renderedNodes);
            if (!sourcePosition || !targetPosition) return;
            const vertices = feedback
                ? [
                    { x: sourcePosition.x, y: feedback.trunk.y },
                    { x: targetPosition.x, y: feedback.trunk.y },
                ]
                : [
                    { x: trunkX, y: sourcePosition.y },
                    { x: trunkX, y: targetPosition.y },
                ];
            const directed = source.role === 'driver' && target.role === 'load';
            const label = network.adapterLabel
                ? `${network.name} ${network.adapterLabel}`
                : network.name;
            const labelText = truncate(label, 28);
            const labelPlacement = placeSchematicNetworkLabel(
                [sourcePosition, ...vertices, targetPosition],
                nodeBounds,
                labelText,
                index
            );
            const edge = graph.addEdge({
                id: `${network.id}:segment:${index}`,
                shape: 'veriflow-network',
                source: endpointTerminal(source),
                target: endpointTerminal(target),
                vertices,
                data: {
                    objectId: network.id,
                    objectType: 'network',
                    network,
                } satisfies CellData,
                attrs: {
                    root: {
                        tabindex: 0,
                        role: 'link',
                        'aria-label': `network: ${network.name}`,
                        'aria-keyshortcuts': 'Enter',
                    },
                    line: {
                        strokeWidth: networkStrokeWidth(network),
                        targetMarker: directed
                            ? { name: 'block', width: 6, height: 6 }
                            : null,
                    },
                },
                labels: labelPlacement ? [{
                    attrs: {
                        text: {
                            text: labelText,
                            fill: 'var(--vscode-editor-foreground, #202124)',
                            fontFamily: 'var(--vscode-font-family, sans-serif)',
                            fontSize: 10,
                        },
                        rect: {
                            fill: 'var(--vscode-editor-background, #ffffff)',
                            stroke: 'var(--vscode-panel-border, #c7c7c7)',
                            strokeWidth: 1,
                            rx: 2,
                            ry: 2,
                        },
                    },
                    position: labelPlacement.position,
                }] : [],
                zIndex: 1,
            });
            edges.push(edge);
        });
    }
    return edges;
}

const selection = new Selection({
    enabled: true,
    multiple: true,
    rubberband: true,
    movable: true,
    strict: false,
    showNodeSelectionBox: true,
    showEdgeSelectionBox: true,
    pointerEvents: 'auto',
    eventTypes: ['leftMouseDown'],
});

const graph = new Graph({
    container: dom.canvas,
    autoResize: true,
    background: { color: 'var(--vscode-editor-background, #ffffff)' },
    grid: {
        visible: true,
        size: 16,
        type: 'dot',
        args: {
            color: 'var(--vscode-editorWhitespace-foreground, #d1d1d1)',
            thickness: 1,
        },
    },
    scaling: { min: MIN_ZOOM, max: MAX_ZOOM },
    mousewheel: {
        enabled: true,
        factor: 1.1,
        minScale: MIN_ZOOM,
        maxScale: MAX_ZOOM,
        modifiers: null,
        zoomAtMousePosition: true,
    },
    panning: {
        enabled: true,
        eventTypes: ['rightMouseDown', 'mouseWheelDown'],
        modifiers: null,
    },
    interacting: {
        nodeMovable: true,
        edgeMovable: false,
        edgeLabelMovable: false,
        arrowheadMovable: false,
        vertexMovable: false,
        vertexAddable: false,
        vertexDeletable: false,
        magnetConnectable: false,
        toolsAddable: false,
    },
    preventDefaultContextMenu: true,
});
graph.use(selection);

let currentGraph: SchematicGraph | undefined;
let currentLayout: SchematicLayout | undefined;
let selectedModuleKey = '';
let applyingLayout = false;
let minimapPlugin: MiniMap | undefined;
let minimapAvailable = false;
let searchMatches: SearchMatch[] = [];
let searchIndex = -1;
let errors = 0;
let warnings = 0;

function post(message: WebviewCommand): void {
    vscode.postMessage(message);
}

const layoutSaveScheduler = new DebouncedLayoutSaveScheduler(
    SAVE_DELAY_MS,
    (moduleKey, layout) => {
        const priorLayouts = vscode.getState()?.layouts ?? {};
        vscode.setState({
            layouts: Object.fromEntries([
                ...Object.entries(priorLayouts)
                    .filter(([key]) => key !== moduleKey),
                [moduleKey, layout],
            ]),
        });
        post({ type: 'saveLayout', moduleKey, layout });
    }
);

function scheduleLayoutSave(): void {
    if (!currentLayout || !currentGraph || applyingLayout) return;
    layoutSaveScheduler.schedule(currentGraph.moduleKey, currentLayout);
}

function setCanvasState(message?: string): void {
    if (message === undefined) {
        dom.canvasState.hidden = true;
        dom.canvasStateMessage.textContent = '';
        return;
    }
    dom.canvasStateMessage.textContent = message;
    dom.canvasState.hidden = false;
}

function setGraphControls(enabled: boolean): void {
    dom.fitButton.disabled = !enabled;
    dom.zoomResetButton.disabled = !enabled;
    dom.relayoutButton.disabled = !enabled;
}

function updateDiagnostics(nextErrors: number, nextWarnings: number): void {
    errors = Math.max(0, Math.trunc(nextErrors));
    warnings = Math.max(0, Math.trunc(nextWarnings));
    dom.errorCount.textContent = `E ${errors}`;
    dom.warningCount.textContent = `W ${warnings}`;
    dom.diagnosticStatus.textContent = `${errors} error${errors === 1 ? '' : 's'}, `
        + `${warnings} warning${warnings === 1 ? '' : 's'}`;
}

function cellData(cell: Cell): CellData | undefined {
    const data = cell.getData<unknown>();
    if (!data || typeof data !== 'object') return undefined;
    const candidate = data as Partial<CellData>;
    return typeof candidate.objectId === 'string'
        && (candidate.objectType === 'node' || candidate.objectType === 'network')
        ? candidate as CellData
        : undefined;
}

function descriptionFor(data: CellData): string {
    if (data.node) return `${data.node.kind}: ${data.node.label}`;
    if (data.network) return `network: ${data.network.name}`;
    return data.objectId;
}

function updateSelectionStatus(cells: Cell[], persist = true): void {
    if (!currentLayout) return;
    const summary = summarizeSchematicSelection(cells.flatMap(cell => {
        const data = cellData(cell);
        return data ? [{
            objectId: data.objectId,
            description: descriptionFor(data),
        }] : [];
    }));
    if (summary.selectedObjectId === undefined) {
        delete currentLayout.selectedObjectId;
    } else {
        currentLayout.selectedObjectId = summary.selectedObjectId;
    }
    dom.selectionStatus.textContent = summary.statusText;
    if (persist) scheduleLayoutSave();
}

function navigationTargetForCell(cell: Cell): {
    sourceSpan?: GraphNode['sourceSpan'];
    definitionKey?: string;
} {
    const data = cellData(cell);
    return data?.node ?? data?.network ?? {};
}

function updateViewportFromGraph(): void {
    if (!currentLayout || applyingLayout) return;
    const translation = graph.translate();
    currentLayout.viewport = {
        x: translation.tx,
        y: translation.ty,
        zoom: graph.zoom(),
    };
    scheduleLayoutSave();
}

function setMinimapVisibility(): void {
    const wanted = currentLayout?.minimap === true && minimapAvailable;
    if (wanted && !minimapPlugin) {
        dom.minimap.hidden = false;
        minimapPlugin = new MiniMap({
            container: dom.minimap,
            width: 180,
            height: 120,
            padding: 8,
            scalable: false,
        });
        graph.use(minimapPlugin);
    } else if (!wanted && minimapPlugin) {
        graph.disposePlugins('minimap');
        minimapPlugin = undefined;
        dom.minimap.replaceChildren();
        dom.minimap.hidden = true;
    } else {
        dom.minimap.hidden = !wanted;
    }
    dom.minimapButton.disabled = !minimapAvailable;
    dom.minimapButton.setAttribute('aria-pressed', String(wanted));
}

function updateMinimapAvailability(): void {
    if (!currentGraph || currentGraph.nodes.length === 0) {
        minimapAvailable = false;
    } else {
        const bounds = graph.getContentBBox();
        const viewportWidth = Math.max(1, dom.canvas.clientWidth);
        const viewportHeight = Math.max(1, dom.canvas.clientHeight);
        minimapAvailable = bounds.width > viewportWidth * 1.25
            || bounds.height > viewportHeight * 1.25;
    }
    setMinimapVisibility();
}

function applyViewport(layout: SchematicLayout): void {
    graph.zoomTo(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, layout.viewport.zoom)));
    graph.translate(layout.viewport.x, layout.viewport.y);
}

function restoreSelection(layout: SchematicLayout): void {
    selection.clean();
    const matchingCell = layout.selectedObjectId
        ? graph.getCells().find(cell =>
            cellData(cell)?.objectId === layout.selectedObjectId
        )
        : undefined;
    if (matchingCell) selection.select(matchingCell);
    updateSelectionStatus(selection.getSelectedCells(), false);
}

function renderSchematic(model: SchematicGraph, layout: SchematicLayout): void {
    applyingLayout = true;
    currentGraph = model;
    currentLayout = cloneSchematicLayout(layout);
    selectedModuleKey = model.moduleKey;
    dom.moduleSelector.value = model.moduleKey;
    graph.clearCells();
    const renderedNodes = new Map<string, RenderedNode>();
    graph.batchUpdate('render-schematic', () => {
        for (const node of model.nodes) {
            renderedNodes.set(node.id, createRenderedNode(node, layout));
        }
        renderNetworks(model, layout, renderedNodes);
    });
    applyViewport(layout);
    restoreSelection(layout);
    applyingLayout = false;

    setGraphControls(model.nodes.length > 0);
    setCanvasState(model.nodes.length === 0 ? 'No schematic objects' : undefined);
    const graphErrors = model.diagnostics.filter(item => item.severity === 'error').length;
    const graphWarnings = model.diagnostics.filter(item => item.severity === 'warning').length;
    updateDiagnostics(graphErrors, graphWarnings);
    updateMinimapAvailability();
    runSearch(dom.searchInput.value, false);
}

function resetSearchStyles(): void {
    for (const cell of graph.getCells()) {
        if (cell.isNode()) {
            cell.attr('body/stroke', 'var(--vscode-editorWidget-border, #8c8c8c)');
            cell.attr('body/strokeWidth', 1);
        } else {
            cell.attr('line/stroke', 'var(--vscode-editor-foreground, #505050)');
            const data = cellData(cell);
            cell.attr('line/strokeWidth', data?.network
                ? networkStrokeWidth(data.network)
                : 1);
        }
    }
}

function searchText(data: CellData): string {
    if (data.node) {
        return [
            data.node.label,
            data.node.subtitle ?? '',
            data.node.kind,
            ...data.node.pins.map(pin => pin.name),
        ].join('\n');
    }
    return [
        data.network?.name ?? '',
        data.network?.adapterLabel ?? '',
        'network',
    ].join('\n');
}

function collectSearchMatches(query: string): SearchMatch[] {
    const lowered = query.trim().toLocaleLowerCase();
    if (!lowered) return [];
    const seen = new Set<string>();
    return graph.getCells().flatMap(cell => {
        const data = cellData(cell);
        if (!data || seen.has(data.objectId)
            || !searchText(data).toLocaleLowerCase().includes(lowered)) {
            return [];
        }
        seen.add(data.objectId);
        return [{ cell, objectId: data.objectId, description: descriptionFor(data) }];
    });
}

function showSearchMatch(index: number): void {
    if (searchMatches.length === 0) {
        searchIndex = -1;
        dom.searchPreviousButton.disabled = true;
        dom.searchNextButton.disabled = true;
        return;
    }
    searchIndex = (index + searchMatches.length) % searchMatches.length;
    const match = searchMatches[searchIndex];
    graph.centerCell(match.cell);
    selection.reset(match.cell);
    dom.selectionStatus.textContent = `${match.description} (${searchIndex + 1}/${searchMatches.length})`;
    dom.searchPreviousButton.disabled = searchMatches.length < 2;
    dom.searchNextButton.disabled = searchMatches.length < 2;
}

function runSearch(query: string, notifyHost: boolean): void {
    resetSearchStyles();
    searchMatches = collectSearchMatches(query);
    for (const match of searchMatches) {
        if (match.cell.isNode()) {
            match.cell.attr('body/stroke', 'var(--vscode-editor-findMatchBorder, #f0a000)');
            match.cell.attr('body/strokeWidth', 2);
        } else {
            match.cell.attr('line/stroke', 'var(--vscode-editor-findMatchBorder, #f0a000)');
            match.cell.attr('line/strokeWidth', 2);
        }
    }
    if (notifyHost) post({ type: 'search', query });
    showSearchMatch(0);
}

function initialize(event: Extract<HostEvent, { type: 'initialize' }>): void {
    dom.moduleSelector.replaceChildren();
    for (const module of event.modules) {
        const option = document.createElement('option');
        option.value = module.key;
        option.textContent = module.name;
        dom.moduleSelector.append(option);
    }
    selectedModuleKey = event.selectedModuleKey;
    dom.moduleSelector.value = event.selectedModuleKey;
    dom.moduleSelector.disabled = event.modules.length === 0;
    setCanvasState(event.modules.length === 0 ? 'No modules' : 'Loading schematic');
}

function handleHostEvent(event: HostEvent): void {
    switch (event.type) {
        case 'initialize':
            initialize(event);
            return;
        case 'graph':
            renderSchematic(event.graph, event.layout);
            return;
        case 'diagnostics':
            updateDiagnostics(event.errors, event.warnings);
            return;
        case 'hostError':
            setGraphControls(false);
            setCanvasState(event.message || 'Unable to render schematic');
            return;
    }
}

function installIcons(): void {
    const icons = [
        [dom.fitButton, Maximize2],
        [dom.zoomResetButton, Scan],
        [dom.relayoutButton, Workflow],
        [dom.searchButton, SearchIcon],
        [dom.minimapButton, MapIcon],
        [dom.searchPreviousButton, ChevronUp],
        [dom.searchNextButton, ChevronDown],
    ] as const;
    for (const [button, icon] of icons) {
        const slot = button.querySelector('[data-icon-slot]');
        if (!slot) continue;
        slot.replaceChildren(createElement(icon, {
            width: 16,
            height: 16,
            'stroke-width': 1.75,
            'aria-hidden': 'true',
        }));
    }
}

installIcons();

dom.moduleSelector.addEventListener('change', () => {
    selectedModuleKey = dom.moduleSelector.value;
    setCanvasState('Loading schematic');
    post({ type: 'selectModule', moduleKey: selectedModuleKey });
});

dom.fitButton.addEventListener('click', () => {
    graph.zoomToFit({ padding: 24, maxScale: 1 });
    updateViewportFromGraph();
    updateMinimapAvailability();
});

dom.zoomResetButton.addEventListener('click', () => {
    graph.zoomTo(1);
    updateViewportFromGraph();
});

dom.relayoutButton.addEventListener('click', () => {
    if (currentGraph) {
        post({ type: 'relayoutAll', moduleKey: currentGraph.moduleKey });
    }
});

dom.searchButton.addEventListener('click', () => {
    const opening = dom.searchControls.hidden;
    dom.searchControls.hidden = !opening;
    dom.searchButton.setAttribute('aria-expanded', String(opening));
    if (opening) {
        dom.searchInput.focus();
        dom.searchInput.select();
    } else {
        dom.searchInput.value = '';
        runSearch('', true);
    }
});

dom.searchInput.addEventListener('input', () => {
    runSearch(dom.searchInput.value, true);
});

dom.searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        showSearchMatch(event.shiftKey ? searchIndex - 1 : searchIndex + 1);
    } else if (event.key === 'Escape') {
        dom.searchControls.hidden = true;
        dom.searchButton.setAttribute('aria-expanded', 'false');
        dom.searchInput.value = '';
        runSearch('', true);
        dom.searchButton.focus();
    }
});

dom.searchPreviousButton.addEventListener('click', () => {
    showSearchMatch(searchIndex - 1);
});

dom.searchNextButton.addEventListener('click', () => {
    showSearchMatch(searchIndex + 1);
});

dom.minimapButton.addEventListener('click', () => {
    if (!currentLayout || !minimapAvailable) return;
    currentLayout.minimap = !currentLayout.minimap;
    setMinimapVisibility();
    scheduleLayoutSave();
});

dom.canvas.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(event.target instanceof Element)) return;
    const cellElement = event.target.closest('.x6-cell[data-cell-id]');
    const cellId = cellElement?.getAttribute('data-cell-id');
    const cell = cellId ? graph.getCellById(cellId) : undefined;
    if (!cell) return;
    const command = navigationCommandForCell(
        navigationTargetForCell(cell),
        event.shiftKey
    );
    if (!command) return;
    event.preventDefault();
    post(command);
});

graph.on('node:change:position', ({ node }) => {
    if (applyingLayout || !currentLayout) return;
    const data = cellData(node);
    if (!data?.node) return;
    const position = node.getPosition();
    const size = node.getSize();
    currentLayout.nodes[data.node.id] = {
        x: position.x + size.width / 2,
        y: position.y + size.height / 2,
        fixed: true,
    };
    scheduleLayoutSave();
    updateMinimapAvailability();
});

graph.on('scale', updateViewportFromGraph);
graph.on('translate', updateViewportFromGraph);

graph.on('cell:dblclick', ({ cell }) => {
    const command = navigationCommandForCell(navigationTargetForCell(cell), false);
    if (command) post(command);
});

graph.on('node:open-definition' as never, ({ cell }: { cell: Cell }) => {
    const command = navigationCommandForCell(navigationTargetForCell(cell), true);
    if (command) post(command);
});

selection.on('selection:changed', ({ selected }) => {
    if (!applyingLayout) updateSelectionStatus(selected);
});

const resizeObserver = new ResizeObserver(() => {
    graph.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
    updateMinimapAvailability();
});
resizeObserver.observe(dom.canvasRegion);

window.addEventListener('message', event => {
    if (!event.data || typeof event.data !== 'object') return;
    const type = (event.data as { type?: unknown }).type;
    if (type === 'initialize' || type === 'graph' || type === 'diagnostics'
        || type === 'hostError') {
        handleHostEvent(event.data as HostEvent);
    }
});

post({ type: 'ready' });
