import type {
    GraphNode,
    NetworkEndpoint,
    SchematicGraph,
} from './model';

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
    pinIndexes: ReadonlyMap<string, number>
): OrderedEndpoint[] {
    const seen = new Set<string>();
    const ordered: OrderedEndpoint[] = [];
    endpoints.forEach((endpoint, endpointIndex) => {
        const nodeIndex = nodeIndexes.get(endpoint.nodeId);
        const pinIndex = pinIndexes.get(`${endpoint.nodeId}\0${endpoint.pinId}`);
        if (nodeIndex === undefined || pinIndex === undefined) return;
        const key = `${nodeIndex}\0${endpoint.pinId}\0${endpoint.role}`;
        if (seen.has(key)) return;
        seen.add(key);
        ordered.push({ endpoint, nodeIndex, pinIndex, endpointIndex });
    });
    return ordered.sort(compareEndpoints);
}

function buildDependencyEdges(graph: SchematicGraph): {
    edges: DependencyEdge[];
    selfCycleNetworkIds: Set<string>;
} {
    const nodeIndexes = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const pinIndexes = new Map(graph.nodes.flatMap(node =>
        node.pins.map((pin, index) => [`${node.id}\0${pin.id}`, index] as const)
    ));
    const edgesByPair = new Map<string, DependencyEdge>();
    const selfCycleNetworkIds = new Set<string>();

    for (const network of graph.networks) {
        const endpoints = orderedEndpoints(
            network.endpoints,
            nodeIndexes,
            pinIndexes
        );
        let sources = endpoints.filter(candidate =>
            candidate.endpoint.role === 'driver'
        );
        let targets = endpoints.filter(candidate =>
            candidate.endpoint.role !== 'driver'
        );
        if (sources.length === 0 && endpoints.length > 0) {
            const source = endpoints.find(candidate =>
                candidate.endpoint.role === 'bidirectional'
                && !isRightBoundary(graph.nodes[candidate.nodeIndex])
            ) ?? endpoints.find(candidate =>
                !isRightBoundary(graph.nodes[candidate.nodeIndex])
            ) ?? endpoints[0];
            sources = [source];
            targets = endpoints.filter(candidate => candidate !== source);
        }

        for (const source of sources) {
            for (const target of targets) {
                if (source.nodeIndex === target.nodeIndex) {
                    selfCycleNetworkIds.add(network.id);
                    continue;
                }
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
                edge.networkIds.add(network.id);
            }
        }
    }

    return { edges: [...edgesByPair.values()], selfCycleNetworkIds };
}

function stronglyConnectedComponents(
    nodeCount: number,
    edges: readonly DependencyEdge[]
): {
    components: number[][];
    componentByNode: number[];
} {
    const adjacency = Array.from({ length: nodeCount }, () => new Set<number>());
    for (const edge of edges) adjacency[edge.from].add(edge.to);

    const visitIndex = new Array<number>(nodeCount).fill(-1);
    const lowLink = new Array<number>(nodeCount).fill(-1);
    const onStack = new Array<boolean>(nodeCount).fill(false);
    const stack: number[] = [];
    const components: number[][] = [];
    let nextVisitIndex = 0;

    const visit = (nodeIndex: number): void => {
        visitIndex[nodeIndex] = nextVisitIndex;
        lowLink[nodeIndex] = nextVisitIndex;
        nextVisitIndex += 1;
        stack.push(nodeIndex);
        onStack[nodeIndex] = true;

        for (const target of [...adjacency[nodeIndex]].sort((left, right) => left - right)) {
            if (visitIndex[target] < 0) {
                visit(target);
                lowLink[nodeIndex] = Math.min(lowLink[nodeIndex], lowLink[target]);
            } else if (onStack[target]) {
                lowLink[nodeIndex] = Math.min(lowLink[nodeIndex], visitIndex[target]);
            }
        }

        if (lowLink[nodeIndex] !== visitIndex[nodeIndex]) return;
        const component: number[] = [];
        while (stack.length > 0) {
            const member = stack.pop()!;
            onStack[member] = false;
            component.push(member);
            if (member === nodeIndex) break;
        }
        component.sort((left, right) => left - right);
        components.push(component);
    };

    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
        if (visitIndex[nodeIndex] < 0) visit(nodeIndex);
    }

    components.sort((left, right) => left[0] - right[0]);
    const componentByNode = new Array<number>(nodeCount);
    components.forEach((component, componentIndex) => {
        for (const nodeIndex of component) componentByNode[nodeIndex] = componentIndex;
    });
    return { components, componentByNode };
}

function topologicalComponents(
    components: readonly (readonly number[])[],
    componentByNode: readonly number[],
    edges: readonly DependencyEdge[]
): { order: number[]; adjacency: readonly ReadonlySet<number>[] } {
    const adjacency = components.map(() => new Set<number>());
    const indegree = components.map(() => 0);
    for (const edge of edges) {
        const source = componentByNode[edge.from];
        const target = componentByNode[edge.to];
        if (source === target || adjacency[source].has(target)) continue;
        adjacency[source].add(target);
        indegree[target] += 1;
    }

    const ready = components
        .map((_, index) => index)
        .filter(index => indegree[index] === 0)
        .sort((left, right) => components[left][0] - components[right][0]);
    const order: number[] = [];
    while (ready.length > 0) {
        const component = ready.shift()!;
        order.push(component);
        for (const target of [...adjacency[component]].sort((left, right) =>
            components[left][0] - components[right][0]
        )) {
            indegree[target] -= 1;
            if (indegree[target] !== 0) continue;
            ready.push(target);
            ready.sort((left, right) =>
                components[left][0] - components[right][0]
            );
        }
    }
    return { order, adjacency };
}

export function assignColumns(graph: SchematicGraph): ColumnAssignment {
    const { edges, selfCycleNetworkIds } = buildDependencyEdges(graph);
    const { components, componentByNode } = stronglyConnectedComponents(
        graph.nodes.length,
        edges
    );
    const { order, adjacency } = topologicalComponents(
        components,
        componentByNode,
        edges
    );
    const hasInternal = components.map(component => component.some(nodeIndex =>
        graph.nodes[nodeIndex].kind !== 'port'
    ));
    const hasInput = components.map(component => component.some(nodeIndex =>
        isInputBoundary(graph.nodes[nodeIndex])
    ));
    const componentRank: number[] = components.map((_, index) =>
        hasInternal[index] ? 1 : 0
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

    let deepestInternalRank = 0;
    components.forEach((_, componentIndex) => {
        if (hasInternal[componentIndex]) {
            deepestInternalRank = Math.max(
                deepestInternalRank,
                componentRank[componentIndex]
            );
        }
    });
    const rightBoundaryRank = deepestInternalRank + 1;
    const nodeColumn = new Map<string, number>();
    graph.nodes.forEach((node, nodeIndex) => {
        const rank = isInputBoundary(node)
            ? 0
            : isRightBoundary(node)
                ? rightBoundaryRank
                : componentRank[componentByNode[nodeIndex]];
        nodeColumn.set(node.id, rank);
    });

    const maximumRank = Math.max(...nodeColumn.values());
    const columns = Array.from({ length: maximumRank + 1 }, () => [] as string[]);
    for (const node of graph.nodes) columns[nodeColumn.get(node.id)!].push(node.id);

    const feedbackCandidates = new Set(selfCycleNetworkIds);
    for (const edge of edges) {
        const component = componentByNode[edge.from];
        if (component !== componentByNode[edge.to]
            || components[component].length < 2) {
            continue;
        }
        for (const networkId of edge.networkIds) feedbackCandidates.add(networkId);
    }
    const feedbackNetworkIds = new Set(graph.networks
        .map(network => network.id)
        .filter(networkId => feedbackCandidates.has(networkId))
    );

    return { columns, nodeColumn, feedbackNetworkIds };
}
