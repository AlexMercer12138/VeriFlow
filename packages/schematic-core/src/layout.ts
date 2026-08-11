import { assignColumns } from './columns';
import type {
    GraphNode,
    GraphNodeKind,
    GraphPin,
    PinDirection,
    SchematicGraph,
    SchematicNetwork,
} from './model';
import {
    fitSchematicNode,
    measureSchematicNodeSize,
    SCHEMATIC_NODE_LAYOUT,
    type MeasuredLabel,
    type ResolvedPin,
    type TextMeasurer,
} from './nodeGeometry';
import { mergePlacement, type SchematicPlacement } from './placement';
import { pinKey, resolvePinSides, type PinKey } from './pins';
import {
    readonlyMap,
    readonlySet,
    SCHEMATIC_NETWORK_LABEL_LAYOUT,
    type LayoutColumn,
    type NetworkRoute,
    type RenderedJunction,
    type RenderedNodeGeometry,
    type RenderedPinGeometry,
    type RenderedTextLabel,
    type SchematicRenderModel,
} from './renderModel';
import type { Point, Rectangle, RouteSegment } from './routing/geometry';
import type { RoutingGridNodeInput } from './routing/grid';
import { deriveJunctions, type Direction } from './routing/junctions';
import {
    routeNetworks,
    type RoutedNetwork,
    type RoutedRouteSegment,
} from './routing/router';

const DIRECTION_ORDER: readonly Direction[] = [
    'north',
    'east',
    'south',
    'west',
];

const GRAPH_NODE_KINDS: ReadonlySet<GraphNodeKind> = new Set([
    'port',
    'instance',
    'constant',
    'expression',
    'opaque',
    'generateArray',
]);

const PIN_DIRECTIONS: ReadonlySet<PinDirection> = new Set([
    'driver',
    'load',
    'bidirectional',
]);

function snapshotArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new RangeError(`${label} must be an array`);
    const length = value.length;
    const result = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) result[index] = value[index];
    return result;
}

function snapshotWidth(value: unknown, label: string): GraphPin['width'] {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RangeError(`${label} width must be an object`);
    }
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    if (kind === 'known') {
        const bits = record.bits;
        if (typeof bits !== 'number') {
            throw new RangeError(`${label} known width must contain bits`);
        }
        return { kind, bits };
    }
    if (kind === 'symbolic') {
        const expression = record.expression;
        if (typeof expression !== 'string') {
            throw new RangeError(`${label} symbolic width must contain an expression`);
        }
        return { kind, expression };
    }
    if (kind === 'unknown') return { kind };
    throw new RangeError(`${label} has an invalid width kind`);
}

function snapshotSourceSpan(
    value: unknown,
    label: string
): GraphNode['sourceSpan'] {
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RangeError(`${label} sourceSpan must be an object`);
    }
    const record = value as Record<string, unknown>;
    const start = record.start;
    const end = record.end;
    const uri = record.uri;
    const compositePartsValue = record.compositeParts;
    if (typeof start !== 'number' || typeof end !== 'number'
        || (uri !== undefined && typeof uri !== 'string')) {
        throw new RangeError(`${label} has an invalid sourceSpan`);
    }
    const compositeParts = compositePartsValue === undefined
        ? undefined
        : snapshotArray(compositePartsValue, `${label} compositeParts`).map(
            (part, index) => {
                if (typeof part !== 'object' || part === null || Array.isArray(part)) {
                    throw new RangeError(`${label} composite part ${index} is invalid`);
                }
                const partRecord = part as Record<string, unknown>;
                const partUri = partRecord.uri;
                const partStart = partRecord.start;
                const partEnd = partRecord.end;
                if (typeof partUri !== 'string' || typeof partStart !== 'number'
                    || typeof partEnd !== 'number') {
                    throw new RangeError(`${label} composite part ${index} is invalid`);
                }
                return { uri: partUri, start: partStart, end: partEnd };
            }
        );
    return { start, end, uri, compositeParts };
}

function snapshotPin(value: unknown, nodeId: string, pinIndex: number): GraphPin {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RangeError(`node ${nodeId} pin ${pinIndex} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const id = record.id;
    const name = record.name;
    const direction = record.direction;
    const widthValue = record.width;
    const readOnly = record.readOnly;
    const sourceSpanValue = record.sourceSpan;
    if (typeof id !== 'string' || typeof name !== 'string'
        || !PIN_DIRECTIONS.has(direction as PinDirection)
        || typeof readOnly !== 'boolean') {
        throw new RangeError(`node ${nodeId} pin ${pinIndex} is invalid`);
    }
    return {
        id,
        name,
        direction: direction as PinDirection,
        width: snapshotWidth(widthValue, `node ${nodeId} pin ${id}`),
        readOnly,
        sourceSpan: snapshotSourceSpan(sourceSpanValue, `node ${nodeId} pin ${id}`),
    };
}

function snapshotNode(
    value: unknown,
    nodeIndex: number,
    seenNodeIds: Set<string>
): GraphNode {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RangeError(`graph node ${nodeIndex} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const id = record.id;
    const kind = record.kind;
    const label = record.label;
    const subtitle = record.subtitle;
    const definitionKey = record.definitionKey;
    const pinsValue = record.pins;
    const readOnly = record.readOnly;
    const sourceSpanValue = record.sourceSpan;
    if (typeof id !== 'string' || seenNodeIds.has(id)) {
        throw new RangeError('graph node IDs must be unique strings');
    }
    seenNodeIds.add(id);
    if (!GRAPH_NODE_KINDS.has(kind as GraphNodeKind)
        || typeof label !== 'string'
        || (subtitle !== undefined && typeof subtitle !== 'string')
        || (definitionKey !== undefined && typeof definitionKey !== 'string')
        || typeof readOnly !== 'boolean') {
        throw new RangeError(`graph node ${id} is invalid`);
    }
    const seenPinIds = new Set<string>();
    const pins = snapshotArray(pinsValue, `node ${id} pins`).map(
        (pinValue, pinIndex) => {
            const pin = snapshotPin(pinValue, id, pinIndex);
            if (seenPinIds.has(pin.id)) {
                throw new RangeError(`node ${id} pin IDs must be unique strings`);
            }
            seenPinIds.add(pin.id);
            return pin;
        }
    );
    return {
        id,
        kind: kind as GraphNodeKind,
        label,
        subtitle: subtitle as string | undefined,
        definitionKey: definitionKey as string | undefined,
        pins,
        readOnly,
        sourceSpan: snapshotSourceSpan(sourceSpanValue, `node ${id}`),
    };
}

function snapshotNetwork(
    value: unknown,
    networkIndex: number,
    nodesById: ReadonlyMap<string, GraphNode>,
    pinsByNode: ReadonlyMap<string, ReadonlyMap<string, GraphPin>>,
    seenNetworkIds: Set<string>,
    networkByPin: Map<PinKey, string>
): SchematicNetwork {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RangeError(`graph network ${networkIndex} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const id = record.id;
    const name = record.name;
    const widthValue = record.width;
    const endpointsValue = record.endpoints;
    const sourceSpanValue = record.sourceSpan;
    const adapterLabel = record.adapterLabel;
    if (typeof id !== 'string' || seenNetworkIds.has(id)) {
        throw new RangeError('graph network IDs must be unique strings');
    }
    seenNetworkIds.add(id);
    if (typeof name !== 'string'
        || (adapterLabel !== undefined && typeof adapterLabel !== 'string')) {
        throw new RangeError(`graph network ${id} is invalid`);
    }
    const seenTerminals = new Set<PinKey>();
    const endpoints = snapshotArray(endpointsValue, `network ${id} endpoints`).map(
        (endpointValue, endpointIndex) => {
            if (typeof endpointValue !== 'object' || endpointValue === null
                || Array.isArray(endpointValue)) {
                throw new RangeError(
                    `network ${id} endpoint ${endpointIndex} must be an object`
                );
            }
            const endpoint = endpointValue as Record<string, unknown>;
            const nodeId = endpoint.nodeId;
            const pinId = endpoint.pinId;
            const role = endpoint.role;
            if (typeof nodeId !== 'string' || typeof pinId !== 'string'
                || !PIN_DIRECTIONS.has(role as PinDirection)) {
                throw new RangeError(`network ${id} endpoint ${endpointIndex} is invalid`);
            }
            const node = nodesById.get(nodeId);
            const pin = pinsByNode.get(nodeId)?.get(pinId);
            if (!node) {
                throw new RangeError(`unknown node ${nodeId} in network ${id}`);
            }
            if (!pin) {
                throw new RangeError(`unknown pin ${nodeId}:${pinId} in network ${id}`);
            }
            if (pin.direction !== 'bidirectional' && pin.direction !== role) {
                throw new RangeError(
                    `endpoint role does not match pin direction in network ${id}`
                );
            }
            const terminalKey = pinKey(nodeId, pinId);
            if (seenTerminals.has(terminalKey)) {
                throw new RangeError(`duplicate terminal in network ${id}`);
            }
            seenTerminals.add(terminalKey);
            const previousNetwork = networkByPin.get(terminalKey);
            if (previousNetwork !== undefined) {
                throw new RangeError(
                    `pin ${nodeId}:${pinId} belongs to both ${previousNetwork} and ${id}`
                );
            }
            networkByPin.set(terminalKey, id);
            return { nodeId, pinId, role: role as PinDirection };
        }
    );
    return {
        id,
        name,
        width: snapshotWidth(widthValue, `network ${id}`),
        endpoints,
        sourceSpan: snapshotSourceSpan(sourceSpanValue, `network ${id}`),
        adapterLabel: adapterLabel as string | undefined,
    };
}

function snapshotGraph(value: SchematicGraph): SchematicGraph {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RangeError('schematic graph must be an object');
    }
    const record = value as unknown as Record<string, unknown>;
    const fileUri = record.fileUri;
    const moduleKey = record.moduleKey;
    const moduleName = record.moduleName;
    const nodesValue = record.nodes;
    const networksValue = record.networks;
    const diagnosticsValue = record.diagnostics;
    if (typeof fileUri !== 'string' || typeof moduleKey !== 'string'
        || typeof moduleName !== 'string') {
        throw new RangeError('schematic graph identity must contain strings');
    }
    const seenNodeIds = new Set<string>();
    const nodes = snapshotArray(nodesValue, 'graph nodes').map(
        (nodeValue, nodeIndex) => snapshotNode(nodeValue, nodeIndex, seenNodeIds)
    );
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const pinsByNode = new Map(nodes.map(node => [
        node.id,
        new Map(node.pins.map(pin => [pin.id, pin])),
    ]));
    const seenNetworkIds = new Set<string>();
    const networkByPin = new Map<PinKey, string>();
    const networks = snapshotArray(networksValue, 'graph networks').map(
        (networkValue, networkIndex) => snapshotNetwork(
            networkValue,
            networkIndex,
            nodesById,
            pinsByNode,
            seenNetworkIds,
            networkByPin
        )
    );
    const diagnostics = snapshotArray(diagnosticsValue, 'graph diagnostics');
    return {
        fileUri,
        moduleKey,
        moduleName,
        nodes,
        networks,
        diagnostics: diagnostics as SchematicGraph['diagnostics'],
    };
}

function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function snapshotPlacement(
    value: SchematicPlacement | undefined,
    graph: SchematicGraph
): SchematicPlacement | undefined {
    if (value === undefined || typeof value !== 'object' || value === null
        || Array.isArray(value)) {
        return undefined;
    }
    const nodesValue = (value as unknown as Record<string, unknown>).nodes;
    if (typeof nodesValue !== 'object' || nodesValue === null
        || Array.isArray(nodesValue)) {
        return undefined;
    }
    const source = nodesValue as Record<string, unknown>;
    const nodes: SchematicPlacement['nodes'] = {};
    for (const node of graph.nodes) {
        if (!Object.prototype.hasOwnProperty.call(source, node.id)) continue;
        const candidateValue = source[node.id];
        if (typeof candidateValue !== 'object' || candidateValue === null
            || Array.isArray(candidateValue)) continue;
        const candidate = candidateValue as Record<string, unknown>;
        const column = candidate.column;
        const order = candidate.order;
        const yOffset = candidate.yOffset;
        const fixed = candidate.fixed;
        setOwn(nodes, node.id, {
            column: column as number,
            order: order as number,
            yOffset: yOffset as number,
            fixed: fixed as boolean,
        });
    }
    return { nodes };
}

function alignNodeSize(value: number): number {
    return Math.ceil(value / SCHEMATIC_NODE_LAYOUT.gridSize)
        * SCHEMATIC_NODE_LAYOUT.gridSize;
}

function freezePoint(point: Readonly<Point>): Readonly<Point> {
    return Object.freeze({ x: point.x, y: point.y });
}

function freezeRectangle(rectangle: Readonly<Rectangle>): Readonly<Rectangle> {
    return Object.freeze({
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
    });
}

function translateRectangle(
    rectangle: Readonly<Rectangle>,
    offset: Readonly<Point>
): Readonly<Rectangle> {
    return freezeRectangle({
        x: rectangle.x + offset.x,
        y: rectangle.y + offset.y,
        width: rectangle.width,
        height: rectangle.height,
    });
}

function renderLabel(
    label: MeasuredLabel,
    offset: Readonly<Point>
): RenderedTextLabel {
    return Object.freeze({
        fullText: label.fullText,
        visibleText: label.visibleText,
        truncated: label.truncated,
        bounds: translateRectangle(label.clipBounds, offset),
    });
}

function renderPin(
    pin: ResolvedPin,
    offset: Readonly<Point>,
    anchor: Readonly<Point>
): RenderedPinGeometry {
    return Object.freeze({
        id: pin.source.id,
        name: pin.source.name,
        direction: pin.source.direction,
        side: pin.side,
        anchor: freezePoint(anchor),
        fullLabel: pin.fullLabel,
        visibleLabel: pin.visibleLabel,
        truncated: pin.truncated,
        clipBounds: translateRectangle(pin.clipBounds, offset),
    });
}

function freezeSegment(segment: RoutedRouteSegment): Readonly<RouteSegment> {
    return Object.freeze({ ...segment });
}

function calculateBounds(
    gridBounds: Readonly<Rectangle>,
    segments: readonly Readonly<RouteSegment>[],
    junctions: readonly RenderedJunction[],
    empty: boolean
): Readonly<Rectangle> {
    if (empty && junctions.length === 0) {
        return freezeRectangle({ x: 0, y: 0, width: 0, height: 0 });
    }
    let minimumX = gridBounds.x;
    let minimumY = gridBounds.y;
    let maximumX = gridBounds.x + gridBounds.width;
    let maximumY = gridBounds.y + gridBounds.height;
    for (const segment of segments) {
        if (segment.orientation === 'horizontal') {
            minimumX = Math.min(minimumX, segment.x1);
            minimumY = Math.min(minimumY, segment.y);
            maximumX = Math.max(maximumX, segment.x2);
            maximumY = Math.max(maximumY, segment.y);
        } else {
            minimumX = Math.min(minimumX, segment.x);
            minimumY = Math.min(minimumY, segment.y1);
            maximumX = Math.max(maximumX, segment.x);
            maximumY = Math.max(maximumY, segment.y2);
        }
    }
    for (const junction of junctions) {
        minimumX = Math.min(
            minimumX,
            junction.point.x - SCHEMATIC_NETWORK_LABEL_LAYOUT.junctionRadius
        );
        minimumY = Math.min(
            minimumY,
            junction.point.y - SCHEMATIC_NETWORK_LABEL_LAYOUT.junctionRadius
        );
        maximumX = Math.max(
            maximumX,
            junction.point.x + SCHEMATIC_NETWORK_LABEL_LAYOUT.junctionRadius
        );
        maximumY = Math.max(
            maximumY,
            junction.point.y + SCHEMATIC_NETWORK_LABEL_LAYOUT.junctionRadius
        );
    }
    return freezeRectangle({
        x: minimumX,
        y: minimumY,
        width: maximumX - minimumX,
        height: maximumY - minimumY,
    });
}

export function layoutSchematic(
    inputGraph: SchematicGraph,
    placement: SchematicPlacement | undefined,
    measureText: TextMeasurer
): SchematicRenderModel {
    const graph = snapshotGraph(inputGraph);
    const assignment = assignColumns(graph);
    const mergedPlacement = mergePlacement(
        graph,
        assignment,
        snapshotPlacement(placement, graph)
    );
    const pinSides = resolvePinSides(graph);
    const fittedById = new Map(graph.nodes.map(node => {
        const measuredSize = measureSchematicNodeSize(node, pinSides);
        const size = {
            width: alignNodeSize(measuredSize.width),
            height: alignNodeSize(measuredSize.height),
        };
        return [
            node.id,
            fitSchematicNode(node, pinSides, size, measureText),
        ] as const;
    }));
    const routingNodes: RoutingGridNodeInput[] = graph.nodes.map(node => {
        const fitted = fittedById.get(node.id)!;
        const placed = mergedPlacement.nodes[node.id];
        return {
            id: node.id,
            column: placed.column,
            order: placed.order,
            yOffset: placed.yOffset,
            size: { width: fitted.width, height: fitted.height },
            pinAnchors: fitted.pins.map(pin => ({
                id: pin.source.id,
                x: pin.anchor.x,
                y: pin.anchor.y,
            })),
        };
    });
    const routed = routeNetworks(
        routingNodes,
        graph.networks.map(network => ({
            id: network.id,
            terminals: network.endpoints.map(endpoint => ({ ...endpoint })),
        })),
        { columnCount: assignment.columns.length }
    );
    const realizedById = new Map(routed.grid.nodes.map(node => [node.id, node]));
    const renderedNodes = graph.nodes.map(node => {
        const fitted = fittedById.get(node.id)!;
        const realized = realizedById.get(node.id)!;
        const offset = { x: realized.bounds.x, y: realized.bounds.y };
        const anchors = new Map(realized.pinAnchors.map(pin => [pin.id, pin.point]));
        const rendered: RenderedNodeGeometry = Object.freeze({
            id: node.id,
            kind: node.kind,
            label: node.label,
            subtitle: node.subtitle,
            column: realized.column,
            row: realized.row,
            bounds: freezeRectangle(realized.bounds),
            title: renderLabel(fitted.title, offset),
            renderedSubtitle: fitted.subtitle
                ? renderLabel(fitted.subtitle, offset)
                : undefined,
            pins: Object.freeze(fitted.pins.map(pin => renderPin(
                pin,
                offset,
                anchors.get(pin.source.id)!
            ))),
        });
        return [node.id, rendered] as const;
    });
    const nodes = readonlyMap(renderedNodes);
    const routedById = new Map(routed.networks.map(network => [network.id, network]));
    const allSegments = graph.networks.flatMap(network =>
        routedById.get(network.id)?.segments ?? []
    );
    const networkOrder = new Map(graph.networks.map((network, index) => [
        network.id,
        index,
    ]));
    const junctions: RenderedJunction[] = deriveJunctions(allSegments)
        .sort((left, right) =>
            (networkOrder.get(left.networkId) ?? Number.MAX_SAFE_INTEGER)
                - (networkOrder.get(right.networkId) ?? Number.MAX_SAFE_INTEGER)
            || left.point.x - right.point.x
            || left.point.y - right.point.y
        ).map(junction => Object.freeze({
            networkId: junction.networkId,
            point: freezePoint(junction.point),
            directions: readonlySet(DIRECTION_ORDER.filter(direction =>
                junction.directions.has(direction)
            )),
        }));
    const networks: NetworkRoute[] = graph.networks.map(network => {
        const route: RoutedNetwork = routedById.get(network.id)!;
        const segments = Object.freeze(route.segments.map(freezeSegment));
        const displayName = network.adapterLabel
            ? `${network.name} ${network.adapterLabel}`
            : network.name;
        const terminals = Object.freeze(network.endpoints.map(endpoint => {
            const point = realizedById.get(endpoint.nodeId)!.pinAnchors.find(
                pin => pin.id === endpoint.pinId
            )!.point;
            return Object.freeze({
                ...endpoint,
                point: freezePoint(point),
            });
        }));
        return Object.freeze({
            id: network.id,
            name: network.name,
            displayName,
            selectionDescription: network.name,
            feedback: route.feedback,
            terminals,
            segments,
        });
    });
    const columns: LayoutColumn[] = routed.grid.columns.map(column => Object.freeze({
        index: column.index,
        x: column.x,
        width: column.width,
        nodeIds: Object.freeze(routed.grid.nodes
            .filter(node => node.column === column.index)
            .sort((left, right) => left.row - right.row)
            .map(node => node.id)),
    }));
    const gridBounds = {
        x: 0,
        y: 0,
        width: routed.grid.width,
        height: routed.grid.height,
    };
    const bounds = calculateBounds(
        gridBounds,
        allSegments,
        junctions,
        graph.nodes.length === 0 && allSegments.length === 0
    );

    return Object.freeze({
        columns: Object.freeze(columns),
        nodes,
        networks: Object.freeze(networks),
        junctions: Object.freeze(junctions),
        bounds,
    });
}
