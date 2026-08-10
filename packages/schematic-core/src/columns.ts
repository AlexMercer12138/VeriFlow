import type {
    GraphNode,
    NetworkEndpoint,
    SchematicGraph,
} from './model';
import { pinKey, type PinKey } from './pins';

export type ColumnAssignment = {
    columns: readonly (readonly string[])[];
    nodeColumn: ReadonlyMap<string, number>;
    feedbackNetworkIds: ReadonlySet<string>;
};

type OrderedEndpoint = {
    endpoint: NetworkEndpoint;
    nodeIndex: number;
    pinIndex: number;
    endpointIndex: number;
};

type DependencyEdge = {
    from: number;
    to: number;
    networkIds: Set<string>;
};

function addDependencyEdge(
    edgesByPair: Map<string, DependencyEdge>,
    source: OrderedEndpoint,
    target: OrderedEndpoint,
    networkId: string
): void {
    const key = `${source.nodeIndex}\0${target.nodeIndex}`;
    let edge = edgesByPair.get(key);
    if (!edge) {
        edge = {
            from: source.nodeIndex,
            to: target.nodeIndex,
            networkIds: new Set(),
        };
        edgesByPair.set(key, edge);
    }
    edge.networkIds.add(networkId);
}

function isInputBoundary(node: GraphNode): boolean {
    return node.kind === 'port' && node.pins[0]?.direction === 'driver';
}

function isRightBoundary(node: GraphNode): boolean {
    return node.kind === 'port' && !isInputBoundary(node);
}

function compareEndpoints(left: OrderedEndpoint, right: OrderedEndpoint): number {
    return left.nodeIndex - right.nodeIndex
        || left.pinIndex - right.pinIndex
        || (left.endpoint.pinId < right.endpoint.pinId
            ? -1
            : left.endpoint.pinId > right.endpoint.pinId ? 1 : 0)
        || left.endpointIndex - right.endpointIndex;
}

function orderedEndpoints(
    endpoints: readonly NetworkEndpoint[],
    nodeIndexes: ReadonlyMap<string, number>,
    pinIndexes: ReadonlyMap<PinKey, number>
): OrderedEndpoint[] {
    const seen = new Set<string>();
    const ordered: OrderedEndpoint[] = [];
    endpoints.forEach((endpoint, endpointIndex) => {
        const nodeIndex = nodeIndexes.get(endpoint.nodeId);
        const pinIndex = pinIndexes.get(pinKey(endpoint.nodeId, endpoint.pinId));
        if (nodeIndex === undefined || pinIndex === undefined) return;
        const key = `${nodeIndex}\0${endpoint.pinId}\0${endpoint.role}`;
        if (seen.has(key)) return;
        seen.add(key);
        ordered.push({ endpoint, nodeIndex, pinIndex, endpointIndex });
    });
    return ordered.sort(compareEndpoints);
}

function buildDependencyEdges(graph: SchematicGraph): {
    placementEdges: DependencyEdge[];
    semanticEdges: DependencyEdge[];
    semanticSelfCycleNetworkIds: Set<string>;
} {
    const nodeIndexes = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const pinIndexes = new Map(graph.nodes.flatMap(node =>
        node.pins.map((pin, index) => [pinKey(node.id, pin.id), index] as const)
    ));
    const placementEdgesByPair = new Map<string, DependencyEdge>();
    const semanticEdgesByPair = new Map<string, DependencyEdge>();
    const semanticSelfCycleNetworkIds = new Set<string>();

    for (const network of graph.networks) {
        const endpoints = orderedEndpoints(
            network.endpoints,
            nodeIndexes,
            pinIndexes
        );
        const explicitSources = endpoints.filter(candidate =>
            candidate.endpoint.role === 'driver'
        );
        const targets = endpoints.filter(candidate =>
            candidate.endpoint.role !== 'driver'
        );
        if (explicitSources.length === 0 && endpoints.length > 0) {
            const source = endpoints.find(candidate =>
                candidate.endpoint.role === 'bidirectional'
                && !isRightBoundary(graph.nodes[candidate.nodeIndex])
            ) ?? endpoints.find(candidate =>
                !isRightBoundary(graph.nodes[candidate.nodeIndex])
            ) ?? endpoints[0];
            for (const target of endpoints) {
                if (target === source || source.nodeIndex === target.nodeIndex) {
                    continue;
                }
                addDependencyEdge(
                    placementEdgesByPair,
                    source,
                    target,
                    network.id
                );
            }
            continue;
        }

        for (const source of explicitSources) {
            for (const target of targets) {
                if (source.nodeIndex === target.nodeIndex) {
                    semanticSelfCycleNetworkIds.add(network.id);
                    continue;
                }
                addDependencyEdge(
                    placementEdgesByPair,
                    source,
                    target,
                    network.id
                );
                addDependencyEdge(
                    semanticEdgesByPair,
                    source,
                    target,
                    network.id
                );
            }
        }
    }

    return {
        placementEdges: [...placementEdgesByPair.values()],
        semanticEdges: [...semanticEdgesByPair.values()],
        semanticSelfCycleNetworkIds,
    };
}

function stronglyConnectedComponents(
    nodeCount: number,
    edges: readonly DependencyEdge[]
): {
    components: number[][];
    componentByNode: number[];
} {
    const adjacencySets = Array.from(
        { length: nodeCount },
        () => new Set<number>()
    );
    for (const edge of edges) adjacencySets[edge.from].add(edge.to);
    const adjacency = adjacencySets.map(targets =>
        [...targets].sort((left, right) => left - right)
    );

    const visitIndex = new Array<number>(nodeCount).fill(-1);
    const lowLink = new Array<number>(nodeCount).fill(-1);
    const onStack = new Array<boolean>(nodeCount).fill(false);
    const stack: number[] = [];
    const components: number[][] = [];
    let nextVisitIndex = 0;

    type VisitFrame = {
        nodeIndex: number;
        parentIndex?: number;
        nextTargetIndex: number;
    };
    const beginVisit = (
        frames: VisitFrame[],
        nodeIndex: number,
        parentIndex?: number
    ): void => {
        visitIndex[nodeIndex] = nextVisitIndex;
        lowLink[nodeIndex] = nextVisitIndex;
        nextVisitIndex += 1;
        stack.push(nodeIndex);
        onStack[nodeIndex] = true;
        frames.push({ nodeIndex, parentIndex, nextTargetIndex: 0 });
    };

    for (let startIndex = 0; startIndex < nodeCount; startIndex += 1) {
        if (visitIndex[startIndex] >= 0) continue;
        const frames: VisitFrame[] = [];
        beginVisit(frames, startIndex);
        while (frames.length > 0) {
            const frame = frames[frames.length - 1];
            const targets = adjacency[frame.nodeIndex];
            if (frame.nextTargetIndex < targets.length) {
                const target = targets[frame.nextTargetIndex];
                frame.nextTargetIndex += 1;
                if (visitIndex[target] < 0) {
                    beginVisit(frames, target, frame.nodeIndex);
                } else if (onStack[target]) {
                    lowLink[frame.nodeIndex] = Math.min(
                        lowLink[frame.nodeIndex],
                        visitIndex[target]
                    );
                }
                continue;
            }

            frames.pop();
            if (frame.parentIndex !== undefined) {
                lowLink[frame.parentIndex] = Math.min(
                    lowLink[frame.parentIndex],
                    lowLink[frame.nodeIndex]
                );
            }
            if (lowLink[frame.nodeIndex] !== visitIndex[frame.nodeIndex]) {
                continue;
            }
            const component: number[] = [];
            while (stack.length > 0) {
                const member = stack.pop()!;
                onStack[member] = false;
                component.push(member);
                if (member === frame.nodeIndex) break;
            }
            component.sort((left, right) => left - right);
            components.push(component);
        }
    }

    components.sort((left, right) => left[0] - right[0]);
    const componentByNode = new Array<number>(nodeCount);
    components.forEach((component, componentIndex) => {
        for (const nodeIndex of component) componentByNode[nodeIndex] = componentIndex;
    });
    return { components, componentByNode };
}

function componentPrecedes(
    left: number,
    right: number,
    components: readonly (readonly number[])[]
): boolean {
    return components[left][0] < components[right][0];
}

function siftReadyDown(
    ready: number[],
    startIndex: number,
    components: readonly (readonly number[])[]
): void {
    let parent = startIndex;
    while (true) {
        const left = parent * 2 + 1;
        if (left >= ready.length) return;
        const right = left + 1;
        const child = right < ready.length
            && componentPrecedes(ready[right], ready[left], components)
            ? right
            : left;
        if (componentPrecedes(ready[parent], ready[child], components)) return;
        [ready[parent], ready[child]] = [ready[child], ready[parent]];
        parent = child;
    }
}

function pushReady(
    ready: number[],
    component: number,
    components: readonly (readonly number[])[]
): void {
    ready.push(component);
    let child = ready.length - 1;
    while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (componentPrecedes(ready[parent], ready[child], components)) return;
        [ready[parent], ready[child]] = [ready[child], ready[parent]];
        child = parent;
    }
}

function popReady(
    ready: number[],
    components: readonly (readonly number[])[]
): number | undefined {
    const first = ready[0];
    const last = ready.pop();
    if (ready.length > 0) {
        ready[0] = last!;
        siftReadyDown(ready, 0, components);
    }
    return first;
}

function topologicalComponents(
    components: readonly (readonly number[])[],
    componentByNode: readonly number[],
    edges: readonly DependencyEdge[]
): { order: number[]; adjacency: readonly (readonly number[])[] } {
    const adjacencySets = components.map(() => new Set<number>());
    const indegree = components.map(() => 0);
    for (const edge of edges) {
        const source = componentByNode[edge.from];
        const target = componentByNode[edge.to];
        if (source === target || adjacencySets[source].has(target)) continue;
        adjacencySets[source].add(target);
        indegree[target] += 1;
    }
    const adjacency = adjacencySets.map(targets => [...targets].sort(
        (left, right) => components[left][0] - components[right][0]
    ));

    const ready = components
        .map((_, index) => index)
        .filter(index => indegree[index] === 0);
    for (let index = Math.floor(ready.length / 2) - 1; index >= 0; index -= 1) {
        siftReadyDown(ready, index, components);
    }
    const order: number[] = [];
    while (ready.length > 0) {
        const component = popReady(ready, components)!;
        order.push(component);
        for (const target of adjacency[component]) {
            indegree[target] -= 1;
            if (indegree[target] !== 0) continue;
            pushReady(ready, target, components);
        }
    }
    return { order, adjacency };
}

export function assignColumns(graph: SchematicGraph): ColumnAssignment {
    const {
        placementEdges,
        semanticEdges,
        semanticSelfCycleNetworkIds,
    } = buildDependencyEdges(graph);
    const { components, componentByNode } = stronglyConnectedComponents(
        graph.nodes.length,
        placementEdges
    );
    const { order, adjacency } = topologicalComponents(
        components,
        componentByNode,
        placementEdges
    );
    const hasInternal = components.map(component => component.some(nodeIndex =>
        graph.nodes[nodeIndex].kind !== 'port'
    ));
    const hasInput = components.map(component => component.some(nodeIndex =>
        isInputBoundary(graph.nodes[nodeIndex])
    ));
    const hasInputBoundary = graph.nodes.some(isInputBoundary);
    const internalBaseRank = hasInputBoundary ? 1 : 0;
    const componentRank: number[] = components.map((_, index) =>
        hasInternal[index] ? internalBaseRank : 0
    );

    for (const source of order) {
        for (const target of adjacency[source]) {
            if (!hasInternal[target]) continue;
            if (hasInternal[source]) {
                componentRank[target] = Math.max(
                    componentRank[target],
                    componentRank[source] + 1
                );
            } else if (hasInput[source]) {
                componentRank[target] = Math.max(componentRank[target], 1);
            }
        }
    }

    let deepestInternalRank = -1;
    components.forEach((_, componentIndex) => {
        if (hasInternal[componentIndex]) {
            deepestInternalRank = Math.max(
                deepestInternalRank,
                componentRank[componentIndex]
            );
        }
    });
    const rightBoundaryRank = deepestInternalRank >= 0
        ? deepestInternalRank + 1
        : hasInputBoundary ? 1 : 0;
    const nodeColumn = new Map<string, number>();
    graph.nodes.forEach((node, nodeIndex) => {
        const rank = isInputBoundary(node)
            ? 0
            : isRightBoundary(node)
                ? rightBoundaryRank
                : componentRank[componentByNode[nodeIndex]];
        nodeColumn.set(node.id, rank);
    });

    let maximumRank = -1;
    for (const rank of nodeColumn.values()) {
        maximumRank = Math.max(maximumRank, rank);
    }
    const columns = Array.from({ length: maximumRank + 1 }, () => [] as string[]);
    for (const node of graph.nodes) columns[nodeColumn.get(node.id)!].push(node.id);

    const feedbackCandidates = new Set(semanticSelfCycleNetworkIds);
    if (semanticEdges.length > 0) {
        const semanticComponents = stronglyConnectedComponents(
            graph.nodes.length,
            semanticEdges
        );
        for (const edge of semanticEdges) {
            const component = semanticComponents.componentByNode[edge.from];
            if (component !== semanticComponents.componentByNode[edge.to]
                || semanticComponents.components[component].length < 2) {
                continue;
            }
            for (const networkId of edge.networkIds) {
                feedbackCandidates.add(networkId);
            }
        }
    }
    const feedbackNetworkIds = new Set(graph.networks
        .map(network => network.id)
        .filter(networkId => feedbackCandidates.has(networkId))
    );

    return { columns, nodeColumn, feedbackNetworkIds };
}
