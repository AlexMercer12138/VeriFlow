import type {
    GraphNode,
    NetworkEndpoint,
    PinSide,
    SchematicGraph,
} from './model';

export type PinKey = `${string}\0${string}`;

type OrderedEndpoint = NetworkEndpoint & {
    key: PinKey;
    node: GraphNode;
    nodeIndex: number;
    pinIndex: number;
};

export function pinKey(nodeId: string, pinId: string): PinKey {
    return `${nodeId}\0${pinId}`;
}

function boundaryPinSide(node: GraphNode): PinSide | undefined {
    if (node.kind !== 'port') return undefined;
    return node.pins[0]?.direction === 'driver' ? 'right' : 'left';
}

function compareEndpoints(left: OrderedEndpoint, right: OrderedEndpoint): number {
    return left.nodeIndex - right.nodeIndex
        || left.pinIndex - right.pinIndex
        || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
        || (left.pinId < right.pinId ? -1 : left.pinId > right.pinId ? 1 : 0);
}

export function resolvePinSides(
    graph: SchematicGraph
): ReadonlyMap<PinKey, PinSide> {
    const orderedPins: Array<{
        key: PinKey;
        node: GraphNode;
        direction: GraphNode['pins'][number]['direction'];
    }> = [];
    const networksByPin = new Map<PinKey, OrderedEndpoint[][]>();
    const nodeIndexes = new Map<string, number>();
    const pinIndexes = new Map<PinKey, number>();
    const nodesById = new Map<string, GraphNode>();

    graph.nodes.forEach((node, nodeIndex) => {
        nodeIndexes.set(node.id, nodeIndex);
        nodesById.set(node.id, node);
        node.pins.forEach((pin, pinIndex) => {
            const key = pinKey(node.id, pin.id);
            orderedPins.push({ key, node, direction: pin.direction });
            pinIndexes.set(key, pinIndex);
        });
    });

    const orderedNetworks = graph.networks.map(network =>
        network.endpoints.flatMap(endpoint => {
            const node = nodesById.get(endpoint.nodeId);
            const key = pinKey(endpoint.nodeId, endpoint.pinId);
            const nodeIndex = nodeIndexes.get(endpoint.nodeId);
            const pinIndex = pinIndexes.get(key);
            if (!node || nodeIndex === undefined || pinIndex === undefined) return [];
            const ordered: OrderedEndpoint = {
                ...endpoint,
                key,
                node,
                nodeIndex,
                pinIndex,
            };
            return [ordered];
        }).sort(compareEndpoints)
    );
    for (const endpoints of orderedNetworks) {
        for (const endpoint of endpoints) {
            const networks = networksByPin.get(endpoint.key) ?? [];
            networks.push(endpoints);
            networksByPin.set(endpoint.key, networks);
        }
    }

    const resolved = new Map<PinKey, PinSide>();
    for (const candidate of orderedPins) {
        const boundary = boundaryPinSide(candidate.node);
        if (boundary) {
            resolved.set(candidate.key, boundary);
        } else if (candidate.direction === 'driver') {
            resolved.set(candidate.key, 'right');
        } else if (candidate.direction === 'load') {
            resolved.set(candidate.key, 'left');
        }
    }

    for (const candidate of orderedPins) {
        if (resolved.has(candidate.key)) continue;
        let hasDriverPeer = false;
        let hasLoadPeer = false;
        for (const endpoints of networksByPin.get(candidate.key) ?? []) {
            for (const peer of endpoints) {
                if (peer.key === candidate.key) continue;
                hasDriverPeer ||= peer.role === 'driver';
                hasLoadPeer ||= peer.role === 'load';
            }
        }
        if (hasDriverPeer) {
            resolved.set(candidate.key, 'left');
        } else if (hasLoadPeer) {
            resolved.set(candidate.key, 'right');
        }
    }

    for (const endpoints of orderedNetworks) {
        const ambiguous = endpoints.filter(endpoint => !resolved.has(endpoint.key));
        if (ambiguous.length === 0) continue;
        const source = ambiguous.find(endpoint => endpoint.node.kind !== 'port')
            ?? ambiguous[0];
        for (const endpoint of ambiguous) {
            resolved.set(endpoint.key, endpoint.key === source.key ? 'right' : 'left');
        }
    }

    for (const candidate of orderedPins) {
        if (!resolved.has(candidate.key)) resolved.set(candidate.key, 'left');
    }

    return new Map(orderedPins.map(candidate => [
        candidate.key,
        resolved.get(candidate.key)!,
    ]));
}
