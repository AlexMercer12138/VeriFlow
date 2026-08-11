import {
    Graph,
    MiniMap,
    Selection,
    type Cell,
    type Node,
} from '@antv/x6';
import {
    ChevronDown,
    ChevronUp,
    createElement,
    Map as MapIcon,
    Maximize2,
    PanelRightClose,
    PanelRightOpen,
    Scan,
    Search as SearchIcon,
    Workflow,
    type IconNode,
} from 'lucide';

import {
    layoutSchematic,
    snapNodesToPlacement,
    SCHEMATIC_NETWORK_LABEL_LAYOUT,
    SCHEMATIC_NODE_LAYOUT,
    SCHEMATIC_TEXT_STYLES,
    type GraphNode,
    type GraphNodeKind,
    type NetworkRoute,
    type RenderedNodeGeometry,
    type RouteSegment,
    type SchematicGraph,
    type SchematicRenderModel,
    type SchematicNetwork,
    type TextMeasurementStyle,
} from '@veriflow/schematic-core';
import type { SchematicLayout } from '../../../veriflow-vscode/src/schematic/layoutStore';
import type { HostEvent, WebviewCommand } from '../../../veriflow-vscode/src/schematic/protocol';
import {
    cloneSchematicLayout,
    DebouncedLayoutSaveScheduler,
    formatSchematicDiagnosticDetails,
    mergeSchematicWebviewLayouts,
    navigationCommandForCell,
    projectSchematicInspector,
    summarizeSchematicSelection,
    type SchematicInspectorModel,
} from '../../../veriflow-vscode/src/schematic/webviewSupport';

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
    networkRoute?: NetworkRoute;
    junction?: boolean;
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
    inspectorToggleButton: requiredElement<HTMLButtonElement>('inspector-toggle-button'),
    inspector: requiredElement<HTMLElement>('inspector'),
    inspectorTitle: requiredElement<HTMLHeadingElement>('inspector-title'),
    inspectorProperties: requiredElement<HTMLDListElement>('inspector-properties'),
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

let textMeasureContext: CanvasRenderingContext2D | null | undefined;

function measureNodeText(text: string, style: TextMeasurementStyle): number {
    if (textMeasureContext === undefined) {
        textMeasureContext = document.createElement('canvas').getContext('2d');
    }
    if (textMeasureContext) {
        const fontFamily = getComputedStyle(document.documentElement)
            .getPropertyValue('--vscode-font-family').trim() || 'sans-serif';
        textMeasureContext.font = `${style.fontWeight} ${style.fontSize}px ${fontFamily}`;
        const width = textMeasureContext.measureText(text).width;
        if (Number.isFinite(width) && width >= 0) return width;
    }
    const weightFactor = style.fontWeight === 600 ? 0.62 : 0.56;
    return text.length * style.fontSize * weightFactor;
}

function registerShapes(): void {
    for (const [kind, shapeName] of Object.entries(shapeNames) as Array<[
        GraphNodeKind,
        string,
    ]>) {
        Graph.registerNode(shapeName, {
            inherit: 'rect',
            width: kind === 'port'
                ? SCHEMATIC_NODE_LAYOUT.portWidth
                : SCHEMATIC_NODE_LAYOUT.minimumWidth,
            height: kind === 'port'
                ? SCHEMATIC_NODE_LAYOUT.portHeight
                : SCHEMATIC_NODE_LAYOUT.minimumHeight,
            markup: [
                { tagName: 'rect', selector: 'body' },
                { tagName: 'rect', selector: 'accent' },
                {
                    tagName: 'svg',
                    selector: 'labelClip',
                    className: ['veriflow-text-clip', 'veriflow-title-clip'],
                    attrs: { overflow: 'hidden' },
                    children: [{ tagName: 'text', selector: 'label' }],
                },
                {
                    tagName: 'svg',
                    selector: 'subtitleClip',
                    className: ['veriflow-text-clip', 'veriflow-subtitle-clip'],
                    attrs: { overflow: 'hidden' },
                    children: [{ tagName: 'text', selector: 'subtitle' }],
                },
            ],
            portMarkup: [{ tagName: 'circle', selector: 'portBody' }],
            portLabelMarkup: [
                {
                    tagName: 'g',
                    selector: 'portLabelContainer',
                    children: [{
                        tagName: 'svg',
                        selector: 'portLabelClip',
                        className: ['veriflow-text-clip', 'veriflow-pin-clip'],
                        attrs: { overflow: 'hidden' },
                        children: [{ tagName: 'text', selector: 'text' }],
                    }],
                },
            ],
            attrs: {
                body: {
                    fill: 'var(--schematic-node-fill)',
                    stroke: 'var(--schematic-node-border)',
                    strokeWidth: 1.5,
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
                    x: 0,
                    y: SCHEMATIC_NODE_LAYOUT.labelHeight / 2,
                    fill: 'var(--schematic-text)',
                    fontFamily: 'var(--vscode-font-family, sans-serif)',
                    fontSize: SCHEMATIC_TEXT_STYLES.title.fontSize,
                    fontWeight: SCHEMATIC_TEXT_STYLES.title.fontWeight,
                    textAnchor: 'start',
                    textVerticalAnchor: 'middle',
                    pointerEvents: 'none',
                },
                subtitle: {
                    x: 0,
                    y: SCHEMATIC_NODE_LAYOUT.labelHeight / 2,
                    fill: 'var(--schematic-muted-text)',
                    fontFamily: 'var(--vscode-font-family, sans-serif)',
                    fontSize: SCHEMATIC_TEXT_STYLES.subtitle.fontSize,
                    fontWeight: SCHEMATIC_TEXT_STYLES.subtitle.fontWeight,
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
                stroke: 'var(--schematic-wire)',
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
        fill: 'var(--schematic-node-fill)',
        stroke: 'var(--schematic-pin)',
        strokeWidth: 1.5,
    };
    return {
        left: {
            position: { name: 'absolute' },
            attrs: { portBody: body },
            label: {
                position: {
                    name: 'right',
                    args: { x: SCHEMATIC_NODE_LAYOUT.pinLabelInset },
                },
            },
        },
        right: {
            position: { name: 'absolute' },
            attrs: { portBody: body },
            label: {
                position: {
                    name: 'left',
                    args: { x: -SCHEMATIC_NODE_LAYOUT.pinLabelInset },
                },
            },
        },
    };
}

function pinItems(
    model: GraphNode,
    rendered: RenderedNodeGeometry
): object[] {
    const pinsById = new Map(model.pins.map(pin => [pin.id, pin]));
    return rendered.pins.map(pin => {
        const source = pinsById.get(pin.id);
        return {
            id: pin.id,
            group: pin.side,
            args: {
                x: pin.anchor.x - rendered.bounds.x,
                y: pin.anchor.y - rendered.bounds.y,
            },
            attrs: {
                portBody: {
                    strokeDasharray: source?.readOnly ? '2 1' : undefined,
                },
                portLabelClip: {
                    x: pin.side === 'left' ? 0 : -pin.clipBounds.width,
                    y: -pin.clipBounds.height / 2,
                    width: pin.clipBounds.width,
                    height: pin.clipBounds.height,
                },
                text: {
                    text: pin.visibleLabel,
                    title: pin.name,
                    x: pin.side === 'left' ? 0 : pin.clipBounds.width,
                    y: pin.clipBounds.height / 2,
                    fill: 'var(--schematic-text)',
                    fontFamily: 'var(--vscode-font-family, sans-serif)',
                    fontSize: SCHEMATIC_TEXT_STYLES.pin.fontSize,
                    fontWeight: SCHEMATIC_TEXT_STYLES.pin.fontWeight,
                    textAnchor: pin.side === 'left' ? 'start' : 'end',
                    textVerticalAnchor: 'middle',
                    pointerEvents: 'none',
                },
            },
        };
    });
}

function relativeBounds(
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
    nodeBounds: RenderedNodeGeometry['bounds']
): { x: number; y: number; width: number; height: number } {
    return {
        x: bounds.x - nodeBounds.x,
        y: bounds.y - nodeBounds.y,
        width: bounds.width,
        height: bounds.height,
    };
}

function createRenderedNode(
    model: GraphNode,
    rendered: RenderedNodeGeometry
): Node {
    const { width, height } = rendered.bounds;
    const cell = graph.addNode({
        id: model.id,
        shape: shapeNames[model.kind],
        x: rendered.bounds.x,
        y: rendered.bounds.y,
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
            labelClip: relativeBounds(rendered.title.bounds, rendered.bounds),
            label: {
                text: rendered.title.visibleText,
                title: rendered.title.fullText,
            },
            subtitleClip: rendered.renderedSubtitle
                ? relativeBounds(rendered.renderedSubtitle.bounds, rendered.bounds)
                : {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            subtitle: {
                text: rendered.renderedSubtitle?.visibleText ?? '',
                title: rendered.renderedSubtitle?.fullText ?? '',
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
            items: pinItems(model, rendered),
        },
        zIndex: 2,
    });
    return cell;
}

function segmentEndpoints(segment: Readonly<RouteSegment>): readonly [
    { x: number; y: number },
    { x: number; y: number },
] {
    return segment.orientation === 'horizontal'
        ? [{ x: segment.x1, y: segment.y }, { x: segment.x2, y: segment.y }]
        : [{ x: segment.x, y: segment.y1 }, { x: segment.x, y: segment.y2 }];
}

function samePoint(
    left: Readonly<{ x: number; y: number }>,
    right: Readonly<{ x: number; y: number }>
): boolean {
    return left.x === right.x && left.y === right.y;
}

function terminatesAtLoad(
    route: NetworkRoute,
    point: Readonly<{ x: number; y: number }>
): boolean {
    return route.terminals.some(terminal =>
        terminal.role === 'load' && samePoint(terminal.point, point)
    );
}

function networkStrokeWidth(network: SchematicNetwork): number {
    return network.width.kind === 'known' && network.width.bits > 1 ? 2 : 1;
}

function renderNetworks(
    model: SchematicGraph,
    renderModel: SchematicRenderModel
): void {
    const networksById = new Map(model.networks.map(network => [network.id, network]));
    const routesById = new Map(renderModel.networks.map(route => [route.id, route]));
    for (const networkRoute of renderModel.networks) {
        const network = networksById.get(networkRoute.id);
        if (!network) continue;
        networkRoute.segments.forEach((segment, index) => {
            const [source, target] = segmentEndpoints(segment);
            graph.addEdge({
                id: `${networkRoute.id}:segment:${index}`,
                shape: 'veriflow-network',
                source,
                target,
                data: {
                    objectId: network.id,
                    objectType: 'network',
                    network,
                    networkRoute,
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
                        sourceMarker: terminatesAtLoad(networkRoute, source)
                            ? { name: 'block', width: 6, height: 6 }
                            : null,
                        targetMarker: terminatesAtLoad(networkRoute, target)
                            ? { name: 'block', width: 6, height: 6 }
                            : null,
                    },
                },
                zIndex: 0,
            });
        });
    }

    renderModel.junctions.forEach((junction, index) => {
        const network = networksById.get(junction.networkId);
        const networkRoute = routesById.get(junction.networkId);
        if (!network || !networkRoute) return;
        const radius = SCHEMATIC_NETWORK_LABEL_LAYOUT.junctionRadius;
        graph.addNode({
            shape: 'circle',
            id: `${junction.networkId}:junction:${index}`,
            x: junction.point.x - radius,
            y: junction.point.y - radius,
            width: radius * 2,
            height: radius * 2,
            data: {
                objectId: network.id,
                objectType: 'network',
                network,
                networkRoute,
                junction: true,
            } satisfies CellData,
            attrs: {
                root: {
                    tabindex: 0,
                    role: 'link',
                    'aria-label': `network junction: ${network.name}`,
                    pointerEvents: 'auto',
                },
                body: {
                    class: 'veriflow-junction-dot',
                    fill: 'var(--schematic-junction)',
                    stroke: 'var(--schematic-junction)',
                    strokeWidth: 1,
                    pointerEvents: 'auto',
                },
                label: { text: '' },
            },
            zIndex: 1,
        });
    });
}

const selection = new Selection({
    enabled: true,
    multiple: true,
    rubberband: true,
    movable: true,
    strict: false,
    showNodeSelectionBox: true,
    showEdgeSelectionBox: false,
    pointerEvents: 'auto',
    eventTypes: ['leftMouseDown'],
    filter: cell => cellData(cell)?.objectType === 'node'
        && cellData(cell)?.junction !== true,
});

const graph = new Graph({
    container: dom.canvas,
    autoResize: true,
    background: { color: 'var(--schematic-canvas)' },
    grid: {
        visible: true,
        size: 16,
        type: 'dot',
        args: {
            color: 'var(--schematic-grid)',
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
        nodeMovable: view => cellData(view.cell)?.junction !== true,
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
let currentRenderModel: SchematicRenderModel | undefined;
let currentRevision = '';
let selectedModuleKey = '';
let applyingLayout = false;
let syncingSelection = false;
let selectedNetworkId: string | undefined;
let inspectorExpanded = true;
let minimapPlugin: MiniMap | undefined;
let minimapAvailable = false;
let searchMatches: SearchMatch[] = [];
let searchIndex = -1;
let errors = 0;
let warnings = 0;
let nodeMoveGeneration = 0;
let scheduledNodeMoveGeneration: number | undefined;
const pendingNodeMoves = new Map<string, { x: number; y: number }>();
let selectionBoxOrigins = new Map<string, { x: number; y: number }>();

function post(message: WebviewCommand): void {
    vscode.postMessage(message);
}

const layoutSaveScheduler = new DebouncedLayoutSaveScheduler(
    SAVE_DELAY_MS,
    (moduleKey, revision, layout) => post({
        type: 'saveLayout',
        moduleKey,
        revision,
        layout,
    })
);

function scheduleLayoutSave(): void {
    if (!currentLayout || !currentGraph || !currentRevision || applyingLayout) return;
    const moduleKey = currentGraph.moduleKey;
    const layouts = mergeSchematicWebviewLayouts(
        vscode.getState()?.layouts,
        moduleKey,
        currentLayout
    );
    vscode.setState({ layouts });
    layoutSaveScheduler.schedule(moduleKey, currentRevision, layouts[moduleKey]);
}

function flushLayoutSaves(): void {
    layoutSaveScheduler.flush();
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
    dom.searchButton.disabled = !enabled;
}

function updateDiagnostics(
    nextErrors: number,
    nextWarnings: number,
    diagnostics?: SchematicGraph['diagnostics']
): void {
    errors = Math.max(0, Math.trunc(nextErrors));
    warnings = Math.max(0, Math.trunc(nextWarnings));
    dom.errorCount.textContent = `E ${errors}`;
    dom.warningCount.textContent = `W ${warnings}`;
    const countText = `${errors} error${errors === 1 ? '' : 's'}, `
        + `${warnings} warning${warnings === 1 ? '' : 's'}`;
    dom.diagnosticStatus.textContent = countText;
    if (diagnostics !== undefined) {
        dom.diagnosticStatus.title = formatSchematicDiagnosticDetails(diagnostics);
    }
    const detailText = dom.diagnosticStatus.title;
    dom.diagnosticStatus.setAttribute(
        'aria-label',
        detailText ? `${countText}. ${detailText.replace(/\n/g, '. ')}` : countText
    );
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

function refreshNetworkSelectionStyles(): void {
    const searchedIds = new Set(searchMatches.map(match => match.objectId));
    for (const cell of graph.getCells()) {
        const data = cellData(cell);
        if (data?.objectType !== 'network') continue;
        const selected = data.objectId === selectedNetworkId;
        const searched = searchedIds.has(data.objectId);
        const view = graph.findViewByCell(cell);
        view?.removeClass([
            'veriflow-network-selected',
            'veriflow-network-search-match',
        ]);
        if (selected) view?.addClass('veriflow-network-selected');
        if (searched) view?.addClass('veriflow-network-search-match');
    }
}

function descriptionFor(data: CellData): string {
    if (data.node) return `${data.node.kind}: ${data.node.label}`;
    if (data.networkRoute) {
        return `network: ${data.networkRoute.selectionDescription}`;
    }
    if (data.network) return `network: ${data.network.name}`;
    return data.objectId;
}

function updateSelectionStatus(cells: Cell[], persist = true): void {
    if (!currentLayout) return;
    const itemsByObjectId = new Map<string, {
        objectId: string;
        description: string;
    }>();
    if (selectedNetworkId !== undefined) {
        const selectedNetworkCell = graph.getCells().find(cell => {
            const data = cellData(cell);
            return data?.objectType === 'network'
                && data.objectId === selectedNetworkId;
        });
        const data = selectedNetworkCell && cellData(selectedNetworkCell);
        if (data) {
            itemsByObjectId.set(data.objectId, {
                objectId: data.objectId,
                description: descriptionFor(data),
            });
        }
    }
    for (const cell of cells) {
        const data = cellData(cell);
        if (data && !itemsByObjectId.has(data.objectId)) {
            itemsByObjectId.set(data.objectId, {
                objectId: data.objectId,
                description: descriptionFor(data),
            });
        }
    }
    const summary = summarizeSchematicSelection([...itemsByObjectId.values()]);
    if (summary.selectedObjectId === undefined) {
        delete currentLayout.selectedObjectId;
    } else {
        currentLayout.selectedObjectId = summary.selectedObjectId;
    }
    dom.selectionStatus.textContent = summary.statusText;
    renderCurrentInspector(cells);
    if (persist) scheduleLayoutSave();
}

function renderInspector(model: SchematicInspectorModel): void {
    dom.inspector.dataset.kind = model.kind;
    dom.inspector.dataset.readOnly = String(model.readOnly);
    dom.inspectorTitle.textContent = model.title;
    const rows = document.createDocumentFragment();
    for (const row of model.rows) {
        const term = document.createElement('dt');
        term.textContent = row.label;
        const description = document.createElement('dd');
        description.textContent = row.value;
        rows.append(term, description);
    }
    dom.inspectorProperties.replaceChildren(rows);
}

function selectedNodeIds(cells: readonly Cell[]): string[] {
    return [...new Set(cells.flatMap(cell => {
        const data = cellData(cell);
        return data?.objectType === 'node' && !data.junction
            ? [data.objectId]
            : [];
    }))];
}

function renderCurrentInspector(cells = selection.getSelectedCells()): void {
    if (!currentGraph) {
        renderInspector({
            kind: 'empty',
            title: 'No selection',
            readOnly: true,
            rows: [],
        });
        return;
    }
    renderInspector(projectSchematicInspector(
        currentGraph,
        selectedNodeIds(cells),
        selectedNetworkId
    ));
}

function selectNetwork(networkId: string | undefined, persist = true): void {
    const matchingCell = networkId === undefined
        ? undefined
        : graph.getCells().find(cell => {
            const data = cellData(cell);
            return data?.objectType === 'network' && data.objectId === networkId;
        });
    selectedNetworkId = matchingCell ? networkId : undefined;
    syncingSelection = true;
    selection.clean();
    syncingSelection = false;
    refreshNetworkSelectionStyles();
    updateSelectionStatus([], persist);
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

function selectedObjectIds(cells: readonly Cell[]): string[] {
    if (selectedNetworkId !== undefined) return [selectedNetworkId];
    return [...new Set(cells.flatMap(cell => {
        const data = cellData(cell);
        return data && !data.junction ? [data.objectId] : [];
    }))];
}

function restoreSelection(
    layout: SchematicLayout,
    preservedObjectIds?: readonly string[]
): void {
    selectedNetworkId = undefined;
    syncingSelection = true;
    selection.clean();
    const wantedObjectIds = preservedObjectIds === undefined
        ? new Set(layout.selectedObjectId ? [layout.selectedObjectId] : [])
        : new Set(preservedObjectIds);
    const matchingNodeCells = graph.getCells().filter(cell => {
        const data = cellData(cell);
        return data?.objectType === 'node'
            && wantedObjectIds.has(data.objectId);
    });
    if (matchingNodeCells.length > 0) {
        selection.select(matchingNodeCells);
    } else {
        const matchingNetwork = graph.getCells().find(cell => {
            const data = cellData(cell);
            return data?.objectType === 'network'
                && wantedObjectIds.has(data.objectId);
        });
        selectedNetworkId = matchingNetwork
            ? cellData(matchingNetwork)?.objectId
            : undefined;
    }
    syncingSelection = false;
    refreshNetworkSelectionStyles();
    updateSelectionStatus(selection.getSelectedCells(), false);
}

function renderSchematic(
    model: SchematicGraph,
    layout: SchematicLayout,
    preservedSelection?: readonly string[]
): void {
    const searchQuery = dom.searchInput.value;
    clearPendingNodeMoves();
    applyingLayout = true;
    currentGraph = model;
    currentLayout = cloneSchematicLayout(layout);
    selectedModuleKey = model.moduleKey;
    dom.moduleSelector.value = model.moduleKey;
    graph.resetCells([]);
    const renderModel = layoutSchematic(model, layout.placement, measureNodeText);
    currentRenderModel = renderModel;
    graph.batchUpdate('render-schematic', () => {
        for (const node of model.nodes) {
            const rendered = renderModel.nodes.get(node.id);
            if (rendered) createRenderedNode(node, rendered);
        }
        renderNetworks(model, renderModel);
    });
    applyViewport(layout);
    restoreSelection(layout, preservedSelection);
    refreshSearchMatches(searchQuery, true);
    applyingLayout = false;

    setGraphControls(model.nodes.length > 0);
    setCanvasState(model.nodes.length === 0 ? 'No schematic objects' : undefined);
    const graphErrors = model.diagnostics.filter(item => item.severity === 'error').length;
    const graphWarnings = model.diagnostics.filter(item => item.severity === 'warning').length;
    updateDiagnostics(graphErrors, graphWarnings, model.diagnostics);
    updateMinimapAvailability();
}

function nodePosition(node: Node): { x: number; y: number } {
    const position = node.getPosition();
    return { x: position.x, y: position.y };
}

function nodeCenter(node: Node): { x: number; y: number } {
    const position = nodePosition(node);
    const size = node.getSize();
    return {
        x: position.x + size.width / 2,
        y: position.y + size.height / 2,
    };
}

function clearPendingNodeMoves(): void {
    nodeMoveGeneration += 1;
    scheduledNodeMoveGeneration = undefined;
    pendingNodeMoves.clear();
    selectionBoxOrigins.clear();
}

function queueNodeMove(node: Node): void {
    if (applyingLayout || !currentGraph || !currentLayout || !currentRenderModel) {
        return;
    }
    const data = cellData(node);
    if (!data?.node) return;
    const dropCenter = nodeCenter(node);
    const rendered = currentRenderModel.nodes.get(data.node.id);
    if (!rendered) return;
    const renderedCenter = {
        x: rendered.bounds.x + rendered.bounds.width / 2,
        y: rendered.bounds.y + rendered.bounds.height / 2,
    };
    if (dropCenter.x === renderedCenter.x && dropCenter.y === renderedCenter.y) {
        return;
    }
    pendingNodeMoves.set(data.node.id, dropCenter);

    const generation = nodeMoveGeneration;
    if (scheduledNodeMoveGeneration === generation) return;
    scheduledNodeMoveGeneration = generation;
    const model = currentGraph;
    const revision = currentRevision;
    queueMicrotask(() => flushPendingNodeMoves(generation, model, revision));
}

function flushPendingNodeMoves(
    generation: number,
    model: SchematicGraph,
    revision: string
): void {
    if (scheduledNodeMoveGeneration === generation) {
        scheduledNodeMoveGeneration = undefined;
    }
    if (generation !== nodeMoveGeneration || currentGraph !== model
        || currentRevision !== revision || applyingLayout
        || !currentLayout || !currentRenderModel) {
        return;
    }
    const drops = [...pendingNodeMoves].map(([nodeId, dropCenter]) => ({
        nodeId,
        dropCenter,
    }));
    pendingNodeMoves.clear();
    if (drops.length === 0) return;

    currentLayout.placement = snapNodesToPlacement(
        model,
        currentLayout.placement,
        currentRenderModel,
        drops,
        measureNodeText
    );
    const preservedSelection = selectedObjectIds(selection.getSelectedCells());
    renderSchematic(model, currentLayout, preservedSelection);
    scheduleLayoutSave();
}

function resetSearchStyles(): void {
    for (const cell of graph.getCells()) {
        const data = cellData(cell);
        if (cell.isNode() && !data?.junction) {
            cell.attr('body/stroke', 'var(--schematic-node-border)');
            cell.attr('body/strokeWidth', 1.5);
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
        data.networkRoute?.displayName ?? data.network?.name ?? '',
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

function updateSearchButtons(): void {
    const canNavigate = searchMatches.length >= 2;
    dom.searchPreviousButton.disabled = !canNavigate;
    dom.searchNextButton.disabled = !canNavigate;
}

function updateActiveSearchStatus(): void {
    const match = searchMatches[searchIndex];
    if (!match || currentLayout?.selectedObjectId !== match.objectId) return;
    dom.selectionStatus.textContent = `${match.description} (${searchIndex + 1}/${
        searchMatches.length
    })`;
}

function refreshSearchMatches(query: string, preserveActiveMatch: boolean): void {
    const previousIndex = searchIndex;
    const previousObjectId = searchMatches[previousIndex]?.objectId;
    resetSearchStyles();
    searchMatches = collectSearchMatches(query);
    if (searchMatches.length === 0) {
        searchIndex = -1;
    } else if (preserveActiveMatch) {
        const retainedIndex = previousObjectId === undefined
            ? -1
            : searchMatches.findIndex(match => match.objectId === previousObjectId);
        searchIndex = retainedIndex >= 0
            ? retainedIndex
            : Math.min(Math.max(previousIndex, 0), searchMatches.length - 1);
    } else {
        searchIndex = -1;
    }
    for (const match of searchMatches) {
        if (cellData(match.cell)?.objectType === 'network') continue;
        match.cell.attr('body/stroke', 'var(--vscode-editor-findMatchBorder, #f0a000)');
        match.cell.attr('body/strokeWidth', 2);
    }
    refreshNetworkSelectionStyles();
    updateSearchButtons();
    if (preserveActiveMatch) updateActiveSearchStatus();
}

function showSearchMatch(index: number): void {
    if (searchMatches.length === 0) {
        searchIndex = -1;
        updateSearchButtons();
        return;
    }
    searchIndex = (index + searchMatches.length) % searchMatches.length;
    const match = searchMatches[searchIndex];
    graph.centerCell(match.cell);
    if (cellData(match.cell)?.objectType === 'network') {
        selectNetwork(match.objectId);
    } else {
        selectedNetworkId = undefined;
        refreshNetworkSelectionStyles();
        selection.reset(match.cell);
    }
    dom.selectionStatus.textContent = `${match.description} (${searchIndex + 1}/${searchMatches.length})`;
    updateSearchButtons();
}

function runSearch(query: string, notifyHost: boolean): void {
    refreshSearchMatches(query, false);
    if (notifyHost) post({ type: 'search', query });
    showSearchMatch(0);
}

function clearSchematicState(): void {
    layoutSaveScheduler.flush();
    layoutSaveScheduler.dispose();
    clearPendingNodeMoves();
    applyingLayout = true;
    selectedNetworkId = undefined;
    selection.clean();
    graph.resetCells([]);
    graph.zoomTo(1);
    graph.translate(0, 0);
    applyingLayout = false;
    currentGraph = undefined;
    currentLayout = undefined;
    currentRenderModel = undefined;
    currentRevision = '';
    selectedModuleKey = '';
    searchMatches = [];
    searchIndex = -1;
    dom.searchInput.value = '';
    dom.searchControls.hidden = true;
    dom.searchButton.setAttribute('aria-expanded', 'false');
    dom.searchPreviousButton.disabled = true;
    dom.searchNextButton.disabled = true;
    dom.selectionStatus.textContent = 'No selection';
    renderCurrentInspector();
    minimapAvailable = false;
    if (minimapPlugin) {
        graph.disposePlugins('minimap');
        minimapPlugin = undefined;
    }
    dom.minimap.replaceChildren();
    dom.minimap.hidden = true;
    dom.minimapButton.disabled = true;
    dom.minimapButton.setAttribute('aria-pressed', 'false');
    setGraphControls(false);
    updateDiagnostics(0, 0, []);
}

function initialize(event: Extract<HostEvent, { type: 'initialize' }>): void {
    if (currentGraph && currentGraph.moduleKey !== event.selectedModuleKey) {
        layoutSaveScheduler.flushModule(currentGraph.moduleKey);
    }
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
    if (event.modules.length === 0) {
        clearSchematicState();
        setCanvasState('No modules');
        return;
    }
    setCanvasState('Loading schematic');
}

function handleHostEvent(event: HostEvent): void {
    switch (event.type) {
        case 'initialize':
            initialize(event);
            return;
        case 'graph':
            if (currentGraph) {
                layoutSaveScheduler.flushModule(currentGraph.moduleKey);
            }
            layoutSaveScheduler.flushModule(event.graph.moduleKey);
            currentRevision = event.revision;
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

function installIcon(button: HTMLButtonElement, icon: IconNode): void {
    const slot = button.querySelector('[data-icon-slot]');
    if (!slot) return;
    slot.replaceChildren(createElement(icon, {
        width: 16,
        height: 16,
        'stroke-width': 1.75,
        'aria-hidden': 'true',
    }));
}

function updateInspectorToggle(): void {
    dom.inspector.hidden = !inspectorExpanded;
    dom.inspectorToggleButton.setAttribute('aria-expanded', String(inspectorExpanded));
    const label = inspectorExpanded ? 'Hide properties' : 'Show properties';
    dom.inspectorToggleButton.title = label;
    dom.inspectorToggleButton.setAttribute('aria-label', label);
    installIcon(
        dom.inspectorToggleButton,
        inspectorExpanded ? PanelRightClose : PanelRightOpen
    );
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
        installIcon(button, icon);
    }
    updateInspectorToggle();
}

installIcons();
renderCurrentInspector();

dom.moduleSelector.addEventListener('change', () => {
    if (currentGraph) {
        layoutSaveScheduler.flushModule(currentGraph.moduleKey);
    }
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

dom.inspectorToggleButton.addEventListener('click', () => {
    inspectorExpanded = !inspectorExpanded;
    updateInspectorToggle();
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

graph.on('node:moved', ({ node }) => {
    queueNodeMove(node);
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

graph.on('edge:click', ({ edge }) => {
    const data = cellData(edge);
    if (data?.objectType === 'network') selectNetwork(data.objectId);
});

graph.on('node:click', ({ node }) => {
    const data = cellData(node);
    if (data?.junction) selectNetwork(data.objectId);
});

graph.on('blank:click', () => {
    selectNetwork(undefined);
});

selection.on('selection:changed', ({ selected }) => {
    if (applyingLayout || syncingSelection) return;
    selectedNetworkId = undefined;
    refreshNetworkSelectionStyles();
    updateSelectionStatus(selected);
});

selection.on('box:mousedown', ({ nodes }) => {
    selectionBoxOrigins = applyingLayout
        ? new Map()
        : new Map(nodes.map(node => [node.id, nodePosition(node)]));
});

selection.on('box:mouseup', () => {
    const origins = selectionBoxOrigins;
    selectionBoxOrigins = new Map();
    if (applyingLayout) return;
    for (const [nodeId, origin] of origins) {
        const cell = graph.getCellById(nodeId);
        if (!cell?.isNode()) continue;
        const position = nodePosition(cell);
        if (position.x !== origin.x || position.y !== origin.y) {
            queueNodeMove(cell);
        }
    }
});

const resizeObserver = new ResizeObserver(() => {
    graph.resize(dom.canvas.clientWidth, dom.canvas.clientHeight);
    updateMinimapAvailability();
});
resizeObserver.observe(dom.canvasRegion);

window.addEventListener('pagehide', flushLayoutSaves);
window.addEventListener('beforeunload', flushLayoutSaves);

window.addEventListener('message', event => {
    if (!event.data || typeof event.data !== 'object') return;
    const type = (event.data as { type?: unknown }).type;
    if (type === 'initialize' || type === 'graph' || type === 'diagnostics'
        || type === 'hostError') {
        handleHostEvent(event.data as HostEvent);
    }
});

post({ type: 'ready' });
