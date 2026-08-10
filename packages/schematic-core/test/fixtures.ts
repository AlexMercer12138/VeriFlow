import {
    routeNetworks,
    type RoutedSchematic,
    type RoutingGridCreateOptions,
    type RoutingGridNodeInput,
    type RoutingNetworkRequest,
} from '../src';

export type RoutingFixture = Readonly<{
    nodes: readonly RoutingGridNodeInput[];
    networks: readonly RoutingNetworkRequest[];
    options?: RoutingGridCreateOptions;
}>;

export function routingNode(
    id: string,
    column: number,
    order: number,
    height = 40,
    yOffset = 0
): RoutingGridNodeInput {
    return {
        id,
        column,
        order,
        yOffset,
        size: { width: 100, height },
        pinAnchors: [
            { id: 'left', x: 0, y: height / 2 },
            { id: 'right', x: 100, y: height / 2 },
        ],
    };
}

export function threeColumnFixture(): RoutingFixture {
    return {
        nodes: [
            routingNode('source', 0, 0),
            routingNode('middle', 1, 0),
            routingNode('sink', 2, 0),
            routingNode('lower-0', 0, 1),
            routingNode('lower-1', 1, 1),
            routingNode('lower-2', 2, 1),
        ],
        networks: [{
            id: 'network:data',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
        options: { columnCount: 3 },
    };
}

export function routeFixture(fixture: RoutingFixture): RoutedSchematic {
    return routeNetworks(fixture.nodes, fixture.networks, fixture.options);
}
