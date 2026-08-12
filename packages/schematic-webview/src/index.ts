import {
    Graph,
    MiniMap,
    Selection,
    type Cell,
    type Node,
} from '@antv/x6';
import {
    SquarePlus as AddBox,
    Cable,
    ChevronDown,
    ChevronUp,
    createElement,
    FileOutput,
    Map as MapIcon,
    Maximize2,
    PanelTopOpen,
    PanelRightClose,
    PanelRightOpen,
    RefreshCw,
    Scan,
    Search as SearchIcon,
    Trash2,
    Workflow,
    type IconNode,
} from 'lucide';

import {
    assignColumns,
    createPlacement,
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
import type {
    ArchDesignEdit,
    ArchDesignInterfaceEndpoint,
    ArchDesignPresentation,
    ArchDesignPortDirection,
} from '@veriflow/schematic-core/arch-design';
import type { SchematicLayout } from '../../../veriflow-vscode/src/schematic/layoutStore';
import type { HostEvent, WebviewCommand } from '../../../veriflow-vscode/src/schematic/protocol';
import {
    archDesignEndpointForPin,
    cloneSchematicLayout,
    DebouncedLayoutSaveScheduler,
    formatSchematicDiagnosticDetails,
    mergeSchematicWebviewLayouts,
    navigationCommandForCell,
    projectArchDesignInspector,
    projectSchematicInspector,
    summarizeSchematicSelection,
    type ArchDesignInspectorModel,
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

type ScalarConnectionTerminal = Readonly<{
    kind: 'scalar';
    endpoint: NonNullable<ReturnType<typeof archDesignEndpointForPin>>;
    pin: GraphNode['pins'][number];
}>;

type InterfaceConnectionTerminal = Readonly<{
    kind: 'interface';
    endpoint: ArchDesignInterfaceEndpoint;
    effectiveRole: 'master' | 'slave';
    protocol: string;
    pin: GraphNode['pins'][number];
}>;

type ConnectionTerminal = ScalarConnectionTerminal | InterfaceConnectionTerminal;

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
    shell: requiredElement<HTMLElement>('schematic-shell'),
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
    authoringActions: requiredElement<HTMLDivElement>('authoring-actions'),
    addInstanceButton: requiredElement<HTMLButtonElement>('add-instance-button'),
    addPortButton: requiredElement<HTMLButtonElement>('add-port-button'),
    connectButton: requiredElement<HTMLButtonElement>('connect-button'),
    exportButton: requiredElement<HTMLButtonElement>('export-button'),
    deleteButton: requiredElement<HTMLButtonElement>('delete-button'),
    inspector: requiredElement<HTMLElement>('inspector'),
    inspectorTitle: requiredElement<HTMLHeadingElement>('inspector-title'),
    inspectorMode: requiredElement<HTMLSpanElement>('inspector-mode'),
    inspectorProperties: requiredElement<HTMLDListElement>('inspector-properties'),
    inspectorForm: requiredElement<HTMLFormElement>('inspector-form'),
    addInstanceDialog: requiredElement<HTMLDialogElement>('add-instance-dialog'),
    addInstanceForm: requiredElement<HTMLFormElement>('add-instance-form'),
    instanceNameInput: requiredElement<HTMLInputElement>('instance-name-input'),
    instanceModuleSelect: requiredElement<HTMLSelectElement>('instance-module-select'),
    addPortDialog: requiredElement<HTMLDialogElement>('add-port-dialog'),
    addPortForm: requiredElement<HTMLFormElement>('add-port-form'),
    portNameInput: requiredElement<HTMLInputElement>('port-name-input'),
    portDirectionSelect: requiredElement<HTMLSelectElement>('port-direction-select'),
    portWidthInput: requiredElement<HTMLInputElement>('port-width-input'),
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
                { tagName: 'rect', selector: 'interfaceTag' },
                { tagName: 'text', selector: 'interfaceTagText' },
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
                interfaceTag: {
                    visibility: 'hidden',
                    stroke: 'none',
                    rx: 2,
                    ry: 2,
                },
                interfaceTagText: {
                    visibility: 'hidden',
                    fill: '#ffffff',
                    fontFamily: 'var(--vscode-font-family, sans-serif)',
                    fontSize: 9,
                    fontWeight: 600,
                    textAnchor: 'middle',
                    textVerticalAnchor: 'middle',
                    pointerEvents: 'none',
                },
                label: {
                    refX: 0,
                    refY: 0,
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

function interfaceColor(role: 'master' | 'slave' | 'unknown'): string {
    if (role === 'master') return 'var(--schematic-interface-master)';
    if (role === 'slave') return 'var(--schematic-interface-slave)';
    return 'var(--schematic-interface-unknown)';
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
                    magnet: source !== undefined && pinConnectable(source),
                    strokeDasharray: source?.readOnly ? '2 1' : undefined,
                    ...(source?.interface === undefined ? {} : { class: [
                            'x6-port-body',
                            'veriflow-interface-pin',
                            `veriflow-interface-${source.interface.role}`,
                            `veriflow-interface-${source.interface.kind}`,
                        ].join(' ') }),
                    r: source?.interface?.kind === 'aggregate' ? 4 : 3,
                    fill: source?.interface === undefined
                        ? 'var(--schematic-node-fill)'
                        : 'var(--schematic-interface-pin-fill)',
                    stroke: source?.interface === undefined
                        ? 'var(--schematic-pin)'
                        : interfaceColor(source.interface.role),
                    strokeWidth: source?.interface?.kind === 'aggregate' ? 2 : 1.5,
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
                    fill: source?.interface === undefined
                        ? 'var(--schematic-text)'
                        : interfaceColor(source.interface.role),
                    class: source?.interface === undefined
                        ? undefined
                        : 'veriflow-interface-label',
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
    const topInterface = model.pins.find(pin => pin.interface?.topLevel)?.interface;
    const titleBounds = relativeBounds(rendered.title.bounds, rendered.bounds);
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
                ...(topInterface === undefined ? {} : {
                    stroke: interfaceColor(topInterface.role),
                    strokeWidth: 2,
                }),
            },
            accent: {
                height,
            },
            interfaceTag: topInterface === undefined ? {} : {
                x: width - 22,
                y: 6,
                width: 16,
                height: 14,
                visibility: 'visible',
                fill: interfaceColor(topInterface.role),
                class: 'veriflow-interface-tag',
            },
            interfaceTagText: topInterface === undefined ? {} : {
                x: width - 14,
                y: 13,
                visibility: 'visible',
                class: 'veriflow-interface-tag-text',
                text: topInterface.role === 'master'
                    ? 'M' : topInterface.role === 'slave' ? 'S' : '?',
            },
            labelClip: topInterface === undefined
                ? titleBounds
                : { ...titleBounds, width: Math.max(0, titleBounds.width - 18) },
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
    if (network.renderWidth !== undefined) return network.renderWidth;
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
                        stroke: network.interface === undefined
                            ? 'var(--schematic-wire)'
                            : 'var(--schematic-interface-wire)',
                        class: network.interface === undefined
                            ? undefined
                            : 'veriflow-interface-route',
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
        magnetConnectable: () => connectionAuthoringEnabled(),
        toolsAddable: false,
    },
    connecting: {
        snap: { radius: 20 },
        allowBlank: false,
        allowLoop: false,
        allowNode: false,
        allowEdge: false,
        allowPort: true,
        allowMulti: true,
        highlight: true,
        validateMagnet({ cell, magnet }): boolean {
            return connectionSourceFor(cell, magnet.getAttribute('port')) !== undefined;
        },
        validateConnection({ sourceCell, targetCell, sourcePort, targetPort }): boolean {
            const source = connectionSourceFor(sourceCell, sourcePort);
            const target = connectionTargetFor(targetCell, targetPort);
            return connectionTerminalsCompatible(source, target);
        },
        createEdge() {
            return this.createEdge({
                shape: 'veriflow-network',
                attrs: {
                    line: {
                        stroke: 'var(--schematic-wire-selected)',
                        strokeWidth: 2,
                        strokeDasharray: '5 3',
                        pointerEvents: 'none',
                    },
                },
                zIndex: 3,
            });
        },
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
let selectedPinId: string | undefined;
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
type EditableArchDesignState = Extract<
    HostEvent,
    { type: 'archDesignState'; status: 'editable' }
>;
let archDesignDocument = false;
let archDesignEditable = false;
let authoringPending = false;
let currentArchDesignState: EditableArchDesignState | undefined;
let currentArchDesignInspector: ArchDesignInspectorModel | undefined;
const autoFittedModules = new Set<string>();
let archDesignLayoutSaveInFlight = false;
let queuedArchDesignLayoutSave: Readonly<{
    moduleKey: string;
    layout: SchematicLayout;
}> | undefined;
type QueuedArchDesignCommand =
    | Readonly<{ type: 'edit'; edit: ArchDesignEdit }>
    | Readonly<{ type: 'export' }>;
let queuedArchDesignCommand: QueuedArchDesignCommand | undefined;
let archDesignSemanticEditInFlight = false;
let unloadLayoutForwarded = false;
let archDesignGraphRefreshInProgress = false;

function connectionAuthoringEnabled(): boolean {
    return archDesignEditable
        && !authoringPending
        && currentArchDesignState !== undefined
        && dom.connectButton.getAttribute('aria-pressed') === 'true';
}

function interfaceInspectorForPin(pin: GraphNode['pins'][number]) {
    const identity = pin.interface?.id;
    return identity === undefined
        ? undefined
        : currentArchDesignState?.inspector?.interfaces.find(
            item => item.identity === identity
        );
}

function interfaceEffectiveRole(
    pin: GraphNode['pins'][number]
): 'master' | 'slave' | undefined {
    if (pin.interface?.kind !== 'aggregate' || pin.interface.role === 'unknown') {
        return undefined;
    }
    return pin.direction === 'driver'
        ? 'master'
        : pin.direction === 'load' ? 'slave' : undefined;
}

function pinConnectable(pin: GraphNode['pins'][number]): boolean {
    if (!connectionAuthoringEnabled() || pin.readOnly) return false;
    if (pin.interface === undefined) return true;
    if (pin.interface.kind === 'member') {
        const item = interfaceInspectorForPin(pin);
        const member = item?.members.find(candidate => candidate.port === pin.name);
        return item?.connection === undefined
            && member !== undefined
            && member.occupancy === undefined;
    }
    const item = interfaceInspectorForPin(pin);
    return interfaceEffectiveRole(pin) !== undefined
        && item !== undefined
        && item.connection === undefined
        && item.members.every(member => member.occupancy === undefined);
}

function connectionTerminal(
    cell: Cell | null | undefined,
    portId: string | null | undefined
): ConnectionTerminal | undefined {
    if (!connectionAuthoringEnabled()
        || !currentArchDesignState
        || !currentGraph
        || !cell
        || !portId) return undefined;
    const data = cellData(cell);
    const node = data?.objectType === 'node' ? data.node : undefined;
    const pin = node?.pins.find(candidate => candidate.id === portId);
    if (!node || !pin || !pinConnectable(pin)) return undefined;
    if (pin.interface?.kind === 'aggregate') {
        const item = interfaceInspectorForPin(pin);
        const effectiveRole = interfaceEffectiveRole(pin);
        return item && effectiveRole
            ? {
                kind: 'interface',
                endpoint: item.endpoint,
                effectiveRole,
                protocol: item.protocol,
                pin,
            }
            : undefined;
    }
    const endpoint = archDesignEndpointForPin(
        currentArchDesignState.design,
        node,
        pin
    );
    return endpoint ? { kind: 'scalar', endpoint, pin } : undefined;
}

function connectionTerminalsCompatible(
    source: ConnectionTerminal | undefined,
    target: ConnectionTerminal | undefined
): boolean {
    if (!source || !target || source.pin.id === target.pin.id
        || source.kind !== target.kind) return false;
    return source.kind === 'scalar'
        || (target.kind === 'interface' && source.protocol === target.protocol);
}

function connectionSourceFor(
    cell: Cell | null | undefined,
    portId: string | null | undefined
) {
    const terminal = connectionTerminal(cell, portId);
    if (terminal?.kind === 'interface') {
        return terminal.effectiveRole === 'master' ? terminal : undefined;
    }
    return terminal && (terminal.pin.direction === 'driver'
        || terminal.pin.direction === 'bidirectional') ? terminal : undefined;
}

function connectionTargetFor(
    cell: Cell | null | undefined,
    portId: string | null | undefined
) {
    const terminal = connectionTerminal(cell, portId);
    if (terminal?.kind === 'interface') {
        return terminal.effectiveRole === 'slave' ? terminal : undefined;
    }
    return terminal && (terminal.pin.direction === 'load'
        || terminal.pin.direction === 'bidirectional') ? terminal : undefined;
}

function refreshConnectionMagnets(): void {
    const enabled = connectionAuthoringEnabled();
    for (const cell of graph.getNodes()) {
        const data = cellData(cell);
        if (data?.objectType !== 'node' || !data.node || data.junction) continue;
        const pinsById = new Map(data.node.pins.map(pin => [pin.id, pin]));
        const view = graph.findViewByCell(cell);
        view?.container.querySelectorAll<SVGGElement>('.x6-port-body[port]').forEach(
            port => {
                const pin = pinsById.get(port.getAttribute('port') ?? '');
                const magnet = String(enabled && pin !== undefined && pinConnectable(pin));
                port.setAttribute('magnet', magnet);
                port.querySelector('[data-selector="portBody"]')
                    ?.setAttribute('magnet', magnet);
            }
        );
    }
}

function post(message: WebviewCommand): void {
    vscode.postMessage(message);
}

const layoutSaveScheduler = new DebouncedLayoutSaveScheduler(
    SAVE_DELAY_MS,
    (moduleKey, revision, layout) => {
        if (archDesignDocument
            && (archDesignLayoutSaveInFlight
                || authoringPending
                || archDesignGraphRefreshInProgress)) {
            queuedArchDesignLayoutSave = { moduleKey, layout };
            unloadLayoutForwarded = false;
            return;
        }
        if (archDesignDocument) archDesignLayoutSaveInFlight = true;
        post({
            type: 'saveLayout',
            moduleKey,
            revision,
            layout,
        });
    }
);

function persistCurrentLayoutState(): SchematicLayout | undefined {
    if (!currentLayout || !currentGraph || !currentRevision || applyingLayout) return undefined;
    const moduleKey = currentGraph.moduleKey;
    const layouts = mergeSchematicWebviewLayouts(
        vscode.getState()?.layouts,
        moduleKey,
        currentLayout
    );
    vscode.setState({ layouts });
    return layouts[moduleKey];
}

function scheduleLayoutSave(): void {
    if (!currentLayout || !currentGraph || !currentRevision || applyingLayout) return;
    const layout = persistCurrentLayoutState();
    if (!layout) return;
    const moduleKey = currentGraph.moduleKey;
    layoutSaveScheduler.schedule(moduleKey, currentRevision, layout);
}

function flushLayoutSaves(): void {
    layoutSaveScheduler.flush();
}

function flushLayoutSavesForUnload(): void {
    flushLayoutSaves();
    if (!archDesignDocument || !queuedArchDesignLayoutSave
        || unloadLayoutForwarded || !currentRevision) return;
    unloadLayoutForwarded = true;
    post({
        type: 'saveLayout',
        moduleKey: queuedArchDesignLayoutSave.moduleKey,
        revision: currentRevision,
        layout: queuedArchDesignLayoutSave.layout,
    });
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

function refreshPinSelectionStyles(): void {
    dom.canvas.querySelectorAll<SVGElement>('.veriflow-pin-selected').forEach(element => {
        element.classList.remove('veriflow-pin-selected');
    });
    if (selectedPinId === undefined) return;
    for (const node of graph.getNodes()) {
        const data = cellData(node);
        if (!data?.node?.pins.some(pin => pin.id === selectedPinId)) continue;
        const view = graph.findViewByCell(node);
        view?.container.querySelectorAll<SVGGElement>('.x6-port-body[port]').forEach(port => {
            if (port.getAttribute('port') === selectedPinId) {
                port.classList.add('veriflow-pin-selected');
            }
        });
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
    if (selectedPinId !== undefined) {
        const selectedPin = currentGraph?.nodes.flatMap(node => node.pins.map(pin => ({
            node,
            pin,
        }))).find(item => item.pin.id === selectedPinId);
        const selectedInterface = currentArchDesignState?.inspector?.interfaces.find(
            item => item.identity === selectedPinId
        );
        if (selectedPin) {
            itemsByObjectId.set(selectedPinId, {
                objectId: selectedPinId,
                description: selectedPin.pin.interface?.kind === 'aggregate'
                    ? `interface: ${selectedPin.node.label}.${selectedPin.pin.name}`
                    : `pin: ${selectedPin.node.label}.${selectedPin.pin.name}`,
            });
        } else if (selectedInterface) {
            itemsByObjectId.set(selectedPinId, {
                objectId: selectedPinId,
                description: `interface: ${selectedInterface.endpoint.kind === 'port'
                    ? selectedInterface.endpoint.port
                    : `${selectedInterface.endpoint.instance}.${
                        selectedInterface.endpoint.interface}`}`,
            });
        }
    }
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
    refreshPinSelectionStyles();
    renderCurrentInspector(cells);
    if (persist) {
        if (archDesignDocument) {
            persistCurrentLayoutState();
        } else {
            scheduleLayoutSave();
        }
    }
}

function renderInspector(model: SchematicInspectorModel): void {
    dom.inspector.dataset.kind = model.kind;
    dom.inspector.dataset.readOnly = String(model.readOnly);
    dom.inspectorTitle.textContent = model.title;
    dom.inspectorMode.textContent = 'Read only';
    dom.inspectorProperties.hidden = false;
    dom.inspectorForm.hidden = true;
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

function setAuthoringControls(): void {
    dom.authoringActions.hidden = !archDesignDocument;
    const disabled = !archDesignEditable || authoringPending;
    dom.addInstanceButton.disabled = disabled
        || (currentArchDesignState?.catalog.length ?? 0) === 0;
    dom.addPortButton.disabled = disabled;
    dom.connectButton.disabled = disabled || !currentGraph;
    dom.exportButton.disabled = disabled;
    dom.deleteButton.disabled = disabled || currentArchDesignInspector?.deleteEdit === undefined;
    dom.inspectorForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input, select'
    ).forEach(control => {
        control.disabled = disabled || control.dataset.readonly === 'true';
    });
    dom.inspectorForm.querySelectorAll<HTMLButtonElement>('.inspector-action').forEach(button => {
        button.disabled = disabled || button.dataset.actionAvailable !== 'true';
    });
    refreshConnectionMagnets();
}

function postArchDesignEdit(requestedEdit: ArchDesignEdit): void {
    if (!currentArchDesignState || !archDesignEditable || authoringPending) return;
    const edit = requestedEdit.type === 'setPresentation' && currentGraph && currentLayout
        ? {
            ...requestedEdit,
            presentation: {
                ...archDesignPresentationForCurrentLayout(currentGraph, currentLayout),
                ...(requestedEdit.presentation.collapsedInterfaces === undefined
                    ? {}
                    : { collapsedInterfaces: requestedEdit.presentation.collapsedInterfaces }),
            },
        } satisfies ArchDesignEdit
        : requestedEdit;
    authoringPending = true;
    queuedArchDesignCommand = { type: 'edit', edit };
    setAuthoringControls();
    if (currentGraph) layoutSaveScheduler.flushModule(currentGraph.moduleKey);
    drainArchDesignWrites();
}

function archDesignPresentationForCurrentLayout(
    model: SchematicGraph,
    layout: SchematicLayout
): ArchDesignPresentation {
    const nodes = Object.fromEntries(model.nodes.flatMap(node => {
        if (node.kind !== 'instance' && node.kind !== 'port') return [];
        const placement = layout.placement.nodes[node.id];
        return placement === undefined ? [] : [[node.id, {
            column: placement.column,
            order: placement.order,
            ...(placement.yOffset === 0 ? {} : { offset: placement.yOffset }),
            ...(placement.fixed ? { userPositioned: true } : {}),
        }]];
    }));
    return {
        ...(Object.keys(nodes).length === 0 ? {} : { nodes }),
        ...(currentArchDesignState?.design.presentation.collapsedInterfaces === undefined
            ? {}
            : {
                collapsedInterfaces: {
                    ...currentArchDesignState.design.presentation.collapsedInterfaces,
                },
            }),
        viewport: { ...layout.viewport },
    };
}

function drainArchDesignWrites(): void {
    if (!archDesignDocument || archDesignLayoutSaveInFlight
        || archDesignSemanticEditInFlight || !currentRevision) return;
    if (queuedArchDesignLayoutSave) {
        const queued = queuedArchDesignLayoutSave;
        queuedArchDesignLayoutSave = undefined;
        unloadLayoutForwarded = false;
        archDesignLayoutSaveInFlight = true;
        post({
            type: 'saveLayout',
            moduleKey: queued.moduleKey,
            revision: currentRevision,
            layout: queued.layout,
        });
        return;
    }
    const command = queuedArchDesignCommand;
    if (!command) return;
    queuedArchDesignCommand = undefined;
    if (command.type === 'edit') {
        archDesignSemanticEditInFlight = true;
        post({
            type: 'editArchDesign',
            revision: currentRevision,
            edit: command.edit,
        });
        return;
    }
    post({ type: 'exportArchDesign', revision: currentRevision });
    authoringPending = false;
    setAuthoringControls();
}

function renderArchDesignInspector(model: ArchDesignInspectorModel): void {
    currentArchDesignInspector = model;
    dom.inspector.dataset.kind = model.kind;
    dom.inspector.dataset.readOnly = 'false';
    dom.inspectorTitle.textContent = model.title;
    dom.inspectorMode.textContent = authoringPending ? 'Applying change' : 'Arch Design';
    dom.inspectorProperties.hidden = true;
    dom.inspectorForm.hidden = false;
    const fields = document.createDocumentFragment();
    for (const field of model.fields) {
        const wrapper = document.createElement('div');
        wrapper.className = 'inspector-field';
        const label = document.createElement('label');
        label.htmlFor = field.id;
        label.textContent = field.label;
        if (field.control === 'readonly') {
            const output = document.createElement('output');
            output.id = field.id;
            output.textContent = field.value;
            wrapper.append(label, output);
        } else {
            const control = field.control === 'select'
                ? document.createElement('select')
                : document.createElement('input');
            control.id = field.id;
            control.value = field.value;
            if (control instanceof HTMLInputElement) {
                control.type = 'text';
                control.autocomplete = 'off';
                control.spellcheck = false;
                control.placeholder = field.placeholder ?? '';
            }
            if (control instanceof HTMLSelectElement) {
                for (const option of field.options ?? []) {
                    const element = document.createElement('option');
                    element.value = option.value;
                    element.textContent = option.label;
                    control.append(element);
                }
                control.value = field.value;
            }
            control.addEventListener('change', () => {
                const edit = field.commit?.(control.value);
                if (edit) postArchDesignEdit(edit);
            });
            wrapper.append(label, control);
        }
        fields.append(wrapper);
    }
    if (model.actions && model.actions.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'inspector-actions';
        for (const action of model.actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'inspector-action';
            button.dataset.inspectorAction = action.id;
            button.dataset.actionAvailable = String(action.edit !== undefined);
            button.disabled = action.edit === undefined;
            button.title = action.disabledReason ?? action.label;
            button.setAttribute('aria-label', action.label);
            button.append(createElement(
                action.id === 'resync-interface' ? RefreshCw : PanelTopOpen,
                {
                    width: 15,
                    height: 15,
                    'stroke-width': 1.75,
                    'aria-hidden': 'true',
                }
            ), document.createTextNode(action.label));
            if (action.edit) {
                button.addEventListener('click', () => postArchDesignEdit(action.edit!));
            }
            actions.append(button);
        }
        fields.append(actions);
    }
    dom.inspectorForm.replaceChildren(fields);
    setAuthoringControls();
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
    if (currentArchDesignState) {
        renderArchDesignInspector(projectArchDesignInspector(
            currentArchDesignState,
            currentGraph,
            selectedNodeIds(cells),
            selectedNetworkId,
            selectedPinId
        ));
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
    selectedPinId = undefined;
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
    if (selectedPinId !== undefined) return [selectedPinId];
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
    selectedPinId = undefined;
    syncingSelection = true;
    selection.clean();
    const wantedObjectIds = preservedObjectIds === undefined
        ? new Set(layout.selectedObjectId ? [layout.selectedObjectId] : [])
        : new Set(preservedObjectIds);
    const matchingPinId = [...wantedObjectIds].find(id =>
        currentGraph?.nodes.some(node => node.pins.some(pin =>
            pin.id === id || pin.interface?.id === id
        ))
    );
    if (matchingPinId !== undefined) selectedPinId = matchingPinId;
    const matchingNodeCells = graph.getCells().filter(cell => {
        const data = cellData(cell);
        return data?.objectType === 'node'
            && wantedObjectIds.has(data.objectId);
    });
    if (selectedPinId !== undefined) {
        // Pin selections do not select or move their owning nodes.
    } else if (matchingNodeCells.length > 0) {
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
    refreshPinSelectionStyles();
    updateSelectionStatus(selection.getSelectedCells(), false);
}

function layoutDisplaySchematic(
    model: SchematicGraph,
    layout: SchematicLayout
): SchematicRenderModel {
    return layoutSchematic(model, layout.placement, measureNodeText);
}

function renderSchematic(
    model: SchematicGraph,
    layout: SchematicLayout,
    preservedSelection?: readonly string[],
    fitOnFirstRender = false
): void {
    const searchQuery = dom.searchInput.value;
    clearPendingNodeMoves();
    applyingLayout = true;
    currentGraph = model;
    currentLayout = cloneSchematicLayout(layout);
    selectedModuleKey = model.moduleKey;
    dom.moduleSelector.value = model.moduleKey;
    graph.resetCells([]);
    const displayModel: SchematicGraph = {
        ...model,
        nodes: model.nodes.map(node => ({
            ...node,
            pins: node.pins.map(pin => pin.interface?.kind === 'aggregate'
                ? { ...pin, name: `${pin.name} · ${pin.interface.protocolName}` }
                : pin),
        })),
    };
    const renderModel = layoutDisplaySchematic(displayModel, layout);
    currentRenderModel = renderModel;
    graph.batchUpdate('render-schematic', () => {
        for (const node of model.nodes) {
            const rendered = renderModel.nodes.get(node.id);
            if (rendered) createRenderedNode(node, rendered);
        }
        renderNetworks(model, renderModel);
    });
    let autoFitted = false;
    if (fitOnFirstRender
        && model.nodes.length > 0
        && !autoFittedModules.has(model.moduleKey)) {
        autoFittedModules.add(model.moduleKey);
        autoFitted = true;
        graph.zoomToFit({ padding: 24, maxScale: 1 });
        const translation = graph.translate();
        currentLayout.viewport = {
            x: translation.tx,
            y: translation.ty,
            zoom: graph.zoom(),
        };
    } else {
        applyViewport(layout);
    }
    restoreSelection(layout, preservedSelection);
    refreshSearchMatches(searchQuery, true);
    applyingLayout = false;
    if (autoFitted) persistCurrentLayoutState();

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
    selectedPinId = undefined;
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
    currentArchDesignInspector = undefined;
    setAuthoringControls();
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
    const nextArchDesignDocument = event.documentKind === 'arch-design';
    if (!nextArchDesignDocument) {
        archDesignLayoutSaveInFlight = false;
        queuedArchDesignLayoutSave = undefined;
        queuedArchDesignCommand = undefined;
        archDesignSemanticEditInFlight = false;
        authoringPending = false;
    }
    archDesignDocument = nextArchDesignDocument;
    archDesignEditable = false;
    currentArchDesignState = undefined;
    currentArchDesignInspector = undefined;
    setAuthoringControls();
    dom.moduleSelector.value = event.selectedModuleKey;
    dom.moduleSelector.disabled = event.modules.length === 0;
    if (event.modules.length === 0) {
        clearSchematicState();
        setCanvasState('No modules');
        return;
    }
    if (!currentGraph || currentGraph.moduleKey !== event.selectedModuleKey) {
        setCanvasState('Loading schematic');
    }
}

function updateArchDesignState(
    event: Extract<HostEvent, { type: 'archDesignState' }>
): void {
    archDesignDocument = true;
    if (event.status === 'editable') {
        archDesignSemanticEditInFlight = false;
        authoringPending = queuedArchDesignCommand !== undefined;
        currentArchDesignState = event;
        archDesignEditable = true;
        dom.instanceModuleSelect.replaceChildren();
        const moduleNames = [...new Set(event.catalog.map(module => module.name))];
        for (const moduleName of moduleNames) {
            const option = document.createElement('option');
            option.value = moduleName;
            option.textContent = moduleName;
            dom.instanceModuleSelect.append(option);
        }
        updateSelectionStatus(selection.getSelectedCells(), false);
    } else {
        archDesignSemanticEditInFlight = false;
        queuedArchDesignCommand = undefined;
        queuedArchDesignLayoutSave = undefined;
        authoringPending = false;
        currentArchDesignState = undefined;
        currentArchDesignInspector = undefined;
        archDesignEditable = false;
        renderInspector({
            kind: 'empty',
            title: event.status === 'readonly' ? 'Read-only Arch Design' : 'Invalid Arch Design',
            readOnly: true,
            rows: [{
                label: 'Status',
                value: event.status === 'readonly'
                    ? event.reason
                    : `${event.diagnostics.length} error${
                        event.diagnostics.length === 1 ? '' : 's'
                    }`,
            }],
        });
    }
    setAuthoringControls();
    drainArchDesignWrites();
}

function handleHostEvent(event: HostEvent): void {
    switch (event.type) {
        case 'initialize':
            initialize(event);
            return;
        case 'graph':
            archDesignGraphRefreshInProgress = archDesignDocument;
            if (currentGraph) {
                layoutSaveScheduler.flushModule(currentGraph.moduleKey);
            }
            layoutSaveScheduler.flushModule(event.graph.moduleKey);
            archDesignGraphRefreshInProgress = false;
            archDesignLayoutSaveInFlight = false;
            unloadLayoutForwarded = false;
            const preservedSelection = archDesignDocument
                && currentGraph?.moduleKey === event.graph.moduleKey
                ? selectedObjectIds(selection.getSelectedCells())
                : undefined;
            const localViewport = event.fitOnFirstRender === true
                && autoFittedModules.has(event.graph.moduleKey)
                ? vscode.getState()?.layouts?.[event.graph.moduleKey]?.viewport
                : undefined;
            const localLayout = queuedArchDesignLayoutSave?.moduleKey
                === event.graph.moduleKey
                ? queuedArchDesignLayoutSave.layout
                : undefined;
            const layout = localLayout ?? (localViewport
                ? {
                    ...event.layout,
                    viewport: { ...localViewport },
                }
                : event.layout);
            currentRevision = event.revision;
            renderSchematic(
                event.graph,
                layout,
                preservedSelection,
                event.fitOnFirstRender === true
            );
            drainArchDesignWrites();
            return;
        case 'diagnostics':
            updateDiagnostics(event.errors, event.warnings);
            return;
        case 'archDesignState':
            updateArchDesignState(event);
            return;
        case 'archDesignLayoutSaved':
            currentRevision = event.revision;
            archDesignLayoutSaveInFlight = false;
            if (currentGraph) {
                layoutSaveScheduler.rebaseRevision(currentGraph.moduleKey, event.revision);
            }
            if (currentArchDesignState) {
                currentArchDesignState = {
                    ...currentArchDesignState,
                    revision: event.revision,
                };
            }
            setAuthoringControls();
            drainArchDesignWrites();
            return;
        case 'archDesignRevisionChanged':
            currentRevision = event.revision;
            if (currentGraph) {
                layoutSaveScheduler.rebaseRevision(currentGraph.moduleKey, event.revision);
            }
            if (currentArchDesignState) {
                currentArchDesignState = {
                    ...currentArchDesignState,
                    revision: event.revision,
                };
            }
            setAuthoringControls();
            drainArchDesignWrites();
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
        [dom.addInstanceButton, AddBox],
        [dom.addPortButton, PanelTopOpen],
        [dom.connectButton, Cable],
        [dom.exportButton, FileOutput],
        [dom.deleteButton, Trash2],
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
    if (currentGraph && currentLayout && archDesignDocument) {
        currentLayout.placement = createPlacement(
            currentGraph,
            assignColumns(currentGraph)
        );
        const preservedSelection = selectedObjectIds(selection.getSelectedCells());
        renderSchematic(currentGraph, currentLayout, preservedSelection);
        scheduleLayoutSave();
    } else if (currentGraph) {
        post({
            type: 'relayoutAll',
            moduleKey: currentGraph.moduleKey,
            revision: currentRevision,
        });
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

function showDialog(dialog: HTMLDialogElement, firstControl: HTMLElement): void {
    if (!archDesignEditable || authoringPending) return;
    dialog.showModal();
    firstControl.focus();
}

function parsedPortWidth(value: string): number | { expression: string } | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === '1') return undefined;
    if (/^[1-9][0-9]*$/.test(trimmed)) return Number(trimmed);
    return { expression: trimmed };
}

dom.addInstanceButton.addEventListener('click', () => {
    dom.instanceNameInput.value = '';
    showDialog(dom.addInstanceDialog, dom.instanceNameInput);
});

dom.addPortButton.addEventListener('click', () => {
    dom.portNameInput.value = '';
    dom.portDirectionSelect.value = 'input';
    dom.portWidthInput.value = '1';
    showDialog(dom.addPortDialog, dom.portNameInput);
});

dom.connectButton.addEventListener('click', () => {
    const active = dom.connectButton.getAttribute('aria-pressed') !== 'true';
    dom.connectButton.setAttribute('aria-pressed', String(active));
    refreshConnectionMagnets();
});

dom.exportButton.addEventListener('click', () => {
    if (!currentArchDesignState || !archDesignEditable || authoringPending) return;
    authoringPending = true;
    queuedArchDesignCommand = { type: 'export' };
    setAuthoringControls();
    if (currentGraph) layoutSaveScheduler.flushModule(currentGraph.moduleKey);
    drainArchDesignWrites();
});

dom.deleteButton.addEventListener('click', () => {
    if (currentArchDesignInspector?.deleteEdit) {
        postArchDesignEdit(currentArchDesignInspector.deleteEdit);
    }
});

dom.addInstanceForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = dom.instanceNameInput.value.trim();
    const module = dom.instanceModuleSelect.value;
    if (!name || !module) return;
    dom.addInstanceDialog.close();
    postArchDesignEdit({ type: 'addInstance', instance: { name, module } });
});

dom.addPortForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = dom.portNameInput.value.trim();
    const direction = dom.portDirectionSelect.value as ArchDesignPortDirection;
    if (!name || (direction !== 'input' && direction !== 'output' && direction !== 'inout')) {
        return;
    }
    const width = parsedPortWidth(dom.portWidthInput.value);
    dom.addPortDialog.close();
    postArchDesignEdit({
        type: 'addPort',
        port: { name, direction, ...(width === undefined ? {} : { width }) },
    });
});

document.querySelectorAll<HTMLButtonElement>('[data-dialog-cancel]').forEach(button => {
    button.addEventListener('click', () => button.closest('dialog')?.close());
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

graph.on('edge:connected', ({ edge, isNew }) => {
    if (!isNew) return;
    const source = connectionSourceFor(
        edge.getSourceCell(),
        edge.getSourcePortId()
    );
    const target = connectionTargetFor(
        edge.getTargetCell(),
        edge.getTargetPortId()
    );
    graph.removeCell(edge);
    if (!source || !target || source.pin.id === target.pin.id) return;
    if (source.kind === 'interface') {
        if (target.kind !== 'interface' || source.protocol !== target.protocol) return;
        const endpointName = (endpoint: ArchDesignInterfaceEndpoint): string =>
            endpoint.kind === 'port' ? endpoint.port : endpoint.interface;
        const baseName = `${endpointName(source.endpoint)}_to_${endpointName(target.endpoint)}`;
        const names = new Set([
            ...(currentArchDesignState?.design.connections.map(item => item.name) ?? []),
            ...(currentArchDesignState?.design.interfaceConnections.map(item => item.name) ?? []),
        ]);
        let name = baseName;
        for (let suffix = 2; names.has(name); suffix += 1) name = `${baseName}_${suffix}`;
        postArchDesignEdit({
            type: 'connectInterface',
            connection: {
                name,
                master: source.endpoint,
                slave: target.endpoint,
            },
        });
        return;
    }
    if (target.kind !== 'scalar') return;
    postArchDesignEdit({
        type: 'connect',
        source: source.endpoint,
        target: target.endpoint,
    });
});

graph.on('edge:click', ({ edge }) => {
    const data = cellData(edge);
    if (data?.objectType === 'network') selectNetwork(data.objectId);
});

graph.on('node:click', ({ node }) => {
    const data = cellData(node);
    if (data?.junction) selectNetwork(data.objectId);
});

graph.on('node:port:click', ({ node, port }) => {
    const data = cellData(node);
    if (!data?.node || !port || !data.node.pins.some(pin => pin.id === port)) return;
    selectedNetworkId = undefined;
    selectedPinId = port;
    syncingSelection = true;
    selection.clean();
    syncingSelection = false;
    refreshNetworkSelectionStyles();
    updateSelectionStatus([]);
});

graph.on('blank:click', () => {
    selectNetwork(undefined);
});

selection.on('selection:changed', ({ selected }) => {
    if (applyingLayout || syncingSelection) return;
    selectedNetworkId = undefined;
    selectedPinId = undefined;
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

window.addEventListener('pagehide', flushLayoutSavesForUnload);
window.addEventListener('beforeunload', flushLayoutSavesForUnload);

window.addEventListener('message', event => {
    if (!event.data || typeof event.data !== 'object') return;
    const type = (event.data as { type?: unknown }).type;
    if (type === 'initialize' || type === 'graph' || type === 'diagnostics'
        || type === 'archDesignState' || type === 'archDesignLayoutSaved'
        || type === 'archDesignRevisionChanged'
        || type === 'hostError') {
        handleHostEvent(event.data as HostEvent);
    }
});

dom.shell.dataset.runtimeReady = 'true';
post({ type: 'ready' });
