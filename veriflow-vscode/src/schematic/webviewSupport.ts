import type { HdlDiagnostic, SourceSpan } from '../core/hdl/model';
import type {
    GraphNode,
    GraphPin,
    PinDirection,
    SchematicGraph,
    SchematicNetwork,
} from '@veriflow/schematic-core';
import type { SchematicLayout } from './layoutStore';
import type { WebviewCommand } from './protocol';

export type SchematicWebviewResources = {
    cspSource: string;
    styleUri: string;
    scriptUri: string;
    nonce: string;
};

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function replaceRequired(
    source: string,
    pattern: RegExp,
    replacement: string,
    description: string
): string {
    if (!pattern.test(source)) {
        throw new Error(`Schematic HTML is missing the ${description} placeholder`);
    }
    return source.replace(pattern, replacement);
}

export function buildSchematicWebviewHtml(
    shell: string,
    resources: SchematicWebviewResources
): string {
    if (!/^[A-Za-z0-9+/_=-]+$/.test(resources.nonce)) {
        throw new Error('Schematic webview nonce contains invalid characters');
    }
    const csp = [
        "default-src 'none'",
        `img-src ${resources.cspSource}`,
        `style-src ${resources.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${resources.nonce}'`,
    ].join('; ') + ';';
    let html = replaceRequired(
        shell,
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/i,
        `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`,
        'Content-Security-Policy'
    );
    html = replaceRequired(
        html,
        /href="\.\/index\.css"/,
        `href="${escapeHtmlAttribute(resources.styleUri)}"`,
        'stylesheet'
    );
    return replaceRequired(
        html,
        /<script\s+src="\.\/index\.js"><\/script>/,
        `<script nonce="${escapeHtmlAttribute(resources.nonce)}" src="${
            escapeHtmlAttribute(resources.scriptUri)
        }"></script>`,
        'script'
    );
}

export type TimerAdapter<Handle> = {
    set(callback: () => void, delayMs: number): Handle;
    clear(handle: Handle): void;
};

export type SchematicSelectionItem = {
    objectId: string;
    description: string;
};

export type SchematicSelectionSummary = {
    selectedObjectId?: string;
    statusText: string;
};

export type SchematicInspectorModel = Readonly<{
    kind: 'empty' | 'network' | 'instance' | 'port' | 'node' | 'multiple';
    title: string;
    readOnly: true;
    rows: readonly Readonly<{ label: string; value: string }>[];
}>;

const MAX_INSPECTOR_ENDPOINT_PREVIEW = 8;

type InspectorGraphIndex = Readonly<{
    nodesById: ReadonlyMap<string, GraphNode>;
    pinsByNodeId: ReadonlyMap<string, ReadonlyMap<string, GraphPin>>;
}>;

function inspectorGraphIndex(graph: SchematicGraph): InspectorGraphIndex {
    const nodesById = new Map<string, GraphNode>();
    const pinsByNodeId = new Map<string, ReadonlyMap<string, GraphPin>>();
    for (const node of graph.nodes) {
        nodesById.set(node.id, node);
        pinsByNodeId.set(node.id, new Map(node.pins.map(pin => [pin.id, pin])));
    }
    return { nodesById, pinsByNodeId };
}

function formatWidth(width: GraphPin['width']): string {
    if (width.kind === 'known') {
        return `${width.bits} bit${width.bits === 1 ? '' : 's'}`;
    }
    return width.kind === 'symbolic' ? width.expression : 'Unknown';
}

function formatHdlDirection(
    direction: PinDirection,
    boundaryPort: boolean
): string {
    if (direction === 'bidirectional') return 'Inout';
    if (boundaryPort) return direction === 'driver' ? 'Input' : 'Output';
    return direction === 'load' ? 'input' : 'output';
}

function endpointName(
    index: InspectorGraphIndex,
    endpoint: SchematicNetwork['endpoints'][number]
): string | undefined {
    const node = index.nodesById.get(endpoint.nodeId);
    const pin = index.pinsByNodeId.get(endpoint.nodeId)?.get(endpoint.pinId);
    if (!node || !pin) return undefined;
    return node.kind === 'port' ? node.label : `${node.label}.${pin.name}`;
}

function formattedEndpoints(
    index: InspectorGraphIndex,
    network: SchematicNetwork
): Record<PinDirection, string> {
    const summaries: Record<PinDirection, { count: number; names: string[] }> = {
        driver: { count: 0, names: [] },
        load: { count: 0, names: [] },
        bidirectional: { count: 0, names: [] },
    };
    for (const endpoint of network.endpoints) {
        const name = endpointName(index, endpoint);
        if (name === undefined) continue;
        const summary = summaries[endpoint.role];
        summary.count += 1;
        if (summary.names.length < MAX_INSPECTOR_ENDPOINT_PREVIEW) {
            summary.names.push(name);
        }
    }
    return Object.fromEntries(Object.entries(summaries).map(([role, summary]) => {
        if (summary.count === 0) return [role, 'None'];
        const hidden = summary.count - summary.names.length;
        const values = hidden > 0
            ? [...summary.names, `... (+${hidden} more)`]
            : summary.names;
        return [role, values.join(', ')];
    })) as Record<PinDirection, string>;
}

function projectNetworkInspector(
    graph: SchematicGraph,
    network: SchematicNetwork
): SchematicInspectorModel {
    const endpoints = formattedEndpoints(inspectorGraphIndex(graph), network);
    return {
        kind: 'network',
        title: network.name,
        readOnly: true,
        rows: [
            { label: 'Name', value: network.name },
            { label: 'Adapter', value: network.adapterLabel ?? 'None' },
            { label: 'Width', value: formatWidth(network.width) },
            { label: 'Drivers', value: endpoints.driver },
            { label: 'Loads', value: endpoints.load },
            {
                label: 'Bidirectional',
                value: endpoints.bidirectional,
            },
        ],
    };
}

function formatPins(node: GraphNode): string {
    if (node.pins.length === 0) return 'None';
    return node.pins.map(pin => `${pin.name} (${formatHdlDirection(
        pin.direction,
        false
    )}, ${formatWidth(pin.width)})`).join(', ');
}

function projectNodeInspector(
    graph: SchematicGraph,
    node: GraphNode
): SchematicInspectorModel {
    if (node.kind === 'instance') {
        return {
            kind: 'instance',
            title: node.label,
            readOnly: true,
            rows: [
                { label: 'Name', value: node.label },
                { label: 'Module', value: node.subtitle ?? 'Unknown' },
                { label: 'Pins', value: formatPins(node) },
                {
                    label: 'Definition',
                    value: node.definitionKey ? 'Available' : 'Unavailable',
                },
                { label: 'Read-only', value: node.readOnly ? 'Yes' : 'No' },
            ],
        };
    }
    if (node.kind === 'port') {
        const pin = node.pins[0];
        const networks = graph.networks.filter(network => network.endpoints.some(
            endpoint => endpoint.nodeId === node.id
                && (pin === undefined || endpoint.pinId === pin.id)
        ));
        return {
            kind: 'port',
            title: node.label,
            readOnly: true,
            rows: [
                { label: 'Name', value: node.label },
                {
                    label: 'Direction',
                    value: pin ? formatHdlDirection(pin.direction, true) : 'Unknown',
                },
                { label: 'Width', value: pin ? formatWidth(pin.width) : 'Unknown' },
                {
                    label: 'Network',
                    value: networks.length > 0
                        ? networks.map(network => network.name).join(', ')
                        : 'Unconnected',
                },
            ],
        };
    }
    return {
        kind: 'node',
        title: node.label,
        readOnly: true,
        rows: [
            { label: 'Name', value: node.label },
            { label: 'Type', value: node.kind },
            { label: 'Pins', value: formatPins(node) },
            { label: 'Read-only', value: node.readOnly ? 'Yes' : 'No' },
        ],
    };
}

export function projectSchematicInspector(
    graph: SchematicGraph,
    selectedNodeIds: readonly string[],
    selectedNetworkId: string | undefined
): SchematicInspectorModel {
    const network = selectedNetworkId === undefined
        ? undefined
        : graph.networks.find(candidate => candidate.id === selectedNetworkId);
    if (network) return projectNetworkInspector(graph, network);

    const wantedNodeIds = new Set(selectedNodeIds);
    const nodes = graph.nodes.filter(node => wantedNodeIds.has(node.id));
    if (nodes.length === 1) return projectNodeInspector(graph, nodes[0]);
    if (nodes.length > 1) {
        const readOnlyValues = new Set(nodes.map(node => node.readOnly));
        return {
            kind: 'multiple',
            title: `${nodes.length} objects selected`,
            readOnly: true,
            rows: [
                { label: 'Count', value: String(nodes.length) },
                {
                    label: 'Read-only',
                    value: readOnlyValues.size > 1
                        ? 'Mixed'
                        : nodes[0].readOnly ? 'Yes' : 'No',
                },
            ],
        };
    }
    return {
        kind: 'empty',
        title: 'No selection',
        readOnly: true,
        rows: [],
    };
}

export function formatSchematicDiagnosticDetails(
    diagnostics: readonly HdlDiagnostic[]
): string {
    return diagnostics.map(diagnostic =>
        `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`
    ).join('\n');
}

type DefaultTimerHandle = ReturnType<typeof setTimeout>;

const defaultTimers: TimerAdapter<DefaultTimerHandle> = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: handle => clearTimeout(handle),
};

export function navigationCommandForCell(
    target: { sourceSpan?: SourceSpan; definitionKey?: string },
    openDefinition: boolean
): WebviewCommand | undefined {
    if (openDefinition) {
        return typeof target.definitionKey === 'string'
            && target.definitionKey.length > 0
            ? { type: 'openDefinition', definitionKey: target.definitionKey }
            : undefined;
    }
    return target.sourceSpan
        ? { type: 'revealSource', span: target.sourceSpan }
        : undefined;
}

export function summarizeSchematicSelection(
    items: readonly SchematicSelectionItem[]
): SchematicSelectionSummary {
    const last = items[items.length - 1];
    if (!last) return { statusText: 'No selection' };
    return {
        selectedObjectId: last.objectId,
        statusText: items.length === 1
            ? last.description
            : `${items.length} objects selected`,
    };
}

export function cloneSchematicLayout(layout: SchematicLayout): SchematicLayout {
    return {
        placement: {
            nodes: Object.fromEntries(Object.entries(layout.placement.nodes).map(
                ([id, node]) => [id, { ...node }]
            )),
        },
        viewport: { ...layout.viewport },
        minimap: layout.minimap,
        ...(layout.selectedObjectId === undefined
            ? {}
            : { selectedObjectId: layout.selectedObjectId }),
    };
}

export function mergeSchematicWebviewLayouts(
    layouts: Readonly<Record<string, SchematicLayout>> | undefined,
    moduleKey: string,
    layout: SchematicLayout
): Record<string, SchematicLayout> {
    return Object.fromEntries([
        ...Object.entries(layouts ?? {}).filter(([key]) => key !== moduleKey),
        [moduleKey, layout] as const,
    ].map(([key, value]) => [key, cloneSchematicLayout(value)]));
}

export class DebouncedLayoutSaveScheduler<Handle = DefaultTimerHandle> {
    private readonly pending = new Map<string, {
        handle?: Handle;
        revision: string;
        layout: SchematicLayout;
    }>();

    constructor(
        private readonly delayMs: number,
        private readonly save: (
            moduleKey: string,
            revision: string,
            layout: SchematicLayout
        ) => void,
        private readonly timers: TimerAdapter<Handle> = defaultTimers as unknown as
            TimerAdapter<Handle>
    ) {}

    schedule(moduleKey: string, revision: string, layout: SchematicLayout): void {
        const previous = this.pending.get(moduleKey);
        if (previous?.handle !== undefined) this.timers.clear(previous.handle);

        const pending: {
            handle?: Handle;
            revision: string;
            layout: SchematicLayout;
        } = {
            revision,
            layout: cloneSchematicLayout(layout),
        };
        this.pending.set(moduleKey, pending);
        pending.handle = this.timers.set(() => {
            this.commit(moduleKey, pending);
        }, this.delayMs);
    }

    flush(): void {
        for (const [moduleKey, pending] of [...this.pending]) {
            this.commit(moduleKey, pending);
        }
    }

    flushModule(moduleKey: string): void {
        const pending = this.pending.get(moduleKey);
        if (pending) this.commit(moduleKey, pending);
    }

    dispose(): void {
        for (const pending of this.pending.values()) {
            if (pending.handle !== undefined) this.timers.clear(pending.handle);
        }
        this.pending.clear();
    }

    private commit(
        moduleKey: string,
        pending: { handle?: Handle; revision: string; layout: SchematicLayout }
    ): void {
        if (this.pending.get(moduleKey) !== pending) return;
        if (pending.handle !== undefined) this.timers.clear(pending.handle);
        this.pending.delete(moduleKey);
        this.save(moduleKey, pending.revision, pending.layout);
    }
}
